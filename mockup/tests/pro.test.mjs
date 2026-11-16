import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
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
  const bundle = Buffer.from(JSON.stringify({ client_id: 'test-id', client_secret: 'test-secret', refresh_token: 'test-refresh' })).toString('base64url');
  const prepared = proConfiguration({ APP_LICENSE_MODE: 'test', APP_PRO_MODE: 'test', APP_PRO_GOOGLE_TEST_ACCOUNT: '1234567890',
    APP_PRO_GOOGLE_TEST_ACTION: '123', APP_PRO_GOOGLE_TEST_OAUTH_B64: bundle }, 'https://example.invalid');
  assert.equal(prepared.google.refresh_token, 'test-refresh');
  const partial = proConfiguration({ APP_LICENSE_MODE: 'test', APP_PRO_MODE: 'test', APP_PRO_WEBHOOK_TEST_URL: 'https://receiver.example.invalid' }, 'https://example.invalid');
  assert.equal(partial.webhook, undefined);
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
  const google = JSON.parse(calls[2].body);
  assert.equal(google.validateOnly, true);
  assert.equal(google.events[0].adIdentifiers.gclid, 'GCLID_1');
  assert.equal(google.events[0].userData, undefined);
  assert.equal(await deliver('webhook', event), 'received');
  const webhook = calls[3];
  assert.equal(webhook.redirect, 'error');
  assert.equal(webhook.headers['X-Rael-Event-Id'], event.id);
  assert.equal(webhook.headers['X-Rael-Signature'], webhookSignature(secret, webhook.headers['X-Rael-Timestamp'], webhook.body));
  const send = async (url, options) => {
    calls.push({ url, ...options });
    if (url.endsWith('/token')) return Response.json({ access_token: 'fixture' });
    return Response.json({ events_received: 1 });
  };
  const live = proDestinations({ ...config, slug: 'agenda', real: true }, send);
  const confirmed = { ...event, mode: 'live', synthetic: false,
    clicks: { fbc: 'fb.1.100.ClickFixture', agent: 'Test browser', google: { gclid: 'ClickFixture' } } };
  await live('meta', confirmed);
  const actualMeta = JSON.parse(calls.at(-1).body);
  assert.equal(actualMeta.test_event_code, undefined);
  assert.deepEqual(actualMeta.data[0].user_data, { fbc: 'fb.1.100.ClickFixture', client_user_agent: 'Test browser' });
  assert.equal(await live('google', confirmed), 'accepted');
  const actualGoogle = JSON.parse(calls.at(-1).body);
  assert.equal(actualGoogle.validateOnly, false);
  assert.deepEqual(actualGoogle.events[0].adIdentifiers, { gclid: 'ClickFixture' });
  assert.equal(actualGoogle.consent.adPersonalization, 'CONSENT_DENIED');
  assert.equal(await deliver('google', confirmed), 'simulated');
});

test('a conta de serviço autentica no Google com escopo exclusivo do Data Manager', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const credential = { type: 'service_account', client_email: 'agendamentos@fixture.iam.gserviceaccount.com',
    private_key_id: '12'.repeat(20), private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const env = { APP_PRO_MODE: 'test', APP_LICENSE_MODE: 'test', APP_PRO_REAL_EVENTS: '1',
    APP_PRO_GOOGLE_TEST_ACCOUNT: '1234567890', APP_PRO_GOOGLE_TEST_ACTION: '123',
    APP_PRO_GOOGLE_CLIENT_ID: 'legacy', APP_PRO_GOOGLE_CLIENT_SECRET: 'legacy', APP_PRO_GOOGLE_REFRESH_TOKEN: 'legacy',
    APP_PRO_GOOGLE_SERVICE_ACCOUNT_B64: Buffer.from(JSON.stringify(credential)).toString('base64url') };
  const config = proConfiguration(env, 'https://example.invalid');
  assert.equal(config.google.refresh_token, undefined);
  assert.equal(proConfiguration({ ...env, APP_PRO_GOOGLE_SERVICE_ACCOUNT_B64: 'invalid' }, 'https://example.invalid').google, undefined);
  const deliver = proDestinations(config, async (url, { body, headers }) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(body);
      assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      const [header, claims, signature] = form.get('assertion').split('.');
      const decode = part => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
      assert.deepEqual(decode(header), { alg: 'RS256', typ: 'JWT', kid: credential.private_key_id });
      const token = decode(claims);
      assert.equal(token.iss, credential.client_email);
      assert.equal(token.scope, 'https://www.googleapis.com/auth/datamanager');
      assert.equal(token.aud, url);
      assert.equal(token.exp - token.iat, 300);
      assert.ok(verify('RSA-SHA256', Buffer.from(header + '.' + claims), publicKey, Buffer.from(signature, 'base64url')));
      return Response.json({ access_token: 'fixture' });
    }
    assert.equal(url, 'https://datamanager.googleapis.com/v1/events:ingest');
    assert.equal(headers.Authorization, 'Bearer fixture');
    const payload = JSON.parse(body);
    assert.equal(payload.destinations[0].operatingAccount.accountId, '1234567890');
    assert.equal(payload.destinations[0].productDestinationId, '123');
    assert.equal(payload.validateOnly, true);
    return Response.json({});
  });
  assert.equal(await deliver('google', { id: 'fixture', at: new Date().toISOString(), mode: 'test', synthetic: true }), 'validated');
});

