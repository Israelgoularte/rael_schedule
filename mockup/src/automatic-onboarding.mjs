import { randomBytes, randomUUID } from 'node:crypto';
import { openDatabase, readSettings } from './database.mjs';
import { provisionAutomaticTenant } from './service.mjs';
import { secretBox } from './mercadopago-client.mjs';
import { createHostingerClient } from './hostinger-client.mjs';
import { validSlug } from './configuration.mjs';
import { digest, failure, isEmail, normalizeEmail, passwordHash, passwordAttempt, rateLimit } from './security.mjs';
import { requireLegalAcceptance } from './legal.mjs';
import { normalizeMetadata } from './metadata.mjs';
import { databaseNamesOverlap, mysqlEntriesConflict } from './mysql-isolation.mjs';

const text = value => typeof value === 'string' && value.trim().length >= 2 && value.length <= 120 && !/[\x00-\x1f\x7f]/.test(value);
const keyValid = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(value);
const retryCategories = new Set(['provider_uncertain', 'provider_busy', 'database_unavailable', 'lease_lost']);
const publicStages = Object.freeze({ queued: 'received', creating: 'workspace', initializing: 'access', ready: 'ready', attention: 'attention' });
// Called inside the same settings-locked transaction that accepts the signup.
// An occupied address must not consume a successful-registration email slot.
async function takeEmailCreationSlot(tx, email) {
  const key = digest(`automatic:email:created:day:${email}`), at = Date.now();
  const [row] = await tx.query('SELECT hits, window_start FROM auth_attempts WHERE attempt_key = ?', [key]);
  if (row && at - Number(row.window_start) < 86400000) {
    if (Number(row.hits) >= 2) throw failure(429, 'Muitas tentativas. Aguarde alguns minutos e tente novamente.');
    await tx.query('UPDATE auth_attempts SET hits = hits + 1 WHERE attempt_key = ?', [key]);
  } else if (row) await tx.query('UPDATE auth_attempts SET hits = ?, window_start = ? WHERE attempt_key = ?', [1, at, key]);
  else await tx.query('INSERT INTO auth_attempts(attempt_key, hits, window_start) VALUES (?, ?, ?)', [key, 1, at]);
}
export function createAutomaticOnboarding(config, { database, registry, getService }) {
  const settings = config.onboarding, now = config.now ?? (() => Date.now());
  const box = id => secretBox(config.integrationKey, `rael:automatic-registration:${id}`);
  const provider = settings?.enabled ? createHostingerClient(settings, config.hostingerTransport) : null;
  let running = null, closed = false;
  const available = () => Boolean(config.enabled && settings?.enabled && config.operations && config.integrationKey);
  const view = row => ({ automatic: true, state: row.state === 'ready' ? 'ready' : row.state === 'attention' ? 'attention' : 'preparing', stage: Object.hasOwn(publicStages, row.state) ? publicStages[row.state] : 'received', slug: row.slug, ...(row.state === 'ready' ? { loginUrl: `/sistema/${row.slug}?visao=perfil` } : {}), message: row.state === 'ready' ? 'Seu negócio está pronto. Os sete dias grátis começaram.' : row.state === 'attention' ? 'A preparação precisa de uma conferência da Raelapps. Seus dados estão guardados; não faça outro cadastro.' : 'Estamos preparando seu espaço. Você não precisa solicitar liberação.' });
  async function request(input, { ip = 'unknown' } = {}) {
    if (!available()) throw failure(503, 'O cadastro automático está temporariamente indisponível. Tente novamente mais tarde.');
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['name', 'slug', 'ownerName', 'ownerEmail', 'phone', 'password', 'requestKey', 'hp', 'legalAcceptance', 'metadata'].includes(k))) throw failure(422, 'Confira os dados do cadastro.');
    if (input.hp !== undefined && (typeof input.hp !== 'string' || input.hp.length > 200)) throw failure(422, 'Confira os dados do cadastro.');
    const db = await database(), source = typeof ip === 'string' && ip.length <= 128 ? ip : 'unknown';
    await rateLimit(db, `automatic:ip:burst:${source}`, 12, 60000);
    if (input.hp?.trim()) return { automatic: true, state: 'preparing', stage: 'received', message: 'Estamos preparando seu espaço.' };
    const legal = requireLegalAcceptance(input.legalAcceptance), email = normalizeEmail(input.ownerEmail), phone = typeof input.phone === 'string' ? input.phone.replace(/\D/g, '') : '';
    if (!text(input.name) || !text(input.ownerName) || !validSlug(input.slug) || typeof input.ownerEmail !== 'string' || !isEmail(email) || typeof input.phone !== 'string' || input.phone.length > 40 || !/^[+\d ().-]+$/.test(input.phone) || !/^\d{10,15}$/.test(phone) || !keyValid(input.requestKey) || typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 128) throw failure(422, 'Confira os dados e use uma senha de 8 a 128 caracteres.');
    const metadata = normalizeMetadata(input.metadata), identity = { name: input.name.trim(), slug: input.slug, ownerName: input.ownerName.trim(), email, phone };
    const requestKey = digest(`automatic:${input.requestKey}`), signature = digest(JSON.stringify({ ...identity, metadata }));
    const legacySignature = Object.keys(metadata).length ? null : digest(JSON.stringify(identity));
    const sameSubmission = row => row.signature === signature || legacySignature !== null && row.signature === legacySignature;
    const [prior] = await db.query('SELECT * FROM automatic_registrations WHERE request_key = ?', [requestKey]);
    if (prior) { if (!sameSubmission(prior)) throw failure(409, 'Este envio corresponde a outro cadastro. Retome a preparação em andamento.'); kick(); return view(prior); }
    // Shared hosting may expose the reverse proxy as remoteAddress. Keep this
    // ceiling compatible with the global quota instead of blocking a shared IP.
    await rateLimit(db, `automatic:ip:day:${source}`, Math.max(20, settings.maxDaily), 86400000);
    await passwordAttempt(db);
    const encodedPassword = await passwordHash(input.password), id = randomUUID(), suffix = `ag${randomBytes(6).toString('hex')}`;
    const entry = config.provisioningEntryFactory && !config.production ? await config.provisioningEntryFactory(id, input.slug) : { driver: 'mysql', host: settings.host, port: 3306, database: `${settings.account}_${suffix}`, user: `${settings.account}_${suffix}`, password: randomBytes(24).toString('base64url') + 'aA1' };
    Object.assign(entry, { testMode: settings.mode === 'sandbox', payments: { enabled: false, mode: settings.mode, holdMinutes: 30 }, license: { enforced: true, billingMode: settings.mode } });
    const payload = { registrationId: id, slug: input.slug, name: input.name.trim(), ownerName: input.ownerName.trim(), ownerEmail: email, phone, metadata, encodedPassword, entry };
    const queued = await db.transaction(async tx => {
      await readSettings(tx, true);
      const [repeat] = await tx.query('SELECT * FROM automatic_registrations WHERE request_key = ?', [requestKey]);
      if (repeat) { if (!sameSubmission(repeat)) throw failure(409, 'Este envio corresponde a outro cadastro.'); return repeat; }
      const [old] = await tx.query('SELECT id FROM operation_requests WHERE slug = ?', [input.slug]);
      const [managed] = await tx.query('SELECT slug FROM managed_tenants WHERE slug = ?', [input.slug]);
      const [retired] = await tx.query('SELECT slug FROM tenant_lifecycle WHERE slug = ?', [input.slug]);
      if (Object.hasOwn(config.entries, input.slug) || old || managed || retired) throw Object.assign(failure(409, 'Esse endereço já está em uso.'), { code: 'slug_unavailable', field: 'slug' });
      const [daily] = await tx.query('SELECT COUNT(*) AS count FROM automatic_registrations WHERE created_at >= ?', [now() - 86400000]);
      const registered = await tx.query('SELECT slug FROM managed_tenants');
      const [pending] = await tx.query("SELECT COUNT(*) AS count FROM automatic_registrations a WHERE state <> 'ready' AND NOT EXISTS (SELECT 1 FROM managed_tenants m WHERE m.registration_id = a.id)");
      const registeredCount = new Set([...Object.keys(config.entries), ...registered.map(r => r.slug)]).size;
      if (Number(daily.count) >= settings.maxDaily || registeredCount + Number(pending.count) >= settings.maxTenants) throw failure(503, 'A capacidade de novos cadastros foi atingida por enquanto. Tente novamente mais tarde.');
      await takeEmailCreationSlot(tx, email);
      const at = now();
      await tx.query('INSERT INTO operation_requests(id, slug, name, owner_name, owner_email, status, notes, metadata_json, revision, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, input.slug, payload.name, payload.ownerName, email, 'preparing', 'Cadastro automático. Telefone para contato: ' + phone, JSON.stringify(metadata), 1, 'automatic', at, at]);
      await tx.query('INSERT INTO automatic_registrations(request_key, id, slug, signature, claim_cipher, payload_cipher, state, attempt_count, lease_until, next_attempt_at, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [requestKey, id, input.slug, signature, '', box(id).seal(payload), 'queued', 0, 0, at, '', at, at]);
      await tx.query('INSERT INTO audit_events(id, actor_id, event_name, detail_json, created_at) VALUES (?, ?, ?, ?, ?)', [randomUUID(), null, 'business_automatic_terms_accepted', JSON.stringify({ requestId: id, ...legal }), at]);
      const [row] = await tx.query('SELECT * FROM automatic_registrations WHERE id = ?', [id]); return row;
    });
    kick(); return view(queued);
  }
  async function status(input, { ip = 'unknown' } = {}) {
    if (!config.enabled || !settings || !keyValid(input?.requestKey) || Object.keys(input).some(k => k !== 'requestKey')) throw failure(422, 'Não foi possível localizar esta preparação.');
    const db = await database(); await rateLimit(db, `automatic:status:${String(ip).slice(0, 128)}`, 200, 60000);
    const [row] = await db.query('SELECT * FROM automatic_registrations WHERE request_key = ?', [digest(`automatic:${input.requestKey}`)]);
    if (!row) throw failure(404, 'Não foi possível localizar esta preparação neste navegador.');
    if (row.state !== 'ready') kick(); return view(row);
  }
  function kick() { if (!closed && available() && !running) { running = sweep().catch(() => {}).finally(() => { running = null; }); } }
  async function sweep() {
    if (!available() || closed) return;
    const db = await database();
    const row = await db.transaction(async tx => {
      await readSettings(tx, true);
      // One global lease bounds both connections and provider requests across workers.
      const [busy] = await tx.query("SELECT id FROM automatic_registrations WHERE lease_until > ? AND state NOT IN ('ready','attention') LIMIT 1", [now()]);
      if (busy) return null;
      const [next] = await tx.query("SELECT * FROM automatic_registrations WHERE state IN ('queued','creating','initializing') AND lease_until <= ? AND next_attempt_at <= ? ORDER BY created_at, id LIMIT 1", [now(), now()]);
      if (!next) return null;
      const fence = randomUUID();
      await tx.query('UPDATE automatic_registrations SET claim_cipher = ?, lease_until = ?, attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?', [fence, now() + 120000, now(), next.id]);
      return { ...next, fence, attempt_count: Number(next.attempt_count) + 1 };
    });
    if (!row) return;
    let targetDb, payload, state = row.state, submissionAttempted = state !== 'queued';
    const update = async (sql, params) => {
      const result = await db.query(sql + ' AND claim_cipher = ?', [...params, row.fence]);
      if (Number(result.changes ?? result.affectedRows) !== 1) throw Object.assign(Error(), { category: 'lease_lost' });
    };
    const requireClaim = async () => {
      const [retired] = await db.query("SELECT slug FROM tenant_lifecycle WHERE slug = ? AND state IN ('deleting','attention','deleted')", [row.slug]);
      if (retired) throw Object.assign(Error(), { category: 'database_identity' });
      const [claim] = await db.query('SELECT claim_cipher, lease_until, state FROM automatic_registrations WHERE id = ?', [row.id]);
      if (claim?.claim_cipher !== row.fence || Number(claim.lease_until) <= now() || ['ready', 'attention'].includes(claim.state)) throw Object.assign(Error(), { category: 'lease_lost' });
    };
    try {
      await requireClaim();
      payload = box(row.id).open(row.payload_cipher);
      if (payload.registrationId !== row.id || payload.slug !== row.slug || !validSlug(row.slug)) throw Object.assign(Error(), { category: 'database_identity' });
      const { entry } = payload;
      if (Object.entries(config.entries).some(([slug, other]) => slug !== row.slug && mysqlEntriesConflict(other, entry))) throw Object.assign(Error(), { category: 'database_scope' });
      const { rows, total } = await provider.databases(), existing = rows.find(r => r.name === entry.database);
      if (existing && (state === 'queued' || existing.user !== entry.user || existing.domain !== null && existing.domain !== settings.domain)) throw Object.assign(Error(), { category: 'database_identity' });
      if (existing && existing.domain === null) throw Object.assign(Error(), { category: 'provider_uncertain' });
      if (rows.some(other => other.name !== entry.database && (databaseNamesOverlap(other.name, entry.database) || other.user.toLowerCase() === entry.user.toLowerCase()))) throw Object.assign(Error(), { category: 'database_scope' });
      if (!existing && state === 'initializing') throw Object.assign(Error(), { category: 'provider_uncertain' });
      if (state !== 'initializing') {
        if (!existing && state === 'queued') {
          if (total >= settings.maxDatabases) throw Object.assign(Error(), { category: 'capacity' });
          await requireClaim();
          // Commit the intent BEFORE POST. Ambiguous replies only trigger GET polling.
          state = 'creating'; await update('UPDATE automatic_registrations SET state = ? WHERE id = ?', [state, row.id]);
          await requireClaim();
          submissionAttempted = true;
          try { await provider.create(entry); }
          catch (error) {
            // These HTTP rejections did not accept the request. An authorized
            // retry may create it again; ambiguous responses must keep creating.
            if (['provider_rejected', 'provider_access', 'provider_busy'].includes(error.category)) {
              state = 'queued'; submissionAttempted = false;
              await update('UPDATE automatic_registrations SET state = ? WHERE id = ?', [state, row.id]);
            }
            throw error;
          }
          await update('UPDATE automatic_registrations SET lease_until = 0, next_attempt_at = ?, category = ?, updated_at = ? WHERE id = ?', [now() + 3000, '', now(), row.id]);
          return;
        }
        if (!existing) throw Object.assign(Error(), { category: 'provider_uncertain' });
        state = 'initializing'; await update('UPDATE automatic_registrations SET state = ? WHERE id = ?', [state, row.id]);
      }
      await requireClaim();
      try { targetDb = await openDatabase(entry); }
      catch { throw Object.assign(Error(), { category: 'database_unavailable' }); }
      await requireClaim();
      try { await provisionAutomaticTenant(targetDb, payload, now); }
      catch (error) { if (/^(ER_|SQLITE_)/.test(error.code ?? '')) throw Object.assign(Error(), { category: 'database_unavailable' }); throw error; }
      await targetDb.close(); targetDb = null;
      await requireClaim();
      await registry.register(row.slug, row.id, entry);
      await registry.refresh({ force: true });
      await getService(row.slug); // Initializes the seven-day trial exactly once.
      await db.transaction(async tx => {
        await readSettings(tx, true);
        const [claim] = await tx.query('SELECT claim_cipher, state FROM automatic_registrations WHERE id = ?', [row.id]);
        if (claim?.claim_cipher !== row.fence || claim.state === 'ready') return;
        await tx.query('UPDATE automatic_registrations SET state = ?, lease_until = 0, next_attempt_at = 0, category = ?, payload_cipher = ?, updated_at = ? WHERE id = ?', ['ready', '', '', now(), row.id]);
        await tx.query('UPDATE operation_requests SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ?', ['ready', now(), row.id]);
        await tx.query('INSERT INTO audit_events(id, actor_id, event_name, detail_json, created_at) VALUES (?, ?, ?, ?, ?)', [randomUUID(), null, 'business_automatic_ready', JSON.stringify({ requestId: row.id, slug: row.slug }), now()]);
      });
    } catch (error) {
      const category = /^[a-z_]{2,40}$/.test(error.category ?? '') ? error.category : 'preparation_failed';
      if (category === 'lease_lost' && !submissionAttempted && state === 'creating') state = 'queued';
      const retry = retryCategories.has(category) && row.attempt_count < 12;
      const saved = !retry && payload ? box(row.id).seal({ ...payload, resumeState: state }) : row.payload_cipher;
      await db.transaction(async tx => {
        await readSettings(tx, true);
        const [claim] = await tx.query('SELECT claim_cipher, state FROM automatic_registrations WHERE id = ?', [row.id]);
        if (claim?.claim_cipher !== row.fence || claim.state === 'ready') return;
        await tx.query('UPDATE automatic_registrations SET state = ?, lease_until = 0, next_attempt_at = ?, category = ?, payload_cipher = ?, updated_at = ? WHERE id = ?', [retry ? state : 'attention', now() + Math.min(60000, 3000 * row.attempt_count), category, saved, now(), row.id]);
        if (!retry) await tx.query('UPDATE operation_requests SET notes = ?, revision = revision + 1, updated_at = ? WHERE id = ?', ['A preparação automática precisa de conferência. Motivo: ' + category, now(), row.id]);
      });
    } finally { if (targetDb) await targetDb.close(); }
  }
  async function retry(id, actorId) {
    if (!available()) throw failure(503, 'Reative a configuração da hospedagem antes de retomar.');
    const db = await database();
    await db.transaction(async tx => {
      await readSettings(tx, true);
      const [row] = await tx.query('SELECT * FROM automatic_registrations WHERE id = ?', [id]);
      if (!row || row.state !== 'attention') throw failure(409, 'Esta preparação já mudou. Atualize a lista.');
      let payload; try { payload = box(row.id).open(row.payload_cipher); } catch { throw failure(409, 'Os dados protegidos precisam de recuperação assistida.'); }
      if (!['queued', 'creating', 'initializing'].includes(payload.resumeState)) throw failure(409, 'Confira o vínculo do banco antes de retomar esta preparação.');
      await tx.query('UPDATE automatic_registrations SET state = ?, attempt_count = 0, lease_until = 0, next_attempt_at = ?, category = ?, updated_at = ? WHERE id = ?', [payload.resumeState, now(), '', now(), id]);
      await tx.query('UPDATE operation_requests SET notes = ?, revision = revision + 1, updated_at = ? WHERE id = ?', ['Preparação automática retomada pela operação.', now(), id]);
      await tx.query('INSERT INTO audit_events(id, actor_id, event_name, detail_json, created_at) VALUES (?, ?, ?, ?, ?)', [randomUUID(), actorId, 'business_automatic_retried', JSON.stringify({ requestId: id }), now()]);
    });
    kick(); return { ok: true };
  }
  async function health() {
    if (!settings) return { status: 'disabled' };
    const db = await database(), rows = await db.query('SELECT state, COUNT(*) AS count, MIN(created_at) AS oldest FROM automatic_registrations GROUP BY state');
    const attention = rows.filter(r => r.state === 'attention').reduce((n, r) => n + Number(r.count), 0), pendingRows = rows.filter(r => !['ready', 'attention'].includes(r.state));
    const pending = pendingRows.reduce((n, r) => n + Number(r.count), 0), stale = pendingRows.some(r => now() - Number(r.oldest) > 5 * 60000);
    return { status: !available() ? 'paused' : attention || stale ? 'degraded' : 'ok', pending, attention, ready: rows.filter(r => r.state === 'ready').reduce((n, r) => n + Number(r.count), 0) };
  }
  return { available, request, status, retry, health, kick, async run() { if (running) await running; else if (!closed) { kick(); if (running) await running; } }, async close() { closed = true; if (running) await running; } };
}
