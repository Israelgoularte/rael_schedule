import { createHmac, randomBytes } from 'node:crypto';
import { digest, equal } from './security.mjs';

const digits = (value, min, max) => typeof value === 'string' && new RegExp('^[0-9]{' + min + ',' + max + '}$').test(value);
const demoHash = digest('rael-homologacao@example.invalid');

export function proConfiguration(env, origin) {
  if (env.APP_PRO_MODE !== 'test' || env.APP_LICENSE_MODE !== 'test') return null;
  const config = { origin };
  if (digits(env.APP_PRO_META_TEST_DATASET_ID, 4, 32) && /^TEST[A-Z0-9_-]+$/i.test(env.APP_PRO_META_TEST_EVENT_CODE ?? '') && env.APP_PRO_META_TEST_TOKEN) {
    config.meta = { dataset: env.APP_PRO_META_TEST_DATASET_ID, token: env.APP_PRO_META_TEST_TOKEN, code: env.APP_PRO_META_TEST_EVENT_CODE };
  }
  if (digits(env.APP_PRO_GOOGLE_TEST_ACCOUNT, 10, 10) && digits(env.APP_PRO_GOOGLE_TEST_ACTION, 1, 22) &&
    env.APP_PRO_GOOGLE_CLIENT_ID && env.APP_PRO_GOOGLE_CLIENT_SECRET && env.APP_PRO_GOOGLE_REFRESH_TOKEN) {
    config.google = {
      account: env.APP_PRO_GOOGLE_TEST_ACCOUNT, action: env.APP_PRO_GOOGLE_TEST_ACTION,
      client_id: env.APP_PRO_GOOGLE_CLIENT_ID, client_secret: env.APP_PRO_GOOGLE_CLIENT_SECRET, refresh_token: env.APP_PRO_GOOGLE_REFRESH_TOKEN
    };
  }
  const webhookUrl = URL.parse(env.APP_PRO_WEBHOOK_TEST_URL ?? '');
  if (webhookUrl?.protocol === 'https:' && !webhookUrl.username && !webhookUrl.password && !webhookUrl.hash &&
    /^[a-f0-9]{64}$/i.test(env.APP_PRO_WEBHOOK_TEST_SECRET ?? '')) {
    config.webhook = { url: webhookUrl.href, secret: env.APP_PRO_WEBHOOK_TEST_SECRET };
  }
  return config;
}

export function metaEvent(event, config) {
  return {
    data: [{
      event_name: 'Schedule', event_id: event.id, event_time: Math.floor(Date.parse(event.at) / 1000),
      action_source: 'website', event_source_url: config.origin + '/',
      user_data: { em: [demoHash] }
    }],
    test_event_code: config.meta?.code ?? 'TEST_LOCAL'
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
      userData: { userIdentifiers: [{ emailAddress: demoHash }] }
    }],
    encoding: 'HEX',
    validateOnly: true
  };
}

export const webhookSignature = (secret, seconds, body) =>
  'sha256=' + createHmac('sha256', Buffer.from(secret, 'hex')).update(seconds + '.').update(body).digest('hex');

export function proDestinations(config, send = fetch) {
  const localSigningKey = randomBytes(32).toString('hex');
  async function post(url, headers, body) {
    const response = await send(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(4500), redirect: 'error' });
    if (!response.ok) throw Object.assign(new Error('upstream_rejected'), { upstreamStatus: response.status });
    return response;
  }

  return async (destination, event) => {
    if (destination === 'meta') {
      const payload = metaEvent(event, config);
      if (!config.meta || !event.synthetic) return 'simulated';
      const response = await post('https://graph.facebook.com/v24.0/' + config.meta.dataset + '/events',
        { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.meta.token }, JSON.stringify(payload));
      if (!(Number((await response.json()).events_received) > 0)) throw Object.assign(new Error('event_not_accepted'), { upstreamStatus: 422 });
      return 'received';
    }
    if (destination === 'google') {
      const payload = googleEvent(event, config);
      if (!config.google || !event.synthetic) return 'simulated';
      const { client_id, client_secret, refresh_token } = config.google;
      const auth = await post('https://oauth2.googleapis.com/token', { 'Content-Type': 'application/x-www-form-urlencoded' },
        new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: 'refresh_token' }));
      const { access_token } = await auth.json();
      if (typeof access_token !== 'string' || !access_token) throw Object.assign(new Error('oauth_failed'), { upstreamStatus: 401 });
      const reply = await post('https://datamanager.googleapis.com/v1/events:ingest',
        { 'Content-Type': 'application/json', Authorization: 'Bearer ' + access_token }, JSON.stringify(payload));
      await reply.body?.cancel();
      return 'validated';
    }

    const body = JSON.stringify(event);
    const seconds = String(Math.floor(Date.now() / 1000));
    const secret = config.webhook?.secret ?? localSigningKey;
    const signature = webhookSignature(secret, seconds, body);
    if (!config.webhook || !event.synthetic) {
      const expected = 'sha256=' + createHmac('sha256', Buffer.from(secret, 'hex')).update(seconds + '.').update(body).digest('hex');
      if (!equal(signature, expected)) throw new Error('signature_failed');
      return 'simulated';
    }
    const reply = await post(config.webhook.url, {
      'Content-Type': 'application/json', 'X-Rael-Event-Id': event.id,
      'X-Rael-Timestamp': seconds, 'X-Rael-Signature': signature, 'X-Rael-Mode': 'test'
    }, body);
    await reply.body?.cancel();
    return 'received';
  };
}
