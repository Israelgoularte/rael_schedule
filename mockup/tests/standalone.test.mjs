import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import sharp from 'sharp';
import { setTimeout as sleep } from 'node:timers/promises';

test('a instalação publica somente os dados da agenda e mantém acessos separados', { timeout: 40000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'rael-standalone-'));
  const listener = createServer().listen(0, '127.0.0.1');
  await new Promise(resolve => listener.once('listening', resolve));
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  const origin = 'http://127.0.0.1:' + port;
  const token = randomBytes(32).toString('base64url');
  const mysql = process.env.TEST_MYSQL_DB;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      APP_ORIGIN: origin, PORT: String(port), HOST: '127.0.0.1',
      ...(mysql ? { DB_HOST: '127.0.0.1', DB_PORT: process.env.TEST_MYSQL_PORT, DB_NAME: mysql,
        DB_USER: process.env.TEST_MYSQL_USER, DB_PASSWORD: process.env.TEST_MYSQL_PASSWORD } :
        { APP_LOCAL_DB: join(folder, 'agenda.sqlite') }),
      APP_BUSINESS_NAME: 'Empresa de teste', APP_OWNER_NAME: 'Pessoa Gestora',
      APP_OWNER_EMAIL: 'equipe@example.com', APP_SETUP_TOKEN: token,
      APP_SETUP_EXPIRES: new Date(Date.now() + 60000).toISOString(),
      APP_SOURCE_URL: 'https://example.com/releases/test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stderr.on('data', chunk => { logs += chunk; });
  child.stdout.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(resolve => child.once('close', resolve));
      child.kill();
      await closed;
    }
    await rm(folder, { recursive: true, force: true });
  });
  async function call(path, { method = 'GET', data, cookie, csrf } = {}) {
    return fetch(origin + path, {
      method, redirect: 'manual',
      headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) },
      body: data ? JSON.stringify(data) : undefined
    });
  }
  for (let i = 0; i < 100; i++) {
    if (await call('/').catch(() => null)) break;
    if (child.exitCode !== null) assert.fail(logs);
    await sleep(40);
  }
  async function json(path, options, status) {
    const response = await call(path, options);
    const raw = await response.text();
    assert.equal(response.status, status, path + ': ' + raw);
    return { data: JSON.parse(raw), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  let response = await call('/');
  assert.equal(response.status, 200, logs);
  const unpublished = await response.text();
  assert.match(unpublished, /<h1>Empresa de teste<\/h1>/);
  assert.match(unpublished, /href="\/negocio\/agenda">Agendar horário/);
  assert.match(unpublished, /href="\/sistema\/agenda\?acesso=cliente">Entrar/);
  assert.match(unpublished, /href="\/sistema\/agenda\?acesso=cadastro">Criar conta/);
  assert.doesNotMatch(unpublished, /<form\b|<input\b/);
  const login = await (await call('/sistema/agenda?acesso=cliente')).text();
  assert.match(login, /data-mode="login"/);
  assert.match(login, /<form method="post">/);
  assert.match(login, /<fieldset hidden disabled>/);
  const signup = await (await call('/sistema/agenda?acesso=cadastro')).text();
  assert.match(signup, /data-mode="register"/);
  assert.match(signup, /<fieldset\s*>/);
  assert.match(signup, /autocomplete="new-password"/);
  assert.doesNotMatch(await (await call('/sistema/agenda')).text(), /data-mode="(?:login|register)"/);
  for (const path of ['/precos', '/comecar', '/operacao', '/plataforma.html', '/internal/agenda/license', '/internal/agenda/account/closure']) {
    assert.equal((await call(path)).status, 404, path);
  }
  const api = '/internal/agenda/';
  const password = 'Uma senha de teste 2026';
  const activate = { method: 'POST', data: { kind: 'invite', token, password } };
  await json(api + 'activate', activate, 200);
  await json(api + 'activate', activate, 422);
  const staff = await json(api + 'login', { method: 'POST', data: { email: 'equipe@example.com', password } }, 200);
  const identity = { cookie: staff.cookie, csrf: staff.data.csrf };
  const { data: { draft, revision } } = await json(api + 'setup', identity, 200);
  assert.equal((await call(api + 'traffic')).status, 401);
  assert.equal((await call('/sistema/agenda/acessos')).status, 200);
  const coverPng = await sharp({ create: { width: 1200, height: 600, channels: 3, background: '#305097' } }).png().toBuffer();
  const { data: cover } = await json(api + 'business-cover', {
    ...identity, method: 'PUT', data: { image: 'data:image/png;base64,' + coverPng.toString('base64'), revision }
  }, 200);
  const { data: beforePublish } = await json(api + 'setup', identity, 200);
  assert.match(beforePublish.images.cover, /^\/media\/agenda\/cover\//);
  assert.equal((await call(beforePublish.images.cover)).status, 401);
  Object.assign(draft.business, {
    description: 'Descrição personalizada', landingHeadline: 'Seu horário, do seu jeito',
    landingColor: '#305097', name: 'Agenda do <Bairro>', segment: 'beleza', phone: '11987654321',
    email: 'agenda@example.com', address: 'Rua Exemplo, 100'
  });
  draft.teamMode = 'team';
  for (let n = 2; n < 5; n++) {
    draft.professionals.push({ ...draft.professionals[0], name: 'Pessoa ' + n,
      email: 'pessoa' + n + '@example.com', id: randomUUID() });
  }
  draft.services = [
    { id: randomUUID(), name: 'Corte clássico', description: 'Corte agendado', priceCents: 4500,
      durationMinutes: 30, gapMinutes: 0, professionalIds: draft.professionals.map(person => person.id), online: true },
    { id: randomUUID(), name: 'Serviço interno', description: '', priceCents: 0,
      durationMinutes: 10, gapMinutes: 0, professionalIds: [], online: false }
  ];
  const setup = await json(api + 'setup', { ...identity, method: 'PUT', data: { draft, revision: cover.revision } }, 200);
  assert.doesNotMatch(await (await call('/')).text(), /Corte clássico/);
  await json(api + 'publish', { ...identity, method: 'POST', data: { revision: setup.data.revision } }, 200);
  const landing = await (await call('/')).text();
  assert.match(landing, /Agenda do &lt;Bairro&gt;/);
  assert.match(landing, /Seu horário, do seu jeito/);
  assert.match(landing, /--accent:#305097/);
  assert.match(landing, /Corte clássico/);
  assert.match(landing, /Pessoa 4/);
  assert.match(landing, /class="hero-cover"/);
  const coverAsset = await call(beforePublish.images.cover);
  assert.equal(coverAsset.status, 200);
  assert.equal(coverAsset.headers.get('content-type'), 'image/webp');
  assert.match(landing, /href="\/negocio\/agenda">Agendar horário/);
  assert.doesNotMatch(landing, /<form\b|<input\b/);
  assert.match(landing, /href="\/codigo-fonte"/);
  assert.doesNotMatch(landing, /Serviço interno|pessoa4@example.com/);
  assert.equal((await call('/negocio/agenda')).status, 200);

  const campaign = { utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'estreia', utm_content: 'botao', utm_term: 'agenda' };
  const trackedPath = '/' + '?' + new URLSearchParams({ ...campaign, other: 'ignorar' });
  const tracked = await (await call(trackedPath)).text();
  const entryLink = tracked.match(/href="([^"]+)">Agendar horário/)[1].replaceAll('&amp;', '&');
  const carried = new URL(origin + entryLink);
  assert.deepEqual(Object.fromEntries(carried.searchParams), campaign);
  const access = await (await call('/sistema/agenda?acesso=cadastro&' + new URLSearchParams(campaign))).text();
  assert.match(access, /data-bookings="\/negocio\/agenda\?visao=agendamentos&amp;utm_source=newsletter/);
  assert.equal((await call(trackedPath, { method: 'HEAD' })).status, 200);
  assert.equal((await call(trackedPath)).status, 200);

  const consumer = { email: 'cliente@example.com', password };
  const register = await json(api + 'customer/register', { method: 'POST',
    data: { ...consumer, name: 'Pessoa Cliente', phone: '5511987654321' } }, 201);
  await json(api + 'customer/session', { cookie: register.cookie }, 200);
  await json(api + 'customer/login', { method: 'POST', data: consumer }, 200);
  assert.equal((await call(api + 'setup', { cookie: register.cookie })).status, 401);
  const audience = { cookie: register.cookie, csrf: register.data.csrf };
  const serviceId = draft.services[0].id;
  const professionalId = draft.professionals[3].id;
  const day = new Date(Date.now() + 3 * 86400000);
  if (day.getUTCDay() === 0) day.setUTCDate(day.getUTCDate() + 1);
  const date = day.toISOString().slice(0, 10);
  const query = new URLSearchParams({ serviceId, professionalId, date });
  const { data: availability } = await json(api + 'availability?' + query, audience, 200);
  assert.ok(availability.slots.length);
  const booking = { serviceId, professionalId, startAt: availability.slots[0].startAt,
    quote: availability.quote.signature, idempotencyKey: randomUUID(), metadata: Object.fromEntries(carried.searchParams) };
  const first = await json(api + 'customer/reserve', { ...audience, method: 'POST', data: booking }, 201);
  const retry = await json(api + 'customer/reserve', { ...audience, method: 'POST', data: booking }, 200);
  assert.equal(first.data.appointment.id, retry.data.appointment.id);
  const { data: history } = await json(api + 'customer/appointments', audience, 200);
  assert.equal(history.appointments.length, 1);
  await json(api + 'customer/status', { ...audience, method: 'POST', data: {
    appointmentId: first.data.appointment.id, revision: first.data.appointment.revision, status: 'cancelled'
  } }, 200);
  assert.equal((await call(api + 'traffic', audience)).status, 401);
  const { data: traffic } = await json(api + 'traffic?days=7', identity, 200);
  assert.deepEqual(traffic.campaigns.find(entry => entry.utms.utm_campaign === 'estreia'), {
    utms: campaign, visits: 2, bookings: 1
  });
  assert.ok(traffic.totals.visits >= 2);
  assert.equal(traffic.totals.bookings, 1);
  assert.equal(traffic.daily.length, 7);
  assert.equal(traffic.daily.reduce((sum, row) => sum + row.visits, 0), traffic.totals.visits);
  const matchingVisits = await call('/?utm_source=social&utm_campaign=estreia');
  assert.equal(matchingVisits.status, 200);
  const { data: campaignSummary } = await json(api + 'traffic?days=7&campaign=utm%3Aestreia', identity, 200);
  assert.deepEqual(campaignSummary.byCampaign, [{ name: 'estreia', visits: 3, bookings: 1, rate: 1 / 3 }]);
  const custom = new URLSearchParams({ days: 'custom', from: traffic.today, to: traffic.today, source: 'utm:newsletter' });
  const { data: filtered } = await json(api + 'traffic?' + custom, identity, 200);
  assert.deepEqual(filtered.daily, [{ date: traffic.today, visits: 2, bookings: 1 }]);
  assert.equal(filtered.totals.rate, .5);
  await json(api + 'traffic?days=custom&from=2020-01-01&to=2021-01-01', identity, 422);
});