test('Real: webhook apenas na confirmação e publicidade apenas após optar', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'rael-pro-real-'));
  const db = await openDatabase({ driver: 'sqlite', path: join(folder, 'real.sqlite') });
  t.after(async () => { await db.close(); await rm(folder, { recursive: true }); });
  await db.query("INSERT INTO business_settings (id, revision, draft_json) VALUES (1, 0, '{}')");
  const time = Date.now(), cfg = { origin: 'https://pilot.example.invalid', real: true,
    meta: {}, google: {}, webhook: { secret: '55'.repeat(32) } };
  let claims = { features: ['advanced_tracking', 'webhooks'], version: 'test:1' };
  const delivered = [];
  const pro = createPro(db, { async proAccess() { return claims; }, async sweep() {} }, cfg, {
    now: () => time, async deliver(destination, event) { delivered.push({ destination, event }); return 'received'; }
  });
  await db.query("INSERT INTO customers (id, email, name, phone, created_at) VALUES ('c', 'fake@example.invalid', 'Test', '55110000000', ?)", [time]);
  async function reserve(id, decision) {
    const ref = await countLandingView(db, {}, time);
    const attributes = { gclid: 'AaBbCc_Fixture-Sample9', fbclid: 'AaBbCc_Fixture-Social7' };
    if (decision === 'opt-in') await pro.consent(ref, 'allow', attributes, 'Test browser');
    const visit = await findLandingVisit(db, ref, time);
    const row = { id, starts_at: time + 600_000, created_at: time };
    await db.query(`INSERT INTO appointments (id, customer_id, professional_id, service_id, starts_at, ends_at,
      occupied_until, status, revision, snapshot_json, metadata_json, created_at, updated_at)
      VALUES (?, 'c', 'pro', 's', ?, ?, ?, 'confirmed', 0, '{}', '{}', ?, ?)`,
      [id, row.starts_at, row.starts_at + 600_000, row.starts_at + 600_000, time, time]);
    await db.query('INSERT INTO landing_visit_bookings (appointment_id, visit_key) VALUES (?, ?)', [id, visit.visitKey]);
    await db.transaction(async tx => {
      await pro.bookingEvent(tx, row, 'confirmed');
      await pro.bookingEvent(tx, row, 'confirmed');
      await pro.bookingEvent(tx, row, 'cancelled');
      await pro.bookingEvent(tx, row, 'rescheduled', 'revision');
    });
    return ref;
  }
  await reserve('confirmed-and-consented', 'opt-in');
  await reserve('confirmed-no-consent');
  const withdrawn = await reserve('confirmed-withdrawn', 'opt-in');
  await pro.consent(withdrawn, 'deny', {}, '');
  await pro.sweep();
  const webhook = delivered.filter(v => v.destination === 'webhook');
  assert.equal(webhook.length, 3);
  assert.ok(webhook.every(v => v.event.type === 'appointment.confirmed' && v.event.mode === 'live' && !v.event.synthetic && !v.event.visitKey && !v.event.clicks));
  assert.equal(delivered.filter(v => v.destination === 'google').length, 1);
  assert.equal(delivered.filter(v => v.destination === 'meta').length, 1);
  const body = Buffer.from(JSON.stringify(webhook[0].event));
  const seconds = String(Math.floor(time / 1000));
  const headers = { 'x-rael-mode': 'live', 'x-rael-event-id': webhook[0].event.id, 'x-rael-timestamp': seconds,
    'x-rael-signature': webhookSignature(cfg.webhook.secret, seconds, body) };
  const [receipt] = (await pro.view()).deliveries.filter(row => row.destination === 'webhook' && row.eventId === webhook[0].event.id);
  assert.equal(receipt.mode, 'live');
  assert.equal((await pro.acceptWebhook(headers, body)).mode, 'live');
  assert.equal((await pro.acceptWebhook(headers, body)).duplicate, true);
  claims = null;
  await assert.rejects(pro.acceptWebhook(headers, body), { status: 403 });
  await reserve('expired-license', '');
  await pro.sweep();
  assert.equal(delivered.length, 5);
});
