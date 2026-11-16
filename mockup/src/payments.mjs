import { randomUUID, createHash } from 'node:crypto';
import { readSettings } from './database.mjs';
import { notifyAppointment } from './notification-events.mjs';
import { token, digest, equal, failure, rateLimit } from './security.mjs';
import { paymentEnvironmentMatches, createMercadoPagoClient, secretBox, verifyNotification, cents, checkoutUrl } from './mercadopago-client.mjs';
import { recordProviderMoney } from './finance.mjs';
import { platformCollectorIds } from './platform-billing.mjs';
import { selfTestBindingFor, selfTestCollectorAllowed } from './payment-self-test.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const numericId = value => /^\d{1,32}$/.test(String(value ?? ''));
const reference = id => `rael_${id}`;
const businessPrincipal = 'business';

export function createPayments(db, slug, config, { authorizeWrite, pro } = {}) {
  const mp = config.payments ?? { enabled: false, mode: 'sandbox', holdMinutes: 30 };
  const now = config.now ?? (() => Date.now());
  const request = createMercadoPagoClient(mp, config.mpTransport);
  const box = scope => secretBox(mp.encryptionKey, `rael:mp:${slug}:${scope}`);
  const configured = () => Boolean(mp.enabled && mp.clientId && mp.clientSecret && mp.encryptionKey && mp.webhookSecret);
  const requireConfigured = () => { if (!configured()) throw failure(503, 'A plataforma está preparando o Mercado Pago. Você pode continuar usando agendamentos sem antecipação.'); };
  const requireProfessional = user => { if (!['admin', 'professional'].includes(user?.role) || !uuid(user.professional_id)) throw failure(403, 'Cada profissional conecta somente a própria conta.'); };
  const administrator = user => { if (user?.role !== 'admin') throw failure(403, 'Somente o gestor configura o recebimento das assinaturas do negócio.'); };
  async function audit(tx, actor, name, details = {}) { await tx.query('INSERT INTO audit_events(id, actor_id, event_name, detail_json, created_at) VALUES (?, ?, ?, ?, ?)', [randomUUID(), actor, name, JSON.stringify(details), now()]); }
  async function event(tx, intentId, paymentId, name, details = {}, discriminator = '') {
    const id = digest(`${intentId}:${paymentId}:${name}:${discriminator}`), [exists] = await tx.query('SELECT id FROM mp_events WHERE id = ?', [id]);
    if (!exists) await tx.query('INSERT INTO mp_events(id, intent_id, provider_id, event_name, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, intentId, paymentId, name, JSON.stringify(details), now()]);
    return id;
  }
  async function ownConnection(tx, professionalId) { const rows = await tx.query('SELECT * FROM mp_connections WHERE professional_id = ? AND mode = ? ORDER BY updated_at DESC', [professionalId, mp.mode]); return rows[0] ?? null; }
  const reservedCollector = collectorId => platformCollectorIds(config).includes(String(collectorId));
  function cleanupReceiverBinding(collectorId) { const binding = selfTestBindingFor(config, slug); return binding && binding.clientId === mp.clientId && binding.collectorId === String(collectorId) ? binding : null; }
  const bindingKey = binding => binding ? JSON.stringify([binding.tenant, binding.clientId, binding.collectorId, binding.customerId, binding.planId, binding.expiresAt]) : null;
  const cleanupReceiverAllowed = collectorId => Boolean(cleanupReceiverBinding(collectorId));
  const receiverAllowed = (collectorId, business = false, selfTestCleanup = false) => !reservedCollector(collectorId) || business && (selfTestCollectorAllowed(config, slug, mp.clientId, String(collectorId), now()) || selfTestCleanup === true && cleanupReceiverAllowed(collectorId));
  function assertReceiverAllowed(collectorId, business = false, selfTestCleanup = false) { if (!receiverAllowed(collectorId, business, selfTestCleanup)) throw failure(409, 'A conta de cobrança da Raelapps é exclusiva da plataforma. Conecte a própria conta Mercado Pago deste negócio.'); }
  function ready(row) { return Boolean(configured() && row?.status === 'connected' && row.secrets_cipher && row.mode === mp.mode && receiverAllowed(row.collector_id, row.professional_id === businessPrincipal)); }
  function connectionView(row) {
    return { ready: ready(row), id: row?.id, collectorId: row?.collector_id, name: row?.receiver_name, mode: mp.mode, status: ready(row) ? 'connected' : row?.status === 'disconnected' ? 'disconnected' : row ? 'reconnect' : 'not_connected' };
  }
  async function connectionFor(tx, professionalId) { return connectionView(uuid(professionalId) && ['sandbox', 'live'].includes(mp.mode) ? await ownConnection(tx, professionalId) : null); }
  async function receivingSettings(tx = db) {
    const [row] = await tx.query('SELECT * FROM subscription_receiving_settings WHERE id = 1');
    if (row && (!['professional', 'business'].includes(row.mode) || !Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 0)) throw failure(503, 'A configuração do recebedor das assinaturas precisa ser conferida.');
    return row ? { ...row, revision: Number(row.revision) } : { mode: 'professional', revision: 0, connection_id: null };
  }
  async function businessConnection(tx = db, settings) {
    const value = settings ?? await receivingSettings(tx);
    if (!value.connection_id) return null;
    const [row] = await tx.query('SELECT * FROM mp_connections WHERE id = ?', [value.connection_id]);
    return row ?? null;
  }
  async function subscriptionReceiving(user) {
    administrator(user);
    const settings = await receivingSettings(), c = connectionView(await businessConnection(db, settings));
    return { mode: settings.mode, revision: settings.revision, configured: configured(), connected: c.ready, status: c.status, receiver: c.ready || c.name ? { name: c.name, id: c.collectorId } : null, callbackUrl: `${config.origin}/payments/mercadopago/callback` };
  }
  async function writeReceiving(tx, settings, user, { mode = settings.mode, connectionId = settings.connection_id } = {}) {
    const revision = settings.revision + 1;
    if (settings.id) await tx.query('UPDATE subscription_receiving_settings SET mode = ?, revision = ?, connection_id = ?, updated_by = ?, updated_at = ? WHERE id = 1', [mode, revision, connectionId, user.id, now()]);
    else await tx.query('INSERT INTO subscription_receiving_settings(id, mode, revision, connection_id, updated_by, updated_at) VALUES (1, ?, ?, ?, ?, ?)', [mode, revision, connectionId, user.id, now()]);
    return revision;
  }
  async function setSubscriptionReceiving(user, input) {
    administrator(user);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'mode') || !Object.hasOwn(input, 'revision') || !['professional', 'business'].includes(input.mode) || !Number.isSafeInteger(input.revision) || input.revision < 0) throw failure(422, 'Confira o modo de recebimento das assinaturas.');
    await db.transaction(async tx => {
      await readSettings(tx, true); const settings = await receivingSettings(tx);
      if (settings.revision !== input.revision) throw failure(409, 'O recebimento das assinaturas foi alterado. Recarregue antes de salvar.');
      const revision = await writeReceiving(tx, settings, user, { mode: input.mode });
      await audit(tx, user.id, 'subscription_receiving_changed', { mode: input.mode, revision });
    });
    return subscriptionReceiving(user);
  }
  async function subscriptionConnectionFor(tx, professionalId) {
    const settings = await receivingSettings(tx), connection = settings.mode === 'business' ? connectionView(await businessConnection(tx, settings)) : await connectionFor(tx, professionalId);
    return { ...connection, receivingMode: settings.mode, receivingRevision: settings.revision };
  }
  async function subscriptionManagedBy(tx, connectionId, user, receivingMode = 'professional') {
    if (!['admin', 'professional'].includes(user?.role) || !['business', 'professional'].includes(receivingMode) || !uuid(connectionId)) return false;
    const [connection] = await tx.query('SELECT professional_id FROM mp_connections WHERE id = ?', [connectionId]);
    return Boolean(connection && (receivingMode === 'business' ? user.role === 'admin' : connection.professional_id !== businessPrincipal && uuid(user.professional_id) && user.professional_id === connection.professional_id));
  }
  async function status(user) { requireProfessional(user); const c = await connectionFor(db, user.professional_id); return { configured: configured(), mode: mp.mode, connected: c.ready, status: c.status, receiver: c.ready || c.name ? { name: c.name, id: c.collectorId } : null, holdMinutes: mp.holdMinutes ?? 30, callbackUrl: `${config.origin}/payments/mercadopago/callback` }; }
  async function startSubject(user, rawSession, business = false) {
    requireConfigured(); business ? administrator(user) : requireProfessional(user); await rateLimit(db, `mp_connect:${user.id}`, 10);
    const principal = business ? businessPrincipal : user.professional_id;
    const value = `${slug}.${business ? 'business.' : ''}${token()}`, verifier = token() + token(), challenge = createHash('sha256').update(verifier).digest('base64url');
    await db.transaction(async tx => { const settings = await readSettings(tx, true); if (!business && !settings.draft.professionals.some(p => p.id === principal && p.active)) throw failure(403, 'Ative seu cadastro profissional antes de conectar uma conta de recebimento.'); await tx.query('DELETE FROM mp_oauth_states WHERE expires_at < ? OR (user_id = ? AND used_at IS NULL)', [now(), user.id]); await tx.query('INSERT INTO mp_oauth_states(state_hash, user_id, professional_id, session_hash, verifier_cipher, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [digest(value), user.id, principal, digest(rawSession), box('oauth').seal({ verifier }), now() + 10 * 60000, null]); });
    const url = new URL('https://auth.mercadopago.com/authorization');
    url.search = new URLSearchParams({ client_id: mp.clientId, response_type: 'code', platform_id: 'mp', state: value, redirect_uri: `${config.origin}/payments/mercadopago/callback`, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    return { url: url.href };
  }
  const start = (user, rawSession) => startSubject(user, rawSession);
  const startBusiness = (user, rawSession) => startSubject(user, rawSession, true);
  function validateTokens(data) {
    const reason = !data || typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 4096 ? 'access_token_missing_or_invalid'
      : typeof data.refresh_token !== 'string' || !data.refresh_token || data.refresh_token.length > 4096 ? 'refresh_token_missing_or_invalid'
      : !numericId(data.user_id) ? 'receiver_missing_or_invalid'
      : typeof data.live_mode !== 'boolean' && !(mp.mode === 'sandbox' && data.live_mode === undefined) ? 'environment_missing_or_invalid'
      : data.live_mode !== undefined && data.live_mode !== (mp.mode === 'live') ? 'environment_mismatch'
      : !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) < 60 ? 'expiration_missing_or_invalid' : null;
    if (reason) throw Object.assign(failure(409, 'A conta retornou credenciais de outro ambiente ou uma autorização incompleta. Reconecte no ambiente correto.'), { mpAuthorizationIssue: reason });
    return { accessToken: data.access_token, refreshToken: data.refresh_token, collectorId: String(data.user_id), expiresAt: now() + Math.min(Number(data.expires_in), 180 * 86400) * 1000 };
  }
  async function verifyReceiver(data, { business = false, selfTestCleanup = false } = {}) {
    // Authorization Code may omit live_mode in a test-account response. Sandbox
    // always requires canonical test_user identity before storing or refreshing
    // credentials; payment reconciliation checks canonical account type again.
    const me = await request('GET', '/users/me', { accessToken: data.accessToken });
    if (String(me.id) !== data.collectorId || me.site_id !== 'MLB') throw failure(409, 'Conecte uma conta recebedora brasileira válida.');
    assertReceiverAllowed(data.collectorId, business, selfTestCleanup);
    if (!Array.isArray(me.tags) || me.tags.includes('test_user') !== (mp.mode === 'sandbox')) throw failure(409, mp.mode === 'sandbox' ? 'A homologação exige uma conta fictícia de teste do Mercado Pago. Não conecte sua conta real neste ambiente.' : 'A cobrança real exige uma conta recebedora real. Não conecte uma conta fictícia neste ambiente.');
    return me;
  }
  async function callback(user, rawSession, query) {
    requireConfigured();
    if (typeof query.state !== 'string' || query.state.length > 150 || !query.state.startsWith(slug + '.')) throw failure(422, 'A conexão não corresponde a este negócio.');
    const business = query.state.startsWith(`${slug}.business.`), principal = business ? businessPrincipal : user.professional_id;
    business ? administrator(user) : requireProfessional(user);
    const state = await db.transaction(async tx => {
      await readSettings(tx, true); const [row] = await tx.query('SELECT * FROM mp_oauth_states WHERE state_hash = ?', [digest(query.state)]);
      if (!row || row.used_at !== null || Number(row.expires_at) <= now() || row.user_id !== user.id || row.professional_id !== principal || !equal(row.session_hash, digest(rawSession))) throw failure(422, 'Esse pedido de conexão expirou ou pertence a outro acesso. Inicie novamente pelo seu perfil.');
      await tx.query('UPDATE mp_oauth_states SET used_at = ? WHERE state_hash = ?', [now(), row.state_hash]); return row;
    });
    if (query.error) { await db.transaction(tx => audit(tx, user.id, 'mp_authorization_cancelled')); return { connected: false }; }
    if (typeof query.code !== 'string' || query.code.length > 1024) throw failure(422, 'O Mercado Pago não retornou a autorização. Inicie novamente.');
    const data = validateTokens(await request('POST', '/oauth/token', { data: { client_id: mp.clientId, client_secret: mp.clientSecret, grant_type: 'authorization_code', code: query.code, redirect_uri: `${config.origin}/payments/mercadopago/callback`, code_verifier: box('oauth').open(state.verifier_cipher).verifier, test_token: mp.mode === 'sandbox' } }));
    const me = await verifyReceiver(data, { business });
    const receiver = String(me.nickname || [me.first_name, me.last_name].filter(Boolean).join(' ') || `Recebedor ${me.id}`).slice(0, 120);
    await db.transaction(async tx => {
      const settings = await readSettings(tx, true);
      // The provider exchange runs outside the transaction. A logout, password
      // reset or role change during that wait must revoke this pending write.
      if (authorizeWrite) await authorizeWrite(tx, user, settings);
      assertReceiverAllowed(data.collectorId, business);
      if (!business && !settings.draft.professionals.some(p => p.id === principal && p.active)) throw failure(403, 'Seu cadastro profissional está inativo.');
      const receiving = business ? await receivingSettings(tx) : null;
      const selected = business ? await businessConnection(tx, receiving) : null;
      const own = await ownConnection(tx, principal);
      const duplicates = await tx.query('SELECT * FROM mp_connections WHERE collector_id = ? AND mode = ? AND professional_id <> ?', [data.collectorId, mp.mode, principal]);
      const shared = business && !reservedCollector(data.collectorId) ? duplicates.find(row => row.id === selected?.id || uuid(user.professional_id) && row.professional_id === user.professional_id) : null;
      if (duplicates.some(row => row.id !== shared?.id)) throw failure(409, 'Essa conta já está vinculada a outro profissional deste negócio. Conecte uma conta própria ou a conta individual do próprio gestor.');
      const old = shared ?? own;
      for (const prior of [old, ...(business && selected?.id !== old?.id ? [selected] : [])]) if (prior && prior.collector_id !== data.collectorId) {
        const [used] = await tx.query('SELECT id FROM mp_intents WHERE connection_id = ? LIMIT 1', [prior.id]); const [subscription] = await tx.query('SELECT id FROM subscriptions WHERE connection_id = ? LIMIT 1', [prior.id]);
        if (used || subscription) throw failure(409, 'Esta conta possui histórico de pagamentos. A troca de recebedor precisa ser acompanhada pelo suporte.');
      }
      const id = old?.id ?? randomUUID(), encoded = box(id).seal({ accessToken: data.accessToken, refreshToken: data.refreshToken });
      if (old) await tx.query('UPDATE mp_connections SET collector_id = ?, receiver_name = ?, status = ?, secrets_cipher = ?, expires_at = ?, refresh_lease_until = 0, revision = revision + 1, updated_at = ? WHERE id = ?', [data.collectorId, receiver, 'connected', encoded, data.expiresAt, now(), id]);
      else await tx.query('INSERT INTO mp_connections(id, professional_id, collector_id, receiver_name, mode, status, secrets_cipher, expires_at, refresh_lease_until, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, principal, data.collectorId, receiver, mp.mode, 'connected', encoded, data.expiresAt, 0, 0, now()]);
      if (business) { const revision = await writeReceiving(tx, receiving, user, { connectionId: id }); await audit(tx, user.id, 'subscription_business_connected', { connectionId: id, collectorId: data.collectorId, mode: mp.mode, revision }); }
      else await tx.query('UPDATE receiving_preferences SET connection_status = ? WHERE professional_id = ?', ['connected', principal]);
      await tx.query('UPDATE business_settings SET revision = revision + 1 WHERE id = 1');
      await audit(tx, user.id, 'mp_connected', { professionalId: principal, collectorId: data.collectorId, mode: mp.mode });
    });
    return { connected: true };
  }
  async function access(connectionId, { allowReservedBusiness = true, selfTestCleanup = false } = {}) {
    requireConfigured();
    const claim = await db.transaction(async tx => {
      await readSettings(tx, true); const [row] = await tx.query('SELECT * FROM mp_connections WHERE id = ?', [connectionId]);
      const cleanupReady = selfTestCleanup === true && row?.status === 'connected' && row.secrets_cipher && row.mode === mp.mode && row.professional_id === businessPrincipal && reservedCollector(row.collector_id) && cleanupReceiverAllowed(row.collector_id);
      if ((!ready(row) && !cleanupReady) || !allowReservedBusiness && reservedCollector(row.collector_id)) throw failure(409, 'O profissional precisa reconectar sua conta Mercado Pago.');
      const secrets = box(row.id).open(row.secrets_cipher);
      if (Number(row.expires_at) > now() + 5 * 60000) return { row, secrets, refresh: false };
      if (Number(row.refresh_lease_until) > now()) throw failure(409, 'A conexão está sendo renovada. Consulte novamente em alguns segundos.');
      const selfTestBinding = row.professional_id === businessPrincipal && reservedCollector(row.collector_id) ? cleanupReceiverBinding(row.collector_id) : null;
      await tx.query('UPDATE mp_connections SET refresh_lease_until = ? WHERE id = ?', [now() + 30000, row.id]); return { row, secrets, refresh: true, selfTestBinding };
    });
    if (!claim.refresh) return { ...claim.row, accessToken: claim.secrets.accessToken };
    let renewed;
    try {
      const data = validateTokens(await request('POST', '/oauth/token', { data: { client_id: mp.clientId, client_secret: mp.clientSecret, grant_type: 'refresh_token', refresh_token: claim.secrets.refreshToken, test_token: mp.mode === 'sandbox' } }));
      if (data.collectorId !== claim.row.collector_id) throw failure(409, 'A renovação retornou outro recebedor. Reconecte sua conta.');
      const business = claim.row.professional_id === businessPrincipal;
      const unchangedBinding = () => !claim.selfTestBinding || bindingKey(cleanupReceiverBinding(data.collectorId)) === bindingKey(claim.selfTestBinding);
      if (!unchangedBinding()) throw failure(409, 'A autorização temporária do recebimento foi alterada.');
      // Keep a provider-rotated token durable when an existing renewal crosses
      // the deadline. This cannot make the receiver ready or release normal use.
      const refreshCleanup = selfTestCleanup === true || Boolean(claim.selfTestBinding);
      await verifyReceiver(data, { business, selfTestCleanup: refreshCleanup });
      await db.transaction(async tx => { await readSettings(tx, true); if (!unchangedBinding()) throw failure(409, 'A autorização temporária do recebimento foi alterada.'); assertReceiverAllowed(data.collectorId, business, refreshCleanup); const [current] = await tx.query('SELECT revision, status FROM mp_connections WHERE id = ?', [connectionId]); if (Number(current.revision) !== Number(claim.row.revision) || current.status !== 'connected') throw failure(409, 'A conexão mudou. Consulte novamente.'); await tx.query('UPDATE mp_connections SET secrets_cipher = ?, expires_at = ?, refresh_lease_until = 0, revision = revision + 1, updated_at = ? WHERE id = ?', [box(connectionId).seal({ accessToken: data.accessToken, refreshToken: data.refreshToken }), data.expiresAt, now(), connectionId]); });
      renewed = { ...claim.row, revision: Number(claim.row.revision) + 1, accessToken: data.accessToken };
    } catch (error) { await db.transaction(async tx => { await readSettings(tx, true); await tx.query('UPDATE mp_connections SET status = ?, refresh_lease_until = 0, updated_at = ? WHERE id = ? AND revision = ?', ['reconnect', now(), connectionId, claim.row.revision]); }); throw error; }
    if (claim.selfTestBinding && selfTestCleanup !== true && !selfTestCollectorAllowed(config, slug, mp.clientId, claim.row.collector_id, now())) throw failure(409, 'A autorização temporária deste recebimento expirou. Faça apenas a conferência e o encerramento da assinatura de teste.');
    return renewed;
  }
  async function rejectAccess(connectionId, revision, providerStatus) {
    if (![401, 403].includes(providerStatus) || !uuid(connectionId) || !Number.isSafeInteger(Number(revision)) || Number(revision) < 0) return;
    await db.transaction(async tx => {
      await readSettings(tx, true);
      // A rejection belongs only to the credentials used by that request. A
      // completed reconnection or token renewal has already advanced revision;
      // an active renewal lease must also be allowed to finish.
      await tx.query('UPDATE mp_connections SET status = ?, refresh_lease_until = 0, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND status = ? AND refresh_lease_until <= ?', ['reconnect', now(), connectionId, revision, 'connected', now()]);
    });
  }
  async function checkConnection(user) {
    requireProfessional(user); const row = await ownConnection(db, user.professional_id);
    if (!row) return status(user);
    try { const c = await access(row.id), me = await request('GET', '/users/me', { accessToken: c.accessToken }); if (String(me.id) !== row.collector_id || me.site_id !== 'MLB') throw failure(409, 'O recebedor precisa ser conferido. Reconecte sua conta.'); }
    catch (error) { if ([401, 403].includes(error.providerStatus)) await db.transaction(async tx => { await readSettings(tx, true); await tx.query('UPDATE mp_connections SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ?', ['reconnect', now(), row.id]); }); throw error; }
    return status(user);
  }
  async function checkBusiness(user) {
    administrator(user); const row = await businessConnection();
    if (!row) return subscriptionReceiving(user);
    try { const c = await access(row.id); await verifyReceiver({ accessToken: c.accessToken, collectorId: row.collector_id }, { business: row.professional_id === businessPrincipal }); }
    catch (error) { if ([401, 403].includes(error.providerStatus)) await db.transaction(async tx => { await readSettings(tx, true); await tx.query('UPDATE mp_connections SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ?', ['reconnect', now(), row.id]); }); throw error; }
    return subscriptionReceiving(user);
  }
  async function disconnectBusiness(user) {
    administrator(user);
    await db.transaction(async tx => {
      await readSettings(tx, true); const settings = await receivingSettings(tx), row = await businessConnection(tx, settings);
      if (!row) return;
      const [pending] = await tx.query("SELECT id FROM mp_intents WHERE connection_id = ? AND (state IN ('waiting', 'pending', 'approved') OR resolution <> '') LIMIT 1", [row.id]);
      const [subscription] = await tx.query('SELECT id FROM subscriptions WHERE connection_id = ? LIMIT 1', [row.id]);
      if (pending || subscription) throw failure(409, 'Há pagamentos ou assinaturas para acompanhar. Mantenha a conexão; fale com o suporte se precisar trocar a conta.');
      // A shared personal connection continues serving that professional's one-off
      // payments. Unlink only the subscription selection in that case.
      if (row.professional_id === businessPrincipal) await tx.query('UPDATE mp_connections SET status = ?, secrets_cipher = NULL, refresh_lease_until = 0, revision = revision + 1, updated_at = ? WHERE id = ?', ['disconnected', now(), row.id]);
      const revision = await writeReceiving(tx, settings, user, { connectionId: null });
      await audit(tx, user.id, 'subscription_business_disconnected', { connectionId: row.id, revision });
    });
    return { ok: true };
  }
  async function disconnect(user) {
    requireProfessional(user);
    await db.transaction(async tx => {
      await readSettings(tx, true); const row = await ownConnection(tx, user.professional_id); if (!row) return;
      const [pending] = await tx.query("SELECT id FROM mp_intents WHERE connection_id = ? AND (state IN ('waiting', 'pending', 'approved') OR resolution <> '') LIMIT 1", [row.id]);
      const [subscription] = await tx.query('SELECT id FROM subscriptions WHERE connection_id = ? LIMIT 1', [row.id]);
      if (pending || subscription) throw failure(409, 'Há pagamentos ou assinaturas para acompanhar. Mantenha a conexão; fale com o suporte se precisar trocar a conta.');
      await tx.query('UPDATE mp_connections SET status = ?, secrets_cipher = NULL, refresh_lease_until = 0, revision = revision + 1, updated_at = ? WHERE id = ?', ['disconnected', now(), row.id]);
      await tx.query('UPDATE receiving_preferences SET connection_status = ? WHERE professional_id = ?', ['not_connected', user.professional_id]); await tx.query('UPDATE business_settings SET revision = revision + 1 WHERE id = 1'); await audit(tx, user.id, 'mp_disconnected', { professionalId: user.professional_id });
    }); return { ok: true };
  }
  async function expire(tx) {
    const rows = await tx.query("SELECT a.id, i.id AS intent_id FROM appointments a JOIN mp_intents i ON i.appointment_id = a.id WHERE a.status = 'awaiting_payment' AND i.expires_at <= ? LIMIT 1000", [now()]);
    for (const row of rows) {
      await tx.query('UPDATE appointments SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ?', ['expired', now(), row.id]);
      await tx.query("UPDATE mp_intents SET state = CASE WHEN state IN ('waiting', 'pending') THEN 'expired' ELSE state END, updated_at = ? WHERE id = ?", [now(), row.intent_id]);
      const eventKey = await event(tx, row.intent_id, '', 'hold_expired');
      await notifyAppointment(tx, { slug, appointmentId: row.id, eventKey, type: 'payment_expired', now: now() });
    }
  }
  async function housekeeping() { await db.transaction(async tx => { await readSettings(tx, true); await expire(tx); }); }
  async function hold(tx, appointmentId, ctx) {
    if (!ctx.snapshot.requirePayment) return;
    requireConfigured();
    assertReceiverAllowed(ctx.connection.collectorId);
    const id = randomUUID(), expires = now() + (mp.holdMinutes ?? 30) * 60000;
    await tx.query('INSERT INTO mp_intents(id, appointment_id, connection_id, collector_id, amount_cents, mode, state, expires_at, preference_id, checkout_url, checkout_state, checkout_lease_until, approved_payment_id, resolution, check_lease_until, next_check_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, appointmentId, ctx.connection.id, ctx.connection.collectorId, ctx.snapshot.service.priceCents, mp.mode, 'waiting', expires, null, null, 'new', 0, null, '', 0, now() + 60000, now(), now()]);
    await event(tx, id, '', 'hold_created');
  }
  function authorize(actor, row) { if (actor.customer ? row.customer_id !== actor.customer.id : !actor.staff || actor.staff.role === 'professional' && row.professional_id !== actor.staff.professional_id) throw failure(404, 'Pagamento não encontrado nesse acesso.'); }
  async function intentFor(tx, appointmentId, actor) {
    if (!uuid(appointmentId)) throw failure(422, 'Agendamento inválido.');
    const [row] = await tx.query('SELECT i.*, a.customer_id, a.professional_id, a.status AS appointment_status, a.starts_at, a.ends_at, a.occupied_until, a.snapshot_json FROM mp_intents i JOIN appointments a ON a.id = i.appointment_id WHERE i.appointment_id = ?', [appointmentId]);
    if (!row) throw failure(404, 'Este agendamento não possui cobrança online.'); authorize(actor, row); return row;
  }
  function publicIntent(row) {
    const snapshot = JSON.parse(row.snapshot_json);
    return { appointmentId: row.appointment_id, serviceName: snapshot.service.name, professionalName: snapshot.professional.name, startAt: Number(row.starts_at), timeZone: snapshot.business.timeZone, state: row.state, appointmentStatus: row.appointment_status, expiresAt: Number(row.expires_at), amountCents: Number(row.amount_cents), receiver: snapshot.receiver ? { name: snapshot.receiver.name, id: snapshot.receiver.id } : null, mode: row.mode, resolution: row.resolution, canPay: !reservedCollector(row.collector_id) && row.appointment_status === 'awaiting_payment' && Number(row.expires_at) > now() && !row.approved_payment_id && !row.resolution && ['waiting', 'rejected', 'cancelled'].includes(row.state), providerPaymentId: row.approved_payment_id ?? null, updatedAt: Number(row.updated_at) };
  }
  async function paymentStatus(actor, appointmentId, reconcile = false) {
    await housekeeping(); const row = await intentFor(db, appointmentId, actor);
    if (reconcile && configured()) { await rateLimit(db, `mp_consult:${actor.customer?.id ?? actor.staff.id}`, 30, 60000); await reconcileIntent(row.id); }
    return publicIntent(await intentFor(db, appointmentId, actor));
  }
  async function beginCheckout(actor, appointmentId) {
    requireConfigured(); await rateLimit(db, `mp_checkout:${actor.customer?.id ?? actor.staff.id}`, 20);
    const intent = await db.transaction(async tx => {
      await readSettings(tx, true); await expire(tx); const row = await intentFor(tx, appointmentId, actor);
      assertReceiverAllowed(row.collector_id);
      if (row.resolution || row.state === 'pending') throw failure(409, 'Há uma tentativa de pagamento em acompanhamento. Atualize a situação antes de tentar pagar novamente.');
      if (row.appointment_status !== 'awaiting_payment' || Number(row.expires_at) <= now() || row.approved_payment_id) throw failure(409, 'Essa reserva não está mais aguardando pagamento. Consulte o atendimento antes de pagar.');
      if (row.checkout_url) return { ...row, existing: true };
      if (Number(row.checkout_lease_until) > now()) throw failure(409, 'Seu link está sendo preparado. Consulte novamente em alguns segundos.');
      await tx.query('UPDATE mp_intents SET checkout_lease_until = ?, checkout_state = ?, updated_at = ? WHERE id = ?', [now() + 30000, 'creating', now(), row.id]); return { ...row, uncertain: row.checkout_state !== 'new' };
    });
    if (intent.existing) return { ...publicIntent(intent), url: checkoutUrl(intent.checkout_url, intent.mode) };
    try {
      const connection = await access(intent.connection_id, { allowReservedBusiness: false }), snapshot = JSON.parse(intent.snapshot_json);
      let preference;
      if (intent.uncertain) {
        const search = await request('GET', '/checkout/preferences/search?' + new URLSearchParams({ external_reference: reference(intent.id), limit: '10' }), { accessToken: connection.accessToken });
        const found = search.elements?.filter(p => p.external_reference === reference(intent.id));
        if (found?.length === 1) preference = await request('GET', `/checkout/preferences/${encodeURIComponent(found[0].id)}`, { accessToken: connection.accessToken });
        else throw failure(409, 'A tentativa anterior ainda precisa ser conferida. Consulte o pagamento; não crie outra reserva nem pague novamente.');
      } else {
        const back = `${config.origin}/negocio/${slug}?pagamento=retorno&reserva=${intent.appointment_id}`;
        preference = await request('POST', '/checkout/preferences', { accessToken: connection.accessToken, key: intent.id, data: { items: [{ id: snapshot.service.id, title: `${snapshot.service.name} · ${snapshot.professional.name}`.slice(0, 200), quantity: 1, currency_id: 'BRL', unit_price: Number(intent.amount_cents) / 100 }], external_reference: reference(intent.id), back_urls: { success: back, failure: back, pending: back }, auto_return: 'approved', notification_url: `${config.origin}/payments/mercadopago/webhook/${slug}`, expires: true, expiration_date_from: new Date(now() - 60000).toISOString(), expiration_date_to: new Date(Number(intent.expires_at)).toISOString(), payment_methods: { installments: 1, excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }] }, metadata: { rael_intent_id: intent.id } } });
      }
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(String(preference?.id ?? '')) || String(preference.collector_id) !== intent.collector_id || preference.external_reference !== reference(intent.id) || !Array.isArray(preference.items) || preference.items.length !== 1 || Number(preference.items[0].quantity) !== 1 || preference.items[0].currency_id !== 'BRL' || cents(preference.items[0].unit_price) !== Number(intent.amount_cents)) throw failure(409, 'A cobrança retornou outro recebedor, valor ou referência. O pagamento precisa ser conferido.');
      // Test-account credentials use init_point too; the account identity and
      // canonical payment environment, not the hostname alone, enforce testing.
      const url = checkoutUrl(preference.init_point ?? (intent.mode === 'sandbox' ? preference.sandbox_init_point : undefined), intent.mode);
      await db.transaction(async tx => { await readSettings(tx, true); await tx.query('UPDATE mp_intents SET preference_id = ?, checkout_url = ?, checkout_state = ?, checkout_lease_until = 0, updated_at = ? WHERE id = ?', [String(preference.id), url, 'ready', now(), intent.id]); await event(tx, intent.id, '', 'checkout_created'); });
      const current = await intentFor(db, appointmentId, actor); if (!publicIntent(current).canPay) throw failure(409, 'A reserva foi alterada enquanto o link era preparado. Consulte o atendimento antes de pagar.');
      return { ...publicIntent(current), url };
    } catch (error) { await db.transaction(async tx => { await readSettings(tx, true); if ([401, 403].includes(error.providerStatus)) await tx.query('UPDATE mp_connections SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ?', ['reconnect', now(), intent.connection_id]); await tx.query("UPDATE mp_intents SET checkout_state = CASE WHEN checkout_state = 'ready' THEN 'ready' ELSE 'uncertain' END, checkout_lease_until = 0, updated_at = ? WHERE id = ?", [now(), intent.id]); }); throw error; }
  }
  async function reconcilePayment(connectionId, paymentId) {
    if (!numericId(paymentId)) throw failure(422, 'Notificação de pagamento inválida.');
    const connection = await access(connectionId, { allowReservedBusiness: false }), payment = await request('GET', `/v1/payments/${paymentId}`, { accessToken: connection.accessToken });
    const match = /^rael_([a-f0-9-]{36})$/.exec(payment.external_reference ?? '');
    if (!match) return { ignored: true };
    const environmentMatches = await paymentEnvironmentMatches(payment, mp.mode, connection.collector_id, connection.accessToken, request);
    return db.transaction(async tx => {
      const settings = await readSettings(tx, true); await expire(tx);
      const [intent] = await tx.query('SELECT * FROM mp_intents WHERE id = ? AND connection_id = ?', [match[1], connectionId]);
      if (!intent) return { ignored: true };
      const amount = cents(payment.transaction_amount), refunded = cents(payment.transaction_amount_refunded ?? 0), updated = Date.parse(payment.date_last_updated ?? '');
      if (String(payment.id) !== String(paymentId) || String(payment.collector_id) !== intent.collector_id || amount !== Number(intent.amount_cents) || payment.currency_id !== 'BRL' || !environmentMatches || intent.mode !== mp.mode || !Number.isFinite(updated) || !['approved', 'pending', 'in_process', 'authorized', 'rejected', 'cancelled', 'refunded', 'charged_back'].includes(payment.status)) {
        await tx.query('UPDATE mp_intents SET resolution = ?, updated_at = ? WHERE id = ?', ['verification_required', now(), intent.id]); await event(tx, intent.id, String(paymentId), 'verification_failed'); return { ignored: false, needsReview: true };
      }
      const id = digest(`${connectionId}:${paymentId}`), [previous] = await tx.query('SELECT * FROM mp_payments WHERE id = ?', [id]);
      if (previous && Number(previous.provider_updated_at) > updated) return { ignored: true };
      const [appointment] = await tx.query('SELECT * FROM appointments WHERE id = ?', [intent.appointment_id]);
      await recordProviderMoney(tx, { connectionId, payment, customerId: appointment.customer_id, professionalId: appointment.professional_id, appointmentId: appointment.id, now: now() });
      if (previous && Number(previous.provider_updated_at) === updated && previous.status === payment.status && Number(previous.refunded_cents) === refunded) return { ignored: false, duplicate: true };
      const detail = String(payment.status_detail ?? '').slice(0, 80);
      if (previous) await tx.query('UPDATE mp_payments SET status = ?, refunded_cents = ?, provider_updated_at = ?, detail_code = ?, updated_at = ? WHERE id = ?', [payment.status, refunded, updated, detail, now(), id]);
      else await tx.query('INSERT INTO mp_payments(id, intent_id, provider_id, status, amount_cents, refunded_cents, provider_updated_at, detail_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, intent.id, String(paymentId), payment.status, amount, refunded, updated, detail, now(), now()]);
      let state = intent.state, resolution = intent.resolution, primary = intent.approved_payment_id;
      if (payment.status === 'approved' && refunded === 0) {
        if (primary && primary !== String(paymentId)) resolution = 'duplicate_payment';
        else {
          primary = String(paymentId); state = 'approved';
          if (['awaiting_payment', 'expired'].includes(appointment.status)) {
            const occupied = await tx.query("SELECT id FROM appointments WHERE id <> ? AND professional_id = ? AND status NOT IN ('cancelled', 'expired') AND starts_at < ? AND occupied_until > ? LIMIT 1", [appointment.id, appointment.professional_id, appointment.occupied_until, appointment.starts_at]);
            const blocks = await tx.query('SELECT id FROM calendar_blocks WHERE professional_id = ? AND active = 1 AND starts_at < ? AND ends_at > ? LIMIT 1', [appointment.professional_id, appointment.occupied_until, appointment.starts_at]);
            const other = await tx.query("SELECT id FROM appointments WHERE id <> ? AND customer_id = ? AND status NOT IN ('cancelled', 'expired') AND starts_at < ? AND ends_at > ? LIMIT 1", [appointment.id, appointment.customer_id, appointment.ends_at, appointment.starts_at]);
            if (!occupied.length && !blocks.length && !other.length && settings.draft.professionals.some(p => p.id === appointment.professional_id && p.active) && Number(appointment.starts_at) > now()) {
              await tx.query('UPDATE appointments SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ?', ['confirmed', now(), appointment.id]); resolution = '';
              const eventKey = await event(tx, intent.id, String(paymentId), 'reservation_confirmed');
              await pro?.bookingEvent(tx, appointment, 'confirmed', eventKey);
              await notifyAppointment(tx, { slug, appointmentId: appointment.id, eventKey, type: 'confirmed', now: now() });
            }
            else resolution = 'paid_without_slot';
          } else if (appointment.status === 'cancelled') resolution = 'refund_required';
        }
      } else if (!primary || primary === String(paymentId)) {
        if (payment.status === 'refunded' || refunded > 0) { state = refunded >= amount || payment.status === 'refunded' ? 'refunded' : 'partially_refunded'; resolution = ''; }
        else if (payment.status === 'charged_back') { state = 'charged_back'; resolution = 'chargeback_review'; }
        else if (!primary) state = ['pending', 'in_process', 'authorized'].includes(payment.status) ? 'pending' : appointment.status === 'expired' ? 'expired' : payment.status;
      }
      await tx.query('UPDATE mp_intents SET state = ?, resolution = ?, approved_payment_id = ?, updated_at = ?, next_check_at = ? WHERE id = ?', [state, resolution, primary, now(), now() + (state === 'approved' ? 86400000 : 120000), intent.id]);
      await event(tx, intent.id, String(paymentId), payment.status, { refundedCents: refunded, resolution }, `${updated}:${refunded}`);
      return { ignored: false };
    });
  }
  async function reconcileIntent(intentId) {
    if (!configured()) return;
    const row = await db.transaction(async tx => { await readSettings(tx, true); const [i] = await tx.query('SELECT * FROM mp_intents WHERE id = ?', [intentId]); if (!i || Number(i.check_lease_until) > now()) return null; await tx.query('UPDATE mp_intents SET check_lease_until = ?, next_check_at = ? WHERE id = ?', [now() + 30000, now() + 120000, intentId]); return i; });
    if (!row) return;
    try {
      if (row.approved_payment_id) await reconcilePayment(row.connection_id, row.approved_payment_id);
      else {
        const c = await access(row.connection_id, { allowReservedBusiness: false }), found = await request('GET', '/v1/payments/search?' + new URLSearchParams({ external_reference: reference(row.id), sort: 'date_created', criteria: 'desc', limit: '5' }), { accessToken: c.accessToken });
        if (!Array.isArray(found.results)) throw failure(503, 'Não foi possível consultar a situação do pagamento.');
        // A previously received canonical payment can be absent from the search
        // index. Recheck its known ID after a verification hold, still validating
        // account identity, reference and amount before releasing any booking.
        const observed = await db.query("SELECT provider_id FROM mp_events WHERE intent_id = ? AND event_name = 'verification_failed' AND provider_id <> '' ORDER BY created_at DESC LIMIT 3", [intentId]);
        const candidates = [...new Map([...observed.map(p => ({ id: p.provider_id })), ...found.results].filter(p => numericId(p.id)).map(p => [String(p.id), p])).values()].sort((a, b) => Number(b.status === 'approved') - Number(a.status === 'approved'));
        for (const p of candidates.slice(0, 3)) if (numericId(p.id)) await reconcilePayment(row.connection_id, String(p.id));
        if (Number(found.paging?.total ?? found.results.length) > 3) await db.transaction(async tx => { await readSettings(tx, true); await tx.query('UPDATE mp_intents SET resolution = ? WHERE id = ? AND resolution = ?', ['multiple_attempts_review', row.id, '']); });
      }
    } finally { await db.query('UPDATE mp_intents SET check_lease_until = 0 WHERE id = ?', [intentId]); }
  }
  async function notification(connectionId, headers, query, body) {
    requireConfigured(); verifyNotification(headers, query['data.id'], mp.webhookSecret, now());
    if (body.type !== 'payment' || String(body.data?.id) !== query['data.id']) throw failure(422, 'Notificação inválida.');
    return reconcilePayment(connectionId, query['data.id']);
  }
  async function notificationByCollector(headers, query, body) {
    requireConfigured(); verifyNotification(headers, query['data.id'], mp.webhookSecret, now());
    if (body.type !== 'payment' || String(body.data?.id) !== query['data.id'] || !numericId(body.user_id)) throw failure(422, 'Notificação inválida.');
    // The unsigned collector only selects a credential. Canonical payment data must
    // still match that connection, reference, currency and amount before any change.
    const rows = await db.query('SELECT id FROM mp_connections WHERE collector_id = ? AND mode = ? LIMIT 2', [String(body.user_id), mp.mode]);
    if (rows.length !== 1) return { ignored: true };
    return reconcilePayment(rows[0].id, query['data.id']);
  }
  async function cancelled(tx, appointmentId) {
    const [intent] = await tx.query('SELECT * FROM mp_intents WHERE appointment_id = ?', [appointmentId]);
    if (!intent) return;
    await tx.query('UPDATE mp_intents SET resolution = ?, updated_at = ? WHERE id = ?', [intent.approved_payment_id && !['refunded', 'charged_back'].includes(intent.state) ? 'refund_required' : intent.resolution, now(), intent.id]); await event(tx, intent.id, '', 'reservation_cancelled');
  }
  async function sweep() {
    await housekeeping(); if (!configured()) return;
    const rows = await db.query('SELECT id FROM mp_intents WHERE next_check_at <= ? AND created_at > ? ORDER BY next_check_at LIMIT 1', [now(), now() - 30 * 86400000]);
    for (const row of rows) { try { await reconcileIntent(row.id); } catch (error) { try { config.onMaintenanceFailure?.('payments', error); } catch { /* Monitoring cannot interrupt durable retry. */ } } }
  }
  return { status, checkConnection, start, callback, disconnect, connectionFor, subscriptionReceiving, setSubscriptionReceiving, startBusiness, checkBusiness, disconnectBusiness, subscriptionConnectionFor, subscriptionManagedBy, access, rejectAccess, expire, housekeeping, hold, paymentStatus, beginCheckout, reconcilePayment, notification, notificationByCollector, cancelled, sweep, configured };
}
