import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
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
  assert.match(await response.text(), /Criar conta/);
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
  const setup = await json(api + 'setup', { ...identity, method: 'PUT', data: { draft, revision } }, 200);
  assert.doesNotMatch(await (await call('/')).text(), /Corte clássico/);
  await json(api + 'publish', { ...identity, method: 'POST', data: { revision: setup.data.revision } }, 200);
  const landing = await (await call('/')).text();
  assert.match(landing, /Agenda do &lt;Bairro&gt;/);
  assert.match(landing, /Seu horário, do seu jeito/);
  assert.match(landing, /--accent:#305097/);
  assert.match(landing, /Corte clássico/);
  assert.match(landing, /Pessoa 4/);
  assert.match(landing, /href="\/codigo-fonte"/);
  assert.doesNotMatch(landing, /Serviço interno|pessoa4@example.com/);
  assert.equal((await call('/negocio/agenda')).status, 200);

  const consumer = { email: 'cliente@example.com', password };
  const register = await json(api + 'customer/register', { method: 'POST',
    data: { ...consumer, name: 'Pessoa Cliente', phone: '5511987654321' } }, 201);
  await json(api + 'customer/session', { cookie: register.cookie }, 200);
  await json(api + 'customer/login', { method: 'POST', data: consumer }, 200);
  assert.equal((await call(api + 'setup', { cookie: register.cookie })).status, 401);
});
