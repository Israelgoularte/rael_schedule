import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { readSettings } from './database.mjs';
import { digest, failure, rateLimit, normalizeEmail, isEmail } from './security.mjs';
import { paymentEnvironmentMatches, createMercadoPagoClient, checkoutUrl, cents, verifyNotification } from './mercadopago-client.mjs';
import { recordProviderMoney } from './finance.mjs';
import { notifySubscription } from './notification-events.mjs';
import { platformCollectorIds } from './platform-billing.mjs';
import { selfTestBindingFor, selfTestFor } from './payment-self-test.mjs';

const uuid = v => typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v);
const providerId = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
const numeric = v => /^\d{1,32}$/.test(String(v ?? ''));
const ref = id => `rael_sub_${id}`;
const only = (v, keys) => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) throw failure(422, 'Confira os dados enviados.'); };
function paymentEmail(value) {
  if (typeof value !== 'string' || !isEmail(normalizeEmail(value)) || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) throw failure(422, 'Informe um e-mail válido para o pagamento, com até 254 caracteres.');
  return normalizeEmail(value);
}
const billingMethod = s => s.billingMethod ?? 'mercadopago';
const manual = row => row.mode === 'manual';
const businessScope = row => JSON.parse(row.snapshot_json).scope === 'business';
const exposedProfessionalId = row => businessScope(row) ? null : row.professional_id;
const creationIssues = ['not_found', 'ambiguous', 'mismatch', 'unavailable'];
const providerIssues = ['provider_rejected', 'not_authorized', 'amount_rejected', 'invalid_request', 'rate_limited', 'provider_unavailable', 'connection_failed', 'invalid_response'];
const creationMismatches = ['id', 'collector', 'reference', 'amount', 'currency', 'frequency', 'status', 'modified', 'url_invalid', 'binding'];
const providerDiagnosticCategories = ['parameter', 'payer', 'oauth', 'authorization', 'environment', 'unknown'];
const providerDiagnosticParams = ['preapproval_id', 'payment_id', 'collector_id', 'application_id', 'offset', 'limit', 'sort', 'criteria', 'payer_email', 'notification_url', 'back_url', 'external_reference', 'auto_recurring', 'frequency', 'frequency_type', 'currency_id', 'transaction_amount', 'status', 'reason', 'card_token_id', 'preapproval_plan_id', 'idempotency_key', 'unknown'];
function providerFailureMetadata(error) {
  const result = {}, data = (object, key) => object && typeof object === 'object' ? Object.getOwnPropertyDescriptor(object, key)?.value : undefined;
  const requestId = data(error, 'providerRequestId');
  if (typeof requestId === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(requestId)) result.providerRequestId = requestId;
  const source = data(error, 'providerDiagnostic');
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    const diagnostic = {}, category = data(source, 'category'), param = data(source, 'param');
    if (providerDiagnosticCategories.includes(category)) diagnostic.category = category;
    if (providerDiagnosticParams.includes(param)) diagnostic.param = param;
    for (const key of ['jsonValid', 'hasError', 'hasMessage', 'hasCause']) { const value = data(source, key); if (typeof value === 'boolean') diagnostic[key] = value; }
    if (Object.keys(diagnostic).length) result.providerDiagnostic = diagnostic;
  }
  return result;
}
// Older plans retain their original JSON. Normalize only when reading so their
// accepted service and quota remain exactly the same as before multi-service plans.
const planServices = snapshot => snapshot.services ?? [{ serviceId: snapshot.serviceId, serviceName: snapshot.serviceName, units: snapshot.units }];
function normalizedSnapshot(snapshot) { const services = planServices(snapshot); return { ...snapshot, services, units: services.reduce((total, service) => total + service.units, 0) }; }
function checkoutReason(name) {
  const text = typeof name === 'string' ? name.normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Cs}]+/gu, ' ').replace(/\s+/gu, ' ').trim() : '';
  // Keep the hosted-checkout title concise. This is our conservative byte
  // budget, not a claimed provider limit; accepted plan terms remain intact.
  let result = '', size = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (size + bytes > 60) break;
    result += character; size += bytes;
  }
  return result.trimEnd() || 'Plano mensal';
}
function externalLink(value) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20]/.test(value)) throw failure(422, 'Informe um link externo HTTPS válido.');
  let url; try { url = new URL(value); } catch { throw failure(422, 'Informe um link externo HTTPS válido.'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  // This is a client-side destination only: the server never fetches this URL.
  // Do not accept local/private destinations or credentials embedded in a link.
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || !host.includes('.') || host.includes(':') || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || /^(localhost|0\.0\.0\.0|127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || /^(0|224|225|226|227|228|229|23\d|24\d|25\d)\./.test(host)) throw failure(422, 'Use um link externo HTTPS público, sem usuário ou senha.');
  return url.href;
}

// Provider consent and a paid invoice are deliberately separate. Neither a return
// URL nor an authorized preapproval creates a service entitlement.
export function createSubscriptions(db, slug, config, payments, license) {
  const mp = config.payments ?? {}, now = config.now ?? (() => Date.now());
  const request = createMercadoPagoClient(mp, config.mpTransport);
  function configured() { if (!payments.configured()) throw failure(503, 'O recebimento online deste negócio ainda não foi configurado.'); }
  function professional(user) { if (!['admin', 'professional'].includes(user.role) || !user.professional_id) throw failure(403, 'Cada profissional gerencia os próprios planos.'); }
  const selfTestFields = ['tenant', 'clientId', 'collectorId', 'customerId', 'planId', 'expiresAt'];
  const reservedCollector = value => platformCollectorIds(config).includes(String(value ?? ''));
  const hasSelfTest = row => Object.hasOwn(JSON.parse(row.snapshot_json), 'selfTest');
  function selfTestRowBinding(row, active = false) {
    const s = JSON.parse(row.snapshot_json), stored = s.selfTest, binding = active ? selfTestFor(config, slug, now()) : selfTestBindingFor(config, slug);
    if (!binding || !stored || typeof stored !== 'object' || Array.isArray(stored) || Reflect.ownKeys(stored).length !== selfTestFields.length || !selfTestFields.every(field => stored[field] === binding[field])) return null;
    return row.mode === 'live' && mp.mode === 'live' && config.testMode === false && mp.clientId === binding.clientId && row.professional_id === 'business' && s.scope === 'business' && billingMethod(s) === 'mercadopago' && s.priceCents === 500 && row.plan_id === binding.planId && row.customer_id === binding.customerId && String(row.collector_id) === binding.collectorId ? binding : null;
  }
  function selfTestOfferBinding(plan, s, customer, connection) {
    const binding = selfTestFor(config, slug, now());
    return binding && config.testMode === false && mp.mode === 'live' && mp.clientId === binding.clientId && customer?.id === binding.customerId && plan.id === binding.planId && !plan.active && plan.professional_id === 'business' && s.scope === 'business' && billingMethod(s) === 'mercadopago' && s.priceCents === 500 && connection?.ready && connection.receivingMode === 'business' && String(connection.collectorId) === binding.collectorId ? binding : null;
  }
  function requireSelfTestRow(row, active = false) {
    const binding = selfTestRowBinding(row, active);
    if (!binding) throw failure(409, active ? 'A preparação deste teste interno não está liberada ou expirou.' : 'O vínculo deste teste interno precisa de conferência.');
    return binding;
  }
  async function selfTestCheckoutReady(tx, row, customer) {
    const binding = selfTestRowBinding(row, true);
    if (!binding || customer?.id !== binding.customerId) return false;
    const [plan] = await tx.query('SELECT * FROM subscription_plans WHERE id = ?', [binding.planId]);
    if (!plan) return false;
    const connection = await subscriptionConnection(tx, plan.professional_id);
    return Boolean(selfTestOfferBinding(plan, JSON.parse(plan.snapshot_json), customer, connection) && connection.id === row.connection_id && checkoutRevision(plan, connection) === JSON.parse(row.snapshot_json).offerRevision);
  }
  async function rowAccess(row) {
    if (hasSelfTest(row) || reservedCollector(row.collector_id)) { requireSelfTestRow(row); return payments.access(row.connection_id, { selfTestCleanup: true }); }
    return payments.access(row.connection_id);
  }
  async function connectionAccess(connectionId) {
    const binding = selfTestBindingFor(config, slug);
    if (binding) {
      const rows = await db.query('SELECT * FROM subscriptions WHERE connection_id = ? AND customer_id = ? AND plan_id = ? LIMIT 2', [connectionId, binding.customerId, binding.planId]);
      if (rows.length === 1 && selfTestRowBinding(rows[0])) return rowAccess(rows[0]);
      if (rows.some(row => hasSelfTest(row) || reservedCollector(row.collector_id))) throw failure(409, 'O vínculo deste teste interno precisa de conferência.');
    }
    const [connection] = await db.query('SELECT collector_id FROM mp_connections WHERE id = ?', [connectionId]);
    if (reservedCollector(connection?.collector_id)) throw failure(409, 'O vínculo deste teste interno precisa de conferência.');
    return payments.access(connectionId);
  }
  async function checkSelfTestStart(row, customer, credential, creating = true) {
    const binding = requireSelfTestRow(row, true);
    if (customer.id !== binding.customerId) throw failure(403, 'Este teste interno não pertence a este acesso.');
    await db.transaction(async tx => {
      const settings = await readSettings(tx, true), [current] = await tx.query('SELECT * FROM subscriptions WHERE id = ?', [row.id]);
      if (!current || current.snapshot_json !== row.snapshot_json || current.payer_email !== row.payer_email || current.connection_id !== row.connection_id || current.state !== 'pending' || current.resolution || creating && (current.provider_id || Number(current.lease_until) !== Number(row.lease_until) || Number(current.lease_until) <= now()) || !creating && current.provider_id !== row.provider_id) throw failure(409, 'A preparação deste teste foi alterada. Confira a situação.');
      requireSelfTestRow(current, true);
      const policy = await renewalState(tx, current.customer_id, current.plan_id);
      if (!policy.renewalAllowed || policy.providerPending) throw failure(409, 'A preparação deste teste foi bloqueada. Confira a situação.');
      const [plan] = await tx.query('SELECT * FROM subscription_plans WHERE id = ?', [binding.planId]), connection = plan ? await subscriptionConnection(tx, plan.professional_id) : null;
      if (!plan || !selfTestOfferBinding(plan, JSON.parse(plan.snapshot_json), customer, connection) || !planAvailable(settings, plan, planServices(JSON.parse(plan.snapshot_json))) || checkoutRevision(plan, connection) !== JSON.parse(current.snapshot_json).offerRevision || connection.id !== current.connection_id) throw failure(409, 'As condições ou o recebedor deste teste foram alterados.');
      if (credential) {
        const [latest] = await tx.query('SELECT revision, status FROM mp_connections WHERE id = ?', [current.connection_id]);
        if (credential.id !== current.connection_id || credential.professional_id !== 'business' || String(credential.collector_id) !== binding.collectorId || credential.mode !== 'live' || !latest || latest.status !== 'connected' || Number(latest.revision) !== Number(credential.revision)) throw failure(409, 'A conexão deste teste foi atualizada. Confira a situação.');
      }
    });
  }
  async function audit(tx, actor, name, detail) {
    const id = randomUUID();
    await tx.query('INSERT INTO audit_events(id, actor_id, event_name, detail_json, created_at) VALUES (?, ?, ?, ?, ?)', [id, actor, name, JSON.stringify(detail), now()]);
    return id;
  }
  const planRevision = row => digest(JSON.stringify([row.id, row.professional_id, Boolean(row.active), row.snapshot_json]));
  const checkoutRevision = (row, connection) => connection?.receivingMode
    ? digest(JSON.stringify([planRevision(row), connection.receivingRevision ?? 0, connection.receivingMode, connection.id ?? null, connection.collectorId ?? null]))
    : planRevision(row);
  async function subscriptionConnection(tx, professionalId) {
    if (payments.subscriptionConnectionFor) return payments.subscriptionConnectionFor(tx, professionalId ?? null);
    return { ...(payments.configured() ? await payments.connectionFor(tx, professionalId ?? null) : { ready: false }), receivingMode: 'professional' };
  }
  function acceptedPlanRevision(row, termsOnly = false) {
    const { receiverName, receiverId, receivingMode, offerRevision, selfTest, ...accepted } = JSON.parse(row.snapshot_json);
    // Before revision-aware offers, agreements copied the active offer verbatim
    // and appended only receiver fields. Reconstruct that accepted revision.
    return !termsOnly && offerRevision ? offerRevision : planRevision({ id: row.plan_id, professional_id: row.professional_id, active: 1, snapshot_json: JSON.stringify(accepted) });
  }
  const canManagePlan = (row, user) => Boolean(user && (businessScope(row) ? user.role === 'admin' : ['admin', 'professional'].includes(user.role) && user.professional_id === row.professional_id));
  const canCreatePlan = user => Boolean(user && ['admin', 'professional'].includes(user.role) && user.professional_id);
  function planView(row, user) { const s = normalizedSnapshot(JSON.parse(row.snapshot_json)), canManage = canManagePlan(row, user); return { id: row.id, professionalId: exposedProfessionalId(row), scope: s.scope ?? 'professional', active: Boolean(row.active), ...s, billingMethod: billingMethod(s), revision: planRevision(row), canEdit: canManage, canManage, canToggle: canManage }; }
  function publishedServices(settings, professionalId, services) { return services.every(item => settings.published?.services.some(service => service.id === item.serviceId && service.online && service.professionalIds.includes(professionalId))); }
  function businessServices(settings, services) {
    return services.every(item => settings.published?.services.some(service => service.id === item.serviceId && service.online && service.professionalIds.some(id => settings.published.professionals.some(pro => pro.id === id) && settings.draft.professionals.some(pro => pro.id === id && pro.active))));
  }
  function planAvailable(settings, row, services) { return businessScope(row) ? businessServices(settings, services) : publishedServices(settings, row.professional_id, services) && settings.draft.professionals.some(pro => pro.id === row.professional_id && pro.active) && settings.published?.professionals.some(pro => pro.id === row.professional_id); }
  async function serviceUsage(tx, cycleId, serviceId) {
    const [usage] = await tx.query('SELECT COUNT(*) AS total FROM subscription_usage u JOIN appointments a ON a.id = u.appointment_id WHERE u.cycle_id = ? AND u.released = 0 AND a.service_id = ?', [cycleId, serviceId]);
    return Number(usage.total);
  }
  async function plans(user, customer) {
    const settings = await readSettings(db), rows = await db.query('SELECT * FROM subscription_plans ORDER BY created_at DESC LIMIT 201');
    const controls = customer ? await db.query('SELECT plan_id, allowed, revision FROM subscription_controls WHERE customer_id = ?', [customer.id]) : [];
    const pending = customer ? await db.query("SELECT s.plan_id, MAX(CASE WHEN j.last_error <> '' THEN 1 ELSE 0 END) AS failed FROM subscription_renewal_jobs j JOIN subscriptions s ON s.id = j.subscription_id WHERE s.customer_id = ? AND j.state = 'pending' GROUP BY s.plan_id", [customer.id]) : [];
    const receiving = await subscriptionConnection(db, user?.professional_id);
    const visible = [], licenseAvailable = !license || (await license.state()).canBook;
    for (const row of rows) {
      const binding = selfTestBindingFor(config, slug), testPlan = binding?.planId === row.id;
      if (user ? user.role === 'professional' && user.professional_id !== row.professional_id : !row.active && !testPlan) continue;
      const p = planView(row, user), servicesAvailable = planAvailable(settings, row, p.services);
      const c = p.billingMethod === 'manual' ? { ready: true } : await subscriptionConnection(db, row.professional_id);
      const testOffer = selfTestOfferBinding(row, p, customer, c);
      if (!user && (testPlan || reservedCollector(c.collectorId)) && !testOffer) continue;
      if (!user && !servicesAvailable) continue;
      const control = controls.find(control => control.plan_id === row.id), job = pending.find(job => job.plan_id === row.id);
      const offeredRevision = checkoutRevision(row, c);
      visible.push({ ...p, revision: user ? p.revision : offeredRevision, checkoutRevision: offeredRevision, receivingMode: p.billingMethod === 'manual' ? null : c.receivingMode, ...(customer ? { renewalAllowed: control ? Boolean(control.allowed) : true, renewalBlocked: control ? !control.allowed : false, renewalRevision: control ? Number(control.revision) : 0, providerPending: Boolean(job), providerError: Boolean(job?.failed) } : {}), available: Boolean((testOffer || row.active && !reservedCollector(c.collectorId)) && servicesAvailable && c.ready && (!businessScope(row) || p.billingMethod === 'manual' || c.receivingMode === 'business') && licenseAvailable), receiver: p.billingMethod !== 'manual' && c.ready ? { id: c.collectorId, name: c.name } : null });
    }
    return { plans: visible, truncated: rows.length > 200, receivingMode: receiving.receivingMode, businessMode: receiving.receivingMode === 'business', ...(user ? { canCreate: canCreatePlan(user), canCreateBusiness: user.role === 'admin' && receiving.receivingMode === 'business' } : {}) };
  }
  function offerInput(input) {
    only(input, ['name', 'serviceId', 'services', 'priceCents', 'units', 'active', 'billingMethod', 'paymentInstructions', 'externalPaymentUrl', 'scope']);
    const scope = input.scope ?? 'professional';
    if (!['professional', 'business'].includes(scope)) throw failure(422, 'Escolha um plano do negócio ou de um profissional.');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const method = input.billingMethod ?? 'mercadopago', instructions = input.paymentInstructions ?? '';
    if (!['mercadopago', 'manual'].includes(method) || typeof instructions !== 'string' || instructions.trim().length > 500 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(instructions)) throw failure(422, 'Escolha a forma de recebimento e use instruções de até 500 caracteres.');
    const link = externalLink(input.externalPaymentUrl);
    if (method !== 'manual' && (instructions.trim() || link)) throw failure(422, 'Instruções e link externo são usados no recebimento manual.');
    const hasServices = Object.hasOwn(input, 'services');
    if (hasServices && (Object.hasOwn(input, 'serviceId') || Object.hasOwn(input, 'units'))) throw failure(422, 'Informe os serviços e as quantidades em uma única lista.');
    const included = hasServices ? input.services : [{ serviceId: input.serviceId, units: input.units }];
    if (!Array.isArray(included) || included.length < 1 || included.length > 100) throw failure(422, 'Escolha de 1 a 100 serviços para o plano.');
    for (const item of included) {
      only(item, ['serviceId', 'units']);
      if (!uuid(item.serviceId) || !Number.isInteger(item.units) || item.units < 1 || item.units > 100) throw failure(422, 'Escolha um serviço e de 1 a 100 atendimentos mensais para cada um.');
    }
    if (new Set(included.map(item => item.serviceId)).size !== included.length) throw failure(422, 'Cada serviço deve aparecer uma única vez no plano.');
    if (name.length < 3 || name.length > 100 || /[\x00-\x1f]/.test(name) || !Number.isSafeInteger(input.priceCents) || input.priceCents < 1 || input.priceCents > 100000000 || typeof input.active !== 'boolean') throw failure(422, 'Informe nome, serviços, valor a partir de R$ 0,01 e as quantidades mensais.');
    return { name, method, scope, instructions: instructions.trim(), link, included, priceCents: input.priceCents, active: input.active };
  }
  function offerSnapshot(settings, user, offer) {
    const central = offer.scope === 'business', pro = settings.published?.professionals.find(p => p.id === user.professional_id);
    if (central ? !businessServices(settings, offer.included) : !pro || !publishedServices(settings, user.professional_id, offer.included) || !settings.draft.professionals.some(p => p.id === pro.id && p.active)) throw failure(409, 'Publique primeiro os serviços incluídos e os profissionais habilitados na configuração.');
    const services = offer.included.map(item => ({ serviceId: item.serviceId, serviceName: settings.published.services.find(service => service.id === item.serviceId).name, units: item.units }));
    return { name: offer.name, services, ...(services.length === 1 ? { serviceId: services[0].serviceId, serviceName: services[0].serviceName } : {}), ...(central ? { scope: 'business', businessName: settings.published.business.name } : {}), professionalName: central ? settings.published.business.name : pro.name, priceCents: offer.priceCents, units: services.reduce((total, item) => total + item.units, 0), frequency: 1, frequencyType: 'months', timeZone: settings.published.business.timeZone, billingMethod: offer.method, ...(offer.method === 'manual' ? { paymentInstructions: offer.instructions, externalPaymentUrl: offer.link } : {}) };
  }
  async function createPlan(user, input) {
    manualManager(user);
    const offer = offerInput(input);
    if (offer.scope === 'business') { if (user?.role !== 'admin') throw failure(403, 'Somente o gestor cria planos do negócio.'); } else professional(user);
    return db.transaction(async tx => {
      const settings = await readSettings(tx, true), snapshot = offerSnapshot(settings, user, offer);
      if (offer.scope === 'business' && (await subscriptionConnection(tx, user.professional_id)).receivingMode !== 'business') throw failure(409, 'Ative o recebimento de assinaturas pelo negócio antes de criar um plano central.');
      const [count] = await tx.query('SELECT COUNT(*) AS total FROM subscription_plans');
      if (Number(count.total) >= 200) throw failure(409, 'O limite de planos desta versão foi atingido.');
      const id = randomUUID(), row = { id, professional_id: offer.scope === 'business' ? 'business' : user.professional_id, active: Number(offer.active), snapshot_json: JSON.stringify(snapshot) };
      await tx.query('INSERT INTO subscription_plans(id, professional_id, active, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?)', [id, row.professional_id, row.active, row.snapshot_json, now()]);
      await audit(tx, user.id, 'subscription_plan_created', { id, priceCents: offer.priceCents, units: snapshot.units, services: offer.included, billingMethod: offer.method }); return { id, revision: planRevision(row) };
    });
  }
  async function updatePlan(user, input) {
    manualManager(user);
    only(input, ['planId', 'expectedRevision', 'name', 'serviceId', 'services', 'priceCents', 'units', 'active', 'billingMethod', 'paymentInstructions', 'externalPaymentUrl', 'scope']);
    const { planId, expectedRevision, ...fields } = input;
    if (!uuid(planId) || typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) throw failure(422, 'Abra novamente o plano antes de editar.');
    return db.transaction(async tx => {
      const settings = await readSettings(tx, true), [row] = await tx.query('SELECT * FROM subscription_plans WHERE id = ?', [planId]);
      if (!row || !canManagePlan(row, user)) throw failure(404, 'Plano não encontrado no seu acesso.');
      if (planRevision(row) !== expectedRevision) throw failure(409, 'Este plano foi alterado em outro acesso. Atualize a página antes de salvar.');
      const old = JSON.parse(row.snapshot_json), scope = old.scope ?? 'professional';
      const offer = offerInput({ ...fields, scope: fields.scope ?? scope });
      if (offer.scope !== scope) throw failure(409, 'Crie outro plano para mudar entre o negócio e um profissional. Os contratos existentes mantêm sua cobertura.');
      const snapshot = { ...offerSnapshot(settings, user, offer), offerVersion: (old.offerVersion ?? 1) + 1 };
      // Every existing agreement has its own accepted snapshot and its own
      // provider preapproval. Only future adhesions read this edited offer.
      const updated = { ...row, active: Number(offer.active), snapshot_json: JSON.stringify(snapshot) };
      await tx.query('UPDATE subscription_plans SET active = ?, snapshot_json = ? WHERE id = ?', [updated.active, updated.snapshot_json, row.id]);
      await audit(tx, user.id, 'subscription_plan_updated', { id: row.id, previousRevision: expectedRevision, revision: planRevision(updated), offerVersion: snapshot.offerVersion, priceCents: offer.priceCents, services: offer.included, billingMethod: offer.method });
      return { ok: true, id: row.id, revision: planRevision(updated) };
    });
  }
  async function archive(user, input) {
    manualManager(user); only(input, ['planId', 'active', 'expectedRevision']);
    if (!uuid(input.planId) || typeof input.active !== 'boolean' || input.expectedRevision !== undefined && (typeof input.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedRevision))) throw failure(422, 'Plano inválido.');
    return db.transaction(async tx => { await readSettings(tx, true); const [p] = await tx.query('SELECT * FROM subscription_plans WHERE id = ?', [input.planId]); if (!p || !canManagePlan(p, user)) throw failure(404, 'Plano não encontrado no seu acesso.'); if (input.expectedRevision !== undefined && input.expectedRevision !== planRevision(p)) throw failure(409, 'Este plano foi alterado em outro acesso. Atualize a página antes de continuar.'); if (Boolean(p.active) !== input.active) { await tx.query('UPDATE subscription_plans SET active = ? WHERE id = ?', [Number(input.active), p.id]); await audit(tx, user.id, 'subscription_plan_visibility', { id: p.id, active: input.active }); } return { ok: true, revision: planRevision({ ...p, active: Number(input.active) }) }; });
  }
  function authorize(actor, row) { if (actor.customer ? row.customer_id !== actor.customer.id : !actor.staff || !['admin', 'professional'].includes(actor.staff.role) || actor.staff.role !== 'admin' && row.professional_id !== actor.staff.professional_id) throw failure(404, 'Assinatura não encontrada no seu acesso.'); }
  async function owned(tx, id, actor) { if (!uuid(id)) throw failure(422, 'Assinatura inválida.'); const [row] = await tx.query('SELECT * FROM subscriptions WHERE id = ?', [id]); if (!row) throw failure(404, 'Assinatura não encontrada.'); authorize(actor, row); return row; }
  // A local withdrawal never asserts that an unknown remote agreement was
  // cancelled. Keep its immutable identity and recover it in a separate queue.
  const withdrawalSourceHash = row => digest(JSON.stringify([row.id, row.customer_id, row.plan_id, row.professional_id, row.connection_id, row.collector_id, row.mode, row.request_key, row.snapshot_json, row.created_at, mp.clientId, ...(row.payer_email == null ? [] : ['payer_email', row.payer_email])]));
  const withdrawalRevision = row => digest(JSON.stringify([withdrawalSourceHash(row), row.state, row.create_state, row.resolution, row.provider_id, row.checkout_url, Number(row.lease_until), Number(row.provider_updated_at)]));
  const withdrawalBinding = (row, item) => Boolean(item && item.subscription_id === row.id && item.customer_id === row.customer_id && item.plan_id === row.plan_id && item.withdrawn_by === row.customer_id && item.source_hash === withdrawalSourceHash(row));
  async function withdrawalFor(tx, id) { return (await tx.query('SELECT * FROM subscription_creation_withdrawals WHERE subscription_id = ?', [id]))[0]; }
  async function creationActivity(tx, row) {
    for (const table of ['subscription_cycles', 'subscription_usage', 'financial_entries']) {
      const [entry] = await tx.query(`SELECT 1 AS found FROM ${table} WHERE subscription_id = ? LIMIT 1`, [row.id]);
      if (entry) return true;
    }
    return false;
  }
  async function nativeCreationRefusal(tx, row) {
    const events = await tx.query('SELECT detail_json FROM audit_events WHERE actor_id = ? AND event_name = ? AND detail_json LIKE ? ORDER BY created_at DESC LIMIT 101', [row.customer_id, 'subscription_creation_failed', '%' + row.id + '%']);
    if (events.length > 100) return false;
    return events.some(event => { try { const detail = JSON.parse(event.detail_json); return detail.id === row.id && detail.phase === 'create' && detail.status === 400; } catch { return false; } });
  }
  async function withdrawable(tx, row, actor, at = now()) {
    if (!actor.customer || actor.customer.id !== row.customer_id || manual(row) || hasSelfTest(row) || reservedCollector(row.collector_id) || row.state !== 'pending' || row.provider_id || row.checkout_url || row.resolution || Number(row.lease_until) > at || !payments.configured()) return false;
    if ((await tx.query('SELECT subscription_id FROM subscription_creation_withdrawals WHERE subscription_id = ? OR successor_id = ? LIMIT 1', [row.id, row.id])).length) return false;
    return !await creationActivity(tx, row) && await nativeCreationRefusal(tx, row);
  }
  async function successorClear(tx, row) {
    const [item] = await tx.query('SELECT * FROM subscription_creation_withdrawals WHERE successor_id = ?', [row.id]);
    if (!item) return true;
    const [source] = await tx.query('SELECT * FROM subscriptions WHERE id = ?', [item.subscription_id]);
    return Boolean(source && withdrawalBinding(source, item) && ['not_found', 'cancelled'].includes(item.check_state) && source.resolution === 'withdrawn_creation' && !await creationActivity(tx, source) && (item.check_state === 'not_found' ? !source.provider_id && source.state === 'pending' : source.provider_id && source.state === 'cancelled'));
  }
  async function assertSuccessorClear(tx, row) { if (!await successorClear(tx, row)) throw failure(409, 'A solicitação anterior precisa de conferência antes de continuar com este plano.'); }
  async function holdWithdrawnSource(tx, row, item, issue) {
    await tx.query('UPDATE subscription_creation_withdrawals SET check_state = ?, last_issue = ?, next_check_at = ?, updated_at = ? WHERE subscription_id = ?', ['review', issue, now() + 300000, now(), row.id]);
    if (item?.successor_id) await tx.query('UPDATE subscriptions SET resolution = ?, checkout_url = NULL, updated_at = ? WHERE id = ? AND customer_id = ?', ['withdrawn_source_review', now(), item.successor_id, row.customer_id]);
  }
  async function renewalState(tx, customerId, planId) {
    const [control] = await tx.query('SELECT * FROM subscription_controls WHERE customer_id = ? AND plan_id = ?', [customerId, planId]);
    const jobs = await tx.query("SELECT j.last_error FROM subscription_renewal_jobs j JOIN subscriptions s ON s.id = j.subscription_id WHERE s.customer_id = ? AND s.plan_id = ? AND j.state = 'pending'", [customerId, planId]);
    return { control, renewalAllowed: control ? Boolean(control.allowed) : true, renewalBlocked: control ? !control.allowed : false, renewalRevision: control ? Number(control.revision) : 0, providerPending: jobs.length > 0, providerError: jobs.some(job => Boolean(job.last_error)) };
  }
  async function assertRenewal(tx, customerId, planId) {
    const policy = await renewalState(tx, customerId, planId);
    if (!policy.renewalAllowed) throw failure(409, 'A renovação deste plano foi bloqueada pelo prestador. Fale com o negócio para continuar.');
    if (policy.providerPending) throw failure(409, 'O cancelamento anterior ainda está sendo confirmado no Mercado Pago. Aguarde antes de contratar ou renovar.');
    return policy;
  }
  async function canManageAutomatic(tx, row, user) {
    if (manual(row) || !row.connection_id || !user || !['admin', 'professional'].includes(user.role)) return false;
    const receivingMode = JSON.parse(row.snapshot_json).receivingMode ?? 'professional';
    if (payments.subscriptionManagedBy) return payments.subscriptionManagedBy(tx, row.connection_id, user, receivingMode);
    // Legacy adapters still verify the persisted receiver, rather than granting
    // financial authority solely because the professional delivers the service.
    const [connection] = await tx.query('SELECT professional_id FROM mp_connections WHERE id = ?', [row.connection_id]);
    return receivingMode === 'professional' && Boolean(connection && user.professional_id === connection.professional_id);
  }
  async function canManageRenewal(tx, row, user) {
    if (!user || !['admin', 'professional'].includes(user.role) || user.role !== 'admin' && user.professional_id !== row.professional_id) return false;
    if (!manual(row) && !await canManageAutomatic(tx, row, user)) return false;
    // A policy applies to the customer and plan, including other live contracts.
    // Selecting historical or manual membership must not bypass their receiver.
    const automatic = await tx.query("SELECT * FROM subscriptions WHERE customer_id = ? AND plan_id = ? AND mode <> 'manual' AND state <> 'cancelled'", [row.customer_id, row.plan_id]);
    for (const agreement of automatic) if (!await canManageAutomatic(tx, agreement, user)) return false;
    return true;
  }
  async function view(tx, row, actor = {}, at = now()) {
    const cycles = await tx.query('SELECT * FROM subscription_cycles WHERE subscription_id = ? AND valid = 1 ORDER BY starts_at DESC LIMIT 24', [row.id]);
    // A long history (or many scheduled future invoices) must not hide the paid
    // period used by the exact management counts below.
    const cycle = cycles.find(c => Number(c.starts_at) <= at && Number(c.ends_at) > at) ?? (await tx.query('SELECT * FROM subscription_cycles WHERE subscription_id = ? AND valid = 1 AND starts_at <= ? AND ends_at > ? ORDER BY starts_at DESC LIMIT 1', [row.id, at, at]))[0];
    const usage = cycle ? await tx.query('SELECT a.service_id, COUNT(*) AS total FROM subscription_usage u JOIN appointments a ON a.id = u.appointment_id WHERE u.cycle_id = ? AND u.released = 0 GROUP BY a.service_id', [cycle.id]) : [];
    const s = normalizedSnapshot(JSON.parse(row.snapshot_json)), isManual = manual(row), latest = cycles.find(c => c.valid), next = cycles.find(c => c.valid && Number(c.starts_at) > at);
    const services = s.services.map(item => { const used = Number(usage.find(row => row.service_id === item.serviceId)?.total ?? 0); return { ...item, used, remaining: Math.max(0, item.units - used) }; });
    const { control, ...renewal } = await renewalState(tx, row.customer_id, row.plan_id);
    const internalTest = hasSelfTest(row) || reservedCollector(row.collector_id), testBinding = internalTest ? selfTestRowBinding(row) : null;
    const testCheckout = !internalTest || Boolean(testBinding && await selfTestCheckoutReady(tx, row, actor.customer));
    const { selfTest: privateSelfTest, ...publicSnapshot } = s;
    const automaticManager = await canManageAutomatic(tx, row, actor.staff), ownCustomer = Boolean(actor.customer && actor.customer.id === row.customer_id), manages = isManual || ownCustomer || automaticManager;
    const withdrawal = await withdrawalFor(tx, row.id), withdrawn = Boolean(withdrawal), successorReady = await successorClear(tx, row);
    const canWithdrawCreation = !withdrawn && await withdrawable(tx, row, actor, at);
    const checking = !isManual && !withdrawn && row.state === 'pending' && !row.provider_id;
    const creation = isManual ? null : { status: row.provider_id ? 'ready' : Number(row.lease_until) > at ? 'preparing' : 'unconfirmed', issue: !row.provider_id && creationIssues.includes(row.create_state) ? row.create_state : null, supportCode: row.id.replaceAll('-', '').slice(0, 8), ...(withdrawn ? { withdrawn: true } : {}) };
    const canCheckCreation = Boolean(checking && manages && (!internalTest || testBinding) && payments.configured() && Number(row.lease_until) <= at && !row.resolution && renewal.renewalAllowed && !renewal.providerPending);
    let payerEmail;
    if (ownCustomer && !isManual) {
      try { payerEmail = paymentEmail(row.payer_email); } catch { payerEmail = null; }
    }
    return { ...(payerEmail !== undefined ? { payerEmail, payerEmailRecorded: payerEmail !== null } : {}), id: row.id, planId: row.plan_id, professionalId: exposedProfessionalId(row), scope: s.scope ?? 'professional', ...publicSnapshot, creation, canCheckCreation, canWithdrawCreation, withdrawalRevision: canWithdrawCreation ? withdrawalRevision(row) : null, receivingMode: isManual ? null : s.receivingMode ?? 'professional', receiver: !isManual && row.collector_id ? { id: row.collector_id, name: s.receiverName } : null, billingMethod: billingMethod(s), ...renewal, canManageAutomatic: automaticManager, canRefresh: !withdrawn && (isManual || Boolean(payments.configured() && manages && (!internalTest || testBinding))), canManageRenewal: await canManageRenewal(tx, row, actor.staff), renewalNeedsNewConsent: Boolean(!isManual && (row.state === 'cancelled' || renewal.providerPending)), state: row.state, resolution: row.resolution, mode: row.mode, canCheckout: !withdrawn && successorReady && !isManual && ownCustomer && testCheckout && payments.configured() && row.state === 'pending' && Boolean(row.checkout_url) && !row.resolution && renewal.renewalAllowed && !renewal.providerPending, canCancel: !withdrawn && manages && (!internalTest || testBinding) && (isManual || Boolean(row.provider_id)) && row.state !== 'cancelled', canManageManual: Boolean(isManual && actor.staff && row.state !== 'cancelled'), latestCycleEndAt: latest ? Number(latest.ends_at) : null, nextCycle: next ? { startAt: Number(next.starts_at), endAt: Number(next.ends_at) } : null, cycle: cycle ? { startAt: Number(cycle.starts_at), endAt: Number(cycle.ends_at), services, used: services.reduce((total, item) => total + item.used, 0), remaining: services.reduce((total, item) => total + item.remaining, 0) } : null, canUse: Boolean(!withdrawn && successorReady && !internalTest && cycle && !row.resolution && (isManual ? row.state === 'authorized' : ['authorized', 'paused', 'cancelled'].includes(row.state))), createdAt: Number(row.created_at) };
  }
  async function list(actor) {
    const customer = actor.customer, staff = actor.staff;
    if (!customer && !staff || staff && !['admin', 'professional'].includes(staff.role)) throw failure(403, 'Acesso não permitido.');
    const rows = await db.query('SELECT s.*, c.name AS customer_name FROM subscriptions s JOIN customers c ON c.id = s.customer_id' + (customer ? ' WHERE customer_id = ?' : staff.role === 'professional' ? ' WHERE professional_id = ?' : '') + ' ORDER BY created_at DESC LIMIT 101', customer ? [customer.id] : staff.role === 'professional' ? [staff.professional_id] : []);
    return { subscriptions: await Promise.all(rows.slice(0, 100).map(async r => ({ ...await view(db, r, actor), ...(staff ? { customerName: r.customer_name } : {}) }))), truncated: rows.length > 100 };
  }
  function managementStaff(user) { if (!user || !['admin', 'professional'].includes(user.role) || user.role === 'professional' && !uuid(user.professional_id)) throw failure(403, 'Somente o gestor ou profissional responsável pode consultar as assinaturas.'); }
  function managementOptions(input, memberList = false) {
    only(input, memberList ? ['planId', 'search', 'status', 'sort', 'page', 'pageSize'] : ['search', 'professionalId', 'billingMethod', 'visibility', 'sort', 'page', 'pageSize']);
    const search = input.search ?? '', sort = input.sort || (memberList ? 'name_asc' : 'active_desc');
    const sorts = memberList ? ['name_asc', 'name_desc', 'expires_asc', 'newest', 'status'] : ['name_asc', 'name_desc', 'active_desc', 'price_asc', 'price_desc', 'newest'];
    if (typeof search !== 'string' || search.length > 120 || /[\x00-\x1f]/.test(search) || !sorts.includes(sort)) throw failure(422, 'Confira a busca e a ordenação.');
    const page = input.page === undefined ? 1 : Number(input.page), pageSize = input.pageSize === undefined ? memberList ? 20 : 12 : Number(input.pageSize);
    if (input.page !== undefined && !/^[1-9]\d{0,5}$/.test(String(input.page)) || input.pageSize !== undefined && !/^[1-9]\d?$/.test(String(input.pageSize)) || !Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) throw failure(422, 'Escolha uma página válida e de 1 a 50 resultados por página.');
    if (memberList) {
      if (!uuid(input.planId) || !['', 'active', 'pending', 'expired', 'suspended', 'ended', 'review'].includes(input.status ?? '')) throw failure(422, 'Escolha um plano e uma situação válida.');
    } else if ((input.professionalId && !uuid(input.professionalId)) || !['', 'manual', 'mercadopago'].includes(input.billingMethod ?? '') || !['', 'visible', 'hidden'].includes(input.visibility ?? '')) throw failure(422, 'Confira os filtros dos planos.');
    return { ...input, search: search.trim(), sort, page, pageSize };
  }
  // SQL uses only relational columns so exact counts and pagination work on both
  // SQLite and MySQL, without parsing every customer's history in JavaScript.
  const activeSql = `s.resolution = '' AND ((s.mode = 'manual' AND s.state = 'authorized') OR (s.mode <> 'manual' AND s.state IN ('authorized', 'paused', 'cancelled'))) AND EXISTS (SELECT 1 FROM subscription_cycles paid WHERE paid.subscription_id = s.id AND paid.valid = 1 AND paid.starts_at <= ? AND paid.ends_at > ?)`;
  // Keep derived status numeric: a CASE of string literals compared to a bound
  // string can inherit incompatible collations on existing MySQL databases.
  // These codes are internal; HTTP responses retain the named status contract.
  const managementStatuses = ['active', 'pending', 'expired', 'suspended', 'review', 'ended'];
  const managementStatusSql = `CASE WHEN s.resolution <> '' THEN 4 WHEN s.mode = 'manual' AND s.state = 'suspended' THEN 3 WHEN ${activeSql} THEN 0 WHEN s.state = 'cancelled' THEN 5 WHEN EXISTS (SELECT 1 FROM subscription_cycles past WHERE past.subscription_id = s.id AND past.valid = 1 AND past.ends_at <= ?) THEN 2 ELSE 1 END`;
  async function managementCounts(tx, user, at, planId) {
    const conditions = [], parameters = [at, at];
    if (user.role === 'professional') { conditions.push('s.professional_id = ?'); parameters.push(user.professional_id); }
    if (planId) { conditions.push('s.plan_id = ?'); parameters.push(planId); }
    const rows = await tx.query(`SELECT s.plan_id, COUNT(DISTINCT s.customer_id) AS total_customers, COUNT(*) AS total_subscriptions, COUNT(DISTINCT CASE WHEN ${activeSql} THEN s.customer_id ELSE NULL END) AS active_customers FROM subscriptions s${conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''} GROUP BY s.plan_id`, parameters);
    return new Map(rows.map(row => [row.plan_id, { activeCustomers: Number(row.active_customers), totalCustomers: Number(row.total_customers), totalSubscriptions: Number(row.total_subscriptions) }]));
  }
  const emptyCounts = () => ({ activeCustomers: 0, totalCustomers: 0, totalSubscriptions: 0 });
  async function overview(user, input = {}) {
    managementStaff(user); const args = managementOptions(input), at = now();
    if (user.role === 'professional' && args.professionalId && args.professionalId !== user.professional_id) throw failure(404, 'Profissional não encontrado no seu acesso.');
    return db.transaction(async tx => {
      const rows = await tx.query('SELECT * FROM subscription_plans' + (user.role === 'professional' ? ' WHERE professional_id = ?' : ''), user.role === 'professional' ? [user.professional_id] : []);
      const counts = await managementCounts(tx, user, at), settings = await readSettings(tx);
      const professionals = new Map(settings.draft.professionals.filter(pro => user.role === 'admin' || pro.id === user.professional_id).map(pro => [pro.id, { id: pro.id, name: pro.name }]));
      for (const row of rows) if (!businessScope(row) && !professionals.has(row.professional_id)) professionals.set(row.professional_id, { id: row.professional_id, name: JSON.parse(row.snapshot_json).professionalName });
      const search = args.search.toLocaleLowerCase('pt-BR');
      const plans = rows.map(row => ({ ...planView(row, user), ...(counts.get(row.id) ?? emptyCounts()), createdAt: Number(row.created_at) })).filter(plan => (!args.professionalId || plan.professionalId === args.professionalId) && (!args.billingMethod || plan.billingMethod === args.billingMethod) && (!args.visibility || plan.active === (args.visibility === 'visible')) && (!search || [plan.name, professionals.get(plan.professionalId)?.name, ...plan.services.map(service => service.serviceName)].join(' ').toLocaleLowerCase('pt-BR').includes(search)));
      const compareName = (a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' });
      const sorters = { name_asc: compareName, name_desc: (a, b) => compareName(b, a), active_desc: (a, b) => b.activeCustomers - a.activeCustomers || compareName(a, b), price_asc: (a, b) => a.priceCents - b.priceCents || compareName(a, b), price_desc: (a, b) => b.priceCents - a.priceCents || compareName(a, b), newest: (a, b) => b.createdAt - a.createdAt };
      plans.sort((a, b) => sorters[args.sort](a, b) || a.id.localeCompare(b.id));
      const offset = (args.page - 1) * args.pageSize;
      const receiving = await subscriptionConnection(tx, user.professional_id);
      return { plans: plans.slice(offset, offset + args.pageSize), professionals: [...professionals.values()].sort(compareName), canCreate: canCreatePlan(user), canCreateBusiness: user.role === 'admin' && receiving.receivingMode === 'business', receivingMode: receiving.receivingMode, businessMode: receiving.receivingMode === 'business', total: plans.length, page: args.page, pageSize: args.pageSize, hasMore: offset + args.pageSize < plans.length };
    });
  }
  async function planMembers(user, input = {}) {
    managementStaff(user); const args = managementOptions(input, true), at = now();
    return db.transaction(async tx => {
      const [planRow] = await tx.query('SELECT * FROM subscription_plans WHERE id = ?' + (user.role === 'professional' ? ' AND professional_id = ?' : ''), user.role === 'professional' ? [args.planId, user.professional_id] : [args.planId]);
      if (!planRow) throw failure(404, 'Plano não encontrado no seu acesso.');
      const conditions = ['s.plan_id = ?'], parameters = [at, at, at, at, at, args.planId];
      if (user.role === 'professional') { conditions.push('s.professional_id = ?'); parameters.push(user.professional_id); }
      // Match the validity shown on the card: current paid period first, then
      // the latest valid period, including an expired one. No period sorts last.
      const base = `SELECT s.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone, ${managementStatusSql} AS management_status, COALESCE((SELECT paid.ends_at FROM subscription_cycles paid WHERE paid.subscription_id = s.id AND paid.valid = 1 AND paid.starts_at <= ? AND paid.ends_at > ? ORDER BY paid.starts_at DESC LIMIT 1), (SELECT latest.ends_at FROM subscription_cycles latest WHERE latest.subscription_id = s.id AND latest.valid = 1 ORDER BY latest.starts_at DESC LIMIT 1)) AS management_expires_at FROM subscriptions s JOIN customers c ON c.id = s.customer_id WHERE ${conditions.join(' AND ')}`;
      const filters = [], filterValues = [];
      if (args.status) { filters.push('management_status = ?'); filterValues.push(managementStatuses.indexOf(args.status)); }
      if (args.search) {
        filters.push("(LOWER(customer_name) LIKE ? ESCAPE '!' OR LOWER(customer_email) LIKE ? ESCAPE '!' OR customer_phone LIKE ? ESCAPE '!')");
        const search = '%' + args.search.toLowerCase().replace(/[!%_]/g, c => '!' + c) + '%'; filterValues.push(search, search, search);
      }
      const where = filters.length ? ' WHERE ' + filters.join(' AND ') : '', values = [...parameters, ...filterValues];
      const [count] = await tx.query(`SELECT COUNT(*) AS total FROM (${base}) managed${where}`, values);
      const sorts = { name_asc: 'LOWER(customer_name) ASC', name_desc: 'LOWER(customer_name) DESC', expires_asc: 'CASE WHEN management_expires_at IS NULL THEN 1 ELSE 0 END ASC, management_expires_at ASC, LOWER(customer_name) ASC', newest: 'created_at DESC', status: 'management_status ASC, LOWER(customer_name) ASC' };
      const offset = (args.page - 1) * args.pageSize, rows = await tx.query(`SELECT * FROM (${base}) managed${where} ORDER BY ${sorts[args.sort]}, id ASC LIMIT ? OFFSET ?`, [...values, args.pageSize, offset]);
      const counts = await managementCounts(tx, user, at, planRow.id), subscriptions = [];
      for (const row of rows) subscriptions.push({ ...await view(tx, row, { staff: user }, at), customerName: row.customer_name, customerEmail: row.customer_email, managementStatus: managementStatuses[Number(row.management_status)] });
      const total = Number(count.total);
      return { plan: { ...planView(planRow, user), ...(counts.get(planRow.id) ?? emptyCounts()) }, subscriptions, total, page: args.page, pageSize: args.pageSize, hasMore: offset + args.pageSize < total };
    });
  }
  function validateProvider(p, row) {
    const s = JSON.parse(row.snapshot_json), a = p?.auto_recurring;
    let amount; try { amount = cents(a?.transaction_amount); } catch { amount = NaN; }
    const mismatch = !providerId(p?.id) ? 'id' : String(p.collector_id) !== row.collector_id ? 'collector' : p.external_reference !== ref(row.id) ? 'reference' : amount !== s.priceCents ? 'amount' : a?.currency_id !== 'BRL' ? 'currency' : Number(a?.frequency) !== 1 || a?.frequency_type !== 'months' ? 'frequency' : !['pending', 'authorized', 'paused', 'cancelled'].includes(p.status) ? 'status' : !Number.isFinite(Date.parse(p.last_modified ?? '')) ? 'modified' : null;
    if (mismatch) throw Object.assign(failure(409, 'A assinatura retornou condições diferentes. Confira a situação com o negócio.'), { subscriptionMismatch: mismatch });
  }
  function providerCheckout(p, mode, previous = null) {
    // A canonical agreement remains manageable without a usable hosted link.
    // Only a pending agreement can expose a checkout, and never an unsafe URL.
    if (p.status !== 'pending') return null;
    // Some canonical reads omit init_point. Retain only this same pending
    // agreement's previously validated link; an explicit invalid value clears it.
    const value = !Object.hasOwn(p, 'init_point') && previous?.state === 'pending' && previous.provider_id === p.id ? previous.checkout_url : p.init_point;
    try { return checkoutUrl(value, mode); } catch { return null; }
  }
  function validateWithdrawnProvider(p, row) {
    validateProvider(p, row);
    if (p.application_id !== undefined && String(p.application_id) !== String(mp.clientId)) throw failure(409, 'A assinatura retornou outra aplicação.');
  }
  async function findCreation(row, connection, budget) {
    const matches = new Map(), reference = ref(row.id);
    async function read(path, search = false) {
      budget.phase = search ? 'search' : 'candidate';
      configured();
      if (Date.now() > budget.deadline - 8000 || search && ++budget.searches > 4) throw Object.assign(new Error(), { creationIssue: 'unavailable' });
      return request('GET', path, { accessToken: connection.accessToken });
    }
    async function pages(filter) {
      let offset = 0, total = null; const seen = new Set();
      for (;;) {
        const found = await read('/preapproval/search?' + new URLSearchParams({ ...filter, limit: '50', offset: String(offset) }), true), paging = found?.paging, rows = found?.results;
        if (!paging || !Array.isArray(rows) || !Number.isSafeInteger(paging.total) || paging.total < 0 || !Number.isSafeInteger(paging.offset) || paging.offset !== offset || !Number.isSafeInteger(paging.limit) || paging.limit < 1 || paging.limit > 50 || rows.length > paging.limit || offset + rows.length > paging.total || total !== null && paging.total !== total) throw Object.assign(new Error(), { creationIssue: 'unavailable' });
        total = paging.total;
        for (const result of rows) {
          if (!providerId(result?.id) || seen.has(result.id)) throw Object.assign(new Error(), { creationIssue: 'unavailable' });
          seen.add(result.id);
          if (result.external_reference === reference) matches.set(result.id, result);
        }
        if (matches.size > 1) return 'ambiguous';
        if (offset + rows.length === total) return null;
        if (rows.length !== paging.limit) throw Object.assign(new Error(), { creationIssue: 'unavailable' });
        offset += rows.length;
      }
    }
    // Search documents q and payer_email; external_reference is checked locally,
    // never assumed to be a supported provider-side filter.
    let issue = await pages({ q: reference });
    if (!issue && !matches.size) {
      let email = row.payer_email;
      if (email == null) { const [customer] = await db.query('SELECT email FROM customers WHERE id = ?', [row.customer_id]); email = customer?.email; }
      if (typeof email !== 'string' || !email) return { issue: 'unavailable' };
      issue = await pages({ payer_email: email });
    }
    // Neither q nor an email filter is documented as an exhaustive reference
    // lookup. Confirm absence only after completing the same receiver's list.
    if (!issue && !matches.size) issue = await pages({});
    if (issue || !matches.size) return { issue: issue ?? 'not_found' };
    const candidate = [...matches.values()][0], provider = await read('/preapproval/' + candidate.id);
    try {
      validateProvider(provider, row);
      if (provider.id !== candidate.id) return { issue: 'mismatch', mismatch: 'id', phase: 'validate' };
    } catch (error) { return { issue: 'mismatch', mismatch: error.subscriptionMismatch ?? 'id', phase: 'validate' }; }
    return { provider, url: providerCheckout(provider, row.mode), phase: 'validate' };
  }
  async function recoverCreation(row, actorId = null, existingLease = null) {
    configured();
    const claim = await db.transaction(async tx => {
      await readSettings(tx, true); const [current] = await tx.query('SELECT * FROM subscriptions WHERE id = ?', [row.id]);
      if (!current || manual(current) || current.provider_id || current.state !== 'pending') return null;
      if (existingLease === null ? Number(current.lease_until) > now() : Number(current.lease_until) !== existingLease) return null;
      const policy = await renewalState(tx, current.customer_id, current.plan_id);
      if (current.resolution || !policy.renewalAllowed || policy.providerPending) return null;
      configured();
      const lease = now() + 120000;
      await tx.query('UPDATE subscriptions SET lease_until = ?, next_check_at = ? WHERE id = ?', [lease, now() + 120000, current.id]);
      return { row: current, lease };
    });
    if (!claim) return;
    let outcome = { issue: 'unavailable' };
    const budget = { deadline: Date.now() + 24000, searches: 0, phase: 'access' };
    try {
      const connection = await rowAccess(claim.row);
      if (String(connection.collector_id) !== claim.row.collector_id || claim.row.mode !== mp.mode) outcome = { issue: 'mismatch', mismatch: 'collector', phase: 'access' };
      else outcome = await findCreation(claim.row, connection, budget);
    } catch (error) { outcome = { issue: 'unavailable', phase: budget.phase, providerStatus: Number.isInteger(error.providerStatus) && error.providerStatus >= 100 && error.providerStatus <= 599 ? error.providerStatus : null, providerIssue: providerIssues.includes(error.providerIssue) ? error.providerIssue : null, ...providerFailureMetadata(error) }; }
    await db.transaction(async tx => {
      await readSettings(tx, true); const [current] = await tx.query('SELECT * FROM subscriptions WHERE id = ?', [claim.row.id]);
      if (!current || current.provider_id || Number(current.lease_until) !== claim.lease) return;
      const policy = await renewalState(tx, current.customer_id, current.plan_id);
      if (!payments.configured() || current.state !== 'pending' || current.resolution || !policy.renewalAllowed || policy.providerPending) outcome = { issue: 'unavailable', phase: 'guard' };
      if (current.connection_id !== claim.row.connection_id || current.collector_id !== claim.row.collector_id || current.mode !== claim.row.mode || current.snapshot_json !== claim.row.snapshot_json || current.payer_email !== claim.row.payer_email) outcome = { issue: 'mismatch', mismatch: 'binding', phase: 'persist' };
      if (outcome.provider) {
        const [other] = await tx.query('SELECT id FROM subscriptions WHERE provider_id = ? AND id <> ?', [outcome.provider.id, current.id]);
        if (other) outcome = { issue: 'mismatch', mismatch: 'id', phase: 'persist' };
      }
      if (outcome.provider) await tx.query('UPDATE subscriptions SET provider_id = ?, checkout_url = ?, state = ?, create_state = ?, lease_until = 0, provider_updated_at = ?, updated_at = ? WHERE id = ?', [outcome.provider.id, outcome.url, outcome.provider.status, 'ready', Date.parse(outcome.provider.last_modified), now(), current.id]);
      else await tx.query('UPDATE subscriptions SET create_state = ?, lease_until = 0, updated_at = ? WHERE id = ?', [outcome.issue, now(), current.id]);
      const detail = { id: current.id, supportCode: current.id.replaceAll('-', '').slice(0, 8), status: outcome.provider ? 'ready' : 'unconfirmed', issue: outcome.issue ?? null, phase: outcome.phase ?? 'search', mismatch: outcome.mismatch ?? null, providerStatus: outcome.providerStatus ?? null, providerIssue: outcome.providerIssue ?? null, ...providerFailureMetadata(outcome) };
      await audit(tx, actorId, 'subscription_creation_check', detail);
      if (!outcome.provider) console.warn('SUBSCRIPTION_CREATION_CHECK', JSON.stringify({ tenant: slug, ...detail, id: undefined }));
    });
  }
  async function withdraw(actor, input) {
    only(input, ['subscriptionId', 'expectedRevision', 'confirmed']);
    if (!actor?.customer || actor.staff) throw failure(403, 'Entre com o acesso do cliente para encerrar esta solicitação.');
    if (!uuid(input.subscriptionId) || input.confirmed !== true || typeof input.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) throw failure(422, 'Confirme o encerramento local da solicitação e confira a situação atual.');
    await rateLimit(db, `subscription_withdraw:${actor.customer.id}`, 10, 60000);
    const claim = await db.transaction(async tx => {
      await readSettings(tx, true); const current = await owned(tx, input.subscriptionId, actor), previous = await withdrawalFor(tx, current.id);
      if (withdrawalBinding(current, previous)) return { repeated: current };
      if (withdrawalRevision(current) !== input.expectedRevision || !await withdrawable(tx, current, actor)) throw failure(409, 'A solicitação mudou ou ainda não pode ser encerrada localmente. Atualize Meus planos.');
      const lease = now() + 120000;
      await tx.query('UPDATE subscriptions SET lease_until = ? WHERE id = ?', [lease, current.id]);
      return { row: current, lease, sourceHash: withdrawalSourceHash(current) };
    });
    if (claim.repeated) return view(db, claim.repeated, actor);
    let outcome;
    try {
      const c = await rowAccess(claim.row);
      if (String(c.collector_id) !== claim.row.collector_id || claim.row.mode !== mp.mode) outcome = { issue: 'mismatch' };
      else outcome = await findCreation(claim.row, c, { deadline: Date.now() + 24000, searches: 0, phase: 'access' });
    } catch { outcome = { issue: 'unavailable' }; }
    const done = await db.transaction(async tx => {
      await readSettings(tx, true); const current = await owned(tx, claim.row.id, actor);
      if (Number(current.lease_until) !== claim.lease || claim.lease <= now() || withdrawalSourceHash(current) !== claim.sourceHash || current.state !== claim.row.state || current.create_state !== claim.row.create_state || current.resolution || current.provider_id || current.checkout_url || !payments.configured() || !await withdrawable(tx, { ...current, lease_until: 0 }, actor)) {
        if (Number(current.lease_until) === claim.lease) await tx.query('UPDATE subscriptions SET lease_until = 0 WHERE id = ?', [current.id]);
        return false;
      }
      if (outcome.provider) {
        const [other] = await tx.query('SELECT id FROM subscriptions WHERE provider_id = ? AND id <> ?', [outcome.provider.id, current.id]);
        if (!other) await tx.query('UPDATE subscriptions SET provider_id = ?, checkout_url = ?, state = ?, create_state = ?, lease_until = 0, provider_updated_at = ?, updated_at = ? WHERE id = ?', [outcome.provider.id, outcome.url, outcome.provider.status, 'ready', Date.parse(outcome.provider.last_modified), now(), current.id]);
        else await tx.query('UPDATE subscriptions SET lease_until = 0, create_state = ? WHERE id = ?', ['mismatch', current.id]);
        return false;
      }
      await tx.query('UPDATE subscriptions SET create_state = ?, lease_until = 0, updated_at = ? WHERE id = ?', [creationIssues.includes(outcome.issue) ? outcome.issue : 'unavailable', now(), current.id]);
      if (outcome.issue !== 'not_found') return false;
      await tx.query('INSERT INTO subscription_creation_withdrawals(subscription_id, customer_id, plan_id, source_hash, revision, successor_id, withdrawn_by, withdrawn_at, check_state, lease_until, next_check_at, last_issue, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [current.id, current.customer_id, current.plan_id, claim.sourceHash, 1, null, actor.customer.id, now(), 'not_found', 0, now() + 120000, '', now()]);
      await tx.query('UPDATE subscriptions SET resolution = ?, updated_at = ? WHERE id = ?', ['withdrawn_creation', now(), current.id]);
      await audit(tx, actor.customer.id, 'subscription_creation_withdrawn', { id: current.id, revision: 1, localOnly: true, remoteIssue: 'not_found' });
      return true;
    });
    if (!done) throw failure(409, 'A conferência não permitiu encerrar esta solicitação. Atualize Meus planos antes de continuar.');
    return view(db, await owned(db, claim.row.id, actor), actor);
  }
  async function start(customer, input) {
    only(input, ['planId', 'planRevision', 'idempotencyKey', 'accepted', 'payerEmail']);
    if (!uuid(input.planId) || !uuid(input.idempotencyKey) || input.accepted !== true || input.planRevision !== undefined && (typeof input.planRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.planRevision))) throw failure(422, 'Confirme as condições da assinatura antes de continuar.');
    await rateLimit(db, `subscription_start:${customer.id}`, 15, 60000);
    const row = await db.transaction(async tx => {
      const settings = await readSettings(tx, true), [plan] = await tx.query('SELECT * FROM subscription_plans WHERE id = ?', [input.planId]);
      if (license) await license.assertBooking(tx);
      if (!plan) throw failure(409, 'Este plano não está disponível para novas assinaturas.');
      await assertRenewal(tx, customer.id, plan.id);
      const s = JSON.parse(plan.snapshot_json), currentRevision = planRevision(plan);
      const key = digest(`${customer.id}:${input.idempotencyKey}`), [repeat] = await tx.query('SELECT * FROM subscriptions WHERE request_key = ?', [key]);
      if (repeat && repeat.plan_id !== plan.id) throw failure(409, 'Esta confirmação já foi usada com outro plano.');
      if (repeat && await withdrawalFor(tx, repeat.id)) throw failure(409, 'Esta solicitação foi encerrada localmente. Abra o plano e confirme uma nova solicitação.');
      const withdrawals = await tx.query('SELECT * FROM subscription_creation_withdrawals WHERE customer_id = ? AND plan_id = ? ORDER BY withdrawn_at DESC LIMIT 2', [customer.id, plan.id]);
      if (withdrawals.length > 1) throw failure(409, 'O histórico deste plano precisa de conferência antes de outra solicitação.');
      const replacement = withdrawals[0];
      if (replacement) {
        const [source] = await tx.query('SELECT * FROM subscriptions WHERE id = ?', [replacement.subscription_id]);
        if (!source || !withdrawalBinding(source, replacement) || !['not_found', 'cancelled'].includes(replacement.check_state) || source.resolution !== 'withdrawn_creation' || await creationActivity(tx, source) || replacement.check_state === 'not_found' && (source.provider_id || source.state !== 'pending') || replacement.check_state === 'cancelled' && (!source.provider_id || source.state !== 'cancelled')) throw failure(409, 'A solicitação anterior precisa de conferência antes de continuar.');
      }
      const rows = repeat ? [repeat] : await tx.query("SELECT * FROM subscriptions WHERE customer_id = ? AND plan_id = ? AND state <> 'cancelled' ORDER BY created_at", [customer.id, plan.id]);
      const existing = rows.find(row => row.id !== replacement?.subscription_id);
      const payerEmail = (existing ? manual(existing) : billingMethod(s) === 'manual') ? null : paymentEmail(Object.hasOwn(input, 'payerEmail') ? input.payerEmail : existing?.payer_email ?? customer.email);
      if (existing) await assertSuccessorClear(tx, existing);
      if (existing) {
        if (!manual(existing) && paymentEmail(existing.payer_email ?? customer.email) !== payerEmail) throw failure(409, 'Esta assinatura já foi preparada com outro e-mail de pagamento. Confira Meus planos antes de continuar.');
        if (hasSelfTest(existing) || reservedCollector(existing.collector_id)) {
          requireSelfTestRow(existing, true);
          const connection = await subscriptionConnection(tx, plan.professional_id);
          if (!repeat || !selfTestOfferBinding(plan, s, customer, connection) || connection.id !== existing.connection_id || checkoutRevision(plan, connection) !== JSON.parse(existing.snapshot_json).offerRevision) throw failure(409, 'Este ensaio já possui uma preparação. Confira o pedido existente.');
        }
        const acceptedRevision = acceptedPlanRevision(existing);
        if (input.planRevision !== undefined && input.planRevision !== acceptedRevision || !repeat && input.planRevision === undefined && currentRevision !== acceptedPlanRevision(existing, true)) throw failure(409, 'Você já tem uma adesão em andamento com condições anteriores. Confira Meus planos antes de continuar.');
        if (manual(existing) && (repeat || existing.state === 'pending')) return existing;
        if (existing.state !== 'pending') throw failure(409, 'Você já possui esta assinatura. Consulte Meus planos antes de contratar outra.');
        configured();
        if (Number(existing.lease_until) > now()) throw failure(409, 'A assinatura está sendo preparada. Consulte novamente em alguns segundos.');
        if (existing.provider_id) return { ...existing, existing: true };
        const lease = now() + 120000;
        await tx.query('UPDATE subscriptions SET lease_until = ? WHERE id = ?', [lease, existing.id]); return { ...existing, lease_until: lease, uncertain: true };
      }
      if (replacement && Number(replacement.lease_until) > now()) throw failure(409, 'A solicitação anterior está sendo conferida. Aguarde alguns segundos antes de confirmar uma nova.');
      if (!planAvailable(settings, plan, planServices(s))) throw failure(409, 'Um dos serviços deste plano está indisponível.');
      if (replacement?.successor_id) throw failure(409, 'Uma nova solicitação já foi preparada para este plano. Confira Meus planos.');
      let c;
      if (billingMethod(s) !== 'manual') { configured(); c = await subscriptionConnection(tx, plan.professional_id); }
      const testBinding = selfTestOfferBinding(plan, s, customer, c), testPlan = selfTestBindingFor(config, slug)?.planId === plan.id;
      if ((testPlan || reservedCollector(c?.collectorId)) && !testBinding) throw failure(409, 'Este plano não está disponível para este acesso.');
      if (!plan.active && !testBinding) throw failure(409, 'Este plano não está disponível para novas assinaturas.');
      if (testBinding) {
        const [previousTest] = await tx.query('SELECT id FROM subscriptions WHERE plan_id = ? LIMIT 1', [testBinding.planId]);
        if (previousTest) throw failure(409, 'Este ensaio já possui uma preparação, inclusive no histórico encerrado.');
      }
      if (businessScope(plan) && c && c.receivingMode !== 'business') throw failure(409, 'O recebimento deste plano do negócio precisa ser configurado novamente.');
      const offeredRevision = checkoutRevision(plan, c);
      if (input.planRevision !== undefined && input.planRevision !== offeredRevision || ((s.offerVersion ?? 1) > 1 || c?.receivingMode === 'business') && input.planRevision === undefined) throw failure(409, 'As condições ou o recebedor deste plano foram atualizados. Abra o plano novamente e confira antes de aceitar.');
      s.offerRevision = offeredRevision;
      if (billingMethod(s) === 'manual') {
        const id = randomUUID();
        await tx.query('INSERT INTO subscriptions(id, plan_id, customer_id, professional_id, connection_id, collector_id, payer_email, mode, request_key, provider_id, checkout_url, state, create_state, lease_until, next_check_at, resolution, snapshot_json, provider_updated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, plan.id, customer.id, plan.professional_id, null, null, null, 'manual', key, null, null, 'pending', 'ready', 0, 0, '', JSON.stringify(s), 0, now(), now()]);
        if (replacement) {
          await tx.query('UPDATE subscription_creation_withdrawals SET successor_id = ?, revision = revision + 1, updated_at = ? WHERE subscription_id = ? AND successor_id IS NULL', [id, now(), replacement.subscription_id]);
          await audit(tx, customer.id, 'subscription_creation_replaced', { id: replacement.subscription_id, successorId: id });
        }
        await audit(tx, customer.id, 'subscription_terms_accepted', { id, priceCents: s.priceCents, units: s.units, frequency: 'monthly', billingMethod: 'manual' });
        await notifySubscription(tx, { slug, subscriptionId: id, eventKey: `subscription:${id}:requested`, type: 'requested', now: now() });
        return (await tx.query('SELECT * FROM subscriptions WHERE id = ?', [id]))[0];
      }
      if (!c.ready) throw failure(409, c.receivingMode === 'business' ? 'O gestor ainda precisa conectar a conta de recebimento do negócio.' : 'O profissional ainda precisa conectar a conta de recebimento.');
      if (testBinding) s.selfTest = { ...testBinding };
      const id = randomUUID(), snapshot = JSON.stringify({ ...s, receivingMode: c.receivingMode, receiverName: c.name, receiverId: c.collectorId });
      await tx.query('INSERT INTO subscriptions(id, plan_id, customer_id, professional_id, connection_id, collector_id, payer_email, mode, request_key, provider_id, checkout_url, state, create_state, lease_until, next_check_at, resolution, snapshot_json, provider_updated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, plan.id, customer.id, plan.professional_id, c.id, c.collectorId, payerEmail, mp.mode, key, null, null, 'pending', 'creating', now() + 60000, now() + 120000, '', snapshot, 0, now(), now()]);
      const [created] = await tx.query('SELECT * FROM subscriptions WHERE id = ?', [id]); await audit(tx, customer.id, 'subscription_terms_accepted', { id, priceCents: s.priceCents, units: s.units, frequency: 'monthly' });
      if (replacement) {
        await tx.query('UPDATE subscription_creation_withdrawals SET successor_id = ?, revision = revision + 1, updated_at = ? WHERE subscription_id = ? AND successor_id IS NULL', [id, now(), replacement.subscription_id]);
        await audit(tx, customer.id, 'subscription_creation_replaced', { id: replacement.subscription_id, successorId: id });
      }
      await notifySubscription(tx, { slug, subscriptionId: id, eventKey: `subscription:${id}:requested`, type: 'requested', now: now() });
      return created;
    });
    async function finishStart(current, url, credential) {
      current = await owned(db, current.id, { customer });
      await assertSuccessorClear(db, current);
      if (hasSelfTest(current) || reservedCollector(current.collector_id)) await checkSelfTestStart(current, customer, credential, false);
      const result = await view(db, current, { customer });
      // Revocation can happen while the provider prepares a hosted agreement.
      // Keep its persisted state for retries, but never expose a checkout while blocked.
      if (!manual(current)) configured();
      if (hasSelfTest(current) || reservedCollector(current.collector_id)) {
        requireSelfTestRow(current, true);
        if (!result.canCheckout) throw failure(409, 'O checkout deste teste interno não está liberado.');
      }
      if (!result.renewalAllowed || result.providerPending) {
        if (!manual(current)) await processRenewalJob(current.id, true);
        throw failure(409, 'A renovação deste plano foi bloqueada durante a preparação. Confira Meus planos e fale com o negócio.');
      }
      if (!manual(current) && (current.state !== 'pending' || current.resolution || !result.canCheckout || current.checkout_url !== url)) throw failure(409, 'A assinatura precisa ser conferida em Meus planos antes de continuar.');
      return { ...result, ...(url ? { url } : {}) };
    }
    if (manual(row)) return finishStart(row);
    if (row.existing) return finishStart(row, checkoutUrl(row.checkout_url, row.mode));
    if (row.uncertain) {
      await recoverCreation(row, customer.id, Number(row.lease_until));
      const current = await owned(db, row.id, { customer });
      if (!current.provider_id || !current.checkout_url || current.state !== 'pending') throw failure(409, 'A criação anterior precisa ser conferida. Confira Meus planos e não contrate outra assinatura.');
      return finishStart(current, checkoutUrl(current.checkout_url, current.mode));
    }
    let prepared, connection, phase = 'access';
    try {
      if (hasSelfTest(row) || reservedCollector(row.collector_id)) await checkSelfTestStart(row, customer);
      connection = await payments.access(row.connection_id);
      if (hasSelfTest(row) || reservedCollector(row.collector_id)) await checkSelfTestStart(row, customer, connection);
      const s = JSON.parse(row.snapshot_json);
      await assertSuccessorClear(db, row);
      phase = 'create';
      const p = await request('POST', '/preapproval', { accessToken: connection.accessToken, key: row.id, data: { reason: checkoutReason(s.name), external_reference: ref(row.id), payer_email: row.payer_email, auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: s.priceCents / 100, currency_id: 'BRL' }, back_url: `${config.origin}/planos/${slug}?assinatura=${row.id}`, notification_url: `${config.origin}/payments/mercadopago/webhook/${slug}`, status: 'pending' } });
      phase = 'validate';
      validateProvider(p, row);
      phase = 'persist';
      await db.transaction(async tx => {
        await readSettings(tx, true); const [current] = await tx.query('SELECT * FROM subscriptions WHERE id = ?', [row.id]);
        if (!current || current.provider_id || current.state !== 'pending' || current.snapshot_json !== row.snapshot_json || current.payer_email !== row.payer_email || current.connection_id !== row.connection_id || current.collector_id !== row.collector_id || current.mode !== row.mode || Number(current.lease_until) !== Number(row.lease_until)) throw failure(409, 'A preparação está em conferência. Atualize Meus planos antes de continuar.');
        // Persist the canonical identity before validating the optional link.
        // A missing/unsafe init_point must not hide a real agreement from cancel.
        await tx.query('UPDATE subscriptions SET provider_id = ?, checkout_url = NULL, state = ?, create_state = ?, lease_until = 0, provider_updated_at = ?, updated_at = ? WHERE id = ?', [p.id, p.status, 'ready', Date.parse(p.last_modified), now(), row.id]);
      });
      phase = 'url';
      let url = null;
      if (p.status === 'pending') {
        try { url = checkoutUrl(p.init_point, row.mode); } catch (error) { throw Object.assign(error, { subscriptionMismatch: 'url_invalid' }); }
        phase = 'persist';
        await db.transaction(async tx => {
          await readSettings(tx, true); const [current] = await tx.query('SELECT * FROM subscriptions WHERE id = ?', [row.id]);
          if (!current || current.provider_id !== p.id || current.state !== 'pending' || current.resolution || current.snapshot_json !== row.snapshot_json || current.payer_email !== row.payer_email || current.connection_id !== row.connection_id || current.collector_id !== row.collector_id || current.mode !== row.mode || Number(current.provider_updated_at) !== Date.parse(p.last_modified) || Number(current.lease_until) !== 0) throw failure(409, 'A preparação está em conferência. Atualize Meus planos antes de continuar.');
          await tx.query('UPDATE subscriptions SET checkout_url = ?, updated_at = ? WHERE id = ?', [url, now(), row.id]);
        });
      }
      prepared = { row: { ...row, provider_id: p.id, checkout_url: url, state: p.status }, url };
    } catch (error) {
      if (phase === 'create' && [401, 403].includes(error.providerStatus)) await payments.rejectAccess(connection.id, connection.revision, error.providerStatus);
      await db.transaction(async tx => {
        await readSettings(tx, true); const [current] = await tx.query('SELECT * FROM subscriptions WHERE id = ?', [row.id]);
        if (current && !current.provider_id && Number(current.lease_until) === Number(row.lease_until)) await tx.query('UPDATE subscriptions SET create_state = ?, lease_until = 0, updated_at = ? WHERE id = ?', ['uncertain', now(), row.id]);
        const detail = { id: row.id, supportCode: row.id.replaceAll('-', '').slice(0, 8), phase, status: Number.isInteger(error.providerStatus) && error.providerStatus >= 100 && error.providerStatus <= 599 ? error.providerStatus : null, providerIssue: providerIssues.includes(error.providerIssue) ? error.providerIssue : ['validate', 'url'].includes(phase) ? 'invalid_response' : null, mismatch: creationMismatches.includes(error.subscriptionMismatch) ? error.subscriptionMismatch : null, ...providerFailureMetadata(error) };
        await audit(tx, customer.id, 'subscription_creation_failed', detail);
        console.warn('SUBSCRIPTION_CREATION_FAILED', JSON.stringify({ tenant: slug, ...detail, id: undefined }));
      });
      throw error;
    }
    return finishStart(prepared.row, prepared.url, connection);
  }
  async function reconcilePreapproval(connectionId, id) {
    if (!providerId(id)) throw failure(422, 'Assinatura inválida.');
    const c = await connectionAccess(connectionId), p = await request('GET', '/preapproval/' + id, { accessToken: c.accessToken });
    const match = /^rael_sub_([a-f0-9-]{36})$/.exec(p?.external_reference ?? '');
    return db.transaction(async tx => {
      await readSettings(tx, true);
      // A known provider ID remains bound to its original local agreement even
      // if the provider omits or changes its reference. Unknown events may ignore it.
      const [known] = await tx.query('SELECT * FROM subscriptions WHERE provider_id = ? AND connection_id = ?', [id, connectionId]);
      const [row] = known ? [known] : match ? await tx.query('SELECT * FROM subscriptions WHERE id = ? AND connection_id = ?', [match[1], connectionId]) : [];
      if (!row) return;
      if (hasSelfTest(row) || reservedCollector(row.collector_id)) requireSelfTestRow(row);
      const withdrawal = await withdrawalFor(tx, row.id);
      try { if (withdrawal) validateWithdrawnProvider(p, row); else validateProvider(p, row); if (p.id !== id || row.provider_id && row.provider_id !== id) throw Error(); }
      catch { await tx.query('UPDATE subscriptions SET resolution = ? WHERE id = ?', ['verification_required', row.id]); if (withdrawal) await holdWithdrawnSource(tx, row, withdrawal, 'mismatch'); return; }
      if (Date.parse(p.last_modified) < Number(row.provider_updated_at)) return;
      if (row.state === 'cancelled' && p.status !== 'cancelled' && !withdrawal) return;
      await tx.query('UPDATE subscriptions SET provider_id = ?, checkout_url = ?, state = ?, create_state = ?, provider_updated_at = ?, updated_at = ? WHERE id = ?', [id, withdrawal ? null : providerCheckout(p, row.mode, row), p.status, 'ready', Date.parse(p.last_modified), now(), row.id]);
      if (withdrawal) {
        if (!withdrawalBinding(row, withdrawal) || ['authorized', 'paused'].includes(p.status) || withdrawal.check_state === 'cancelled' && p.status !== 'cancelled') await holdWithdrawnSource(tx, row, withdrawal, withdrawalBinding(row, withdrawal) ? 'unexpected_status' : 'mismatch');
        else if (withdrawal.check_state !== 'review' && withdrawal.check_state !== 'cancelled') await tx.query('UPDATE subscription_creation_withdrawals SET check_state = ?, next_check_at = ?, updated_at = ? WHERE subscription_id = ?', ['found', now(), now(), row.id]);
      }
      if (!withdrawal && row.state !== 'cancelled' && p.status === 'cancelled') {
        const policy = await renewalState(tx, row.customer_id, row.plan_id);
        // A staff block already notified this consumer in the policy transaction.
        // Canonical confirmation must not repeat the same renewal notice.
        if (!policy.providerPending) await notifySubscription(tx, { slug, subscriptionId: row.id, eventKey: `subscription:${row.id}:provider-cancelled`, type: 'renewal_disabled', now: now() });
      }
    });
  }
  async function reconcileInvoice(connectionId, id) {
    if (!numeric(id)) throw failure(422, 'Fatura inválida.');
    const c = await connectionAccess(connectionId), invoice = await request('GET', '/authorized_payments/' + id, { accessToken: c.accessToken });
    if (String(invoice?.id) !== String(id) || !providerId(invoice.preapproval_id)) throw failure(409, 'A fatura precisa ser conferida.');
    const [row] = await db.query('SELECT * FROM subscriptions WHERE provider_id = ? AND connection_id = ?', [invoice.preapproval_id, connectionId]); if (!row) return;
    if (hasSelfTest(row) || reservedCollector(row.collector_id)) requireSelfTestRow(row);
    await reconcilePreapproval(connectionId, row.provider_id);
    if (!numeric(invoice.payment?.id)) return; // A scheduled invoice is not a payment.
    const p = await request('GET', '/v1/payments/' + invoice.payment.id, { accessToken: c.accessToken }), s = JSON.parse(row.snapshot_json);
    const environmentMatches = await paymentEnvironmentMatches(p, row.mode, row.collector_id, c.accessToken, request);
    const updated = Date.parse(p.date_last_updated ?? ''), start = Date.parse(invoice.debit_date ?? '');
    let end;
    try { end = Temporal.Instant.fromEpochMilliseconds(start).toZonedDateTimeISO(s.timeZone).add({ months: 1 }).epochMilliseconds; } catch { end = NaN; }
    return db.transaction(async tx => {
      await readSettings(tx, true);
      const valid = String(p.id) === String(invoice.payment.id) && String(p.collector_id) === row.collector_id && environmentMatches && p.currency_id === 'BRL' && invoice.currency_id === 'BRL' && cents(p.transaction_amount) === s.priceCents && cents(invoice.transaction_amount) === s.priceCents && Number.isFinite(updated) && Number.isFinite(end) && start >= Number(row.created_at) - 86400000 && (!p.external_reference || p.external_reference === ref(row.id));
      if (!valid) { await tx.query('UPDATE subscriptions SET resolution = ? WHERE id = ?', ['verification_required', row.id]); return; }
      await recordProviderMoney(tx, { connectionId, payment: p, customerId: row.customer_id, professionalId: row.professional_id, subscriptionId: row.id, now: now() });
      const withdrawal = await withdrawalFor(tx, row.id);
      if (withdrawal) {
        // A late payment is real money and must be recorded, even though the
        // locally withdrawn request never grants service credits automatically.
        await holdWithdrawnSource(tx, row, withdrawal, 'payment_activity');
        return;
      }
      if (hasSelfTest(row) || reservedCollector(row.collector_id)) {
        requireSelfTestRow(row);
        await tx.query('UPDATE subscriptions SET resolution = ?, updated_at = ? WHERE id = ?', ['self_test_payment_review', now(), row.id]);
        return; // An internal preparation never releases service entitlement.
      }
      const idCycle = digest(`${row.id}:${start}`), [old] = await tx.query('SELECT * FROM subscription_cycles WHERE id = ?', [idCycle]);
      if (old && (old.invoice_id !== String(id) || old.payment_id !== String(p.id))) { await tx.query('UPDATE subscriptions SET resolution = ? WHERE id = ?', ['duplicate_cycle_review', row.id]); return; }
      if (old && Number(old.provider_updated_at) > updated) return;
      const paid = p.status === 'approved' && cents(p.transaction_amount_refunded ?? 0) === 0;
      if (old) await tx.query('UPDATE subscription_cycles SET valid = ?, provider_updated_at = ? WHERE id = ?', [Number(paid), updated, idCycle]);
      else if (paid) await tx.query('INSERT INTO subscription_cycles(id, subscription_id, invoice_id, payment_id, starts_at, ends_at, valid, provider_updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [idCycle, row.id, String(id), String(p.id), start, end, 1, updated, now()]);
      if (old && !paid) await tx.query('UPDATE subscriptions SET resolution = ? WHERE id = ?', ['payment_review', row.id]);
      if (paid && !old?.valid) {
        const [current] = await tx.query('SELECT resolution FROM subscriptions WHERE id = ?', [row.id]);
        if (!current.resolution) await notifySubscription(tx, { slug, subscriptionId: row.id, eventKey: `subscription-cycle:${idCycle}`, type: 'active', now: now() });
      }
    });
  }
  async function refresh(actor, id) {
    const row = await owned(db, id, actor);
    if (!manual(row) && actor.staff && !await canManageAutomatic(db, row, actor.staff)) throw failure(403, 'Somente o cliente ou o responsável pela conta recebedora pode atualizar esta assinatura.');
    await rateLimit(db, `subscription_refresh:${actor.customer?.id ?? actor.staff.id}`, 20, 60000);
    if (!manual(row)) {
      configured();
      if (!row.provider_id && row.state === 'pending') await recoverCreation(row, actor.customer?.id ?? actor.staff.id);
      else if (!await processRenewalJob(row.id, true)) await reconcile(row);
    }
    return view(db, await owned(db, id, actor), actor);
  }
  async function reconcile(row) {
    if (!row.provider_id) { if (!manual(row) && row.state === 'pending') await recoverCreation(row); return; }
    const claimed = await db.transaction(async tx => { await readSettings(tx, true); const [current] = await tx.query('SELECT * FROM subscriptions WHERE id = ?', [row.id]); if (Number(current.lease_until) > now() || !current.provider_id) return null; await tx.query('UPDATE subscriptions SET lease_until = ?, next_check_at = ? WHERE id = ?', [now() + 60000, now() + 5 * 60000, row.id]); return current; });
    if (!claimed) return;
    try {
      await reconcilePreapproval(claimed.connection_id, claimed.provider_id);
      const c = await rowAccess(claimed), found = await request('GET', '/authorized_payments/search?' + new URLSearchParams({ preapproval_id: claimed.provider_id, limit: '12', sort: 'debit_date', criteria: 'desc' }), { accessToken: c.accessToken });
      if (!Array.isArray(found.results)) throw failure(503, 'Não foi possível consultar as faturas.');
      for (const invoice of found.results.slice(0, 3)) if (numeric(invoice.id)) await reconcileInvoice(claimed.connection_id, String(invoice.id));
      // Recheck the active paid cycle even if pagination puts it outside the search.
      const cycles = await db.query('SELECT invoice_id FROM subscription_cycles WHERE subscription_id = ? AND ends_at > ? LIMIT 2', [row.id, now()]);
      for (const cycle of cycles) if (!found.results.some(i => String(i.id) === cycle.invoice_id)) await reconcileInvoice(claimed.connection_id, cycle.invoice_id);
    } finally { await db.query('UPDATE subscriptions SET lease_until = 0 WHERE id = ?', [row.id]); }
  }
  async function cancel(actor, input) {
    only(input, ['subscriptionId']); const row = await owned(db, input.subscriptionId, actor);
    if (manual(row)) return db.transaction(async tx => {
      await readSettings(tx, true); const current = await owned(tx, row.id, actor);
      if (current.state !== 'cancelled') {
        await tx.query('UPDATE subscriptions SET state = ?, updated_at = ? WHERE id = ?', ['cancelled', now(), current.id]);
        const eventKey = await audit(tx, actor.customer?.id ?? actor.staff.id, 'manual_subscription_cancelled', { id: current.id });
        await notifySubscription(tx, { slug, subscriptionId: current.id, eventKey, type: 'cancelled', now: now() });
      }
      return { ok: true };
    });
    if (actor.staff && !await canManageAutomatic(db, row, actor.staff)) throw failure(403, 'O cancelamento é feito pelo cliente ou pelo responsável pela conta recebedora.');
    await stopProviderRenewal(row);
    await db.transaction(tx => audit(tx, actor.customer?.id ?? actor.staff.id, 'subscription_cancelled', { id: row.id })); return { ok: true };
  }
  async function stopProviderRenewal(row) {
    configured();
    if (row.state === 'cancelled') return { ok: true };
    if (!row.provider_id) throw failure(409, 'A criação ainda precisa ser conferida no Mercado Pago antes de cancelar.');
    // A previous PUT may have succeeded even if its response was lost. Confirm
    // canonical state first so a provider that rejects a repeated cancellation
    // cannot leave an already stopped agreement pending forever.
    await reconcilePreapproval(row.connection_id, row.provider_id);
    const [before] = await db.query('SELECT state FROM subscriptions WHERE id = ?', [row.id]);
    if (before.state === 'cancelled') return;
    const c = await rowAccess(row);
    // PUT cancellation is safe to retry. Never create another recurring agreement.
    await request('PUT', '/preapproval/' + row.provider_id, { accessToken: c.accessToken, data: { status: 'cancelled' } });
    await reconcilePreapproval(row.connection_id, row.provider_id);
    const [current] = await db.query('SELECT state FROM subscriptions WHERE id = ?', [row.id]); if (current.state !== 'cancelled') throw failure(409, 'O cancelamento ainda não foi confirmado. Atualize a situação antes de tentar novamente.');
  }
  async function renewalPolicy(user, input) {
    manualManager(user); only(input, ['subscriptionId', 'allowed', 'expectedRevision']);
    if (!uuid(input.subscriptionId) || typeof input.allowed !== 'boolean' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw failure(422, 'Confira a assinatura e a situação atual da renovação.');
    await rateLimit(db, `subscription_renewal_policy:${user.id}`, 60, 60000);
    const result = await db.transaction(async tx => {
      await readSettings(tx, true); const row = await owned(tx, input.subscriptionId, { staff: user });
      if (!await canManageRenewal(tx, row, user)) throw failure(403, 'Somente o responsável pelas contas recebedoras pode controlar esta renovação.');
      const policy = await renewalState(tx, row.customer_id, row.plan_id);
      if (policy.renewalRevision !== input.expectedRevision) throw failure(409, 'A renovação foi alterada em outro acesso. Atualize a situação antes de continuar.');
      let revision = policy.renewalRevision;
      if (policy.renewalAllowed !== input.allowed) {
        revision++;
        if (policy.control) await tx.query('UPDATE subscription_controls SET allowed = ?, revision = ?, updated_by = ?, updated_at = ? WHERE customer_id = ? AND plan_id = ?', [Number(input.allowed), revision, user.id, now(), row.customer_id, row.plan_id]);
        else await tx.query('INSERT INTO subscription_controls(customer_id, plan_id, allowed, revision, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [row.customer_id, row.plan_id, Number(input.allowed), revision, user.id, now()]);
        await audit(tx, user.id, 'subscription_renewal_policy', { customerId: row.customer_id, planId: row.plan_id, allowed: input.allowed, revision });
        if (!input.allowed) await notifySubscription(tx, { slug, subscriptionId: row.id, eventKey: `subscription-policy:${row.customer_id}:${row.plan_id}:${revision}`, type: 'renewal_disabled', now: now() });
      }
      let jobId;
      if (!input.allowed) {
        const automatic = await tx.query("SELECT id FROM subscriptions WHERE customer_id = ? AND plan_id = ? AND mode <> 'manual' AND state <> 'cancelled'", [row.customer_id, row.plan_id]);
        for (const subscription of automatic) {
          const [job] = await tx.query('SELECT state FROM subscription_renewal_jobs WHERE subscription_id = ?', [subscription.id]);
          if (!job) await tx.query('INSERT INTO subscription_renewal_jobs(subscription_id, control_revision, state, attempts, lease_until, next_check_at, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [subscription.id, revision, 'pending', 0, 0, now(), '', now(), now()]);
          else if (job.state === 'done') await tx.query('UPDATE subscription_renewal_jobs SET control_revision = ?, state = ?, attempts = 0, lease_until = 0, next_check_at = ?, last_error = ?, updated_at = ? WHERE subscription_id = ?', [revision, 'pending', now(), '', now(), subscription.id]);
          jobId ??= subscription.id;
        }
      }
      return { id: row.id, jobId };
    });
    // The policy is durable before contacting the provider. A failed attempt is
    // represented by pending/error flags and remains in the retry queue.
    if (result.jobId) await processRenewalJob(result.jobId, true);
    return view(db, await owned(db, result.id, { staff: user }), { staff: user });
  }
  async function processRenewalJob(subscriptionId, force = false) {
    const claimed = await db.transaction(async tx => {
      await readSettings(tx, true);
      const conditions = ["j.state = 'pending'"], args = [];
      if (subscriptionId) { conditions.push('j.subscription_id = ?'); args.push(subscriptionId); }
      if (!force) { conditions.push('j.next_check_at <= ?'); args.push(now()); }
      conditions.push('j.lease_until <= ?'); args.push(now());
      const [job] = await tx.query('SELECT j.* FROM subscription_renewal_jobs j WHERE ' + conditions.join(' AND ') + ' ORDER BY j.next_check_at, j.created_at LIMIT 1', args);
      if (!job) {
        if (subscriptionId) { const [pending] = await tx.query("SELECT subscription_id FROM subscription_renewal_jobs WHERE subscription_id = ? AND state = 'pending'", [subscriptionId]); return pending ? { busy: true } : null; }
        return null;
      }
      const [row] = await tx.query('SELECT * FROM subscriptions WHERE id = ?', [job.subscription_id]);
      // Never race an in-flight creation. Its existing lease expires even after
      // a process restart; recovery below only searches and never posts again.
      if (Number(row.lease_until) > now()) { await tx.query('UPDATE subscription_renewal_jobs SET next_check_at = ?, updated_at = ? WHERE subscription_id = ?', [Number(row.lease_until), now(), row.id]); return { busy: true }; }
      const attempt = Number(job.attempts) + 1, leaseUntil = now() + 60000;
      await tx.query('UPDATE subscription_renewal_jobs SET attempts = ?, lease_until = ?, updated_at = ? WHERE subscription_id = ?', [attempt, leaseUntil, now(), row.id]);
      return { job, row, attempt, leaseUntil };
    });
    if (!claimed) return false;
    if (claimed.busy) return true;
    const { job, attempt } = claimed; let row = claimed.row;
    try {
      configured();
      if (!row.provider_id && row.state !== 'cancelled') {
        const c = await rowAccess(row);
        if (String(c.collector_id) !== row.collector_id || row.mode !== mp.mode) throw failure(409, 'O recebedor da preparação precisa ser conferido antes do cancelamento.');
        // The cancellation policy intentionally blocks normal creation recovery.
        // Reuse its read-only, paginated identity lookup under this job's lease.
        const found = await findCreation(row, c, { deadline: Date.now() + 24000, searches: 0, phase: 'access' });
        if (!found.provider) throw failure(409, 'A criação anterior ainda precisa ser identificada antes do cancelamento.');
        await reconcilePreapproval(row.connection_id, found.provider.id);
        [row] = await db.query('SELECT * FROM subscriptions WHERE id = ?', [row.id]);
        if (!row.provider_id) throw failure(409, 'A criação anterior ainda precisa ser conferida antes do cancelamento.');
      }
      await stopProviderRenewal(row);
      await db.transaction(async tx => {
        await readSettings(tx, true);
        const [lease] = await tx.query('SELECT state, attempts, lease_until FROM subscription_renewal_jobs WHERE subscription_id = ?', [row.id]);
        if (lease.state !== 'pending' || Number(lease.attempts) !== attempt || Number(lease.lease_until) !== claimed.leaseUntil) return;
        const [current] = await tx.query('SELECT state FROM subscriptions WHERE id = ?', [row.id]);
        if (current.state !== 'cancelled') throw failure(409, 'O Mercado Pago ainda não confirmou o cancelamento.');
        const [control] = await tx.query('SELECT updated_by FROM subscription_controls WHERE customer_id = ? AND plan_id = ?', [row.customer_id, row.plan_id]);
        await tx.query('UPDATE subscription_renewal_jobs SET state = ?, lease_until = 0, next_check_at = 0, last_error = ?, updated_at = ? WHERE subscription_id = ?', ['done', '', now(), row.id]);
        await audit(tx, control?.updated_by ?? null, 'subscription_renewal_cancel_confirmed', { subscriptionId: row.id, controlRevision: Number(job.control_revision) });
      });
    } catch (error) {
      const code = error.status === 409 ? 'verification_required' : 'provider_unavailable', delay = Math.min(3600000, 30000 * 2 ** Math.min(attempt - 1, 7));
      await db.query('UPDATE subscription_renewal_jobs SET lease_until = 0, next_check_at = ?, last_error = ?, updated_at = ? WHERE subscription_id = ? AND state = ? AND attempts = ? AND lease_until = ?', [now() + delay, code, now(), row.id, 'pending', attempt, claimed.leaseUntil]);
      try { config.onMaintenanceFailure?.('subscription_renewals', error); } catch { /* Pending work must remain durable even if monitoring fails. */ }
    }
    return true;
  }
  function manualManager(user) { if (!user || !['admin', 'professional'].includes(user.role)) throw failure(403, 'O recebimento e a situação manual são gerenciados pelo gestor ou profissional responsável.'); }
  async function manualReceipt(user, input) {
    manualManager(user); only(input, ['subscriptionId', 'idempotencyKey', 'method', 'note', 'receivedConfirmed', 'expectedCycleEndAt']);
    if (!uuid(input.subscriptionId) || !uuid(input.idempotencyKey) || input.receivedConfirmed !== true || !['cash', 'pix', 'card', 'transfer', 'external', 'other'].includes(input.method) || typeof input.note !== 'string' || input.note.trim().length > 250 || /[\x00-\x1f]/.test(input.note) || input.expectedCycleEndAt !== null && (!Number.isSafeInteger(input.expectedCycleEndAt) || input.expectedCycleEndAt < 0)) throw failure(422, 'Confirme o recebimento, a forma de pagamento e a situação atual do período. Use observações de até 250 caracteres.');
    await rateLimit(db, `subscription_receipt:${user.id}`, 60, 60000);
    const key = digest(`subscription_manual:${user.id}:${input.idempotencyKey}`), signature = digest(JSON.stringify({ subscriptionId: input.subscriptionId, method: input.method, note: input.note.trim(), receivedConfirmed: true, expectedCycleEndAt: input.expectedCycleEndAt }));
    return db.transaction(async tx => {
      await readSettings(tx, true); const row = await owned(tx, input.subscriptionId, { staff: user });
      if (!manual(row)) throw failure(409, 'Este plano usa cobrança automática. Confira o recebimento no Mercado Pago.');
      const [prior] = await tx.query('SELECT id, signature FROM financial_entries WHERE request_key = ?', [key]);
      if (prior) {
        if (prior.signature !== signature) throw failure(409, 'Esta confirmação já foi usada com outro recebimento.');
        return { ...await view(tx, row, { staff: user }), receiptId: prior.id, repeated: true };
      }
      await assertRenewal(tx, row.customer_id, row.plan_id);
      if (row.state === 'cancelled' || row.resolution) throw failure(409, 'Esta assinatura foi encerrada ou precisa de conferência. Não registre um novo período.');
      const cycles = await tx.query('SELECT * FROM subscription_cycles WHERE subscription_id = ? AND valid = 1 ORDER BY ends_at DESC', [row.id]);
      const latestEnd = cycles.length ? Number(cycles[0].ends_at) : null;
      if (input.expectedCycleEndAt !== latestEnd) throw failure(409, 'O período desta assinatura mudou. Atualize a situação antes de confirmar outro recebimento.');
      if (cycles.some(c => Number(c.starts_at) > now())) throw failure(409, 'O próximo período já está pago. Aguarde seu início antes de registrar outra renovação.');
      const s = JSON.parse(row.snapshot_json), start = Math.max(now(), latestEnd ?? now()), end = Temporal.Instant.fromEpochMilliseconds(start).toZonedDateTimeISO(s.timeZone).add({ months: 1 }).epochMilliseconds;
      const cycleId = digest(`${key}:cycle`), receiptId = digest(`${key}:receipt`);
      await tx.query('INSERT INTO subscription_cycles(id, subscription_id, invoice_id, payment_id, starts_at, ends_at, valid, provider_updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [cycleId, row.id, null, null, start, end, 1, now(), now()]);
      await tx.query('INSERT INTO financial_entries(id, request_key, signature, customer_id, professional_id, appointment_id, subscription_id, source, kind, method, amount_cents, occurred_at, date_source, actor_id, note, reverse_of, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [receiptId, key, signature, row.customer_id, row.professional_id, null, row.id, 'subscription', 'receipt', input.method, s.priceCents, now(), 'manual_confirmed', user.id, input.note.trim(), null, now()]);
      await tx.query('UPDATE subscriptions SET state = ?, updated_at = ? WHERE id = ?', ['authorized', now(), row.id]);
      await audit(tx, user.id, 'manual_subscription_receipt', { id: row.id, cycleId, receiptId, amountCents: s.priceCents, method: input.method, startAt: start, endAt: end });
      await notifySubscription(tx, { slug, subscriptionId: row.id, eventKey: `subscription-cycle:${cycleId}`, type: 'active', now: now() });
      return { ...await view(tx, { ...row, state: 'authorized' }, { staff: user }), receiptId, repeated: false };
    });
  }
  async function manualStatus(user, input) {
    manualManager(user); only(input, ['subscriptionId', 'active']);
    if (!uuid(input.subscriptionId) || typeof input.active !== 'boolean') throw failure(422, 'Escolha ativar ou suspender esta assinatura.');
    await rateLimit(db, `subscription_status:${user.id}`, 60, 60000);
    return db.transaction(async tx => {
      await readSettings(tx, true); const row = await owned(tx, input.subscriptionId, { staff: user });
      if (!manual(row)) throw failure(409, 'Esta assinatura é atualizada automaticamente pelo Mercado Pago.');
      if (row.state === 'cancelled' || row.resolution) throw failure(409, 'Esta assinatura foi encerrada ou precisa de conferência.');
      const state = input.active ? 'authorized' : 'suspended';
      if (input.active) {
        const [cycle] = await tx.query('SELECT id FROM subscription_cycles WHERE subscription_id = ? AND valid = 1 AND starts_at <= ? AND ends_at > ? LIMIT 1', [row.id, now(), now()]);
        if (!cycle) throw failure(409, 'Confirme o recebimento de um período vigente antes de reativar.');
      }
      if (state !== row.state) {
        await tx.query('UPDATE subscriptions SET state = ?, updated_at = ? WHERE id = ?', [state, now(), row.id]);
        const eventKey = await audit(tx, user.id, input.active ? 'manual_subscription_resumed' : 'manual_subscription_suspended', { id: row.id });
        await notifySubscription(tx, { slug, subscriptionId: row.id, eventKey, type: input.active ? 'active' : 'suspended', now: now() });
      }
      return view(tx, { ...row, state }, { staff: user });
    });
  }
  async function notification(connectionId, headers, query, body) {
    configured(); verifyNotification(headers, query['data.id'], mp.webhookSecret, now());
    if (String(body.data?.id) !== query['data.id']) throw failure(422, 'Notificação inválida.');
    if (body.type === 'subscription_preapproval') await reconcilePreapproval(connectionId, query['data.id']);
    else if (body.type === 'subscription_authorized_payment') await reconcileInvoice(connectionId, query['data.id']);
    else if (body.type === 'payment' && numeric(query['data.id'])) { const c = await connectionAccess(connectionId), found = await request('GET', '/authorized_payments/search?' + new URLSearchParams({ payment_id: query['data.id'], limit: '5' }), { accessToken: c.accessToken }); for (const i of (found.results ?? []).slice(0, 5)) if (numeric(i.id)) await reconcileInvoice(connectionId, String(i.id)); }
    else throw failure(422, 'Tipo de notificação não atendido.');
  }
  async function notificationByCollector(headers, query, body) {
    configured(); verifyNotification(headers, query['data.id'], mp.webhookSecret, now());
    if (String(body?.data?.id) !== query['data.id'] || !numeric(body?.user_id) || !['subscription_preapproval', 'subscription_authorized_payment', 'payment'].includes(body?.type)) throw failure(422, 'Notificação inválida.');
    // The collector in the body is unsigned; it only selects a known credential.
    // Existing reconciliation re-fetches the resource and verifies its canonical
    // collector, local subscription, financial terms and payment environment.
    const rows = await db.query('SELECT id FROM mp_connections WHERE collector_id = ? AND mode = ? LIMIT 2', [String(body.user_id), mp.mode]);
    if (rows.length !== 1) return { ignored: true };
    if (body.type === 'payment') {
      const [subscription] = await db.query('SELECT id FROM subscriptions WHERE connection_id = ? AND provider_id IS NOT NULL LIMIT 1', [rows[0].id]);
      if (!subscription) return { ignored: true };
    }
    await notification(rows[0].id, headers, query, body);
    return { ok: true };
  }
  async function coveredProfessional(tx, row, serviceId, professionalId) {
    if (!businessScope(row)) return row.professional_id === professionalId;
    const settings = await readSettings(tx);
    return Boolean(settings.published?.professionals.some(pro => pro.id === professionalId) && settings.draft.professionals.some(pro => pro.id === professionalId && pro.active) && publishedServices(settings, professionalId, [{ serviceId }]));
  }
  async function coverage(tx, id, customerId, serviceId, professionalId) {
    const row = await owned(tx, id, { customer: { id: customerId } }), s = JSON.parse(row.snapshot_json);
    if (hasSelfTest(row) || reservedCollector(row.collector_id)) throw failure(409, 'O teste interno de preparação não libera atendimentos.');
    await assertSuccessorClear(tx, row);
    const service = planServices(s).find(item => item.serviceId === serviceId);
    if (!service || !await coveredProfessional(tx, row, serviceId, professionalId) || row.resolution || !(manual(row) ? row.state === 'authorized' : ['authorized', 'paused', 'cancelled'].includes(row.state))) throw failure(409, 'Este plano não cobre o serviço ou profissional escolhido, ou precisa de conferência.');
    const [cycle] = await tx.query('SELECT * FROM subscription_cycles WHERE subscription_id = ? AND valid = 1 AND starts_at <= ? AND ends_at > ? ORDER BY starts_at DESC LIMIT 1', [row.id, now(), now()]);
    if (!cycle) throw failure(409, 'Não há um período pago vigente para este plano. Confira a situação com o negócio.');
    if (await serviceUsage(tx, cycle.id, serviceId) >= service.units) throw failure(409, 'Plano mensal esgotado para este serviço. Escolha pagamento avulso ou aguarde a próxima renovação.');
    return { id: row.id, cycleId: cycle.id, startAt: Number(cycle.starts_at), endAt: Number(cycle.ends_at) };
  }
  async function consume(tx, id, appointmentId, customerId, serviceId, professionalId, startAt, snapshot, original) {
    if (!id && !original?.subscription) return;
    const membershipId = original?.subscription?.id ?? id, row = await owned(tx, membershipId, { customer: { id: customerId } }), s = JSON.parse(row.snapshot_json);
    await assertSuccessorClear(tx, row);
    const service = planServices(s).find(item => item.serviceId === serviceId);
    if (!service || !await coveredProfessional(tx, row, serviceId, professionalId) || row.resolution || !(manual(row) ? row.state === 'authorized' : ['authorized', 'paused', 'cancelled'].includes(row.state))) throw failure(409, 'Este plano não cobre o serviço ou profissional escolhido, ou precisa de conferência.');
    const [existing] = await tx.query('SELECT * FROM subscription_usage WHERE appointment_id = ?', [appointmentId]);
    const cycles = await tx.query('SELECT * FROM subscription_cycles WHERE subscription_id = ? AND valid = 1 AND starts_at <= ? AND ends_at > ? ORDER BY starts_at DESC', [row.id, now(), now()]);
    const cycle = cycles.find(c => Number(c.starts_at) <= startAt && Number(c.ends_at) > startAt && (!existing || c.id === existing.cycle_id));
    if (!cycle) throw failure(409, 'O atendimento deve acontecer dentro do ciclo já pago do seu plano. Escolha outra data.');
    if (!existing) {
      if (await serviceUsage(tx, cycle.id, serviceId) >= service.units) throw failure(409, 'Plano mensal esgotado para este serviço. Escolha pagamento avulso ou aguarde a próxima renovação.');
      // The appointment is inserted by the caller before this FK-bearing ledger row.
    }
    snapshot.requirePayment = false; delete snapshot.receiver;
    snapshot.subscription = { id: row.id, planName: s.name, cycleId: cycle.id, cycleEndAt: Number(cycle.ends_at), included: true };
    return { subscriptionId: row.id, cycleId: cycle.id, existing: Boolean(existing) };
  }
  async function recordUsage(tx, appointmentId, usage) { if (usage && !usage.existing) await tx.query('INSERT INTO subscription_usage(appointment_id, subscription_id, cycle_id, released, created_at) VALUES (?, ?, ?, ?, ?)', [appointmentId, usage.subscriptionId, usage.cycleId, 0, now()]); }
  async function release(tx, row) { const s = JSON.parse(row.snapshot_json); if (s.subscription && now() <= Number(row.starts_at) - s.cancelHours * 3600000) await tx.query('UPDATE subscription_usage SET released = 1 WHERE appointment_id = ?', [row.id]); }
  async function withdrawalInvoices(row, credential) {
    const ids = new Set(); let offset = 0, total = null;
    for (let page = 0; page < 4; page++) {
      const found = await request('GET', '/authorized_payments/search?' + new URLSearchParams({ preapproval_id: row.provider_id, ...(offset ? { limit: '50', offset: String(offset) } : {}) }), { accessToken: credential.accessToken });
      const paging = found?.paging, items = found?.results;
      if (!paging || !Array.isArray(items) || !Number.isSafeInteger(paging.total) || paging.total < 0 || !Number.isSafeInteger(paging.limit) || paging.limit < 1 || paging.limit > 50 || paging.offset !== offset || total !== null && paging.total !== total || items.length > paging.limit || offset + items.length > paging.total) throw failure(503, 'A conferência das faturas ainda não foi concluída.');
      total = paging.total;
      for (const invoice of items) {
        if (!numeric(invoice?.id) || ids.has(String(invoice.id)) || invoice.preapproval_id !== row.provider_id) throw failure(409, 'Uma fatura retornou outro vínculo.');
        ids.add(String(invoice.id));
        await reconcileInvoice(row.connection_id, String(invoice.id));
      }
      if (offset + items.length === total) return ids.size;
      if (items.length !== paging.limit) throw failure(503, 'A conferência das faturas ainda não foi concluída.');
      offset += items.length;
    }
    throw failure(503, 'A conferência das faturas ainda não foi concluída.');
  }
  async function processWithdrawal() {
    const claim = await db.transaction(async tx => {
      await readSettings(tx, true);
      const [item] = await tx.query("SELECT * FROM subscription_creation_withdrawals WHERE check_state <> 'cancelled' AND next_check_at <= ? AND lease_until <= ? ORDER BY next_check_at, withdrawn_at LIMIT 1", [now(), now()]);
      if (!item) return null;
      const [row] = await tx.query('SELECT * FROM subscriptions WHERE id = ?', [item.subscription_id]);
      if (!row || !withdrawalBinding(row, item) || !['withdrawn_creation', 'verification_required'].includes(row.resolution)) {
        await tx.query('UPDATE subscription_creation_withdrawals SET check_state = ?, last_issue = ?, next_check_at = ?, updated_at = ? WHERE subscription_id = ?', ['review', 'mismatch', now() + 300000, now(), item.subscription_id]);
        if (row) await holdWithdrawnSource(tx, row, item, 'mismatch');
        return null;
      }
      if (Number(row.lease_until) > now()) return null;
      const lease = now() + 120000, revision = Number(item.revision) + 1;
      await tx.query('UPDATE subscription_creation_withdrawals SET lease_until = ?, revision = ?, updated_at = ? WHERE subscription_id = ?', [lease, revision, now(), row.id]);
      await tx.query('UPDATE subscriptions SET lease_until = ? WHERE id = ?', [lease, row.id]);
      return { row, item: { ...item, revision }, lease };
    });
    if (!claim) return false;
    let outcome = { state: 'review', issue: 'unavailable' }, row = claim.row;
    async function guard(credential = null) {
      return db.transaction(async tx => {
        await readSettings(tx, true); const [current] = await tx.query('SELECT * FROM subscriptions WHERE id = ?', [row.id]), item = await withdrawalFor(tx, row.id);
        if (!current || !withdrawalBinding(current, item) || Number(item.revision) !== claim.item.revision || Number(item.lease_until) !== claim.lease || Number(current.lease_until) !== claim.lease || claim.lease <= now() || !payments.configured() || current.mode !== mp.mode || current.snapshot_json !== claim.row.snapshot_json || !['withdrawn_creation', 'verification_required'].includes(current.resolution)) throw failure(409, 'O vínculo da conferência anterior foi alterado.');
        if (credential) {
          const [connection] = await tx.query('SELECT status, revision FROM mp_connections WHERE id = ?', [current.connection_id]);
          if (!connection || connection.status !== 'connected' || Number(connection.revision) !== Number(credential.revision) || String(credential.collector_id) !== current.collector_id || credential.id !== current.connection_id || credential.mode !== current.mode) throw failure(409, 'A conta de recebimento foi alterada durante a conferência.');
        }
        return { current, item };
      });
    }
    try {
      configured(); let c = await rowAccess(row); await guard(c);
      let p;
      if (!row.provider_id) {
        const found = await findCreation(row, c, { deadline: Date.now() + 24000, searches: 0, phase: 'access' });
        if (!found.provider) { outcome = { state: found.issue === 'not_found' ? 'not_found' : 'review', issue: found.issue === 'not_found' ? '' : found.issue }; }
        else p = found.provider;
      } else {
        p = await request('GET', '/preapproval/' + row.provider_id, { accessToken: c.accessToken });
        validateProvider(p, row); if (p.id !== row.provider_id) throw failure(409, 'A assinatura retornou outro vínculo.');
      }
      if (p) {
        validateWithdrawnProvider(p, row);
        await db.transaction(async tx => {
          await readSettings(tx, true); const [current] = await tx.query('SELECT * FROM subscriptions WHERE id = ?', [row.id]), item = await withdrawalFor(tx, row.id);
          if (!current || !withdrawalBinding(current, item) || Number(item.lease_until) !== claim.lease || Number(current.lease_until) !== claim.lease || Number(item.revision) !== claim.item.revision || current.provider_id && current.provider_id !== p.id || Date.parse(p.last_modified) < Number(current.provider_updated_at)) throw failure(409, 'A conferência foi alterada.');
          const [other] = await tx.query('SELECT id FROM subscriptions WHERE provider_id = ? AND id <> ?', [p.id, row.id]); if (other) throw failure(409, 'A assinatura retornou outro vínculo.');
          await tx.query('UPDATE subscriptions SET provider_id = ?, checkout_url = NULL, state = ?, create_state = ?, provider_updated_at = ?, updated_at = ? WHERE id = ?', [p.id, p.status, 'ready', Date.parse(p.last_modified), now(), row.id]);
          if (['authorized', 'paused'].includes(p.status)) await holdWithdrawnSource(tx, current, item, 'unexpected_status');
        });
        [row] = await db.query('SELECT * FROM subscriptions WHERE id = ?', [row.id]);
        const invoices = await withdrawalInvoices(row, c), { current, item } = await guard(c);
        if (invoices || await creationActivity(db, current)) outcome = { state: 'review', issue: 'invoice_activity' };
        else if (['authorized', 'paused'].includes(p.status) || item.check_state === 'review' && ['unexpected_status', 'payment_activity', 'invoice_activity', 'mismatch', 'ambiguous'].includes(item.last_issue)) outcome = { state: 'review', issue: item.last_issue || 'unexpected_status' };
        else {
          if (p.status === 'pending') {
            c = await rowAccess(current); await guard(c);
            const canonical = await request('GET', '/preapproval/' + p.id, { accessToken: c.accessToken });
            validateWithdrawnProvider(canonical, current);
            if (canonical.id !== p.id || canonical.status !== 'pending') {
              if (canonical.id !== p.id) throw failure(409, 'A assinatura retornou outro vínculo.');
              await reconcilePreapproval(row.connection_id, p.id);
              outcome = { state: 'review', issue: 'unexpected_status' };
            } else {
              const latest = await guard(c);
              if (latest.current.state !== 'pending' || latest.current.provider_id !== p.id || latest.item.check_state === 'review' && ['unexpected_status', 'payment_activity', 'invoice_activity', 'mismatch', 'ambiguous'].includes(latest.item.last_issue) || await creationActivity(db, latest.current)) throw failure(409, 'A assinatura anterior precisa de conferência.');
              await request('PUT', '/preapproval/' + p.id, { accessToken: c.accessToken, data: { status: 'cancelled' } });
              await reconcilePreapproval(row.connection_id, p.id);
              [row] = await db.query('SELECT * FROM subscriptions WHERE id = ?', [row.id]);
              if (row.state !== 'cancelled') throw failure(409, 'O cancelamento remoto ainda não foi confirmado.');
              const after = await withdrawalInvoices(row, c);
              outcome = { state: after || await creationActivity(db, row) ? 'review' : 'cancelled', issue: after ? 'invoice_activity' : '' };
            }
          } else if (p.status === 'cancelled') outcome = { state: 'cancelled', issue: '' };
        }
      }
    } catch (error) { outcome = { state: 'review', issue: error.status === 409 ? 'mismatch' : 'unavailable' }; }
    await db.transaction(async tx => {
      await readSettings(tx, true); const [current] = await tx.query('SELECT * FROM subscriptions WHERE id = ?', [claim.row.id]), item = await withdrawalFor(tx, claim.row.id);
      if (!current || !item || Number(item.lease_until) !== claim.lease || Number(item.revision) !== claim.item.revision) return;
      if (!withdrawalBinding(current, item) || item.check_state === 'review' && ['unexpected_status', 'payment_activity', 'invoice_activity', 'mismatch', 'ambiguous'].includes(item.last_issue)) outcome = { state: 'review', issue: item.last_issue || 'mismatch' };
      await tx.query('UPDATE subscription_creation_withdrawals SET check_state = ?, lease_until = 0, next_check_at = ?, last_issue = ?, updated_at = ? WHERE subscription_id = ?', [outcome.state, outcome.state === 'cancelled' ? 0 : now() + 300000, outcome.issue, now(), current.id]);
      await tx.query('UPDATE subscriptions SET lease_until = 0, checkout_url = NULL WHERE id = ? AND lease_until = ?', [current.id, claim.lease]);
      if (outcome.state === 'review') await holdWithdrawnSource(tx, current, item, outcome.issue);
      await audit(tx, null, 'subscription_withdrawal_checked', { id: current.id, state: outcome.state, issue: outcome.issue || null });
    });
    return true;
  }
  async function sweep() {
    try {
      await processRenewalJob();
      if (!payments.configured()) return;
      await processWithdrawal();
      const [row] = await db.query('SELECT s.* FROM subscriptions s WHERE s.provider_id IS NOT NULL AND s.next_check_at <= ? AND NOT EXISTS (SELECT 1 FROM subscription_creation_withdrawals w WHERE w.subscription_id = s.id) ORDER BY s.next_check_at LIMIT 1', [now()]);
      if (row) await reconcile(row);
    } catch (error) { try { config.onMaintenanceFailure?.('subscriptions', error); } catch { /* Monitoring cannot interrupt durable retry. */ } }
  }
  return { plans, createPlan, updatePlan, archive, list, overview, planMembers, start, withdraw, refresh, cancel, renewalPolicy, manualReceipt, manualStatus, notification, notificationByCollector, coverage, consume, recordUsage, release, sweep };
}
