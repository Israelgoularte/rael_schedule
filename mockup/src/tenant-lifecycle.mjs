import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import { readSettings } from './database.mjs';
import { digest, failure, token } from './security.mjs';
import { validSlug } from './configuration.mjs';
import { createHostingerClient } from './hostinger-client.mjs';
import { mysqlEntriesConflict } from './mysql-isolation.mjs';
import { databaseFingerprint } from './backup.mjs';
import { tenantCategories, readTenantRetention, tenantRetention, closureFromLifecycle } from './tenant-retention.mjs';
import { legalVersions } from './legal.mjs';
import { scrubRegistrationRequest } from './registration-admin.mjs';

const DAY = 86400000;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const only = (value, keys) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw failure(422, 'Confira os dados enviados.'); };
const summaryOf = row => row ? JSON.parse(row.summary_json) : {};
const refundDisclaimer = 'O encerramento não gera reembolso automático, ressalvadas as hipóteses previstas em lei.';
const backupsNotice = 'A exclusão remove o banco operacional. Cópias de recuperação já existentes seguem a retenção de até 30 dias e os procedimentos de limpeza da Raelapps. Registros financeiros necessários da relação com a plataforma são conservados separadamente.';
const plainLicense = state => Object.fromEntries(['state', 'canBook', 'enforced', 'priceCents', 'paidUntil', 'trialEndsAt', 'trialStartedAt', 'graceUntil', 'renewing', 'resolution', 'mode'].map(key => [key, state[key] ?? null]));

