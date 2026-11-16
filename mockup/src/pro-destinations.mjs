import { createHmac, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { digest, equal } from './security.mjs';

const digits = (value, min, max) => typeof value === 'string' && new RegExp('^[0-9]{' + min + ',' + max + '}$').test(value);
const demoHash = digest('rael-homologacao@example.invalid');
const googleTokenEndpoint = 'https://oauth2.googleapis.com/token';

function googleCredential(env) {
  const bundle = env.APP_PRO_GOOGLE_SERVICE_ACCOUNT_B64;
  if (bundle) {
    if (!/^[A-Za-z0-9_-]{20,8192}$/.test(bundle)) return null;
    try {
      const { type, client_email, private_key, private_key_id } = JSON.parse(Buffer.from(bundle, 'base64url').toString('utf8'));
      if (type !== 'service_account' || !/^[a-z0-9-]+@[a-z0-9.-]+\.gserviceaccount\.com$/i.test(client_email) ||
        !/^[a-f0-9]{40}$/i.test(private_key_id)) return null;
      const signingKey = createPrivateKey(private_key);
      return signingKey.asymmetricKeyType === 'rsa' ? { serviceAccount: { email: client_email, keyId: private_key_id, signingKey } } : null;
    } catch { return null; }
  }
  let oauth = { client_id: env.APP_PRO_GOOGLE_CLIENT_ID, client_secret: env.APP_PRO_GOOGLE_CLIENT_SECRET, refresh_token: env.APP_PRO_GOOGLE_REFRESH_TOKEN };
  if (/^[A-Za-z0-9_-]{20,4096}$/.test(env.APP_PRO_GOOGLE_TEST_OAUTH_B64 ?? '')) {
    try { oauth = JSON.parse(Buffer.from(env.APP_PRO_GOOGLE_TEST_OAUTH_B64, 'base64url').toString('utf8')) ?? {}; }
    catch { oauth = {}; }
  }
  const fields = ['client_id', 'client_secret', 'refresh_token'];
  return fields.every(key => typeof oauth[key] === 'string' && oauth[key].trim())
    ? Object.fromEntries(fields.map(key => [key, oauth[key].trim()])) : null;
}

function googleGrant({ serviceAccount, client_id, client_secret, refresh_token }) {
  if (!serviceAccount) return new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: 'refresh_token' });
  const { email, keyId, signingKey } = serviceAccount;
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: 'RS256', typ: 'JWT', kid: keyId });
  const claims = encode({ iss: email, scope: 'https://www.googleapis.com/auth/datamanager',
    aud: googleTokenEndpoint, iat: now, exp: now + 300 });
  const unsigned = header + '.' + claims;
  const signature = sign('RSA-SHA256', Buffer.from(unsigned), signingKey).toString('base64url');
  return new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + signature });
}

export function proConfiguration(env, origin) {
  if (env.APP_PRO_MODE !== 'test' || env.APP_LICENSE_MODE !== 'test') return null;
  const config = { origin, real: env.APP_PRO_REAL_EVENTS === '1', slug: env.APP_SLUG || 'agenda' };
  if (digits(env.APP_PRO_META_TEST_DATASET_ID, 4, 32) && /^TEST[A-Z0-9_-]+$/i.test(env.APP_PRO_META_TEST_EVENT_CODE ?? '') && env.APP_PRO_META_TEST_TOKEN) {
    config.meta = { dataset: env.APP_PRO_META_TEST_DATASET_ID, token: env.APP_PRO_META_TEST_TOKEN, code: env.APP_PRO_META_TEST_EVENT_CODE };
  }
  if (digits(env.APP_PRO_GOOGLE_TEST_ACCOUNT, 10, 10) && digits(env.APP_PRO_GOOGLE_TEST_ACTION, 1, 22)) {
    const credential = googleCredential(env);
    if (credential) config.google = { account: env.APP_PRO_GOOGLE_TEST_ACCOUNT, action: env.APP_PRO_GOOGLE_TEST_ACTION, ...credential };
  }
  const webhookUrl = URL.parse(env.APP_PRO_WEBHOOK_TEST_URL ?? '');
  if (webhookUrl?.protocol === 'https:' && !webhookUrl.username && !webhookUrl.password && !webhookUrl.hash &&
    /^[a-f0-9]{64}$/i.test(env.APP_PRO_WEBHOOK_TEST_SECRET ?? '')) {
    config.webhook = { url: webhookUrl.href, secret: env.APP_PRO_WEBHOOK_TEST_SECRET };
  }
  return config;
}

