import { randomUUID } from 'node:crypto';
import { readSettings } from './database.mjs';
import { validSlug } from './configuration.mjs';
import { digest, failure, isEmail, rateLimit } from './security.mjs';
import { createMercadoPagoClient, cents, checkoutUrl, paymentEnvironmentMatches } from './mercadopago-client.mjs';

const lifetime = 2 * 60 * 60 * 1000, leaseMs = 120000;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const numeric = value => /^\d{1,32}$/.test(String(value ?? ''));
const providerId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const statuses = ['pending', 'authorized', 'paused', 'cancelled'];
const issues = ['not_found', 'ambiguous', 'mismatch', 'unavailable', 'url_unavailable', 'invoice_unavailable', 'invoice_activity', 'unexpected_status'];
const providerIssues = ['provider_rejected', 'not_authorized', 'amount_rejected', 'invalid_request', 'rate_limited', 'provider_unavailable', 'connection_failed', 'invalid_response'];
const categories = ['parameter', 'payer', 'oauth', 'authorization', 'environment', 'unknown'];
const params = ['payer_email', 'notification_url', 'back_url', 'external_reference', 'auto_recurring', 'frequency', 'frequency_type', 'currency_id', 'transaction_amount', 'status', 'reason', 'card_token_id', 'preapproval_plan_id', 'idempotency_key', 'preapproval_id', 'payment_id', 'collector_id', 'application_id', 'offset', 'limit', 'sort', 'criteria', 'unknown'];
const descriptor = (object, key) => object && typeof object === 'object' ? Object.getOwnPropertyDescriptor(object, key)?.value : undefined;
const only = (input, keys) => { if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(input, key))) throw failure(422, 'Confira os dados do diagnóstico.'); };
const mismatch = message => Object.assign(failure(409, message), { diagnosticMismatch: true });
const paymentStatuses = ['approved', 'pending', 'authorized', 'in_process', 'in_mediation', 'rejected', 'cancelled', 'refunded', 'charged_back'];
const paymentDetails = ['accredited', 'partially_refunded', 'pending_capture', 'offline_process', 'pending_contingency', 'pending_review_manual', 'pending_waiting_payment', 'pending_waiting_transfer', 'deferred_retry', 'cc_rejected_bad_filled_card_number', 'cc_rejected_bad_filled_date', 'cc_rejected_bad_filled_other', 'cc_rejected_bad_filled_security_code', 'cc_rejected_blacklist', 'cc_rejected_call_for_authorize', 'cc_rejected_card_disabled', 'cc_rejected_duplicated_payment', 'cc_rejected_high_risk', 'cc_rejected_insufficient_amount', 'cc_rejected_invalid_installments', 'cc_rejected_max_attempts', 'cc_rejected_other_reason'];
const indeterminatePayment = () => ({ determination: 'indeterminate', status: 'unknown', status_detail: 'unknown', amountCents: null, receiverVerified: false, linkVerified: false });

function safeFailure(error, phase) {
  const status = descriptor(error, 'providerStatus'), issue = descriptor(error, 'providerIssue'), requestId = descriptor(error, 'providerRequestId'), raw = descriptor(error, 'providerDiagnostic');
  const result = { phase, status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null, providerIssue: providerIssues.includes(issue) ? issue : null };
  if (typeof requestId === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(requestId)) result.providerRequestId = requestId;
  if (raw && categories.includes(descriptor(raw, 'category')) && params.includes(descriptor(raw, 'param')) && ['jsonValid', 'hasError', 'hasMessage', 'hasCause'].every(key => typeof descriptor(raw, key) === 'boolean')) result.providerDiagnostic = Object.fromEntries(['category', 'param', 'jsonValid', 'hasError', 'hasMessage', 'hasCause'].map(key => [key, descriptor(raw, key)]));
  return result;
}

