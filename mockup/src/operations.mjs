import { randomUUID } from 'node:crypto';
import { validSlug } from './configuration.mjs';
import { readSettings } from './database.mjs';
import { digest, failure, isEmail, normalizeEmail, rateLimit, token } from './security.mjs';
import { licenseMoneyReport, platformPeriod } from './platform-finance.mjs';
import { platformBillingForTenant } from './platform-billing.mjs';
import { readMetadata } from './metadata.mjs';
import { createTenantLifecycle, archivedLicenseMoneyReport } from './tenant-lifecycle.mjs';
import { closureFromLifecycle } from './tenant-retention.mjs';
import { createPaymentDiagnostics } from './payment-diagnostics.mjs';
import { createRegistrationAdmin } from './registration-admin.mjs';

const only = (v, keys) => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) throw failure(422, 'Confira os dados enviados.'); };
export function createOperations(config, get, database, { retryAutomatic, withTenantQuiesced, retireTenant, finalizeTenant, withTenant = async (_slug, work) => work() } = {}) {
  const now = config.now ?? (() => Date.now());
  const allowed = (slug, user) => Boolean(config.operations?.tenant === slug && user.role === 'admin' && config.operations.userIds.includes(user.id));
  const lifecycle = createTenantLifecycle(config, { getService: get, database, withTenantQuiesced, retireTenant, finalizeTenant, withTenant });
  const paymentDiagnostics = createPaymentDiagnostics(config, { getService: get, database, withTenant });
  const registrationAdmin = createRegistrationAdmin(config, { getService: get, database, lifecycle });
  function entry(req, query) {
    const operations = config.operations;
    if (!config.enabled || !operations || !validSlug(operations.tenant) || !Object.hasOwn(config.entries, operations.tenant) || !Array.isArray(operations.userIds) || !operations.userIds.length) throw failure(404, 'Operação não disponível.');
    if (req.method !== 'GET') throw failure(405, 'Ação não permitida.');
    only(query, []);
    // This is only login discovery. Authentication still uses the configured
    // tenant's normal password, cookie, CSRF and operator allowlist checks.
    return { loginUrl: `/sistema/${operations.tenant}?retorno=operacao` };
  }
  async function actor(req) {
    if (!config.enabled || !config.operations) throw failure(404, 'Operação não disponível.');
    const service = await get(config.operations.tenant), cookie = String(req.headers.cookie ?? '').split(';').map(v => v.trim()).find(v => v.startsWith(service.cookieName + '='));
    const user = await service.session(cookie?.slice(service.cookieName.length + 1));
    if (!allowed(config.operations.tenant, user)) throw failure(403, 'Acesso reservado à operação da plataforma.');
    if (req.method !== 'GET') { if (req.headers.origin !== config.origin) throw failure(403, 'Abra o endereço oficial.'); service.verifyCsrf(user, req.headers['x-csrf-token']); }
    return { ...user, tenant: config.operations.tenant };
  }
  async function target(slug) { if (!validSlug(slug) || !Object.hasOwn(config.entries, slug)) throw failure(404, 'Negócio ainda não provisionado.'); return get(slug); }
  function trialLifecycleReason(current) {
    try { if ((current?.state ?? 'open') !== 'open' || closureFromLifecycle(current)) return 'Este negócio está arquivado ou em processo de encerramento. Reabra a conta antes de prorrogar o teste.'; }
    catch { return 'A situação do encerramento deste negócio precisa ser conferida.'; }
    return '';
  }
  async function audit(tx, user, event, details) { await tx.query('INSERT INTO audit_events(id, actor_id, event_name, detail_json, created_at) VALUES (?, ?, ?, ?, ?)', [randomUUID(), user.id, event, JSON.stringify(details), now()]); }
  async function preparation(db, id, revision) {
    const [r] = await db.query('SELECT * FROM operation_requests WHERE id = ?', [id ?? '']);
    if (!r || Number(r.revision) !== revision) throw failure(409, 'A preparação mudou. Atualize a página.');
    if (r.archived_at != null || r.deleted_at != null) throw failure(409, 'Esta solicitação está arquivada ou foi removida. Consulte o histórico.');
    return r;
  }
  const samePreparation = (r, preview) => r.slug === preview.slug && r.owner_email === preview.owner_email && r.owner_name === preview.owner_name;
  async function handle(req, path, query, input) {
    const user = await actor(req), db = await database(config.operations.tenant);
    if (path === 'session' && req.method === 'GET') return { name: user.name, csrf: user.csrf, tenant: user.tenant };
    if (path === 'payment-diagnostics' && req.method === 'GET') { only(query, []); return paymentDiagnostics.view(user); }
    if (path === 'payment-diagnostics/payment' && req.method === 'GET') return paymentDiagnostics.paymentStatus(user, query);
    if (['payment-diagnostics/start', 'payment-diagnostics/refresh', 'payment-diagnostics/cancel'].includes(path) && req.method === 'POST') {
      only(query, []);
      return paymentDiagnostics[path.split('/')[1]](user, input);
    }
    if (path === 'access' && req.method === 'GET') {
      only(query, ['slug']);
      return (await target(query.slug)).operatorAccess(user);
    }
    if (path === 'access/recovery' && req.method === 'POST') {
      only(input, ['slug', 'userId', 'identityConfirmed']);
      if (input.identityConfirmed !== true) throw failure(422, 'Confirme a identidade da pessoa antes de gerar a recuperação.');
      const service = await target(input.slug), targetDb = await database(input.slug), operatorService = await get(config.operations.tenant);
      await rateLimit(db, `operator_recovery:${user.id}`, 10, 60 * 60 * 1000);
      await rateLimit(targetDb, 'recovery', 10, 60 * 60 * 1000);
      // Hold the operator's current session while creating the target grant, so
      // a concurrent reset, logout or role change cannot authorize a stale request.
      return withTenant(input.slug, () => operatorService.withCurrentSession(user, async (tx, current, settings) => {
        if (!allowed(current.tenant, current)) throw failure(403, 'Acesso reservado à operação da plataforma.');
        return service.operatorRecovery(current, input.userId, targetDb === db ? tx : undefined, targetDb === db ? settings : undefined);
      }));
    }
    if (path === 'finance' && req.method === 'GET') {
      const period = platformPeriod(query, now()), mode = query.mode ?? config.platformBilling?.mode ?? (config.testMode ? 'sandbox' : 'live');
      if (!['sandbox', 'live'].includes(mode)) throw failure(422, 'Ambiente financeiro inválido.');
      const archives = await db.query('SELECT slug, name, payload_json FROM tenant_finance_archives'), archiveBySlug = new Map(archives.map(item => [item.slug, item]));
      const lifecycleRows = await db.query('SELECT slug, state FROM tenant_lifecycle'), retired = new Set(lifecycleRows.filter(item => ['deleting', 'attention', 'deleted'].includes(item.state)).map(item => item.slug));
      const archiveSlugs = archives.filter(item => { const payload = JSON.parse(item.payload_json); return payload.entries.some(entry => entry.mode === mode) || payload.cycles.some(cycle => cycle.mode === mode); }).map(item => item.slug);
      const slugs = [...new Set([...Object.keys(config.entries).filter(slug => platformBillingForTenant(config, slug).mode === mode), ...archiveSlugs])].sort();
      if (slugs.length > 100) throw failure(422, 'A consolidação atende até 100 negócios. Amplie a rotina antes de adicionar novos clientes.');
      if (query.slug && !slugs.includes(query.slug)) throw failure(404, 'Negócio não encontrado.');
      const states = ['all', 'active', 'trial', 'overdue', 'suspended', 'awaiting_payment', 'cancelled', 'validation'];
      if (!states.includes(query.state ?? 'all')) throw failure(422, 'Situação inválida.');
      const businesses = [], unavailable = [], totals = { receiptsCents: 0, reversalsCents: 0, netCents: 0, onlineNetCents: 0, manualNetCents: 0 }, counts = { paidActive: 0, trial: 0, overdue: 0, blocked: 0, validation: 0 }, choices = [];
      let monthlyRecurringCents = 0, historicalPending = 0, selectedEntries = [], entryHasMore = false;
      for (const slug of slugs) {
        try {
          if (retired.has(slug)) {
            const archive = archiveBySlug.get(slug);
            if (!archive) { if (!query.slug || query.slug === slug) unavailable.push(slug); continue; }
            const name = archive.name; choices.push({ slug, name });
            if (query.slug && query.slug !== slug || query.state && query.state !== 'all' && query.state !== 'cancelled') continue;
            const report = archivedLicenseMoneyReport(archive.payload_json, mode, period, query.slug === slug);
            historicalPending += report.historicalPending;
            for (const key of Object.keys(totals)) totals[key] += report.totals[key];
            counts.blocked++;
            businesses.push({ slug, name, state: 'cancelled', renewing: false, paidUntil: null, graceUntil: null, trialEndsAt: null, totals: report.totals, archived: true });
            if (query.slug === slug) { selectedEntries = report.entries; entryHasMore = report.hasMore; }
            continue;
          }
          const service = await get(slug), targetDb = await database(slug), settings = await readSettings(targetDb), state = await service.license.state();
          const name = settings.draft.business.name; choices.push({ slug, name });
          if (query.slug && query.slug !== slug || query.state && query.state !== 'all' && state.state !== query.state) continue;
          const report = await licenseMoneyReport(targetDb, mode, period, query.slug === slug);
          const [legacy] = await targetDb.query('SELECT COUNT(*) AS total FROM license_cycles c WHERE c.mode = ? AND c.paid_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM license_money_entries m WHERE m.cycle_id = c.id)', [mode]);
          historicalPending += Number(legacy.total); for (const key of Object.keys(totals)) totals[key] += report.totals[key];
          if (state.state === 'active') { counts.paidActive++; if (state.renewing) monthlyRecurringCents += state.priceCents; }
          else if (state.state === 'trial') counts.trial++;
          else if (state.state === 'overdue') counts.overdue++;
          else if (state.state === 'validation') counts.validation++;
          else counts.blocked++;
          businesses.push({ slug, name, state: state.state, renewing: Boolean(state.renewing), paidUntil: state.paidUntil, graceUntil: state.graceUntil, trialEndsAt: state.trialEndsAt ?? null, totals: report.totals });
          if (query.slug === slug) { selectedEntries = report.entries; entryHasMore = report.hasMore; }
        } catch { if (!query.slug || query.slug === slug) unavailable.push(slug); }
      }
      const operationalReserveCents = Math.round(Math.max(0, totals.netCents) * 0.2);
      return { from: period.from, to: period.to, timeZone: 'America/Sao_Paulo', mode, slug: query.slug ?? '', state: query.state ?? 'all', offset: period.offset, choices, counts, totals, monthlyRecurringCents, operationalReserveCents, afterReserveCents: totals.netCents - operationalReserveCents, businesses: businesses.slice(query.slug ? 0 : period.offset, query.slug ? 1 : period.offset + 20), hasMore: query.slug ? entryHasMore : businesses.length > period.offset + 20, entries: selectedEntries, unavailable, historicalPending, incomplete: unavailable.length > 0 || historicalPending > 0 };
    }
    if (path === 'businesses' && req.method === 'GET') {
      const result = await lifecycle.list(query);
      const pending = await registrationAdmin.list(user, { view: 'pending' });
      return { ...result, requests: pending.requests, requestCount: pending.total, requestsHasMore: pending.hasMore };
    }
    if (path === 'requests' && req.method === 'GET') return registrationAdmin.list(user, query);
    if (path === 'requests/detail' && req.method === 'GET') return registrationAdmin.detail(user, query);
    if (path === 'requests/archive' && req.method === 'POST') { only(query, []); return registrationAdmin.archive(user, input); }
    if (path === 'requests/deletion-preview' && req.method === 'GET') return registrationAdmin.deletionPreview(user, query);
    if (path === 'requests/delete' && req.method === 'POST') { only(query, []); return registrationAdmin.deleteRequest(user, input); }
    if (path === 'businesses/deletion-preview' && req.method === 'GET') { only(query, ['slug']); return lifecycle.previewDeletion(user, query.slug); }
    if (path === 'businesses/archive' && req.method === 'POST') return lifecycle.archive(user, input);
    if (path === 'businesses/delete' && req.method === 'POST') return lifecycle.deleteTenant(user, input);
    if (path === 'requests/retry' && req.method === 'POST') {
      only(input, ['id']); if (typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/.test(input.id) || !retryAutomatic) throw failure(422, 'Preparação automática inválida.');
      const [current] = await db.query('SELECT archived_at, deleted_at FROM operation_requests WHERE id = ?', [input.id]);
      if (!current || current.archived_at != null || current.deleted_at != null) throw failure(409, 'Esta solicitação está arquivada ou foi removida. Consulte o histórico.');
      return retryAutomatic(input.id, user.id);
    }
    if (path === 'license' && req.method === 'GET') {
      const service = await target(query.slug), detail = await service.license.view(user);
      const webhookReceipts = await service.license.webhookReceipts();
      const [request] = await db.query('SELECT metadata_json FROM operation_requests WHERE slug = ?', [query.slug]);
      const [currentLifecycle] = await db.query('SELECT * FROM tenant_lifecycle WHERE slug = ?', [query.slug]);
      const extension = await service.license.trialExtension(user), lifecycleBlock = trialLifecycleReason(currentLifecycle);
      const trialExtension = lifecycleBlock ? { ...extension, canExtend: false, blockedReason: lifecycleBlock } : extension;
      return { ...detail, trialExtension, testPlan: await service.license.testPlan(), metadata: readMetadata(request?.metadata_json), webhookReceipts, ...(query.slug === config.operations.tenant ? {} : { accountClosure: await lifecycle.viewClosure(query.slug, user) }) };
    }
    if (path === 'license/trial-extension' && req.method === 'POST') {
      only(query, []); only(input, ['slug', 'days', 'note', 'expectedEndsAt', 'idempotencyKey']);
      if (input.slug === config.operations.tenant) throw failure(403, 'A gestão da Raelapps é protegida. A prorrogação é exclusiva para os clientes da plataforma.');
      const service = await target(input.slug), targetDb = await database(input.slug), operatorService = await get(config.operations.tenant);
      await rateLimit(db, `operator_trial_extension:${user.id}`, 60, 60000);
      return withTenant(input.slug, () => operatorService.withCurrentSession(user, async (tx, current) => {
        if (!allowed(current.tenant, current)) throw failure(403, 'Acesso reservado à operação da plataforma.');
        const [checkedLifecycle] = await tx.query('SELECT * FROM tenant_lifecycle WHERE slug = ?', [input.slug]), blockedReason = trialLifecycleReason(checkedLifecycle);
        if (blockedReason) throw failure(409, blockedReason);
        return service.license.extendTrial(current, { days: input.days, note: input.note, expectedEndsAt: input.expectedEndsAt, idempotencyKey: input.idempotencyKey }, targetDb === db ? tx : undefined);
      }));
    }
    if (['license/test-plan', 'license/manual'].includes(path) && req.method === 'POST') {
      if (path === 'license/test-plan') only(input, ['slug', 'visible', 'revision']);
      else { only(input, ['slug', 'idempotencyKey', 'note', 'receivedConfirmed', 'planId', 'paymentMethod']); if (input.receivedConfirmed !== true) throw failure(422, 'Confirme o recebimento antes de registrar a mensalidade.'); }
      const service = await target(input.slug), targetDb = await database(input.slug), operatorService = await get(config.operations.tenant);
      const [currentLifecycle] = await db.query('SELECT * FROM tenant_lifecycle WHERE slug = ?', [input.slug]);
      if (closureFromLifecycle(currentLifecycle)) throw failure(409, 'O negócio solicitou encerramento. Novas ativações e mensalidades estão bloqueadas.');
      // Revalidate and hold the real operator session through the target write.
      // Reuse the locked transaction when operating on the central tenant itself.
      return withTenant(input.slug, () => operatorService.withCurrentSession(user, async (tx, current) => {
        if (!allowed(current.tenant, current)) throw failure(403, 'Acesso reservado à operação da plataforma.');
        const [checkedLifecycle] = await tx.query('SELECT * FROM tenant_lifecycle WHERE slug = ?', [input.slug]);
        if (closureFromLifecycle(checkedLifecycle)) throw failure(409, 'O negócio solicitou encerramento. Novas ativações e mensalidades estão bloqueadas.');
        const transaction = targetDb === db ? tx : undefined;
        return path === 'license/test-plan'
          ? service.license.setTestPlan(current, { visible: input.visible, revision: input.revision }, transaction)
          : service.license.manual(current, { idempotencyKey: input.idempotencyKey, note: input.note, ...(input.planId !== undefined ? { planId: input.planId } : {}), ...(input.paymentMethod !== undefined ? { paymentMethod: input.paymentMethod } : {}) }, transaction);
      }));
    }
    if (path === 'requests' && req.method === 'POST') {
      only(input, ['slug', 'name', 'ownerName', 'ownerEmail', 'notes']);
      const email = normalizeEmail(input.ownerEmail), text = v => typeof v === 'string' && v.trim().length >= 2 && v.length <= 120;
      if (!validSlug(input.slug) || Object.hasOwn(config.entries, input.slug) || !text(input.name) || !text(input.ownerName) || !isEmail(email) || typeof input.notes !== 'string' || input.notes.length > 500) throw failure(422, 'Informe os dados do novo negócio e um identificador livre.');
      return db.transaction(async tx => { await readSettings(tx, true); const [old] = await tx.query('SELECT id FROM operation_requests WHERE slug = ?', [input.slug]); if (old) throw failure(409, 'Já há uma preparação para esse endereço.'); const id = randomUUID(); await tx.query('INSERT INTO operation_requests(id, slug, name, owner_name, owner_email, status, notes, revision, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, input.slug, input.name.trim(), input.ownerName.trim(), email, 'received', input.notes.trim(), 1, user.id, now(), now()]); await audit(tx, user, 'business_preparation_requested', { id, slug: input.slug }); return { id, ok: true }; });
    }
    if (path === 'requests/status' && req.method === 'POST') {
      only(input, ['id', 'revision', 'status']); if (!['preparing', 'ready', 'cancelled'].includes(input.status) || !Number.isInteger(input.revision)) throw failure(422, 'Situação inválida.');
      const [automatic] = await db.query('SELECT id FROM operation_requests WHERE id = ? AND created_by = ?', [input.id, 'automatic']);
      if (automatic) throw failure(409, 'Este cadastro é preparado automaticamente. Atualize a lista ou use Retomar preparação.');
      let preview, preparedEntry;
      if (input.status === 'ready') {
        preview = await preparation(db, input.id, input.revision);
        if (!['received', 'preparing'].includes(preview.status)) throw failure(409, 'Essa preparação já foi encerrada. Atualize a lista antes de continuar.');
        if (!Object.hasOwn(config.entries, preview.slug)) throw failure(409, 'Prepare e confira o banco e o usuário exclusivos na hospedagem antes de marcar como pronto.');
        preparedEntry = config.entries[preview.slug];
        // Refresh may consult the central application registry. Complete it before
        // locking that registry, then check the request again under its lock.
        await target(preview.slug);
        await readSettings(await database(preview.slug));
      }
      return db.transaction(async tx => {
        await readSettings(tx, true);
        const r = await preparation(tx, input.id, input.revision);
        if (!['received', 'preparing'].includes(r.status)) throw failure(409, 'Essa preparação já foi encerrada. Atualize a lista antes de continuar.');
        if (input.status === 'ready' && (!samePreparation(r, preview) || config.entries[r.slug] !== preparedEntry)) throw failure(409, 'O provisionamento mudou. Confira os dados e atualize a página.');
        await tx.query('UPDATE operation_requests SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ?', [input.status, now(), r.id]);
        await audit(tx, user, 'business_preparation_status', { id: r.id, status: input.status });
        return { ok: true };
      });
    }
    if (path === 'requests/access' && req.method === 'POST') {
      only(input, ['id', 'revision', 'identityConfirmed']);
      if (typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/.test(input.id) || !Number.isInteger(input.revision) || input.revision < 1 || input.identityConfirmed !== true) throw failure(422, 'Confira a identidade do responsável antes de liberar o primeiro acesso.');
      const preview = await preparation(db, input.id, input.revision);
      if (preview.status !== 'ready' || preview.slug === config.operations.tenant) throw failure(409, 'Conclua a preparação do banco exclusivo antes de liberar o acesso.');
      const preparedEntry = config.entries[preview.slug];
      if (!preparedEntry?.bootstrap || normalizeEmail(preparedEntry.bootstrap.ownerEmail) !== normalizeEmail(preview.owner_email)) throw failure(409, 'O responsável configurado para este negócio não corresponde à solicitação. Confira o provisionamento.');
      await target(preview.slug);
      const targetDb = await database(preview.slug);
      if (targetDb === db) throw failure(409, 'Prepare o banco exclusivo do negócio antes de liberar o acesso.');
      return withTenant(preview.slug, () => db.transaction(async tx => {
        await readSettings(tx, true);
        const r = await preparation(tx, input.id, input.revision);
        if (!samePreparation(r, preview) || config.entries[r.slug] !== preparedEntry) throw failure(409, 'O provisionamento mudou. Confira os dados e atualize a página.');
        if (r.status !== 'ready' || r.slug === config.operations.tenant) throw failure(409, 'Conclua a preparação do banco exclusivo antes de liberar o acesso.');
        const entry = config.entries[r.slug];
        if (!entry?.bootstrap || normalizeEmail(entry.bootstrap.ownerEmail) !== normalizeEmail(r.owner_email)) throw failure(409, 'O responsável configurado para este negócio não corresponde à solicitação. Confira o provisionamento.');
        const loginUrl = `${config.origin}/sistema/${r.slug}`;
        // The grant marker and hashed token live in the same transaction/database.
        // If the operations transaction loses its response, retrying cannot create
        // another invitation or silently reset the owner's existing password.
        const result = await targetDb.transaction(async targetTx => {
          await readSettings(targetTx, true);
          const [owner] = await targetTx.query('SELECT id, role, active, password_hash FROM users WHERE email = ?' + targetTx.lock, [normalizeEmail(r.owner_email)]);
          if (!owner || owner.role !== 'admin' || !Number(owner.active)) throw failure(409, 'O acesso do responsável ainda não está pronto. Confira o provisionamento.');
          if (owner.password_hash) return { ok: true, state: 'active', alreadyActivated: true, loginUrl };
          const [grant] = await targetTx.query('SELECT user_id, expires_at FROM onboarding_access_grants WHERE request_id = ?', [r.id]);
          if (grant) {
            if (grant.user_id !== owner.id) throw failure(409, 'O responsável mudou após a liberação. Solicite a revisão assistida do acesso.');
            return { ok: true, state: 'already_issued', loginUrl, expiresAt: Number(grant.expires_at) };
          }
          const value = token(), issuedAt = Date.now(), expiresAt = issuedAt + 86400000;
          await targetTx.query('UPDATE account_tokens SET used_at = ? WHERE user_id = ? AND kind = ? AND used_at IS NULL', [issuedAt, owner.id, 'invite']);
          await targetTx.query('INSERT INTO account_tokens(token_hash, user_id, kind, expires_at, used_at) VALUES (?, ?, ?, ?, ?)', [digest(value), owner.id, 'invite', expiresAt, null]);
          await targetTx.query('INSERT INTO onboarding_access_grants(request_id, user_id, issued_at, expires_at) VALUES (?, ?, ?, ?)', [r.id, owner.id, issuedAt, expiresAt]);
          await audit(targetTx, user, 'business_owner_first_access', { requestId: r.id, userId: owner.id, operatorTenant: user.tenant });
          return { ok: true, state: 'invitation', url: `${loginUrl}#ativar=${value}`, loginUrl, expiresInHours: 24, expiresAt };
        });
        if (result.state === 'invitation') {
          await tx.query('UPDATE operation_requests SET revision = revision + 1, updated_at = ? WHERE id = ?', [now(), r.id]);
          await audit(tx, user, 'business_first_access_released', { id: r.id, slug: r.slug });
          result.revision = Number(r.revision) + 1;
        } else result.revision = Number(r.revision);
        return result;
      }));
    }
    throw failure(404, 'Ação não encontrada.');
  }
  return { handle, allowed, entry, lifecycle };
}