export function createTenantLifecycle(config, { getService, database, withTenantQuiesced, retireTenant, finalizeTenant, withTenant = async (_slug, work) => work() } = {}) {
  const now = config.now ?? (() => Date.now());
  const inFlight = new Set();
  const worker = { host: hostname(), pid: process.pid };
  const provider = config.onboarding?.token && config.onboarding?.account && config.onboarding?.domain ? createHostingerClient(config.onboarding, config.hostingerTransport) : null;
  const previewKey = /^[a-f0-9]{64}$/i.test(config.integrationKey ?? '') ? Buffer.from(config.integrationKey, 'hex') : null;
  const operatorAllowed = actor => Boolean(actor && actor.tenant === config.operations?.tenant && actor.role === 'admin' && config.operations?.userIds?.includes(actor.id));
  function requireOperator(actor) { if (!operatorAllowed(actor)) throw failure(403, 'Acesso reservado à operação da plataforma.'); }
  function requireManager(slug, actor) { if (!actor || actor.role !== 'admin' || actor.tenant !== slug && !operatorAllowed(actor)) throw failure(403, 'O encerramento é solicitado pelo gestor deste negócio.'); }
  const central = () => database(config.operations.tenant);
  async function row(db, slug, lock = false) { const [value] = await db.query('SELECT * FROM tenant_lifecycle WHERE slug = ?' + (lock ? db.lock : ''), [slug]); return value ?? null; }
  async function audit(tx, actor, event, details) { await tx.query('INSERT INTO audit_events(id, actor_id, event_name, detail_json, created_at) VALUES (?, ?, ?, ?, ?)', [randomUUID(), actor.id, event, JSON.stringify(details), now()]); }
  async function operatorSession(actor, work) {
    requireOperator(actor);
    const service = await getService(config.operations.tenant);
    return service.withCurrentSession(actor, async (tx, current) => { requireOperator(current); return work(tx, current); });
  }
  function targetEntry(slug) {
    if (!validSlug(slug) || !Object.hasOwn(config.entries, slug)) throw failure(404, 'Negócio não encontrado para esta operação.');
    if (slug === config.operations.tenant) throw failure(403, 'A infraestrutura da gestão da Raelapps é protegida.');
    return config.entries[slug];
  }
  async function facts(slug, current = null, targetTx = null, knownService = null) {
    const service = knownService ?? await getService(slug), db = targetTx ?? await database(slug), settings = await readSettings(db), license = await service.license.state(db);
    const retention = await readTenantRetention(db, license, now(), current);
    const [users] = await db.query('SELECT COUNT(*) AS total FROM users'), [customers] = await db.query('SELECT COUNT(*) AS total FROM customers'), [appointments] = await db.query('SELECT COUNT(*) AS total FROM appointments'), [subscriptions] = await db.query('SELECT COUNT(*) AS total FROM subscriptions');
    return { name: settings.draft.business.name, license: plainLicense(license), retention, activeProfessionals: settings.draft.professionals.filter(person => person.active).length, counts: { users: Number(users.total), customers: Number(customers.total), appointments: Number(appointments.total), subscriptions: Number(subscriptions.total) } };
  }
  async function persist(tx, old, slug, state, actor, summary, fields = {}) {
    const at = now(), revision = Number(old?.revision ?? 0) + 1;
    const value = { archived_at: old?.archived_at ?? null, deleted_at: old?.deleted_at ?? null, deletion_key: old?.deletion_key ?? null, deletion_stage: old?.deletion_stage ?? '', error_code: '', ...fields };
    if (old) await tx.query('UPDATE tenant_lifecycle SET state = ?, revision = ?, archived_at = ?, deleted_at = ?, updated_by = ?, summary_json = ?, deletion_key = ?, deletion_stage = ?, error_code = ?, updated_at = ? WHERE slug = ?', [state, revision, value.archived_at, value.deleted_at, actor.id, JSON.stringify(summary), value.deletion_key, value.deletion_stage, value.error_code, at, slug]);
    else await tx.query('INSERT INTO tenant_lifecycle(slug, state, revision, archived_at, deleted_at, updated_by, summary_json, deletion_key, deletion_stage, error_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [slug, state, revision, value.archived_at, value.deleted_at, actor.id, JSON.stringify(summary), value.deletion_key, value.deletion_stage, value.error_code, at, at]);
    return { ...old, slug, state, revision, updated_by: actor.id, summary_json: JSON.stringify(summary), ...value, updated_at: at };
  }
  function projection(slug, current, snapshot, unavailable = false) {
    const retention = tenantRetention(snapshot?.license, now(), { futurePaidUntil: snapshot?.retention?.paidUntil ?? 0, hasPaidHistory: snapshot?.retention?.hasEverActivated ?? Boolean(snapshot?.hasEverActivated), lifecycle: current });
    const isProtected = slug === config.operations?.tenant;
    const state = current?.state ?? 'open';
    const blocked = isProtected ? 'A infraestrutura da Raelapps é protegida.' : unavailable ? 'Não foi possível conferir os dados deste negócio.' : !provider || !previewKey || !withTenantQuiesced || !retireTenant ? 'A exclusão precisa da configuração protegida da hospedagem.' : retention.hasCoverage ? 'Existe um período de licença ou teste ainda vigente.' : retention.closure && !retention.closure.eligible ? 'Aguarde o prazo do encerramento solicitado pelo gestor.' : !['archived', 'attention', 'deleting'].includes(state) ? 'Arquive este cliente antes de apagar os dados.' : '';
    return { state, revision: Number(current?.revision ?? 0), category: unavailable ? 'unavailable' : retention.category, cohort: retention.cohort, hasEverActivated: retention.hasEverActivated, inactiveSince: retention.inactiveSince, inactiveDays: retention.inactiveDays, expiresAt: retention.expiresAt, archivedAt: current?.archived_at ? Number(current.archived_at) : null, deletedAt: current?.deleted_at ? Number(current.deleted_at) : null, closure: retention.closure, canArchive: !isProtected && !unavailable && ['open', 'closing'].includes(state), canUnarchive: !isProtected && state === 'archived', canDelete: state !== 'deleted' && !blocked, deletionBlockedReason: blocked, errorCode: current?.error_code ?? '', deletionStage: current?.deletion_stage ?? '', protected: isProtected };
  }
  async function list(query = {}) {
    only(query, ['offset', 'q', 'category', 'cohort']);
    const offset = Number(query.offset ?? 0), category = query.category ?? 'all', cohort = query.cohort ?? 'all', search = String(query.q ?? '').trim().toLowerCase();
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000 || !['all', ...tenantCategories].includes(category) || !['all', 'trial', 'licensed'].includes(cohort) || search.length > 100) throw failure(422, 'Confira os filtros dos clientes.');
    const db = await central(), lifecycleRows = await db.query('SELECT * FROM tenant_lifecycle ORDER BY slug'), bySlug = new Map(lifecycleRows.map(item => [item.slug, item]));
    const slugs = [...new Set([...Object.keys(config.entries), ...lifecycleRows.map(item => item.slug)])].filter(slug => slug !== config.operations.tenant).sort();
    if (slugs.length > 1000) throw failure(422, 'Amplie a consulta administrativa antes de ultrapassar mil negócios.');
    const all = [];
    for (const slug of slugs) {
      const current = bySlug.get(slug), previous = summaryOf(current);
      if (['deleted', 'deleting', 'attention'].includes(current?.state)) {
        const retention = tenantRetention(previous.license, now(), { futurePaidUntil: previous.retention?.paidUntil ?? 0, hasPaidHistory: previous.retention?.hasEverActivated ?? previous.retention?.hasPaidHistory, lifecycle: current });
        const snapshot = { ...previous, retention };
        all.push({ slug, name: previous.name ?? slug, license: previous.license ?? { state: 'suspended' }, activeProfessionals: Number(previous.activeProfessionals ?? 0), cohort: retention.cohort, hasEverActivated: retention.hasEverActivated, lifecycle: projection(slug, current, snapshot) });
        continue;
      }
      try {
        const snapshot = await facts(slug, current);
        all.push({ slug, name: snapshot.name, license: snapshot.license, activeProfessionals: snapshot.activeProfessionals, cohort: snapshot.retention.cohort, hasEverActivated: snapshot.retention.hasEverActivated, lifecycle: projection(slug, current, snapshot) });
      } catch { all.push({ slug, name: previous.name ?? slug, unavailable: true, cohort: previous.retention?.cohort ?? 'trial', lifecycle: projection(slug, current, previous, true) }); }
    }
    const emptyCounts = () => Object.fromEntries(['all', ...tenantCategories].map(key => [key, 0]));
    const countsByCohort = { trial: emptyCounts(), licensed: emptyCounts() };
    for (const item of all) { const counts = countsByCohort[item.cohort]; counts.all++; counts[item.lifecycle.category]++; }
    const counts = cohort === 'all' ? Object.fromEntries(Object.keys(countsByCohort.trial).map(key => [key, countsByCohort.trial[key] + countsByCohort.licensed[key]])) : countsByCohort[cohort];
    const matched = all.filter(item => (cohort === 'all' || item.cohort === cohort) && (category === 'all' || item.lifecycle.category === category) && (!search || `${item.slug} ${item.name}`.toLowerCase().includes(search)));
    return { businesses: matched.slice(offset, offset + 20), hasMore: matched.length > offset + 20, total: matched.length, offset, category, cohort, q: query.q ?? '', counts, countsByCohort };
  }
  async function lookup(actor, slug) {
    requireOperator(actor);
    if (!validSlug(slug)) throw failure(404, 'Negócio não encontrado.');
    const db = await central(), current = await row(db, slug), previous = summaryOf(current);
    if (!Object.hasOwn(config.entries, slug) && !current) throw failure(404, 'Negócio não encontrado.');
    if (['deleted', 'deleting', 'attention'].includes(current?.state)) return { slug, name: previous.name ?? slug, available: false, lifecycle: projection(slug, current, previous) };
    try { const snapshot = await facts(slug, current); return { slug, name: snapshot.name, available: true, lifecycle: projection(slug, current, snapshot) }; }
    catch { return { slug, name: previous.name ?? slug, available: false, lifecycle: projection(slug, current, previous, true) }; }
  }
  async function archive(actor, input) {
    only(input, ['slug', 'revision', 'archived']); requireOperator(actor); targetEntry(input.slug);
    if (!Number.isSafeInteger(input.revision) || input.revision < 0 || typeof input.archived !== 'boolean') throw failure(422, 'Confira a situação atual deste cliente.');
    const db = await central(), old = await row(db, input.slug), snapshot = await facts(input.slug, old);
    return operatorSession(actor, async (tx, currentActor) => {
      const current = await row(tx, input.slug, true);
      if (Number(current?.revision ?? 0) !== input.revision) throw failure(409, 'O cliente mudou. Atualize antes de continuar.');
      if (!['open', 'archived', 'closing'].includes(current?.state ?? 'open')) throw failure(409, 'Este cliente já está em processo de exclusão.');
      const summary = { ...snapshot, ...(closureFromLifecycle(current) ? { closure: closureFromLifecycle(current) } : {}) };
      const state = input.archived ? 'archived' : summary.closure ? 'closing' : 'open';
      const saved = await persist(tx, current, input.slug, state, currentActor, summary, { archived_at: input.archived ? now() : null });
      await audit(tx, currentActor, input.archived ? 'platform_tenant_archived' : 'platform_tenant_unarchived', { slug: input.slug, revision: saved.revision });
      return { ok: true, lifecycle: projection(input.slug, saved, snapshot) };
    });
  }
  async function providerInventory(slug, entry, { allowAbsent = false } = {}) {
    if (!provider || !entry?.database || !entry?.user || !entry.database.startsWith(config.onboarding.account + '_') || !entry.user.startsWith(config.onboarding.account + '_')) throw failure(409, 'A configuração protegida não identifica um banco exclusivo desta hospedagem.');
    for (const [otherSlug, other] of Object.entries(config.entries)) if (otherSlug !== slug && (mysqlEntriesConflict(entry, other) || String(other.database ?? '').toLowerCase() === entry.database.toLowerCase() || String(other.user ?? '').toLowerCase() === entry.user.toLowerCase())) throw failure(409, 'O banco ou usuário se sobrepõe a outro negócio. A exclusão foi bloqueada.');
    if (entry.driver !== 'mysql' && !(entry.driver === 'sqlite' && !config.production && typeof config.hostingerTransport === 'function')) throw failure(409, 'Este banco não pode ser removido pelo fluxo da hospedagem.');
    const inventory = await provider.databases(), matches = inventory.rows.filter(item => item.name === entry.database);
    if (inventory.rows.some(item => item.name?.toLowerCase() === entry.database.toLowerCase() && item.name !== entry.database)) throw failure(409, 'A hospedagem retornou uma identificação ambígua do banco. Confira a vinculação antes de continuar.');
    if (!matches.length) { if (allowAbsent) return { absent: true }; throw failure(409, 'O banco não foi localizado na hospedagem. Confira a vinculação antes de excluir.'); }
    if (matches.length !== 1 || matches[0].user !== entry.user || inventory.rows.some(item => item.name !== entry.database && item.user.toLowerCase() === entry.user.toLowerCase())) throw failure(409, 'O vínculo exclusivo do banco e usuário precisa ser conferido.');
    const domain = matches[0].website_domain ?? matches[0].website?.domain ?? matches[0].domain;
    if (domain && domain !== config.onboarding.domain) throw failure(409, 'O banco pertence a outro site da hospedagem.');
    return { absent: false };
  }
  async function diagnosticBlockers(slug, db = null) {
    // Probes live in the operation database, while their OAuth credentials live
    // in the tenant database. Removing the tenant must not strand an agreement.
    const probes = await (db ?? await central()).query('SELECT provider_id, provider_status, state, issue, invoice_count, has_approved_invoice, lease_until FROM mp_diagnostic_probes WHERE tenant_slug = ? LIMIT 1001', [slug]);
    const zero = value => value === 0 || value === '0';
    const confirmed = probe => typeof probe.provider_id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(probe.provider_id) && probe.provider_status === 'cancelled' && probe.state === 'cancelled' && probe.issue === '' && zero(probe.invoice_count) && zero(probe.has_approved_invoice) && zero(probe.lease_until);
    return probes.length > 1000 || probes.some(probe => !confirmed(probe)) ? ['Há um diagnóstico de recebimentos aguardando encerramento ou conferência no Mercado Pago.'] : [];
  }
  async function blockers(slug, snapshot, db) {
    const reasons = await diagnosticBlockers(slug);
    if (snapshot.retention.hasCoverage) reasons.push('Existe um período pago ou de teste ainda vigente ou futuro.');
    if (snapshot.retention.closure && !snapshot.retention.closure.eligible) reasons.push('O prazo da solicitação de encerramento ainda não terminou.');
    const checks = [
      ["SELECT COUNT(*) AS total FROM license_contracts WHERE status <> 'cancelled' OR resolution <> ''", [], 'Há uma contratação, renovação ou pendência da mensalidade da plataforma.'],
      ["SELECT COUNT(*) AS total FROM license_cycles WHERE source = 'mercadopago' AND status NOT IN ('approved', 'rejected', 'cancelled', 'refunded', 'charged_back')", [], 'Há pagamento da mensalidade da plataforma ainda sem conclusão.'],
      ["SELECT COUNT(*) AS total FROM subscriptions WHERE (mode <> 'manual' AND state <> 'cancelled') OR resolution <> '' OR create_state = 'creating'", [], 'Há assinatura de consumidor ou pendência no Mercado Pago.'],
      ['SELECT COUNT(*) AS total FROM subscription_cycles WHERE valid = 1 AND ends_at > ?', [now()], 'Há período de consumidor pago ainda vigente ou futuro.'],
      ["SELECT COUNT(*) AS total FROM appointments WHERE status = 'in_progress' OR (status IN ('confirmed', 'awaiting_payment') AND ends_at > ?)", [now()], 'Há atendimento em andamento ou reserva futura.'],
      ["SELECT COUNT(*) AS total FROM mp_intents WHERE resolution <> '' OR state IN ('pending', 'in_process') OR checkout_state = 'creating' OR (state = 'waiting' AND expires_at > ?)", [now()], 'Há pagamento de atendimento aguardando conferência.'],
      ["SELECT COUNT(*) AS total FROM mp_payments WHERE status NOT IN ('approved', 'rejected', 'cancelled', 'refunded', 'charged_back')", [], 'Há pagamento de atendimento ainda sem conclusão.'],
      ["SELECT COUNT(*) AS total FROM subscription_renewal_jobs WHERE state = 'pending'", [], 'Há interrupção de renovação de consumidor ainda pendente.'],
    ];
    for (const [sql, params, message] of checks) { const [value] = await db.query(sql, params); if (Number(value.total) > 0) reasons.push(message); }
    return reasons;
  }
  function signPreview(value) {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
    return payload + '.' + createHmac('sha256', previewKey).update(payload).digest('base64url');
  }
  function verifyPreview(value, actor, slug, revision, fingerprint) {
    if (!previewKey || typeof value !== 'string' || value.length > 5000) throw failure(409, 'Atualize a prévia antes de confirmar a exclusão.');
    const [payload, signature, extra] = value.split('.');
    const expected = createHmac('sha256', previewKey).update(payload ?? '').digest('base64url');
    if (extra || !signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw failure(409, 'A prévia de exclusão é inválida.');
    let decoded; try { decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { throw failure(409, 'A prévia de exclusão é inválida.'); }
    if (decoded.actor !== actor.id || decoded.slug !== slug || decoded.revision !== revision || decoded.fingerprint !== fingerprint || !Number.isSafeInteger(decoded.expiresAt) || decoded.expiresAt < now()) throw failure(409, 'A prévia mudou ou expirou. Confira o cliente novamente.');
    return decoded;
  }
  async function previewDeletion(actor, slug) {
    requireOperator(actor); const entry = targetEntry(slug), db = await central(), current = await row(db, slug), previous = summaryOf(current);
    const resuming = ['deleting', 'attention'].includes(current?.state);
    let snapshot, blockedReasons = [], absent = false;
    if (resuming) { snapshot = { ...previous, retention: tenantRetention(previous.license, now(), { futurePaidUntil: previous.retention?.paidUntil ?? 0, hasPaidHistory: previous.retention?.hasEverActivated, lifecycle: current }) }; blockedReasons = await diagnosticBlockers(slug, db); }
    else { snapshot = await facts(slug, current); blockedReasons = await blockers(slug, snapshot, await database(slug)); }
    if (!['archived', 'attention', 'deleting'].includes(current?.state)) blockedReasons.push('Arquive este cliente antes de apagar os dados.');
    if (resuming && previous.fingerprint !== databaseFingerprint(entry)) blockedReasons.push('O vínculo do banco mudou após o início da exclusão. Solicite a conferência assistida da Raelapps.');
    if (!previewKey || !provider || !withTenantQuiesced || !retireTenant) blockedReasons.push('A exclusão precisa da configuração protegida e do bloqueio de operações da hospedagem.');
    if (inFlight.has(slug)) blockedReasons.push('Já existe uma exclusão em andamento. Aguarde a conclusão e confira novamente.');
    if (current?.state === 'deleting' && previous.attempt?.active) {
      let finished = false;
      if (previous.attempt.host === worker.host && Number.isSafeInteger(previous.attempt.pid) && previous.attempt.pid > 0) {
        try { process.kill(previous.attempt.pid, 0); } catch (error) { finished = error.code === 'ESRCH'; }
      }
      if (!finished) blockedReasons.push('Uma execução anterior ainda pode estar ativa. Aguarde ou solicite a conferência assistida da Raelapps.');
    }
    try { absent = (await providerInventory(slug, entry, { allowAbsent: resuming })).absent; }
    catch (error) { blockedReasons.push(error.status ? error.message : 'Não foi possível conferir a hospedagem.'); }
    if (absent) { const [archive] = await db.query('SELECT slug FROM tenant_finance_archives WHERE slug = ?', [slug]); if (!archive) blockedReasons.push('O banco está ausente e o arquivo financeiro ainda não foi confirmado. Solicite conferência assistida.'); }
    const expiresAt = now() + 300000, fingerprint = databaseFingerprint(entry), eligible = blockedReasons.length === 0;
    return { slug, name: snapshot.name ?? slug, state: current?.state ?? 'open', revision: Number(current?.revision ?? 0), eligible, blockedReasons, confirmation: 'EXCLUIR ' + slug, previewToken: eligible ? signPreview({ slug, actor: actor.id, revision: Number(current.revision), fingerprint, expiresAt, nonce: token() }) : null, expiresAt, counts: snapshot.counts ?? {}, retention: snapshot.retention, cohort: snapshot.retention?.cohort ?? 'trial', financialArchiveRetained: true, databaseReleasable: eligible, userRemovalSupported: false, databaseAlreadyAbsent: absent, backupsNotice };
  }
  async function saveFinancialArchive(tx, slug, name, targetDb) {
    const cycles = await targetDb.query('SELECT id, source, mode, amount_cents, starts_at, ends_at, valid, status, paid_at, created_at, plan_id, payment_method FROM license_cycles LIMIT 10001');
    const entries = await targetDb.query('SELECT id, cycle_id, mode, source, kind, amount_cents, occurred_at, created_at FROM license_money_entries LIMIT 10001');
    const snapshots = await targetDb.query('SELECT payment_key, cycle_id, received_cents, reversed_cents, provider_updated_at FROM license_money_snapshots LIMIT 10001');
    if ([cycles, entries, snapshots].some(items => items.length > 10000)) throw failure(409, 'O histórico financeiro exige uma exportação assistida antes de excluir.');
    const payload = JSON.stringify({ version: 1, cycles, entries, snapshots }), [old] = await tx.query('SELECT slug FROM tenant_finance_archives WHERE slug = ?', [slug]);
    if (old) await tx.query('UPDATE tenant_finance_archives SET name = ?, payload_json = ?, archived_at = ? WHERE slug = ?', [name, payload, now(), slug]);
    else await tx.query('INSERT INTO tenant_finance_archives(slug, name, payload_json, archived_at) VALUES (?, ?, ?, ?)', [slug, name, payload, now()]);
  }
  async function finishDeleted(actor, slug, key) {
    return operatorSession(actor, async (tx, currentActor) => {
      const current = await row(tx, slug, true);
      if (!current || current.deletion_key !== key) throw failure(409, 'A exclusão mudou. Confira a situação do cliente.');
      const summary = summaryOf(current);
      const [archive] = await tx.query('SELECT slug FROM tenant_finance_archives WHERE slug = ?', [slug]);
      if (!archive) throw failure(409, 'O arquivo financeiro precisa ser confirmado antes de concluir.');
      const requests = await tx.query('SELECT * FROM operation_requests WHERE slug = ?', [slug]);
      for (const request of requests) if (request.deleted_at == null) await scrubRegistrationRequest(tx, request, currentActor, now(), digest('tenant-request-deleted:' + slug + ':' + request.id + ':' + key));
      await tx.query("UPDATE automatic_registrations SET state = 'deleted', claim_cipher = '{}', payload_cipher = '{}', signature = ?, lease_until = 0, next_attempt_at = 0, category = 'deleted', updated_at = ? WHERE slug = ?", [digest('deleted:' + slug), now(), slug]);
      await tx.query('DELETE FROM managed_tenants WHERE slug = ?', [slug]);
      await tx.query('DELETE FROM mp_application_claims WHERE tenant_slug = ?', [slug]);
      const saved = await persist(tx, current, slug, 'deleted', currentActor, { name: summary.name ?? slug, license: summary.license, retention: summary.retention, activeProfessionals: 0, counts: summary.counts, closure: summary.closure ?? null, fingerprint: summary.fingerprint }, { deleted_at: now(), deletion_stage: 'verified', error_code: '' });
      await audit(tx, currentActor, 'platform_tenant_deleted', { slug, databaseVerifiedAbsent: true, financialArchiveRetained: true, revision: saved.revision });
      return { ok: true, state: 'deleted', deleted: true, verifiedDatabaseReleased: true, revision: saved.revision, userRemoved: false, message: 'Dados operacionais excluídos e banco liberado. O usuário MySQL não teve sua remoção confirmada pela API da hospedagem.' };
    });
  }
  async function deleteTenant(actor, input) {
    only(input, ['slug', 'revision', 'confirmation', 'previewToken', 'idempotencyKey', 'acknowledged']); requireOperator(actor);
    if (!validSlug(input.slug) || !Number.isSafeInteger(input.revision) || input.revision < 1 || !uuid(input.idempotencyKey) || input.acknowledged !== true || input.confirmation !== 'EXCLUIR ' + input.slug) throw failure(422, 'Confirme explicitamente o cliente e a exclusão definitiva.');
    const db = await central(), previous = await row(db, input.slug), key = digest('delete:' + input.slug + ':' + input.idempotencyKey);
    if (previous?.state === 'deleted') return { ok: true, state: 'deleted', deleted: true, verifiedDatabaseReleased: true, revision: Number(previous.revision), repeated: true, userRemoved: false };
    const entry = targetEntry(input.slug), fingerprint = databaseFingerprint(entry);
    verifyPreview(input.previewToken, actor, input.slug, input.revision, fingerprint);
    if (!provider || !withTenantQuiesced || !retireTenant || !previewKey || inFlight.has(input.slug)) throw failure(409, 'A exclusão está indisponível ou já está sendo executada.');
    const preflight = await previewDeletion(actor, input.slug);
    if (!preflight.eligible || preflight.revision !== input.revision) throw failure(409, preflight.blockedReasons[0] ?? 'O cliente mudou. Atualize a prévia.');
    inFlight.add(input.slug);
    try {
      await operatorSession(actor, async (tx, currentActor) => {
        const current = await row(tx, input.slug, true);
        if (!current || Number(current.revision) !== input.revision || !['archived', 'attention', 'deleting'].includes(current.state)) throw failure(409, 'O cliente mudou. Atualize a prévia.');
        const summary = { ...summaryOf(current), name: preflight.name, retention: preflight.retention, counts: preflight.counts, fingerprint, attempt: { ...worker, active: true } };
        await persist(tx, current, input.slug, 'deleting', currentActor, summary, { deletion_key: key, deletion_stage: current.deletion_stage && current.deletion_stage !== 'quiescing' ? current.deletion_stage : 'quiescing', error_code: '' });
        await audit(tx, currentActor, 'platform_tenant_deletion_requested', { slug: input.slug, idempotencyKey: key, previousState: current.state });
      });
      const inventory = await providerInventory(input.slug, entry, { allowAbsent: true });
      if (!inventory.absent) await withTenantQuiesced(input.slug, async () => {
        const targetDb = await database(input.slug), current = await row(db, input.slug), snapshot = await facts(input.slug, current);
        const reasons = await blockers(input.slug, snapshot, targetDb);
        if (reasons.length) throw failure(409, reasons[0]);
        if (databaseFingerprint(config.entries[input.slug]) !== fingerprint) throw failure(409, 'O vínculo do banco mudou durante a exclusão.');
        await providerInventory(input.slug, entry);
        await operatorSession(actor, async (tx, currentActor) => {
          const locked = await row(tx, input.slug, true);
          if (!locked || locked.deletion_key !== key || locked.state !== 'deleting') throw failure(409, 'A exclusão mudou durante a conferência.');
          await saveFinancialArchive(tx, input.slug, snapshot.name, targetDb);
          const oldSummary = summaryOf(locked), summary = { ...snapshot, fingerprint, attempt: oldSummary.attempt, ...(oldSummary.closure ? { closure: oldSummary.closure } : {}) };
          await persist(tx, locked, input.slug, 'deleting', currentActor, summary, { deletion_stage: 'provider_delete' });
        });
        await retireTenant(input.slug);
        // The fresh operator session is held only for the provider action, after
        // the durable intent and financial snapshot already committed.
        await operatorSession(actor, async () => { await provider.remove(entry.database); });
      });
      const verification = await providerInventory(input.slug, entry, { allowAbsent: true });
      if (!verification.absent) throw Object.assign(failure(409, 'A hospedagem ainda não confirmou a remoção. Confira a situação antes de repetir.'), { category: 'provider_pending' });
      const result = await finishDeleted(actor, input.slug, key);
      if (finalizeTenant) await finalizeTenant(input.slug);
      return result;
    } catch (error) {
      try { await operatorSession(actor, async (tx, currentActor) => {
        const current = await row(tx, input.slug, true);
        if (current?.state === 'deleting' && current.deletion_key === key) {
          const category = ['provider_pending', 'provider_uncertain', 'provider_access', 'provider_busy', 'provider_rejected'].includes(error.category) ? error.category : error.status === 409 ? 'verification_required' : 'deletion_interrupted';
          const summary = summaryOf(current);
          await persist(tx, current, input.slug, 'attention', currentActor, { ...summary, attempt: { ...summary.attempt, active: false } }, { error_code: category });
          await audit(tx, currentActor, 'platform_tenant_deletion_attention', { slug: input.slug, category });
        }
      }); } catch { /* The durable deleting intent still blocks access and retry is manual. */ }
      throw error;
    } finally { inFlight.delete(input.slug); }
  }
  async function closureData(slug, actor, current = undefined, targetTx = null, knownService = null) {
    requireManager(slug, actor); targetEntry(slug);
    const db = current === undefined ? await central() : null, lifecycle = current === undefined ? await row(db, slug) : current, snapshot = await facts(slug, lifecycle, targetTx, knownService), previous = closureFromLifecycle(lifecycle);
    const targetDb = targetTx ?? await database(slug), contracts = await targetDb.query("SELECT provider_id, status, resolution, create_state FROM license_contracts WHERE status <> 'cancelled' OR resolution <> ''");
    const blockedReasons = [];
    if (['deleting', 'deleted', 'attention'].includes(lifecycle?.state)) blockedReasons.push('Este negócio já está sob análise de exclusão pela Raelapps.');
    if (contracts.some(contract => contract.resolution || !contract.provider_id)) blockedReasons.push('Confira a criação ou pendência da mensalidade antes de solicitar o encerramento.');
    const coveredUntil = Math.max(previous?.coveredUntil ?? 0, snapshot.retention.expiresAt ?? 0, previous ? 0 : now());
    const deleteEligibleAt = Math.max(previous?.deleteEligibleAt ?? 0, coveredUntil + 7 * DAY);
    return { slug, revision: Number(lifecycle?.revision ?? 0), status: previous ? coveredUntil > now() ? 'closing' : 'deletion_wait' : lifecycle?.state ?? 'open', requestedAt: previous?.requestedAt ?? null, coveredUntil, deleteEligibleAt, daysRemaining: Math.max(0, Math.ceil((deleteEligibleAt - now()) / DAY)), canRequest: !previous && blockedReasons.length === 0, blockedReasons, requiresRenewalCancellation: contracts.some(contract => contract.provider_id && contract.status !== 'cancelled'), disclaimer: refundDisclaimer, snapshot, lifecycle, contracts };
  }
  const publicClosure = value => Object.fromEntries(['slug', 'revision', 'status', 'requestedAt', 'coveredUntil', 'deleteEligibleAt', 'daysRemaining', 'canRequest', 'blockedReasons', 'requiresRenewalCancellation', 'disclaimer'].map(key => [key, value[key]]));
  async function viewClosure(slug, actor) { return publicClosure(await closureData(slug, actor)); }
  async function withLicensePurchaseAllowed(slug, actor, work) {
    requireManager(slug, actor); targetEntry(slug);
    const centralDb = await central();
    return withTenant(slug, () => centralDb.transaction(async tx => {
      await readSettings(tx, true);
      const current = await row(tx, slug, true);
      if (closureFromLifecycle(current) || ['deleting', 'attention', 'deleted'].includes(current?.state)) throw failure(409, 'Este negócio está em processo de encerramento. Fale com a Raelapps antes de contratar outro período.');
      return work();
    }));
  }
  async function requestClosure(slug, actor, input) {
    requireManager(slug, actor); targetEntry(slug);
    if (operatorAllowed(actor)) throw failure(403, 'Use o acesso do gestor para registrar esta solicitação.');
    only(input, ['revision', 'idempotencyKey', 'acknowledged', 'cancelRenewalAccepted']);
    if (!Number.isSafeInteger(input.revision) || input.revision < 0 || !uuid(input.idempotencyKey) || input.acknowledged !== true || input.cancelRenewalAccepted !== true) throw failure(422, 'Confirme o encerramento, o prazo e a interrupção das próximas renovações.');
    const before = await closureData(slug, actor), requestKey = digest('closure:' + slug + ':' + input.idempotencyKey);
    const oldClosure = closureFromLifecycle(before.lifecycle);
    if (oldClosure) {
      if (oldClosure.requestKey === requestKey) return { ok: true, ...publicClosure(before), repeated: true };
      throw failure(409, 'Já existe uma solicitação de encerramento para este negócio.');
    }
    if (!before.canRequest || before.revision !== input.revision) throw failure(409, before.blockedReasons[0] ?? 'A situação mudou. Confira o prazo novamente.');
    const service = await getService(slug);
    // The owner consent is explicit. This stops future platform recurrence only;
    // no refund, new payment or consumer subscription is initiated here.
    if (before.requiresRenewalCancellation) {
      // Hold the current owner session only across the provider PUT. Canonical
      // reconciliation and its own target transactions happen after that lock.
      await service.withCurrentSession(actor, async () => {});
      await service.license.cancel(actor, { authorizeProvider: work => service.withCurrentSession(actor, async (_tx, current) => {
        requireManager(slug, { ...current, tenant: slug });
        return work();
      }) });
    }
    const centralDb = await central();
    return withTenant(slug, () => centralDb.transaction(async tx => {
        await readSettings(tx, true); const current = await row(tx, slug, true);
        if (Number(current?.revision ?? 0) !== input.revision) throw failure(409, 'A situação mudou. Confira o encerramento novamente.');
        return service.withCurrentSession(actor, async (targetTx, currentActor) => {
        const checked = await closureData(slug, { ...currentActor, tenant: slug }, current, targetTx, service);
        if (checked.contracts.some(contract => contract.status !== 'cancelled' || contract.resolution)) throw failure(409, 'A interrupção da renovação ainda não foi confirmada. Nenhum encerramento foi registrado.');
        const at = now(), coveredUntil = Math.max(at, checked.snapshot.retention.expiresAt ?? 0), deleteEligibleAt = coveredUntil + 7 * DAY;
        const closure = { requestKey, requestedAt: at, requestedBy: currentActor.id, coveredUntil, deleteEligibleAt, termsVersion: legalVersions.terms, privacyVersion: legalVersions.privacy };
        const summary = { ...checked.snapshot, closure };
        const saved = await persist(tx, current, slug, 'closing', currentActor, summary);
        await audit(tx, currentActor, 'platform_tenant_closure_requested', { slug, coveredUntil, deleteEligibleAt, termsVersion: legalVersions.terms, privacyVersion: legalVersions.privacy });
        return { ok: true, slug, revision: saved.revision, status: coveredUntil > at ? 'closing' : 'deletion_wait', requestedAt: at, coveredUntil, deleteEligibleAt, daysRemaining: Math.ceil((deleteEligibleAt - at) / DAY), canRequest: false, blockedReasons: [], requiresRenewalCancellation: false, disclaimer: refundDisclaimer };
        });
    }));
  }
  return { list, lookup, archive, previewDeletion, deleteTenant, viewClosure, requestClosure, withLicensePurchaseAllowed, operatorAllowed };
}

export function archivedLicenseMoneyReport(payload, mode, period, includeEntries = false) {
  const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
  if (data?.version !== 1 || !Array.isArray(data.entries) || !Array.isArray(data.cycles)) throw Error('Arquivo financeiro inválido.');
  const rows = data.entries.filter(entry => entry.mode === mode && Number(entry.occurred_at) >= period.start && Number(entry.occurred_at) < period.end);
  const totals = { receiptsCents: 0, reversalsCents: 0, onlineNetCents: 0, manualNetCents: 0, netCents: 0 };
  for (const entry of rows) { const amount = Number(entry.amount_cents), receipt = entry.kind === 'receipt'; totals[receipt ? 'receiptsCents' : 'reversalsCents'] += amount; totals[entry.source === 'manual' ? 'manualNetCents' : 'onlineNetCents'] += receipt ? amount : -amount; }
  totals.netCents = totals.receiptsCents - totals.reversalsCents;
  rows.sort((a, b) => Number(b.occurred_at) - Number(a.occurred_at) || Number(b.created_at) - Number(a.created_at) || a.id.localeCompare(b.id));
  const selected = includeEntries ? rows.slice(period.offset, period.offset + 26) : [];
  const historicalPending = data.cycles.filter(cycle => cycle.mode === mode && cycle.paid_at !== null && !data.entries.some(entry => entry.cycle_id === cycle.id)).length;
  return { totals, historicalPending, hasMore: selected.length > 25, entries: selected.slice(0, 25).map(entry => ({ id: entry.id, cycleId: entry.cycle_id, source: entry.source, kind: entry.kind, amountCents: Number(entry.amount_cents), occurredAt: Number(entry.occurred_at), note: 'Registro financeiro de cliente encerrado' })) };
}
