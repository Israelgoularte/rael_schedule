import { ECDH, randomUUID } from 'node:crypto';
import { Agent } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { digest, failure, rateLimit } from './security.mjs';
import { readSettings } from './database.mjs';
import { insertNotification, notifyLicense } from './notification-events.mjs';
import { readTenantRetention } from './tenant-retention.mjs';

const only = (value, keys) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw failure(422, 'Confira os dados da notificação.'); };
const idOk = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const DAYS90 = 90 * 86400000, PUSH_MAX_AGE = 86400000;
function bytes(value, length) {
  if (typeof value !== 'string' || value.length > 150 || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) throw failure(422, 'A inscrição deste navegador é inválida.');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== length || decoded.toString('base64url') !== value.replace(/=+$/, '')) throw failure(422, 'A inscrição deste navegador é inválida.');
  return decoded;
}
export function validatePushEndpoint(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f]/.test(value)) throw failure(422, 'O serviço de notificações deste navegador não é compatível.');
  let url; try { url = new URL(value); } catch { throw failure(422, 'Endereço de notificações inválido.'); }
  const host = url.hostname;
  const google = host === 'fcm.googleapis.com' && /^\/(?:fcm\/send|wp)\/.+/.test(url.pathname);
  const mozilla = host === 'updates.push.services.mozilla.com' && /^\/wpush\/v[12]\/.+/.test(url.pathname);
  const apple = host === 'web.push.apple.com' && url.pathname.length > 1;
  const windows = /^[a-z0-9-]+\.notify\.windows\.com$/.test(host) && url.pathname === '/w/' && Boolean(url.search);
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || url.hash || !(google || mozilla || apple || windows)) throw failure(422, 'O serviço de notificações deste navegador não é compatível.');
  return url.href;
}
export function publicPushAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && [0, 168].includes(b) || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19, 51].includes(b) || a === 203 && b === 0);
  }
  // Provider IPv6 must be global unicast. This excludes mapped IPv4, local,
  // loopback, unspecified, multicast and link-local destinations.
  return family === 6 && /^[23]/i.test(address) && !/^2001:db8:/i.test(address);
}
export function createPushLookup(resolve = lookup) {
  return (host, options, callback) => {
    Promise.resolve().then(() => resolve(host, { all: true, verbatim: true })).then(records => {
      if (!Array.isArray(records) || !records.length || records.some(record => !publicPushAddress(record.address))) throw Error('Destino de notificações não permitido.');
      const selected = options?.family ? records.filter(record => record.family === options.family) : records;
      if (!selected.length) throw Error('Destino de notificações indisponível.');
      if (options?.all) callback(null, selected); else callback(null, selected[0].address, selected[0].family);
    }).catch(() => callback(Object.assign(Error('Destino de notificações não permitido.'), { code: 'EACCES' })));
  };
}
function vapid(config) {
  try {
    if (!config) return null;
    const publicKey = bytes(config.publicKey, 65), privateKey = bytes(config.privateKey, 32), key = ECDH('prime256v1');
    key.setPrivateKey(privateKey);
    let validSubject = typeof config.subject === 'string' && /^mailto:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(config.subject);
    if (!validSubject && typeof config.subject === 'string') { const url = new URL(config.subject); validSubject = url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; }
    if (!publicKey.equals(key.getPublicKey()) || !validSubject) return null;
    return { publicKey: publicKey.toString('base64url'), privateKey: privateKey.toString('base64url'), subject: config.subject };
  } catch { return null; }
}
export function createNotifications(db, slug, config, license) {
  const now = config.now ?? (() => Date.now()), keys = vapid(config.notifications), agent = new Agent({ keepAlive: false, lookup: createPushLookup() });
  let cleanupCursor = '';
  function actor(value) {
    const person = value?.staff ?? value?.customer, type = value?.staff ? 'staff' : 'customer';
    if (!person?.id || typeof person.csrf !== 'string' || !person.csrf || type === 'staff' && !['admin', 'professional', 'reception'].includes(person.role)) throw failure(403, 'Entre na sua conta para consultar as notificações.');
    return { type, id: person.id, sessionHash: digest(person.csrf) };
  }
  async function settings(value) {
    const owner = actor(value), [row] = await db.query('SELECT COUNT(*) AS total FROM notification_devices WHERE recipient_type = ? AND recipient_id = ? AND session_hash = ? AND active = 1 AND (expiration_at IS NULL OR expiration_at > ?)', [owner.type, owner.id, owner.sessionHash, now()]);
    return { pushAvailable: Boolean(keys), publicKey: keys?.publicKey ?? null, pushEnabled: Boolean(Number(row.total)) };
  }
  async function list(value, input = {}) {
    const owner = actor(value); only(input, ['before', 'unread', 'limit']);
    const limit = input.limit === undefined ? 20 : Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || input.limit !== undefined && !/^[1-9]\d?$/.test(String(input.limit)) || !['', '0', '1'].includes(input.unread ?? '')) throw failure(422, 'Confira os filtros das notificações.');
    const conditions = ['recipient_type = ?', 'recipient_id = ?', 'created_at >= ?'], params = [owner.type, owner.id, now() - DAYS90];
    if (input.unread === '1') conditions.push('read_at IS NULL');
    if (input.before) {
      let cursor; try { if (typeof input.before !== 'string' || input.before.length > 200 || !/^[A-Za-z0-9_-]+$/.test(input.before)) throw Error(); cursor = JSON.parse(Buffer.from(input.before, 'base64url').toString()); } catch { throw failure(422, 'Página de notificações inválida.'); }
      if (!Number.isSafeInteger(cursor?.at) || cursor.at < 0 || !idOk(cursor.id) || Object.keys(cursor).sort().join(',') !== 'at,id') throw failure(422, 'Página de notificações inválida.');
      conditions.push('(created_at < ? OR (created_at = ? AND id < ?))'); params.push(cursor.at, cursor.at, cursor.id);
    }
    const rows = await db.query('SELECT id, title, body, url, created_at, read_at FROM notifications WHERE ' + conditions.join(' AND ') + ' ORDER BY created_at DESC, id DESC LIMIT ?', [...params, limit + 1]);
    const items = rows.slice(0, limit).map(row => ({ id: row.id, title: row.title, body: row.body, url: row.url, createdAt: Number(row.created_at), readAt: row.read_at === null ? null : Number(row.read_at) }));
    const [unread] = await db.query('SELECT COUNT(*) AS total FROM notifications WHERE recipient_type = ? AND recipient_id = ? AND created_at >= ? AND read_at IS NULL', [owner.type, owner.id, now() - DAYS90]);
    const last = items.at(-1);
    return { items, unreadCount: Number(unread.total), ...(rows.length > limit ? { nextBefore: Buffer.from(JSON.stringify({ at: last.createdAt, id: last.id })).toString('base64url') } : {}) };
  }
  async function read(value, input) {
    const owner = actor(value); only(input, ['id', 'all']);
    if (!(idOk(input.id) && input.all === undefined || input.all === true && input.id === undefined)) throw failure(422, 'Escolha o aviso ou marque todos como lidos.');
    if (input.id) { const [row] = await db.query('SELECT id FROM notifications WHERE id = ? AND recipient_type = ? AND recipient_id = ?', [input.id, owner.type, owner.id]); if (!row) throw failure(404, 'Notificação não encontrada.'); }
    await db.query('UPDATE notifications SET read_at = ? WHERE recipient_type = ? AND recipient_id = ? AND read_at IS NULL' + (input.id ? ' AND id = ?' : ''), input.id ? [now(), owner.type, owner.id, input.id] : [now(), owner.type, owner.id]);
    return { ok: true };
  }
  async function push(value, input) {
    const owner = actor(value); only(input, ['subscription']); only(input.subscription, ['endpoint', 'expirationTime', 'keys']); only(input.subscription.keys, ['p256dh', 'auth']);
    if (!keys) throw failure(503, 'Os avisos do navegador ainda não foram configurados.');
    const endpoint = validatePushEndpoint(input.subscription.endpoint), point = bytes(input.subscription.keys.p256dh, 65), auth = bytes(input.subscription.keys.auth, 16);
    try { if (point[0] !== 4 || ECDH.convertKey(point, 'prime256v1', undefined, undefined, 'uncompressed').length !== 65) throw Error(); } catch { throw failure(422, 'A chave deste navegador é inválida.'); }
    const expiration = input.subscription.expirationTime ?? null;
    if (expiration !== null && (!Number.isSafeInteger(expiration) || expiration <= now())) throw failure(422, 'A inscrição deste navegador já expirou.');
    await rateLimit(db, `notification_push:${owner.type}:${owner.id}`, 15, 60000);
    return db.transaction(async tx => {
      await readSettings(tx, true);
      const hash = digest(endpoint), [existing] = await tx.query('SELECT * FROM notification_devices WHERE endpoint_hash = ?', [hash]);
      const [count] = await tx.query('SELECT COUNT(*) AS total FROM notification_devices WHERE recipient_type = ? AND recipient_id = ? AND active = 1' + (existing ? ' AND id <> ?' : ''), existing ? [owner.type, owner.id, existing.id] : [owner.type, owner.id]);
      if (Number(count.total) >= 5) throw failure(409, 'Você já ativou cinco dispositivos. Desative um antes de adicionar outro.');
      const encoded = JSON.stringify({ p256dh: point.toString('base64url'), auth: auth.toString('base64url') });
      if (existing) {
        if (existing.recipient_type !== owner.type || existing.recipient_id !== owner.id || existing.session_hash !== owner.sessionHash) await tx.query("UPDATE notification_outbox SET state = 'discarded', lease_until = 0, updated_at = ? WHERE device_id = ? AND state = 'pending'", [now(), existing.id]);
        await tx.query('UPDATE notification_devices SET recipient_type = ?, recipient_id = ?, session_hash = ?, endpoint = ?, keys_json = ?, expiration_at = ?, active = 1, updated_at = ? WHERE id = ?', [owner.type, owner.id, owner.sessionHash, endpoint, encoded, expiration, now(), existing.id]);
      } else await tx.query('INSERT INTO notification_devices(id, recipient_type, recipient_id, session_hash, endpoint_hash, endpoint, keys_json, expiration_at, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [hash, owner.type, owner.id, owner.sessionHash, hash, endpoint, encoded, expiration, 1, now(), now()]);
      return { ok: true };
    });
  }
  async function removeDevices(owner, sessionOnly, endpoint) {
    return db.transaction(async tx => {
      await readSettings(tx, true);
      const where = 'recipient_type = ? AND recipient_id = ?' + (sessionOnly ? ' AND session_hash = ?' : ' AND endpoint_hash = ?'), params = [owner.type, owner.id, sessionOnly ? owner.sessionHash : digest(endpoint)];
      const rows = await tx.query('SELECT id FROM notification_devices WHERE ' + where, params);
      for (const row of rows) { await tx.query('DELETE FROM notification_outbox WHERE device_id = ?', [row.id]); await tx.query('DELETE FROM notification_devices WHERE id = ?', [row.id]); }
      return { ok: true };
    });
  }
  async function pushRemove(value, input) { only(input, ['endpoint']); return removeDevices(actor(value), false, validatePushEndpoint(input.endpoint)); }
  async function revokeSession(value) { return removeDevices(actor(value), true); }
  async function test(value, input) {
    const owner = actor(value); only(input, []); await rateLimit(db, `notification_test:${owner.type}:${owner.id}`, 5, 60000);
    const id = await db.transaction(async tx => { await readSettings(tx, true); return insertNotification(tx, { recipientType: owner.type, recipientId: owner.id, sessionHash: owner.sessionHash, eventKey: randomUUID(), type: 'test', title: 'Notificações de teste', body: 'Os avisos internos estão funcionando. Se ativou o navegador, confira também o aviso do dispositivo.', url: owner.type === 'staff' ? `/sistema/${slug}?visao=perfil` : `/negocio/${slug}`, now: now() }); });
    return { ok: true, id };
  }
  async function validDevice(tx, device) {
    if (!device.active || device.expiration_at !== null && Number(device.expiration_at) <= now()) return false;
    const table = device.recipient_type === 'staff' ? 'users' : 'customers', [person] = await tx.query(`SELECT * FROM ${table} WHERE id = ?`, [device.recipient_id]);
    if (!person || device.recipient_type === 'staff' && (!person.active || !['admin', 'professional', 'reception'].includes(person.role))) return false;
    if (person.role === 'professional' && !(await readSettings(tx)).draft.professionals.some(pro => pro.id === person.professional_id && pro.active)) return false;
    const sessions = await tx.query(`SELECT csrf FROM ${device.recipient_type === 'staff' ? 'sessions' : 'customer_sessions'} WHERE ${device.recipient_type === 'staff' ? 'user_id' : 'customer_id'} = ? AND expires_at > ?`, [device.recipient_id, now()]);
    return sessions.some(session => digest(session.csrf) === device.session_hash);
  }
  async function processOne() {
    const claimed = await db.transaction(async tx => {
      await readSettings(tx, true);
      const [job] = await tx.query("SELECT * FROM notification_outbox WHERE state = 'pending' AND next_check_at <= ? AND lease_until <= ? ORDER BY next_check_at, id LIMIT 1", [now(), now()]); if (!job) return null;
      const [notice] = await tx.query('SELECT * FROM notifications WHERE id = ?', [job.notification_id]), [device] = await tx.query('SELECT * FROM notification_devices WHERE id = ?', [job.device_id]);
      if (!notice || !device || notice.created_at < now() - PUSH_MAX_AGE || notice.recipient_type !== device.recipient_type || notice.recipient_id !== device.recipient_id || !await validDevice(tx, device)) { await tx.query("UPDATE notification_outbox SET state = 'discarded', lease_until = 0, updated_at = ? WHERE id = ?", [now(), job.id]); return { skipped: true }; }
      const attempts = Number(job.attempts) + 1, lease = now() + 60000;
      await tx.query('UPDATE notification_outbox SET attempts = ?, lease_until = ?, updated_at = ? WHERE id = ?', [attempts, lease, now(), job.id]);
      return { job, notice, device, attempts, lease };
    });
    if (!claimed) return false; if (claimed.skipped) return true;
    const { job, notice, device, attempts, lease } = claimed;
    try {
      // Re-check the lease and session immediately before contacting the push
      // provider. Logout, device re-binding or another worker invalidates a claim.
      const maySend = await db.transaction(async tx => {
        await readSettings(tx, true);
        const [currentJob] = await tx.query('SELECT * FROM notification_outbox WHERE id = ?', [job.id]), [currentDevice] = await tx.query('SELECT * FROM notification_devices WHERE id = ?', [device.id]);
        if (currentJob?.state !== 'pending' || Number(currentJob.attempts) !== attempts || Number(currentJob.lease_until) !== lease || lease <= now()) return false;
        if (!currentDevice || currentDevice.recipient_type !== device.recipient_type || currentDevice.recipient_id !== device.recipient_id || currentDevice.session_hash !== device.session_hash || currentDevice.keys_json !== device.keys_json || !await validDevice(tx, currentDevice)) {
          await tx.query("UPDATE notification_outbox SET state = 'discarded', lease_until = 0, updated_at = ? WHERE id = ?", [now(), job.id]); return false;
        }
        return true;
      });
      if (!maySend) return true;
      const endpoint = validatePushEndpoint(device.endpoint), subscription = { endpoint, keys: JSON.parse(device.keys_json) }, payload = JSON.stringify({ id: notice.id, url: notice.url });
      // The SDK uses https.request and never follows redirects. Its socket DNS
      // lookup is pinned to the validated public address to prevent rebinding.
      const send = config.notificationTransport ?? (async (...args) => (await import('web-push')).default.sendNotification(...args));
      const result = await send(subscription, payload, { vapidDetails: keys, TTL: 3600, urgency: 'normal', timeout: 10000, agent });
      if (!Number.isInteger(result?.statusCode) || result.statusCode < 200 || result.statusCode > 299) throw Object.assign(Error('Envio não confirmado.'), { statusCode: result?.statusCode });
      await db.query("UPDATE notification_outbox SET state = 'sent', lease_until = 0, last_error = '', updated_at = ? WHERE id = ? AND state = 'pending' AND attempts = ? AND lease_until = ?", [now(), job.id, attempts, lease]);
    } catch (error) {
      if ([404, 410].includes(Number(error.statusCode))) await db.transaction(async tx => {
        await readSettings(tx, true);
        const [currentJob] = await tx.query('SELECT state, attempts, lease_until FROM notification_outbox WHERE id = ?', [job.id]), [current] = await tx.query('SELECT session_hash, keys_json, updated_at FROM notification_devices WHERE id = ?', [device.id]);
        if (currentJob?.state === 'pending' && Number(currentJob.attempts) === attempts && Number(currentJob.lease_until) === lease && current?.session_hash === device.session_hash && current.keys_json === device.keys_json && Number(current.updated_at) === Number(device.updated_at)) {
          await tx.query('DELETE FROM notification_outbox WHERE device_id = ?', [device.id]); await tx.query('DELETE FROM notification_devices WHERE id = ?', [device.id]);
        }
      });
      else await db.query("UPDATE notification_outbox SET state = ?, lease_until = 0, next_check_at = ?, last_error = ?, updated_at = ? WHERE id = ? AND state = 'pending' AND attempts = ? AND lease_until = ?", [attempts >= 8 ? 'discarded' : 'pending', now() + Math.min(3600000, 30000 * 2 ** Math.min(attempts - 1, 7)), 'delivery_failed', now(), job.id, attempts, lease]);
    }
    return true;
  }
  async function synthesizeLicense() {
    if (!license) return;
    // Lifecycle lives in the central database. Read it before taking the target
    // lock, preserving the central -> target order used by operator actions.
    const lifecycle = typeof config.lifecycleForTenant === 'function' ? await config.lifecycleForTenant(slug) : null;
    await db.transaction(async tx => {
      await readSettings(tx, true);
      const state = await license.state(tx); if (!state.enforced) return;
      const at = now(), retention = await readTenantRetention(tx, state, at, lifecycle);
      if (retention.closure) return;
      let type, deadline;
      if (state.state === 'trial' && state.trialEndsAt - at <= 2 * 86400000) { type = 'trial_expiring'; deadline = state.trialEndsAt; }
      else if (state.state === 'active' && state.paidUntil - at <= 3 * 86400000) { type = 'renewal_due'; deadline = state.paidUntil; }
      else if (state.state === 'overdue') { type = 'overdue'; deadline = state.graceUntil; }
      else if (!state.canBook) { type = 'blocked'; deadline = state.paidUntil ?? state.trialEndsAt ?? state.graceUntil; }
      if (type) await notifyLicense(tx, { slug, eventKey: `license:${type}:${deadline ?? 'unavailable'}`, type, now: at });
      // A confirmed closure already contains its own coverage and seven-day
      // deadline. Do not send a second, conflicting inactivity countdown.
      if (retention.inactiveSince && config.operations?.tenant !== slug) {
        for (const days of [30, 60]) if (retention.inactiveDays >= days) await notifyLicense(tx, { slug, eventKey: `retention:${retention.inactiveSince}:${days}`, type: `retention_${days}`, now: at });
      }
    });
  }
  async function cleanup() {
    await db.transaction(async tx => {
      await readSettings(tx, true); const old = await tx.query('SELECT id FROM notifications WHERE created_at < ? LIMIT 200', [now() - DAYS90]);
      for (const notice of old) { await tx.query('DELETE FROM notification_outbox WHERE notification_id = ?', [notice.id]); await tx.query('DELETE FROM notifications WHERE id = ?', [notice.id]); }
      // A bounded rotating scan also removes expired, logged-out and restored
      // registrations. Sessions are deliberately absent from restored backups.
      let devices = await tx.query('SELECT * FROM notification_devices WHERE id > ? ORDER BY id LIMIT 50', [cleanupCursor]);
      if (!devices.length && cleanupCursor) { cleanupCursor = ''; devices = await tx.query('SELECT * FROM notification_devices ORDER BY id LIMIT 50'); }
      for (const device of devices) if (!await validDevice(tx, device)) { await tx.query('DELETE FROM notification_outbox WHERE device_id = ?', [device.id]); await tx.query('DELETE FROM notification_devices WHERE id = ?', [device.id]); }
      if (devices.length) cleanupCursor = devices.at(-1).id;
    });
  }
  async function deliver() {
    if (!keys) return { nextAt: null };
    for (let i = 0; i < 5 && await processOne(); i++) {}
    const [next] = await db.query("SELECT MIN(CASE WHEN lease_until > next_check_at THEN lease_until ELSE next_check_at END) AS next_at FROM notification_outbox WHERE state = 'pending'");
    return { nextAt: next?.next_at === null || next?.next_at === undefined ? null : Number(next.next_at) };
  }
  async function sweep({ deliver: shouldDeliver = true } = {}) { try { await synthesizeLicense(); await cleanup(); if (shouldDeliver) await deliver(); } catch (error) { try { config.onMaintenanceFailure?.('notifications', error); } catch { /* A monitor cannot interrupt durable delivery. */ } } }
  return { settings, list, read, push, pushRemove, revokeSession, test, sweep, deliver };
}