export function createPaymentDiagnostics(config, { getService, database, withTenant = async (_slug, work) => work() }) {
  const now = config.now ?? (() => Date.now()), loadedAt = now(), request = createMercadoPagoClient({}, config.mpTransport);
  const invoiceFailures = new WeakMap();
  function binding(active = false) {
    const value = config.paymentDiagnostics, fields = ['tenant', 'subscriptionId', 'expiresAt', 'maxAttempts'];
    if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== fields.length || !fields.every(key => Object.hasOwn(value, key)) || !validSlug(value.tenant) || !Object.hasOwn(config.entries ?? {}, value.tenant) || !/^[a-f0-9-]{36}$/.test(value.subscriptionId ?? '') || value.maxAttempts !== 2 || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0 || value.expiresAt > loadedAt + lifetime || active && value.expiresAt <= now()) return null;
    return { ...value, key: digest(JSON.stringify([value.tenant, value.subscriptionId])) };
  }
  function allowed(user) { return Boolean(config.enabled && config.operations && user?.tenant === config.operations.tenant && user.role === 'admin' && Array.isArray(config.operations.userIds) && config.operations.userIds.includes(user.id)); }
  async function authorize(user) {
    if (!allowed(user)) throw failure(403, 'Acesso reservado à operação da plataforma.');
    const service = await getService(config.operations.tenant);
    if (typeof service.withCurrentSession !== 'function') throw failure(503, 'A conferência do acesso operacional está indisponível.');
    await service.withCurrentSession(user, async (_tx, current) => { if (!allowed(current)) throw failure(403, 'Acesso reservado à operação da plataforma.'); });
    return database(config.operations.tenant);
  }
  // This read-only lookup has no dependency on the temporary proposal window.
  // Tokens stay in payments.access; no reconciliation or financial writes run here.
  async function paymentSource(slug, id) {
    const db = await database(slug), service = await getService(slug);
    const [row] = await db.query('SELECT * FROM subscriptions WHERE id = ?', [id]);
    const [app] = await db.query('SELECT client_id, mode, revision FROM mp_integration_settings WHERE id = 1');
    const [connection] = row?.connection_id ? await db.query('SELECT id, professional_id, collector_id, mode, status, revision FROM mp_connections WHERE id = ?', [row.connection_id]) : [];
    let terms; try { terms = JSON.parse(row?.snapshot_json); } catch { return null; }
    if (!row || !providerId(row.provider_id) || !uuid(row.connection_id) || !numeric(row.collector_id) || !['sandbox', 'live'].includes(row.mode) || (terms.billingMethod ?? 'mercadopago') !== 'mercadopago' || !Number.isSafeInteger(terms.priceCents) || terms.priceCents < 1 || (terms.currency_id ?? terms.currency ?? 'BRL') !== 'BRL' || Number(terms.frequency ?? 1) !== 1 || (terms.frequencyType ?? 'months') !== 'months' || !app || !numeric(app.client_id) || app.mode !== row.mode || !connection || connection.id !== row.connection_id || String(connection.collector_id) !== String(row.collector_id) || connection.mode !== row.mode || connection.status !== 'connected' || !service.payments.configured()) return null;
    const fingerprint = digest(JSON.stringify([row.id, row.customer_id, row.plan_id, row.professional_id, row.provider_id, row.connection_id, String(row.collector_id), row.mode, row.snapshot_json, app.client_id, app.mode, app.revision, connection.professional_id]));
    return { row, app, connection, terms, service, fingerprint };
  }
  function canonicalPaymentSource(value, source) {
    return value && String(value.id) === source.row.provider_id && String(value.collector_id) === String(source.row.collector_id) && value.external_reference === `rael_sub_${source.row.id}` && statuses.includes(value.status) && Number.isFinite(Date.parse(value.last_modified)) && (!Object.hasOwn(value, 'application_id') || String(value.application_id) === source.app.client_id) && value.auto_recurring?.currency_id === 'BRL' && value.auto_recurring?.frequency === 1 && value.auto_recurring?.frequency_type === 'months' && cents(value.auto_recurring?.transaction_amount) === source.terms.priceCents;
  }
  async function invoiceLinksPayment(source, access, paymentId) {
    const hits = []; let offset = 0, total;
    for (let page = 0; page < 5; page++) {
      const query = new URLSearchParams({ payment_id: paymentId, ...(offset ? { offset: String(offset) } : {}) });
      const result = await request('GET', '/authorized_payments/search?' + query, { accessToken: access.accessToken });
      const p = result?.paging;
      if (!Array.isArray(result?.results) || !p || !Number.isSafeInteger(p.total) || p.total < 0 || p.total > 100 || !Number.isSafeInteger(p.offset) || p.offset !== offset || !Number.isSafeInteger(p.limit) || p.limit < 1 || result.results.length > p.limit || offset + result.results.length > p.total || total !== undefined && total !== p.total) return false;
      total = p.total;
      for (const hit of result.results) { if (!numeric(hit?.id)) return false; hits.push(hit); }
      offset += result.results.length;
      if (offset === total) break;
      if (!result.results.length || page === 4) return false;
    }
    if (new Set(hits.map(hit => String(hit.id))).size !== hits.length) return false;
    const matches = hits.filter(hit => String(hit.preapproval_id) === source.row.provider_id && String(hit.payment?.id) === paymentId);
    if (matches.length !== 1) return false;
    const invoice = await request('GET', '/authorized_payments/' + matches[0].id, { accessToken: access.accessToken });
    return String(invoice?.id) === String(matches[0].id) && String(invoice.preapproval_id) === source.row.provider_id && String(invoice.payment?.id) === paymentId;
  }
  async function paymentStatus(user, input) {
    const central = await authorize(user);
    only(input, ['slug', 'subscriptionId', 'paymentId']);
    if (!validSlug(input.slug) || !Object.hasOwn(config.entries ?? {}, input.slug) || !uuid(input.subscriptionId) || typeof input.paymentId !== 'string' || !numeric(input.paymentId)) throw failure(422, 'Confira o negócio, a assinatura e o pagamento.');
    await rateLimit(central, `operator_payment_diagnostic:${user.id}`, 20, 60 * 1000);
    return withTenant(input.slug, async () => {
      let source, access, result = indeterminatePayment();
      try {
        source = await paymentSource(input.slug, input.subscriptionId);
        if (source) {
          access = await source.service.payments.access(source.row.connection_id);
          if (access.id !== source.row.connection_id || String(access.collector_id) !== String(source.row.collector_id) || access.mode !== source.row.mode || access.status !== 'connected' || access.professional_id !== source.connection.professional_id) throw mismatch();
          const agreement = await request('GET', '/preapproval/' + source.row.provider_id, { accessToken: access.accessToken });
          if (!canonicalPaymentSource(agreement, source)) throw mismatch();
          const payment = await request('GET', '/v1/payments/' + input.paymentId, { accessToken: access.accessToken });
          const amount = cents(payment?.transaction_amount);
          if (String(payment?.id) !== input.paymentId || payment.currency_id !== 'BRL' || !Number.isSafeInteger(amount) || amount < 0 || Object.hasOwn(payment, 'application_id') && String(payment.application_id) !== source.app.client_id || !await paymentEnvironmentMatches(payment, source.row.mode, source.row.collector_id, access.accessToken, request)) throw mismatch();
          const linked = payment.external_reference === `rael_sub_${source.row.id}` || (payment.external_reference === undefined || payment.external_reference === null || payment.external_reference === '') && await invoiceLinksPayment(source, access, input.paymentId);
          if (linked) result = { determination: 'verified', status: paymentStatuses.includes(payment.status) ? payment.status : 'unknown', status_detail: paymentDetails.includes(payment.status_detail) ? payment.status_detail : 'unknown', amountCents: amount, receiverVerified: true, linkVerified: true };
        }
      } catch { /* Missing, inaccessible or unbound provider objects disclose no data. */ }
      const operator = await getService(config.operations.tenant);
      return operator.withCurrentSession(user, async (_tx, current) => {
        if (!allowed(current)) throw failure(403, 'Acesso reservado à operação da plataforma.');
        if (result.determination === 'verified') {
          const latest = await paymentSource(input.slug, input.subscriptionId);
          if (!latest || latest.fingerprint !== source.fingerprint || Number(latest.connection.revision) !== Number(access.revision)) return indeterminatePayment();
        }
        return result;
      });
    });
  }
  function requireBinding(active = false, expected) {
    const current = binding(active);
    if (!current || expected && current.key !== expected.key) throw failure(409, 'A autorização deste diagnóstico não está ativa ou foi alterada.');
    return current;
  }
  async function audit(tx, user, event, row, detail = {}) { await tx.query('INSERT INTO audit_events(id, actor_id, event_name, detail_json, created_at) VALUES (?, ?, ?, ?, ?)', [randomUUID(), user.id, event, JSON.stringify({ id: row.id, supportCode: row.id.replaceAll('-', '').slice(0, 8), ...detail }), now()]); }
  function origin() { let url; try { url = new URL(config.origin); } catch { throw failure(503, 'O endereço oficial precisa ser conferido.'); } if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw failure(503, 'O endereço oficial precisa ser conferido.'); return url.origin; }
  async function source(scope, payer = false) {
    const db = await database(scope.tenant), service = await getService(scope.tenant);
    const [row] = await db.query('SELECT * FROM subscriptions WHERE id = ?', [scope.subscriptionId]);
    if (!row || row.state !== 'pending' || row.provider_id || row.checkout_url || row.mode !== 'live' || row.resolution || Number(row.lease_until) > now() || !uuid(row.connection_id) || !numeric(row.collector_id)) throw failure(409, 'A assinatura de origem não está elegível para este diagnóstico.');
    let terms; try { terms = JSON.parse(row.snapshot_json); } catch { throw failure(409, 'As condições da origem precisam ser conferidas.'); }
    if (!Number.isSafeInteger(terms.priceCents) || terms.priceCents < 1 || terms.priceCents > 15000 || (terms.billingMethod ?? 'mercadopago') !== 'mercadopago' || (terms.currency_id ?? terms.currency ?? 'BRL') !== 'BRL' || Number(terms.frequency ?? 1) !== 1 || (terms.frequencyType ?? 'months') !== 'months') throw failure(409, 'O diagnóstico exige o valor original de até R$ 150,00, em BRL e mensal.');
    const [cycle] = await db.query('SELECT id FROM subscription_cycles WHERE subscription_id = ? LIMIT 1', [row.id]);
    const [app] = await db.query('SELECT client_id, mode FROM mp_integration_settings WHERE id = 1');
    const [connection] = await db.query('SELECT id, professional_id, collector_id, mode, status FROM mp_connections WHERE id = ?', [row.connection_id]);
    if (cycle || !app || typeof app.client_id !== 'string' || !/^\d{4,32}$/.test(app.client_id) || app.mode !== 'live' || !connection || String(connection.collector_id) !== String(row.collector_id) || connection.mode !== 'live' || connection.status !== 'connected' || !service.payments.configured()) throw failure(409, 'Confira a aplicação e a conexão da assinatura de origem.');
    let email;
    if (payer) { const [customer] = await db.query('SELECT email FROM customers WHERE id = ?', [row.customer_id]); if (!customer || !isEmail(customer.email)) throw failure(409, 'O cadastro original não possui e-mail elegível.'); email = customer.email; }
    return { service, email, snapshot: { tenant: scope.tenant, sourceId: row.id, sourceHash: digest(JSON.stringify([row.id, row.customer_id, row.plan_id, row.snapshot_json, row.connection_id, row.collector_id, row.mode])), connectionId: row.connection_id, collectorId: String(row.collector_id), clientId: app.client_id, mode: 'live', amountCents: terms.priceCents, currency: 'BRL', frequency: 1, frequencyType: 'months' } };
  }
  function snapshot(row, scope) {
    let value; try { value = JSON.parse(row.snapshot_json); } catch { throw failure(409, 'O vínculo do diagnóstico precisa de conferência.'); }
    if (row.binding_key !== scope.key || row.tenant_slug !== scope.tenant || row.source_subscription_id !== scope.subscriptionId || value.tenant !== scope.tenant || value.sourceId !== scope.subscriptionId || !uuid(value.connectionId) || !numeric(value.collectorId) || typeof value.clientId !== 'string' || !/^\d{4,32}$/.test(value.clientId) || value.mode !== 'live' || value.reference !== `rael_diag_${row.id}` || value.currency !== 'BRL' || value.frequency !== 1 || value.frequencyType !== 'months' || !Number.isSafeInteger(value.amountCents) || value.amountCents < 1 || value.amountCents > 15000) throw failure(409, 'O vínculo do diagnóstico precisa de conferência.');
    return value;
  }
  async function credential(scope, stored, onIdentity) {
    requireBinding(false, scope);
    const db = await database(scope.tenant), service = await getService(scope.tenant);
    const [app] = await db.query('SELECT client_id, mode FROM mp_integration_settings WHERE id = 1');
    if (!app || app.client_id !== stored.clientId || app.mode !== stored.mode || !service.payments.configured()) throw failure(409, 'A aplicação deste diagnóstico foi alterada.');
    const access = await service.payments.access(stored.connectionId);
    if (access.id !== stored.connectionId || String(access.collector_id) !== stored.collectorId || access.mode !== stored.mode) throw failure(409, 'A conexão deste diagnóstico foi alterada.');
    onIdentity?.();
    const me = await request('GET', '/users/me', { accessToken: access.accessToken });
    if (String(me?.id) !== stored.collectorId || me.site_id !== 'MLB' || !Array.isArray(me.tags) || me.tags.includes('test_user')) throw failure(409, 'A identidade do recebedor deste diagnóstico não foi confirmada.');
    return access;
  }
  async function rows(db, scope) { return db.query('SELECT * FROM mp_diagnostic_probes WHERE tenant_slug = ? AND source_subscription_id = ? ORDER BY created_at, id', [scope.tenant, scope.subscriptionId]); }
  const blocksStart = row => Number(row.lease_until) > now() || row.state === 'review' || Boolean((row.provider_id || row.checkout_url) && row.provider_status !== 'cancelled');
  function publicProbe(row, scope) {
    const stored = snapshot(row, scope), busy = Number(row.lease_until) > now(), active = Boolean(binding(true)?.key === scope.key);
    const state = busy ? 'preparing' : row.state === 'preparing' ? 'unconfirmed' : row.state;
    const unsafe = ['mismatch', 'ambiguous', 'invoice_activity'].includes(row.issue) || Boolean(Number(row.has_approved_invoice)) || Number(row.invoice_count) > 0;
    let url = null; if (active && state === 'pending' && row.provider_status === 'pending' && !unsafe && (!row.issue || ['url_unavailable', 'invoice_unavailable'].includes(row.issue)) && row.checkout_url) { try { url = checkoutUrl(row.checkout_url, stored.mode); } catch { /* A stored link never bypasses the allowlist. */ } }
    let diagnostic = null; try { const parsed = JSON.parse(row.diagnostic_json); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) diagnostic = safeFailure({ providerStatus: parsed.status, providerIssue: parsed.providerIssue, providerRequestId: parsed.providerRequestId, providerDiagnostic: parsed.providerDiagnostic }, ['access', 'identity', 'source', 'create', 'validate', 'persist', 'search', 'invoice', 'cancel'].includes(parsed.phase) ? parsed.phase : 'validate'); } catch { /* Corrupt metadata is never reflected. */ }
    return { id: row.id, supportCode: row.id.replaceAll('-', '').slice(0, 8), reference: stored.reference, state, providerId: providerId(row.provider_id) ? row.provider_id : null, providerStatus: statuses.includes(row.provider_status) ? row.provider_status : null, issue: issues.includes(row.issue) ? row.issue : null, amountCents: stored.amountCents, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), canRefresh: !busy, canCancel: !busy && Boolean(row.provider_id) && row.provider_status !== 'cancelled' && !unsafe, canCheckout: Boolean(url), url, invoiceCount: Number(row.invoice_count) < 0 ? null : Number(row.invoice_count), hasApprovedInvoice: Boolean(Number(row.has_approved_invoice)), cancellationConfirmed: row.provider_status === 'cancelled', diagnostic };
  }
  async function view(user) {
    const db = await authorize(user), scope = binding();
    if (!scope) return { configured: false, active: false, tenant: null, subscriptionId: null, expiresAt: null, maxAttempts: 2, attemptsUsed: 0, remainingAttempts: 0, canStart: false, source: null, probes: [] };
    return withTenant(scope.tenant, async () => {
      const found = await rows(db, scope); let current;
      let details = null; try { current = await source(scope); details = { available: true, amountCents: current.snapshot.amountCents, currency: 'BRL', frequency: 1, frequencyType: 'months' }; } catch { details = { available: false, amountCents: null, currency: 'BRL', frequency: 1, frequencyType: 'months' }; }
      let probes = found.map(row => { const probe = publicProbe(row, scope), stored = snapshot(row, scope); if (!current || ['tenant', 'sourceId', 'sourceHash', 'connectionId', 'collectorId', 'clientId', 'mode', 'amountCents', 'currency', 'frequency', 'frequencyType'].some(key => stored[key] !== current.snapshot[key])) return { ...probe, canCheckout: false, url: null }; return probe; });
      const active = Boolean(binding(true));
      if (!active) probes = probes.map(probe => ({ ...probe, canCheckout: false, url: null }));
      return { configured: true, active, tenant: scope.tenant, subscriptionId: scope.subscriptionId, expiresAt: scope.expiresAt, maxAttempts: 2, attemptsUsed: found.length, remainingAttempts: Math.max(0, 2 - found.length), canStart: active && details.available && found.length < 2 && !found.some(blocksStart), source: details, probes };
    });
  }
  async function owned(db, id, scope) { const [row] = await db.query('SELECT * FROM mp_diagnostic_probes WHERE id = ?', [id]); if (!row) throw failure(404, 'Diagnóstico não encontrado.'); snapshot(row, scope); return row; }
  async function claim(db, row, scope) {
    return db.transaction(async tx => { await readSettings(tx, true); const current = await owned(tx, row.id, scope); if (Number(current.lease_until) > now()) return null; const lease = now() + leaseMs, revision = Number(current.revision) + 1; await tx.query('UPDATE mp_diagnostic_probes SET lease_until = ?, revision = ?, updated_at = ? WHERE id = ?', [lease, revision, now(), row.id]); return { ...current, lease_until: lease, revision }; });
  }
  async function save(db, user, row, scope, outcome) {
    await db.transaction(async tx => {
      await readSettings(tx, true); const current = await owned(tx, row.id, scope);
      if (Number(current.revision) !== Number(row.revision) || Number(current.lease_until) !== Number(row.lease_until) || current.snapshot_json !== row.snapshot_json) return;
      const id = outcome.provider?.id ?? current.provider_id;
      if (id) { const [other] = await tx.query('SELECT id FROM mp_diagnostic_probes WHERE provider_id = ? AND id <> ?', [id, row.id]); if (other) { outcome = { state: 'review', issue: 'ambiguous', diagnostic: safeFailure({}, 'validate') }; } }
      const provider = outcome.provider;
      await tx.query('UPDATE mp_diagnostic_probes SET provider_id = ?, checkout_url = ?, state = ?, provider_status = ?, issue = ?, lease_until = 0, diagnostic_json = ?, invoice_count = ?, has_approved_invoice = ?, updated_at = ? WHERE id = ?', [provider?.id ?? current.provider_id, outcome.url ?? null, outcome.state ?? (current.provider_id ? 'review' : 'unconfirmed'), provider?.status ?? current.provider_status, outcome.issue ?? '', JSON.stringify(outcome.diagnostic ?? null), outcome.invoiceCount ?? Number(current.invoice_count), Number(outcome.hasApprovedInvoice ?? Boolean(Number(current.has_approved_invoice))), now(), row.id]);
      await audit(tx, user, 'mp_diagnostic_updated', row, { state: outcome.state ?? 'unconfirmed', issue: outcome.issue ?? null, ...(outcome.diagnostic ?? {}) });
    });
  }
  function validate(provider, stored, expectedId) {
    let amount; try { amount = cents(provider?.auto_recurring?.transaction_amount); } catch { amount = NaN; }
    if (!providerId(provider?.id) || expectedId && provider.id !== expectedId || String(provider.collector_id) !== stored.collectorId || Object.hasOwn(provider, 'application_id') && String(provider.application_id) !== stored.clientId || provider.external_reference !== stored.reference || amount !== stored.amountCents || provider.auto_recurring?.currency_id !== 'BRL' || Number(provider.auto_recurring?.frequency) !== 1 || provider.auto_recurring?.frequency_type !== 'months' || !statuses.includes(provider.status) || !Number.isFinite(Date.parse(provider.last_modified ?? ''))) throw mismatch('As condições canônicas do diagnóstico não correspondem ao vínculo original.');
    return provider;
  }
  async function inspect(access, stored, id, onPhase) {
    onPhase?.('validate');
    const provider = validate(await request('GET', '/preapproval/' + id, { accessToken: access.accessToken }), stored, id);
    onPhase?.('invoice');
    let invoices;
    try { invoices = await request('GET', '/authorized_payments/search?' + new URLSearchParams({ preapproval_id: id }), { accessToken: access.accessToken }); }
    catch (error) { if (error && typeof error === 'object') invoiceFailures.set(error, provider); throw error; }
    const paging = invoices?.paging;
    if (!Array.isArray(invoices?.results) || !paging || !Number.isSafeInteger(paging.total) || paging.total < invoices.results.length || !Number.isSafeInteger(paging.offset) || paging.offset !== 0 || !Number.isSafeInteger(paging.limit) || paging.limit < 1 || paging.limit > 20 || invoices.results.length > paging.limit || paging.total > 0 && !invoices.results.length) throw failure(409, 'As faturas deste diagnóstico precisam de conferência.');
    if (invoices.results.some(invoice => String(invoice?.preapproval_id) !== id || !numeric(invoice.id))) throw mismatch('As faturas deste diagnóstico não correspondem ao vínculo original.');
    const count = Math.max(invoices.results.length, Number.isSafeInteger(invoices.paging?.total) ? invoices.paging.total : 0), approved = invoices.results.some(invoice => invoice.payment?.status === 'approved');
    let url = null; if (provider.init_point) { try { url = checkoutUrl(provider.init_point, stored.mode); } catch { /* Keep the canonical ID for cancellation even without a safe URL. */ } }
    return { provider, url, invoiceCount: count, hasApprovedInvoice: approved, state: count ? 'review' : provider.status === 'cancelled' ? 'cancelled' : provider.status === 'pending' ? 'pending' : 'review', issue: count ? 'invoice_activity' : !['pending', 'cancelled'].includes(provider.status) ? 'unexpected_status' : !url && provider.status === 'pending' ? 'url_unavailable' : '' };
  }
  async function knownActivity(db, row) {
    if (Number(row.invoice_count) > 0 || Number(row.has_approved_invoice) || row.provider_status && row.provider_status !== 'pending' || ['invoice_activity', 'unexpected_status', 'mismatch', 'ambiguous'].includes(row.issue)) return true;
    const history = await db.query('SELECT detail_json FROM audit_events WHERE event_name = ? AND detail_json LIKE ? LIMIT 1001', ['mp_diagnostic_updated', '%' + row.id + '%']);
    if (history.length > 1000) return true;
    for (const event of history) { let detail; try { detail = JSON.parse(event.detail_json); } catch { return true; } if (detail.id === row.id && (detail.state === 'cancelled' || ['invoice_activity', 'unexpected_status', 'mismatch', 'ambiguous'].includes(detail.issue))) return true; }
    return false;
  }
  async function failureOutcome(db, row, stored, error, phase) {
    const provider = phase === 'invoice' && descriptor(error, 'providerStatus') === 400 && error && typeof error === 'object' ? invoiceFailures.get(error) : null;
    if (provider) {
      validate(provider, stored, row.provider_id || provider.id);
      const known = await knownActivity(db, row), pending = provider.status === 'pending' && !known;
      let url = null; if (pending) { try { url = checkoutUrl(provider.init_point, stored.mode); } catch { /* Unknown invoices never make an unsafe link usable. */ } }
      return { provider, state: pending ? 'pending' : 'review', issue: !['pending', 'cancelled'].includes(provider.status) ? 'unexpected_status' : 'invoice_unavailable', url, invoiceCount: Number(row.invoice_count) > 0 ? Number(row.invoice_count) : -1, hasApprovedInvoice: Boolean(Number(row.has_approved_invoice)), diagnostic: safeFailure(error, phase), pendingCleanup: pending };
    }
    const differs = descriptor(error, 'diagnosticMismatch') === true;
    return { state: differs ? 'review' : 'unconfirmed', issue: differs ? 'mismatch' : 'unavailable', diagnostic: safeFailure(error, phase) };
  }
  async function search(access, stored) {
    let offset = 0, total = null; const seen = new Set(), matches = new Set(), deadline = Date.now() + 32000;
    for (let page = 0; page < 8; page++) {
      if (Date.now() > deadline - 8000) return { issue: 'unavailable' };
      const result = await request('GET', '/preapproval/search?' + new URLSearchParams({ limit: '50', offset: String(offset) }), { accessToken: access.accessToken }), paging = result?.paging, items = result?.results;
      if (!paging || !Array.isArray(items) || !Number.isSafeInteger(paging.total) || paging.total < 0 || !Number.isSafeInteger(paging.offset) || paging.offset !== offset || !Number.isSafeInteger(paging.limit) || paging.limit < 1 || paging.limit > 50 || items.length > paging.limit || offset + items.length > paging.total || total !== null && total !== paging.total) return { issue: 'unavailable' };
      total = paging.total;
      for (const item of items) { if (!providerId(item?.id) || seen.has(item.id)) return { issue: 'unavailable' }; seen.add(item.id); if (item.external_reference === stored.reference) matches.add(item.id); }
      if (matches.size > 1) return { issue: 'ambiguous' };
      if (offset + items.length === total) return matches.size ? { id: [...matches][0] } : { issue: 'not_found' };
      if (items.length !== paging.limit) return { issue: 'unavailable' }; offset += items.length;
    }
    return { issue: 'unavailable' };
  }
  async function bindCandidate(db, user, row, scope, id) {
    if (!providerId(id)) return false;
    let assigned = false;
    await db.transaction(async tx => { await readSettings(tx, true); const current = await owned(tx, row.id, scope); if (Number(current.revision) !== Number(row.revision) || Number(current.lease_until) !== Number(row.lease_until)) return; const [other] = await tx.query('SELECT id FROM mp_diagnostic_probes WHERE provider_id = ? AND id <> ?', [id, row.id]); if (other || current.provider_id && current.provider_id !== id) return; await tx.query('UPDATE mp_diagnostic_probes SET provider_id = ?, updated_at = ? WHERE id = ?', [id, now(), row.id]); await audit(tx, user, 'mp_diagnostic_provider_observed', row); assigned = true; });
    return assigned;
  }
  async function start(user, input) {
    only(input, ['requestKey', 'confirmedPendingOnly']); if (!uuid(input.requestKey) || input.confirmedPendingOnly !== true) throw failure(422, 'Confirme a preparação exclusivamente pendente deste diagnóstico.');
    const db = await authorize(user), scope = requireBinding(); origin();
    return withTenant(scope.tenant, async () => {
      const key = digest(JSON.stringify([scope.key, input.requestKey]));
      const [prior] = await db.query('SELECT * FROM mp_diagnostic_probes WHERE request_key = ?', [key]);
      if (prior) { snapshot(prior, scope); return { ...await view(user), selectedId: prior.id }; }
      requireBinding(true, scope);
      const current = await source(scope, true);
      await rateLimit(db, `mp_diagnostic_start:${user.id}`, 5, 60000);
      const intent = await db.transaction(async tx => {
        await readSettings(tx, true); requireBinding(true, scope);
        const [repeat] = await tx.query('SELECT * FROM mp_diagnostic_probes WHERE request_key = ?', [key]); if (repeat) return { ...repeat, existing: true };
        const previous = await rows(tx, scope);
        if (previous.length >= 2 || previous.some(blocksStart)) throw failure(409, 'O limite ou a conferência deste diagnóstico impede outra preparação.');
        const id = randomUUID(), stored = { ...current.snapshot, reference: `rael_diag_${id}` }, lease = now() + leaseMs;
        await tx.query('INSERT INTO mp_diagnostic_probes(id, binding_key, tenant_slug, source_subscription_id, request_key, snapshot_json, provider_id, checkout_url, state, provider_status, issue, lease_until, revision, diagnostic_json, invoice_count, has_approved_invoice, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, 1, ?, 0, 0, ?, ?, ?)', [id, scope.key, scope.tenant, scope.subscriptionId, key, JSON.stringify(stored), 'preparing', '', lease, 'null', user.id, now(), now()]);
        const [created] = await tx.query('SELECT * FROM mp_diagnostic_probes WHERE id = ?', [id]); await audit(tx, user, 'mp_diagnostic_requested', created, { amountCents: stored.amountCents }); return created;
      });
      if (intent.existing) return { ...await view(user), selectedId: intent.id };
      let phase = 'access';
      try {
        const stored = snapshot(intent, scope), access = await credential(scope, stored, () => { phase = 'identity'; });
        phase = 'source'; const latest = await source(scope, true);
        if (JSON.stringify(latest.snapshot) !== JSON.stringify(current.snapshot)) throw failure(409, 'A origem deste diagnóstico foi alterada.');
        const existing = await owned(db, intent.id, scope); if (Number(existing.revision) !== Number(intent.revision) || Number(existing.lease_until) !== Number(intent.lease_until) || Number(existing.lease_until) <= now()) throw failure(409, 'A preparação deste diagnóstico foi alterada.');
        requireBinding(true, scope);
        await authorize(user); requireBinding(true, scope);
        phase = 'create';
        const result = await request('POST', '/preapproval', { accessToken: access.accessToken, key: intent.id, data: { reason: `Diagnóstico técnico Rael · ${intent.id.slice(0, 8)}`, external_reference: stored.reference, payer_email: latest.email, auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: stored.amountCents / 100, currency_id: 'BRL' }, back_url: `${origin()}/operacao/diagnostico-mp`, notification_url: `${origin()}/payments/mercadopago/webhook/${scope.tenant}`, status: 'pending' } });
        phase = 'validate';
        if (!providerId(result?.id) || !await bindCandidate(db, user, intent, scope, result.id)) throw mismatch('A referência devolvida precisa de conferência.');
        const outcome = await inspect(access, stored, result.id, value => { phase = value; }); await save(db, user, intent, scope, outcome);
      } catch (error) { await save(db, user, intent, scope, await failureOutcome(db, intent, snapshot(intent, scope), error, phase)); }
      return { ...await view(user), selectedId: intent.id };
    });
  }
  async function action(user, input, cancelling) {
    only(input, ['id']); if (!uuid(input.id)) throw failure(422, 'Diagnóstico inválido.');
    const db = await authorize(user), scope = requireBinding();
    await rateLimit(db, `mp_diagnostic_check:${user.id}`, 20, 60000);
    return withTenant(scope.tenant, async () => {
      const original = await owned(db, input.id, scope), row = await claim(db, original, scope);
      if (!row) return { ...await view(user), selectedId: original.id };
      const stored = snapshot(row, scope); let phase = 'access', outcome, access, putAttempted = false;
      try {
        access = await credential(scope, stored, () => { phase = 'identity'; }); let id = row.provider_id;
        if (!id) { phase = 'search'; const found = await search(access, stored); if (!found.id) outcome = { state: found.issue === 'ambiguous' ? 'review' : 'unconfirmed', issue: found.issue }; else { id = found.id; if (!await bindCandidate(db, user, row, scope, id)) outcome = { state: 'review', issue: 'ambiguous' }; } }
        if (id && !outcome) {
          phase = 'validate'; outcome = await inspect(access, stored, id, value => { phase = value; });
          if (cancelling && !outcome.invoiceCount && outcome.provider.status !== 'cancelled') {
            await authorize(user); requireBinding(false, scope);
            const latest = await owned(db, row.id, scope); if (Number(latest.revision) !== Number(row.revision) || Number(latest.lease_until) !== Number(row.lease_until) || Number(latest.lease_until) <= now()) throw failure(409, 'A conferência deste diagnóstico foi alterada.');
            phase = 'cancel'; putAttempted = true; await request('PUT', '/preapproval/' + id, { accessToken: access.accessToken, data: { status: 'cancelled' } });
            phase = 'validate'; outcome = await inspect(access, stored, id, value => { phase = value; });
            if (outcome.provider.status !== 'cancelled') outcome = { ...outcome, state: 'review', issue: 'unavailable' };
          }
        }
      } catch (error) {
        outcome = await failureOutcome(db, row, stored, error, phase);
        if (cancelling && !putAttempted && outcome.pendingCleanup) {
          try {
            const id = outcome.provider.id;
            access = await credential(scope, stored, () => { phase = 'identity'; });
            phase = 'validate';
            const fresh = validate(await request('GET', '/preapproval/' + id, { accessToken: access.accessToken }), stored, id);
            if (fresh.status !== 'pending') outcome = { ...outcome, provider: fresh, state: 'review', issue: fresh.status === 'cancelled' ? 'invoice_unavailable' : 'unexpected_status', url: null, pendingCleanup: false };
            else {
              await authorize(user); requireBinding(false, scope);
              const latest = await owned(db, row.id, scope);
              if (Number(latest.revision) !== Number(row.revision) || Number(latest.lease_until) !== Number(row.lease_until) || Number(latest.lease_until) <= now() || latest.snapshot_json !== row.snapshot_json || latest.provider_id !== id || await knownActivity(db, latest)) throw failure(409, 'A conferência deste diagnóstico foi alterada.');
              requireBinding(false, scope); phase = 'cancel'; putAttempted = true;
              await request('PUT', '/preapproval/' + id, { accessToken: access.accessToken, data: { status: 'cancelled' } });
              try { outcome = await inspect(access, stored, id, value => { phase = value; }); }
              catch (verificationError) { outcome = await failureOutcome(db, row, stored, verificationError, phase); }
            }
          } catch (cleanupError) { outcome = await failureOutcome(db, row, stored, cleanupError, phase); }
        }
        if (cancelling && putAttempted && outcome.provider?.status !== 'cancelled') outcome = { ...outcome, state: 'review', issue: 'unavailable', url: null };
      }
      await save(db, user, row, scope, outcome); return { ...await view(user), selectedId: row.id };
    });
  }
  return { view, start, paymentStatus, refresh: (user, input) => action(user, input, false), cancel: (user, input) => action(user, input, true) };
}
