import { randomBytes, randomUUID } from 'node:crypto';
import { readSettings } from './database.mjs';
import { readMetadata } from './metadata.mjs';
import { digest, equal, failure, rateLimit } from './security.mjs';
import { proDestinations, webhookSignature } from './pro-destinations.mjs';

const featureFor = { meta: 'advanced_tracking', google: 'advanced_tracking', webhook: 'webhooks' };
const allFeatures = [...new Set(['api', ...Object.values(featureFor)])];
const statuses = new Set(['awaiting_payment', 'confirmed', 'cancelled', 'in_progress', 'completed', 'no_show', 'expired']);
const leaseTime = 30_000;
const emptyAccess = { features: [], version: '' };

export function adChannels(query) {
  const present = key => /^[A-Za-z0-9_.-]{1,256}$/.test(query.get(key) ?? '');
  return [
    ...(present('fbclid') ? ['meta'] : []),
    ...(['gclid', 'gbraid', 'wbraid'].some(present) ? ['google'] : [])
  ];
}

export function createPro(db, license, config, { now = Date.now, deliver = config && proDestinations(config) } = {}) {
  if (!license || !config) return null;
  let checking, lastCheck = -Infinity, working;
  async function refresh() {
    if (checking) return checking;
    if (now() - lastCheck >= 30_000) {
      lastCheck = now();
      checking = license.sweep().catch(() => {}).finally(() => { checking = null; });
    }
    return checking;
  }

  async function access(conn = db) {
    const signed = await license.proAccess(conn);
    if (!signed) return emptyAccess;
    return { features: signed.features.filter(feature => allFeatures.includes(feature)), version: signed.version };
  }

  async function assertFeature(name, conn = db) {
    const active = await access(conn);
    if (!active.features.includes(name)) throw failure(403, 'Este recurso exige uma licença PRO ativa.');
    return active;
  }

  async function view() {
    await refresh();
    const { features, version } = await access();
    if (!features.length) return { mode: 'test', features, deliveries: [], keyActive: false };
    const [key] = features.includes('api') ? await db.query('SELECT id FROM pro_api_key WHERE id = 1 AND license_version = ?', [version]) : [];
    const rows = await db.query(`SELECT event_id, destination, status, attempts, created_at, details FROM pro_delivery
      WHERE license_version = ? ORDER BY created_at DESC, destination LIMIT 30`, [version]);
    return { mode: 'test', features, keyActive: Boolean(key),
      destinations: { meta: Boolean(config.meta), google: Boolean(config.google), webhook: Boolean(config.webhook) },
      deliveries: rows.filter(row => features.includes(featureFor[row.destination])).map(row => ({
        eventId: row.event_id, destination: row.destination, status: row.status, attempts: Number(row.attempts),
        at: new Date(Number(row.created_at)).toISOString(), detail: row.details
      })) };
  }

  async function key(rotate) {
    await refresh();
    return db.transaction(async tx => {
      await readSettings(tx, true);
      const { version } = await assertFeature('api', tx);
      await tx.query('DELETE FROM pro_api_key WHERE id = 1');
      if (!rotate) return { ok: true };
      const apiKey = 'rael_test_' + randomBytes(32).toString('base64url');
      await tx.query('INSERT INTO pro_api_key (id, key_hash, license_version) VALUES (1, ?, ?)', [digest(apiKey), version]);
      return { apiKey };
    });
  }

  async function appointments(authorization, params) {
    const match = /^Bearer (rael_test_[A-Za-z0-9_-]{43})$/.exec(authorization ?? '');
    if (!match) throw failure(401, 'Informe um token de API válido.');
    const [key] = await db.query('SELECT key_hash, license_version FROM pro_api_key WHERE id = 1');
    if (!key || !equal(key.key_hash, digest(match[1]))) throw failure(401, 'Informe um token de API válido.');
    await refresh();
    const active = await assertFeature('api');
    if (active.version !== key.license_version) throw failure(401, 'Gere um novo token para esta licença.');
    await rateLimit(db, 'pro_api_read', 120, 60_000);
    const limit = Number(params.get('limit') ?? 30), offset = Number(params.get('offset') ?? 0), status = params.get('status');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > 10_000 || (status !== null && !statuses.has(status))) {
      throw failure(422, 'Use limit entre 1 e 100, offset de 0 a 10000 e um status válido.');
    }
    const rows = await db.query(`SELECT id, professional_id, service_id, starts_at, ends_at, status, updated_at FROM appointments
      ${status ? 'WHERE status = ?' : ''} ORDER BY starts_at DESC, id LIMIT ? OFFSET ?`, [...(status ? [status] : []), limit + 1, offset]);
    return { mode: 'test', nextOffset: rows.length > limit && offset + limit <= 10_000 ? offset + limit : null,
      appointments: rows.slice(0, limit).map(row => ({
        id: row.id, status: row.status, serviceId: row.service_id, professionalId: row.professional_id,
        startsAt: new Date(Number(row.starts_at)).toISOString(), endsAt: new Date(Number(row.ends_at)).toISOString(),
        updatedAt: new Date(Number(row.updated_at)).toISOString()
      })) };
  }

  async function queue(tx, active, event, destinations) {
    for (const destination of destinations) {
      if (!active.features.includes(featureFor[destination])) continue;
      const [existing] = await tx.query('SELECT event_id FROM pro_delivery WHERE event_id = ? AND destination = ?', [event.id, destination]);
      if (existing) continue;
      const time = now();
      await tx.query(`INSERT INTO pro_delivery (event_id, destination, license_version, payload_json, status, details, attempts, next_at, lease_until, lease_id, created_at)
        VALUES (?, ?, ?, ?, 'pending', '', 0, ?, 0, NULL, ?)`, [event.id, destination, active.version, JSON.stringify(event), time, time]);
    }
  }

  async function bookingEvent(tx, row, type, transactionId) {
    const active = await access(tx);
    if (!active.features.length) return;
    const [visit] = type === 'confirmed' ? await tx.query(`SELECT v.utm_json FROM landing_visit_bookings b
      JOIN landing_visits v ON v.visit_key = b.visit_key WHERE b.appointment_id = ?`, [row.id]) : [];
    const markers = readMetadata(visit?.utm_json).rael_ad_channels;
    const channels = ['meta', 'google'].filter(value => Array.isArray(markers) && markers.includes(value));
    const event = { id: digest(row.id + ':' + type + ':' + (type === 'rescheduled' ? transactionId : '')),
      type: 'appointment.' + type, at: new Date(now()).toISOString(), mode: 'test', synthetic: false,
      appointment: { id: row.id, startsAt: new Date(Number(row.starts_at)).toISOString() },
      attribution: channels };
    await queue(tx, active, event, ['webhook', ...channels]);
  }

  async function testEvent() {
    await refresh();
    await rateLimit(db, 'pro_test_event', 5, 60_000);
    return db.transaction(async tx => {
      await readSettings(tx, true);
      const active = await access(tx);
      const destinations = Object.keys(featureFor).filter(destination => active.features.includes(featureFor[destination]));
      if (!destinations.length) throw failure(403, 'Este recurso exige uma licença PRO ativa.');
      const id = randomUUID();
      await queue(tx, active, { id, type: 'appointment.confirmed', at: new Date(now()).toISOString(),
        mode: 'test', synthetic: true, appointment: { id: randomUUID() }, attribution: ['meta', 'google'] }, destinations);
      return { eventId: id };
    });
  }

  async function acceptWebhook(headers, bytes) {
    if (!config.webhook) throw failure(404, 'Receptor de teste indisponível.');
    const timestamp = headers['x-rael-timestamp'], id = headers['x-rael-event-id'];
    const denied = () => failure(401, 'Evento de teste não autenticado.');
    if (headers['x-rael-mode'] !== 'test' || !/^[0-9]{10,11}$/.test(timestamp ?? '') ||
      Math.abs(now() - Number(timestamp) * 1000) > 300_000 ||
      !/^[a-f0-9-]{36}$/.test(id ?? '') ||
      !equal(headers['x-rael-signature'], webhookSignature(config.webhook.secret, timestamp, bytes))) throw denied();
    await refresh();
    return db.transaction(async tx => {
      await readSettings(tx, true);
      const { version } = await assertFeature('webhooks', tx);
      const [row] = await tx.query("SELECT payload_json FROM pro_delivery WHERE event_id = ? AND destination = 'webhook' AND license_version = ?", [id, version]);
      if (!row || !bytes.equals(Buffer.from(row.payload_json)) || JSON.parse(row.payload_json).synthetic !== true) throw denied();
      const [existing] = await tx.query('SELECT event_id FROM pro_webhook_receipt WHERE event_id = ?', [id]);
      if (!existing) await tx.query('INSERT INTO pro_webhook_receipt (event_id, received_at) VALUES (?, ?)', [id, now()]);
      return { received: true, duplicate: Boolean(existing), eventId: id, mode: 'test' };
    });
  }

  async function claim() {
    return db.transaction(async tx => {
      await readSettings(tx, true);
      const active = await access(tx);
      const destinations = Object.keys(featureFor).filter(destination => active.features.includes(featureFor[destination]));
      if (!destinations.length) return;
      const time = now(), lease = randomUUID();
      const [row] = await tx.query(`SELECT * FROM pro_delivery WHERE status = 'pending' AND license_version = ?
        AND next_at <= ? AND lease_until <= ? AND destination IN (${destinations.map(() => '?').join(',')})
        ORDER BY next_at, created_at LIMIT 1`, [active.version, time, time, ...destinations]);
      if (!row) return;
      await tx.query('UPDATE pro_delivery SET lease_id = ?, lease_until = ? WHERE event_id = ? AND destination = ?',
        [lease, time + leaseTime, row.event_id, row.destination]);
      return { ...row, lease_id: lease };
    });
  }

  async function drain() {
    await refresh();
    for (let i = 0; i < 6; i++) {
      const row = await claim();
      if (!row) break;
      const active = await access();
      if (row.license_version !== active.version || !active.features.includes(featureFor[row.destination])) break;
      const attempts = Number(row.attempts) + 1;
      let status, detail = '';
      try { status = await deliver(row.destination, JSON.parse(row.payload_json)); }
      catch (error) {
        const code = Number(error.upstreamStatus);
        const phase = ['OAuth', 'Data Manager'].includes(error.upstreamStage) ? error.upstreamStage + ' ' : '';
        const reason = ['invalid_client', 'invalid_grant', 'invalid_request'].includes(error.upstreamReason) ? ' ' + error.upstreamReason : '';
        detail = Number.isInteger(code) && code > 0 ? phase + 'HTTP ' + code + reason : 'Falha de conexão';
        status = attempts < 4 && (!code || code === 429 || code >= 500) ? 'pending' : 'failed';
      }
      await db.query('UPDATE pro_delivery SET status = ?, details = ?, attempts = ?, next_at = ?, lease_id = NULL, lease_until = 0 WHERE event_id = ? AND destination = ? AND lease_id = ?',
        [status, detail, attempts, now() + 60_000 * (2 ** (attempts - 1)), row.event_id, row.destination, row.lease_id]);
    }
    const cutoff = now() - 30 * 86_400_000;
    await db.query('DELETE FROM pro_webhook_receipt WHERE received_at < ?', [cutoff]);
    await db.query('DELETE FROM pro_delivery WHERE created_at < ? AND lease_until <= ?', [cutoff, now()]);
  }

  function sweep() {
    if (!working) working = drain().finally(() => { working = null; });
    return working;
  }
  return { view, appointments, key, testEvent, bookingEvent, acceptWebhook, sweep,
    async attribution(params) { return (await access()).features.includes('advanced_tracking') ? adChannels(params) : []; } };
}
