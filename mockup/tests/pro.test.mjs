import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/database.mjs';
import { createPro } from '../src/pro.mjs';
import { countLandingView, findLandingVisit } from '../src/traffic.mjs';
import { proConfiguration, proDestinations, webhookSignature } from '../src/pro-destinations.mjs';

test('fila e API usam as permissões assinadas e param quando a licença perde acesso', async t => {
  const path = await mkdtemp(join(tmpdir(), 'rael-pro-test-'));
  const db = await openDatabase({ driver: 'sqlite', path: join(path, 'test.sqlite') });
  t.after(async () => { await db.close(); await rm(path, { recursive: true }); });
  await db.query("INSERT INTO business_settings (id, revision, draft_json) VALUES (1, 0, '{}')");
  const time = Date.now();
  const row = { id: 'reservation-1', starts_at: time + 3600_000 };
  await db.query('INSERT INTO customers (id, email, name, phone, created_at) VALUES (?, ?, ?, ?, ?)',
    ['customer', 'private@example.invalid', 'Não exportar', '55999999999', time]);
  await db.query(`INSERT INTO appointments (id, customer_id, professional_id, service_id, starts_at, ends_at,
    occupied_until, status, revision, snapshot_json, metadata_json, created_at, updated_at)
    VALUES (?, 'customer', 'professional', 'service', ?, ?, ?, 'confirmed', 0, '{}', '{}', ?, ?)`,
    [row.id, row.starts_at, row.starts_at + 600_000, row.starts_at + 600_000, time, time]);
  const features = ['api', 'webhooks', 'advanced_tracking'];
  let claims = null;
  const received = [];
  const receiptSecret = '24'.repeat(32);
  const pro = createPro(db, { async proAccess() { return claims; }, async sweep() {} }, { origin: 'https://example.invalid', webhook: { secret: receiptSecret } }, {
    now: () => time, async deliver(destination, event) {
      received.push({ destination, ...event });
      return 'simulated';
    }
  });
  await assert.rejects(pro.key(true), { status: 403 });
  await assert.rejects(pro.testEvent(), { status: 403 });
  claims = { features, version: 'license:1' };
  const params = new URLSearchParams('utm_campaign=teste&gclid=secret-google&fbclid=secret-meta');
  const channels = await pro.attribution(params);
  assert.deepEqual(channels, ['meta', 'google']);
  const ref = await countLandingView(db, params, time, channels);
  const visit = await findLandingVisit(db, ref, time);
  assert.doesNotMatch(JSON.stringify(await db.query('SELECT utm_json FROM landing_visits')), /secret-/);
  await db.query('INSERT INTO landing_visit_bookings (appointment_id, visit_key) VALUES (?, ?)', [row.id, visit.visitKey]);

  await db.transaction(async tx => {
    await pro.bookingEvent(tx, row, 'confirmed', 'first');
    await pro.bookingEvent(tx, row, 'confirmed', 'retry');
  });
  await pro.sweep();
  assert.equal(received.length, 3);
  assert.ok(received.every(event => event.id === received[0].id && event.synthetic === false));
  assert.deepEqual(new Set(received.map(event => event.destination)), new Set(['google', 'meta', 'webhook']));

  const { apiKey } = await pro.key(true);
  const auth = 'Bearer ' + apiKey;
  const api = await pro.appointments(auth, new URLSearchParams('status=confirmed&limit=1'));
  assert.equal(api.appointments[0].id, row.id);
  assert.doesNotMatch(JSON.stringify(api), /private|customer|Não exportar/);
  await assert.rejects(pro.appointments(auth, new URLSearchParams('limit=1000')), { status: 422 });
  const next = await pro.key(true);
  await assert.rejects(pro.appointments(auth, new URLSearchParams()), { status: 401 });
  assert.notEqual(apiKey, next.apiKey);

  const testEvent = await pro.testEvent();
  const [queued] = await db.query("SELECT payload_json FROM pro_delivery WHERE event_id = ? AND destination = 'webhook'", [testEvent.eventId]);
  const bytes = Buffer.from(queued.payload_json);
  const seconds = String(Math.floor(time / 1000));
  const headers = { 'x-rael-mode': 'test', 'x-rael-event-id': testEvent.eventId, 'x-rael-timestamp': seconds,
    'x-rael-signature': webhookSignature(receiptSecret, seconds, bytes) };
  await assert.rejects(pro.acceptWebhook(headers, Buffer.concat([bytes, Buffer.from(' ')])), { status: 401 });
  await assert.rejects(pro.acceptWebhook({ ...headers, 'x-rael-timestamp': String(Number(seconds) - 400) }, bytes), { status: 401 });
  assert.equal((await pro.acceptWebhook(headers, bytes)).duplicate, false);
  assert.equal((await pro.acceptWebhook(headers, bytes)).duplicate, true);
  claims = null;
  await pro.sweep();
  assert.equal(received.length, 3);
  await assert.rejects(pro.appointments('Bearer ' + next.apiKey, new URLSearchParams()), { status: 403 });
  claims = { features, version: 'license:2' };
  await pro.sweep();
  assert.equal(received.length, 3);
  assert.ok(!(await pro.view()).deliveries.some(row => row.eventId === testEvent.eventId));
  await assert.rejects(pro.appointments('Bearer ' + next.apiKey, new URLSearchParams()), { status: 401 });
});

test('conectores de teste usam sandbox, validação e HMAC e não enviam reservas reais', async () => {
  assert.equal(proConfiguration({ APP_LICENSE_MODE: 'test', APP_PRO_MODE: 'live' }, 'https://example.invalid'), null);
  const secret = '11'.repeat(32);
  const config = {
    origin: 'https://example.invalid',
    meta: { dataset: '123456', token: 'synthetic', code: 'TEST123' },
    google: { account: '1234567890', action: '123456', client_id: 'synthetic', client_secret: 'synthetic', refresh_token: 'synthetic' },
    webhook: { url: 'https://receiver.example.invalid/webhook', secret }
  };
  const calls = [];
  const deliver = proDestinations(config, async (url, options) => {
    calls.push({ url, ...options });
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'synthetic' });
    if (url.startsWith('https://graph.facebook.com/')) return Response.json({ events_received: 1 });
    return Response.json({});
  });
  const event = { id: 'synthetic-event', at: new Date().toISOString(), type: 'appointment.confirmed', mode: 'test', synthetic: false };
  for (const dest of ['meta', 'google', 'webhook']) assert.equal(await deliver(dest, event), 'simulated');
  assert.equal(calls.length, 0);
  event.synthetic = true;
  assert.equal(await deliver('meta', event), 'received');
  assert.equal(JSON.parse(calls[0].body).data[0].event_name, 'Schedule');
  assert.equal(JSON.parse(calls[0].body).test_event_code, 'TEST123');
  assert.equal(await deliver('google', event), 'validated');
  assert.equal(JSON.parse(calls[2].body).validateOnly, true);
  assert.equal(await deliver('webhook', event), 'received');
  const webhook = calls[3];
  assert.equal(webhook.redirect, 'error');
  assert.equal(webhook.headers['X-Rael-Event-Id'], event.id);
  assert.equal(webhook.headers['X-Rael-Signature'], webhookSignature(secret, webhook.headers['X-Rael-Timestamp'], webhook.body));
});
