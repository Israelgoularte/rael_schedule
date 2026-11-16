import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase, readSettings } from '../src/database.mjs';
import { createInstallationLicense } from '../src/installation-license.mjs';

test('a licença da instalação acompanha compra, renovação e recuperação e recusa tokens ou checkouts inválidos', async t => {
  const path = await mkdtemp(join(tmpdir(), 'rael-license-test-'));
  const db = await openDatabase({ driver: 'sqlite', path: join(path, 'test.sqlite') });
  t.after(async () => { await db.close(); await rm(path, { recursive: true }); });
  const professionals = ['a', 'b', 'c'].map(id => ({ id, active: true }));
  const draft = JSON.stringify({ professionals });
  await db.query('INSERT INTO business_settings (id, revision, draft_json, published_json) VALUES (1, 0, ?, ?)', [draft, draft]);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const product = 'rael-schedule', keyId = 'integration-test';
  const licenseId = randomUUID(), orderId = randomUUID();
  const day = 86_400_000, initial = Date.UTC(2026, 0, 1);
  let time = initial, validity = initial + 365 * day;
  let registered, paid = false, connected = true, sandbox = true, wrongSubject = false, tamper = false, moved = false;
  const calls = [];
  const service = createInstallationLicense(db, true, {
    now: () => time, config: { keyId, key: publicKey },
    async send(raw, options) {
      if (!connected) throw new Error('offline');
      const url = new URL(raw);
      assert.equal(url.origin, 'https://licencas.raelapps.com');
      assert.equal(options.redirect, 'error');
      calls.push(url.pathname);
      if (url.pathname === '/v1/catalog') return Response.json({ plans: [{ code: 'team', amount: 29700 }] });
      if (url.pathname === '/v1/installations') {
        const data = JSON.parse(options.body);
        assert.match(data.credential, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(data.product, product);
        registered = data;
        return Response.json({ id: data.id, product });
      }
      assert.equal(options.headers.Authorization, 'Bearer ' + registered.credential);
      assert.equal(options.headers['X-Installation-Id'], registered.id);
      const order = { id: orderId, emailVerified: paid, status: paid ? 'paid' : 'open' };
      if (url.pathname === '/v1/orders') return Response.json(options.method === 'POST' ? order : [order]);
      if (url.pathname === '/v1/orders/renewal') return Response.json({ ...order, emailVerified: true, status: 'open' });
      if (url.pathname.endsWith('/checkout')) return Response.json({ url: sandbox ? 'https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=test' : 'https://www.mercadopago.com.br/checkout/v1/redirect' });
      if (url.pathname === '/v1/recovery') {
        assert.deepEqual(JSON.parse(options.body), { email: 'test@example.com' });
        return Response.json({ submitted: true });
      }
      assert.equal(url.pathname, '/v1/license');
      if (!paid || moved) return Response.json({ status: 'community', product });
      const payload = Buffer.from(JSON.stringify({
        schema: 'rael-license-v1', keyId, product, installationId: wrongSubject ? randomUUID() : registered.id,
        licenseId, activationVersion: 1, plan: 'team', seats: 20, features: [],
        validFrom: new Date(initial).toISOString(), expiresAt: new Date(validity).toISOString(),
        graceUntil: new Date(validity + day).toISOString()
      }));
      const signature = sign(null, tamper ? Buffer.from('invalid') : payload, privateKey);
      return Response.json({ id: licenseId, status: 'active', license: payload.toString('base64url') + '.' + signature.toString('base64url') });
    }
  });
  const settings = await readSettings(db);
  assert.deepEqual((await service.view()).license, { status: 'community', plan: 'community', seats: 2 });
  assert.deepEqual(calls, ['/v1/catalog']);
  await assert.rejects(service.assertSeats(db, settings, professionals, true), { status: 422 });
  assert.deepEqual([...await service.bookable(db, settings)], ['a', 'b']);
  assert.deepEqual(await service.action('purchase', { plan: 'team', email: 'test@example.com' }), { id: orderId, emailVerified: false, status: 'open' });
  assert.match((await service.action('checkout', { orderId })).url, /^https:\/\/sandbox\./);
  sandbox = false;
  await assert.rejects(service.action('checkout', { orderId }), { status: 503 });

  paid = true;
  tamper = true;
  assert.equal((await service.view()).online, false);
  assert.equal((await service.current()).status, 'community');
  tamper = false;
  wrongSubject = true;
  await assert.rejects(service.sweep(), { status: 503 });
  wrongSubject = false;
  await service.sweep();
  const active = await service.view();
  assert.equal(active.license.status, 'active');
  assert.equal(active.license.seats, 20);
  assert.doesNotMatch(JSON.stringify(active), new RegExp(registered.credential + '|' + registered.id));
  assert.deepEqual([...await service.bookable(db, settings)], ['a', 'b', 'c']);
  await service.assertSeats(db, settings, professionals, true);
  await service.action('renewal', {});
  validity += 365 * day;
  assert.equal((await service.view()).license.expiresAt, new Date(validity).toISOString());

  connected = false;
  assert.equal((await service.view()).license.status, 'active');
  time = validity;
  assert.equal((await service.current()).status, 'grace');
  time += day;
  assert.equal((await service.current()).status, 'expired');
  assert.equal((await service.current()).seats, 2);

  connected = true;
  time = initial;
  moved = true;
  assert.deepEqual(await service.action('recovery', { email: 'test@example.com' }), { submitted: true });
  assert.equal((await service.view()).license.status, 'community');
  moved = false;
  assert.equal((await service.view()).license.status, 'active');
});