export function metaEvent(event, config) {
  const real = event.mode === 'live';
  return {
    data: [{
      event_name: 'Schedule', event_id: event.id, event_time: Math.floor(Date.parse(event.at) / 1000),
      action_source: 'website', event_source_url: config.origin + (real ? '/negocio/' + encodeURIComponent(config.slug) : '/'),
      user_data: real ? { fbc: event.clicks.fbc, client_user_agent: event.clicks.agent } : { em: [demoHash] }
    }],
    ...(real ? {} : { test_event_code: config.meta?.code ?? 'TEST_LOCAL' })
  };
}

export function googleEvent(event, config) {
  return {
    destinations: [{
      operatingAccount: { accountType: 'GOOGLE_ADS', accountId: config.google?.account ?? '0000000000' },
      productDestinationId: config.google?.action ?? '123'
    }],
    events: [{
      transactionId: event.id, eventTimestamp: event.at, eventSource: 'WEB',
      adIdentifiers: event.mode === 'live' ? event.clicks.google : { gclid: 'GCLID_1' }
    }],
    ...(event.mode === 'live' ? { consent: { adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_DENIED' } } : {}),
    validateOnly: event.mode !== 'live'
  };
}

export const webhookSignature = (secret, seconds, body) =>
  'sha256=' + createHmac('sha256', Buffer.from(secret, 'hex')).update(seconds + '.').update(body).digest('hex');

export function proDestinations(config, send = fetch) {
  const localSigningKey = randomBytes(32).toString('hex');
  async function post(url, headers, body, stage) {
    const response = await send(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(4500), redirect: 'error' });
    if (!response.ok) {
      let upstreamReason;
      if (stage === 'OAuth') {
        const report = await response.json().catch(() => null);
        if (['invalid_client', 'invalid_grant', 'invalid_request'].includes(report?.error)) upstreamReason = report.error;
      }
      throw Object.assign(new Error('upstream_rejected'), { upstreamStatus: response.status, upstreamStage: stage, upstreamReason });
    }
    return response;
  }

  return async (destination, event) => {
    const real = config.real && event.mode === 'live' && event.synthetic === false && event.type === 'appointment.confirmed';
    const test = event.mode === 'test' && event.synthetic === true;
    if (destination === 'meta') {
      if (!config.meta || !(test || (real && event.clicks?.fbc && event.clicks?.agent))) return 'simulated';
      const payload = metaEvent(event, config);
      const response = await post('https://graph.facebook.com/v24.0/' + config.meta.dataset + '/events',
        { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.meta.token }, JSON.stringify(payload));
      if (!(Number((await response.json()).events_received) > 0)) throw Object.assign(new Error('event_not_accepted'), { upstreamStatus: 422 });
      return 'received';
    }
    if (destination === 'google') {
      if (!config.google || !(test || (real && event.clicks?.google))) return 'simulated';
      const payload = googleEvent(event, config);
      const auth = await post(googleTokenEndpoint, { 'Content-Type': 'application/x-www-form-urlencoded' },
        googleGrant(config.google).toString(), 'OAuth');
      const { access_token } = await auth.json();
      if (typeof access_token !== 'string' || !access_token) throw Object.assign(new Error('oauth_failed'), { upstreamStatus: 401, upstreamStage: 'OAuth' });
      const reply = await post('https://datamanager.googleapis.com/v1/events:ingest',
        { 'Content-Type': 'application/json', Authorization: 'Bearer ' + access_token }, JSON.stringify(payload), 'Data Manager');
      await reply.body?.cancel();
      return real ? 'accepted' : 'validated';
    }

    const body = JSON.stringify(event);
    const seconds = String(Math.floor(Date.now() / 1000));
    const secret = config.webhook?.secret ?? localSigningKey;
    const signature = webhookSignature(secret, seconds, body);
    if (!config.webhook || !(test || real)) {
      const expected = 'sha256=' + createHmac('sha256', Buffer.from(secret, 'hex')).update(seconds + '.').update(body).digest('hex');
      if (!equal(signature, expected)) throw new Error('signature_failed');
      return 'simulated';
    }
    const reply = await post(config.webhook.url, {
      'Content-Type': 'application/json', 'X-Rael-Event-Id': event.id,
      'X-Rael-Timestamp': seconds, 'X-Rael-Signature': signature, 'X-Rael-Mode': event.mode
    }, body);
    await reply.body?.cancel();
    return 'received';
  };
}
