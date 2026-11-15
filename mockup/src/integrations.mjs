import { randomBytes, randomUUID } from 'node:crypto';
import { failure, rateLimit } from './security.mjs';
import { createMercadoPagoClient, secretBox } from './mercadopago-client.mjs';
import { platformCollectorIds } from './platform-billing.mjs';
import { selfTestBindingFor, selfTestCollectorAllowed } from './payment-self-test.mjs';

const numeric = value => typeof value === 'string' && /^\d{4,32}$/.test(value);
const keyReady = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const allowed = ['clientId', 'clientSecret', 'webhookSecret', 'revision', 'confirmedOwnership'];
const complete = value => Boolean(value?.enabled && numeric(value.clientId) && value.clientSecret && keyReady(value.encryptionKey) && value.webhookSecret);
const safeSecret = value => typeof value === 'string' && value.length <= 4096 && !/[\x00-\x20\x7f]/.test(value);

// A shared mutable object lets existing payment/subscription services observe a
// committed rotation without restarting. No credential is inherited globally.
export function createIntegrationSettings(db, slug, config, runtimePayments, { registryDatabase, authorizeWrite } = {}) {
  const legacy = { ...runtimePayments }, now = config.now ?? (() => Date.now());
  const request = createMercadoPagoClient({}, config.mpTransport);
  const envelope = () => secretBox(config.integrationKey, `rael:mp:application:${slug}`);
  const serverMode = () => config.testMode ? 'sandbox' : (legacy.mode ?? 'live');
  let current = null, application = null, ready = true, recoverableClaim = false, problem = '';

  function administrator(user) { if (user?.role !== 'admin') throw failure(403, 'Somente o administrador configura o Mercado Pago deste negócio.'); }
  function replace(value) { for (const key of Object.keys(runtimePayments)) delete runtimePayments[key]; Object.assign(runtimePayments, value); }
  function activate(value) {
    application = value;
    // Protected application storage is independent from permission to move money.
    // Refresh always applies the current release guard, including after revocation.
    replace({ ...value, enabled: value.enabled === true && liveAllowed(value.mode) });
  }
  async function registry() {
    const central = registryDatabase ? await registryDatabase() : Object.keys(config.entries ?? { [slug]: {} }).length <= 1 ? db : null;
    if (!central) throw failure(503, 'A plataforma precisa preparar o registro exclusivo das aplicações antes de salvar.');
    return central;
  }
  function decode(row) {
    const value = envelope().open(row.payload_cipher);
    if (!complete(value) || value.clientId !== row.client_id || value.mode !== row.mode || !['sandbox', 'live'].includes(value.mode)) throw failure(503, 'A configuração protegida do Mercado Pago precisa ser conferida pela plataforma.');
    return value;
  }
  function liveAllowed(mode) { return mode !== 'live' || !config.testMode && config.paymentsLiveApproved === true; }
  async function refresh() {
    const [row] = await db.query('SELECT * FROM mp_integration_settings WHERE id = 1');
    current = row ?? null; application = null; ready = true; recoverableClaim = false; problem = '';
    try {
      const reserved = platformCollectorIds(config);
      const clientId = row?.client_id ?? legacy.clientId;
      const cleanupBinding = selfTestBindingFor(config, slug);
      const boundCollector = collectorId => cleanupBinding && cleanupBinding.clientId === clientId && cleanupBinding.collectorId === String(collectorId);
      if (row && reserved.includes(String(row.owner_id)) && !boundCollector(row.owner_id)) throw failure(503, 'A conta recebedora pertence à plataforma.');
      if (reserved.length) {
        const connected = await db.query('SELECT professional_id, collector_id FROM mp_connections WHERE status = ?', ['connected']);
        if (connected.some(connection => reserved.includes(String(connection.collector_id)) && (connection.professional_id !== 'business' || !boundCollector(connection.collector_id)))) throw failure(503, 'A conta conectada pertence à plataforma.');
      }
      if (!row) { activate(legacy); return; }
      const value = decode(row), central = await registry();
      const [claim] = await central.query('SELECT tenant_slug FROM mp_application_claims WHERE client_id = ?', [row.client_id]);
      if (!claim) {
        recoverableClaim = true;
        throw failure(503, 'O vínculo exclusivo da aplicação precisa ser confirmado novamente.');
      }
      if (claim.tenant_slug !== slug) throw failure(503, 'A exclusividade da aplicação precisa ser conferida pela plataforma.');
      activate(value);
    } catch {
      // A corrupt envelope, missing central reservation or revoked live approval
      // fails closed for payments while the rest of the scheduling app works.
      ready = false; problem = recoverableClaim ? 'As chaves estão protegidas, mas o vínculo exclusivo precisa ser confirmado. Confira a titularidade e valide novamente, mantendo o Client ID e deixando as duas chaves em branco.' : 'A configuração protegida de recebimento precisa ser conferida pela plataforma.';
      replace({ enabled: false, mode: row?.mode ?? legacy.mode, holdMinutes: legacy.holdMinutes ?? 30 });
    }
  }
  async function view(user) {
    administrator(user); await refresh();
    let centralReady = true; try { await registry(); } catch { centralReady = false; }
    const storageReady = keyReady(config.integrationKey) && centralReady && (ready || recoverableClaim);
    const protectedSecrets = recoverableClaim ? decode(current) : application ?? runtimePayments;
    const applicationConfigured = ready && complete(application);
    const paymentsEnabled = complete(runtimePayments);
    const releasePending = !liveAllowed(serverMode());
    return {
      configured: paymentsEnabled, applicationConfigured, paymentsEnabled, releasePending,
      editable: storageReady, storageReady,
      revision: Number(current?.revision ?? 0), clientId: current?.client_id ?? legacy.clientId ?? '',
      mode: current?.mode ?? serverMode(), owner: current ? { id: current.owner_id, name: current.owner_name } : null,
      source: current ? 'stored' : 'environment',
      secretConfigured: { clientSecret: Boolean(protectedSecrets.clientSecret), webhookSecret: Boolean(protectedSecrets.webhookSecret) },
      callbackUrl: `${config.origin}/payments/mercadopago/callback`,
      webhookUrl: `${config.origin}/payments/mercadopago/webhook/${slug}`,
      ...(problem || !storageReady || releasePending ? { message: problem || (!storageReady ? 'A plataforma está preparando o armazenamento protegido desta configuração.' : 'As chaves podem ser salvas. A conexão das contas e os recebimentos reais aguardam liberação da Raelapps.') } : {})
    };
  }
  async function hasHistory(tx) {
    for (const table of ['mp_connections', 'mp_intents', 'subscriptions']) {
      const [row] = await tx.query(`SELECT COUNT(*) AS total FROM ${table}`);
      if (Number(row.total)) return true;
    }
    const [pending] = await tx.query('SELECT COUNT(*) AS total FROM mp_oauth_states WHERE used_at IS NULL AND expires_at > ?', [now()]);
    return Number(pending.total) > 0;
  }
  function legacyExclusivity(clientId) {
    if (Object.entries(config.entries ?? {}).some(([other, entry]) => other !== slug && String(entry.payments?.clientId ?? '') === clientId)) throw failure(409, 'Essa aplicação já pertence a outro negócio. Crie uma aplicação exclusiva para este negócio.');
  }
  async function claimLegacy(tx) {
    // Also reserve environment-only applications, so a newly guided tenant cannot
    // take an application that a legacy tenant already uses.
    for (const [tenant, entry] of Object.entries(config.entries ?? {})) {
      const id = entry.payments?.clientId;
      if (!numeric(id)) continue;
      const [owner] = await tx.query('SELECT tenant_slug FROM mp_application_claims WHERE client_id = ?', [id]);
      if (owner && owner.tenant_slug !== tenant) throw failure(409, 'Existe um conflito no registro exclusivo das aplicações. A plataforma precisa conferi-lo.');
      const [reserved] = await tx.query('SELECT client_id FROM mp_application_claims WHERE tenant_slug = ?', [tenant]);
      if (!owner && !reserved) await tx.query('INSERT INTO mp_application_claims(client_id, tenant_slug, updated_at) VALUES (?, ?, ?)', [id, tenant, now()]);
    }
  }
  async function validateOwner(clientId, clientSecret, mode) {
    const result = await request('POST', '/oauth/token', { data: { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret } });
    if (typeof result?.access_token !== 'string' || !result.access_token || result.access_token.length > 4096) throw failure(409, 'Não foi possível validar as credenciais da aplicação.');
    const account = await request('GET', '/users/me', { accessToken: result.access_token });
    const id = String(account?.id ?? ''), test = account?.tags?.includes('test_user');
    if (!/^\d{1,32}$/.test(id) || account?.site_id !== 'MLB' || !Array.isArray(account?.tags) || result.user_id !== undefined && String(result.user_id) !== id || (mode === 'sandbox' ? !test : test)) throw failure(409, mode === 'sandbox' ? 'Use uma aplicação de uma conta fictícia brasileira do Mercado Pago para esta validação.' : 'Use uma aplicação da sua conta real brasileira do Mercado Pago. Contas fictícias não recebem pagamentos reais.');
    if (platformCollectorIds(config).includes(id) && !selfTestCollectorAllowed(config, slug, clientId, id, now())) throw failure(409, 'A conta de cobrança da Raelapps é exclusiva da plataforma. Use a própria conta Mercado Pago deste negócio.');
    const name = String(account.nickname || [account.first_name, account.last_name].filter(Boolean).join(' ') || 'Conta Mercado Pago').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 120);
    return { id, name: name || 'Conta Mercado Pago' };
  }
  async function save(user, input) {
    administrator(user);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(input, key)) || !numeric(input.clientId) || !safeSecret(input.clientSecret) || !safeSecret(input.webhookSecret) || !Number.isSafeInteger(input.revision) || input.revision < 0 || input.confirmedOwnership !== true) throw failure(422, 'Confira as credenciais e confirme que a aplicação pertence a este negócio.');
    if (!keyReady(config.integrationKey)) throw failure(503, 'A plataforma precisa preparar o armazenamento protegido antes de salvar.');
    const mode = serverMode();
    legacyExclusivity(input.clientId); const central = await registry();
    await refresh(); if (!ready && !recoverableClaim) throw failure(503, 'A plataforma precisa conferir a configuração protegida e seu vínculo exclusivo antes de alterar.');
    if (Number(current?.revision ?? 0) !== input.revision) throw failure(409, 'A configuração foi alterada em outro acesso. Recarregue antes de salvar.');
    const previous = current ? decode(current) : legacy;
    const sameApp = previous.clientId === input.clientId;
    if (recoverableClaim && (!sameApp || mode !== previous.mode || input.clientSecret || input.webhookSecret)) throw failure(409, 'Primeiro recupere o vínculo com o mesmo Client ID e deixe as duas chaves em branco. Depois você poderá atualizar a configuração.');
    const clientSecret = input.clientSecret || (sameApp ? previous.clientSecret : ''), webhookSecret = input.webhookSecret || (sameApp ? previous.webhookSecret : '');
    if (!clientSecret || !webhookSecret) throw failure(422, 'Informe o Client Secret e o segredo das notificações da sua aplicação.');
    await rateLimit(db, `mp_application_save:${user.id}`, 10);
    const owner = await validateOwner(input.clientId, clientSecret, mode);
    if (current && sameApp && current.owner_id !== owner.id) throw failure(409, 'A titularidade da aplicação retornou diferente. A plataforma precisa conferir antes de alterar.');
    const value = { enabled: true, mode, holdMinutes: previous.holdMinutes ?? legacy.holdMinutes ?? 30, clientId: input.clientId, clientSecret, webhookSecret, encryptionKey: keyReady(previous.encryptionKey) ? previous.encryptionKey : randomBytes(32).toString('hex') };
    const cipher = envelope().seal(value), revision = input.revision + 1;
    try {
      await central.transaction(async centralTx => {
        // One registry lock serializes claims, including first-claim races. With a
        // separate tenant database, refresh also verifies the committed claim;
        // a failure committing either database never activates an unclaimed app.
        await centralTx.query('SELECT id FROM business_settings WHERE id = 1' + centralTx.lock);
        await claimLegacy(centralTx);
        const [claimed] = await centralTx.query('SELECT tenant_slug FROM mp_application_claims WHERE client_id = ?', [input.clientId]);
        if (claimed && claimed.tenant_slug !== slug) throw failure(409, 'Essa aplicação já pertence a outro negócio. Crie uma aplicação exclusiva para este negócio.');
        const write = async tx => {
          await tx.query('SELECT id FROM business_settings WHERE id = 1' + tx.lock);
          // Recheck the session after the remote credential validation, while
          // holding the same lock used by password and team access changes.
          if (authorizeWrite) await authorizeWrite(tx, user);
          const [latest] = await tx.query('SELECT * FROM mp_integration_settings WHERE id = 1');
          if (platformCollectorIds(config).includes(owner.id) && !selfTestCollectorAllowed(config, slug, input.clientId, owner.id, now())) throw failure(409, 'A autorização temporária desta aplicação expirou.');
          if (Number(latest?.revision ?? 0) !== input.revision) throw failure(409, 'A configuração foi alterada em outro acesso. Recarregue antes de salvar.');
          const prior = latest ? decode(latest) : legacy;
          if ((prior.clientId !== value.clientId || prior.mode !== value.mode || !keyReady(prior.encryptionKey)) && await hasHistory(tx)) throw failure(409, 'Já existem conexões ou cobranças neste negócio. Preserve a aplicação, o ambiente e a chave de proteção atuais; a troca exige uma migração assistida.');
          if (latest && prior.encryptionKey !== value.encryptionKey) throw failure(409, 'A chave de proteção foi alterada em outro acesso. Recarregue antes de salvar.');
          const [reserved] = await centralTx.query('SELECT client_id FROM mp_application_claims WHERE tenant_slug = ?', [slug]);
          if (reserved) await centralTx.query('UPDATE mp_application_claims SET client_id = ?, updated_at = ? WHERE tenant_slug = ?', [input.clientId, now(), slug]);
          else await centralTx.query('INSERT INTO mp_application_claims(client_id, tenant_slug, updated_at) VALUES (?, ?, ?)', [input.clientId, slug, now()]);
          if (latest) await tx.query('UPDATE mp_integration_settings SET revision = ?, payload_cipher = ?, client_id = ?, owner_id = ?, owner_name = ?, mode = ?, updated_at = ? WHERE id = 1', [revision, cipher, input.clientId, owner.id, owner.name, mode, now()]);
          else await tx.query('INSERT INTO mp_integration_settings(id, revision, payload_cipher, client_id, owner_id, owner_name, mode, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)', [revision, cipher, input.clientId, owner.id, owner.name, mode, now()]);
          await tx.query('INSERT INTO audit_events(id, actor_id, event_name, detail_json, created_at) VALUES (?, ?, ?, ?, ?)', [randomUUID(), user.id, 'mp_application_configured', JSON.stringify({ clientId: input.clientId, mode, revision }), now()]);
        };
        if (central === db) await write(centralTx); else await db.transaction(write);
      });
    } catch (error) {
      if (error.status) throw error;
      // SQL/provider diagnostics can contain credential-bearing parameters.
      throw failure(503, 'Não foi possível concluir o vínculo protegido. Reabra a configuração e siga a orientação exibida antes de validar novamente.');
    }
    return view(user);
  }
  return { refresh, view, save };
}
