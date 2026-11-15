import { randomBytes, createCipheriv, createDecipheriv, createHmac } from 'node:crypto';
import { equal, failure } from './security.mjs';

export function secretBox(key, context) {
  const bytes = Buffer.from(key ?? '', 'hex');
  if (bytes.length !== 32) throw failure(503, 'O recebimento está aguardando configuração da plataforma.');
  return {
    seal(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', bytes, iv); cipher.setAAD(Buffer.from(context)); const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]); return [iv, cipher.getAuthTag(), body].map(b => b.toString('base64url')).join('.'); },
    open(value) { try { const [iv, tag, body] = value.split('.').map(s => Buffer.from(s, 'base64url')); const cipher = createDecipheriv('aes-256-gcm', bytes, iv); cipher.setAAD(Buffer.from(context)); cipher.setAuthTag(tag); return JSON.parse(Buffer.concat([cipher.update(body), cipher.final()]).toString()); } catch { throw failure(503, 'A conexão precisa ser configurada novamente pelo profissional.'); } },
  };
}

export function verifyNotification(headers, dataId, secret, now = Date.now()) {
  const signature = headers['x-signature'], requestId = headers['x-request-id'];
  if (!secret || typeof signature !== 'string' || typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{1,150}$/.test(requestId) || !/^[a-z0-9_-]{1,128}$/i.test(dataId ?? '')) throw failure(401, 'Notificação não autenticada.');
  const parts = signature.split(',').map(v => v.trim().split('=')), timestamps = parts.filter(([key]) => key === 'ts'), hashes = parts.filter(([key]) => key === 'v1');
  if (timestamps.length !== 1 || hashes.length < 1 || hashes.length > 2) throw failure(401, 'Notificação não autenticada.');
  const ts = timestamps[0][1], stamp = Number(ts) * (ts?.length <= 10 ? 1000 : 1);
  if (!/^\d{10,13}$/.test(ts ?? '') || !Number.isSafeInteger(stamp) || Math.abs(now - stamp) > 15 * 60000) throw failure(401, 'Notificação fora do período de validação.');
  const expected = createHmac('sha256', secret).update(`id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`).digest('hex');
  if (!hashes.some(([, hash]) => /^[a-f0-9]{64}$/i.test(hash ?? '') && equal(hash.toLowerCase(), expected))) throw failure(401, 'Notificação não autenticada.');
}

export const cents = value => { const s = String(value); if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(s)) throw failure(409, 'O valor recebido precisa de conferência.'); const [whole, fraction = ''] = s.split('.'); return Number(whole) * 100 + Number(fraction.padEnd(2, '0')); };
export async function paymentEnvironmentMatches(payment, mode, collectorId, accessToken, request) {
  if (!['sandbox', 'live'].includes(mode) || typeof payment?.live_mode !== 'boolean' || String(payment.collector_id) !== String(collectorId) || mode === 'live' && payment.live_mode !== true) return false;
  // Payments between Mercado Pago test accounts may carry live_mode: true.
  // The authenticated canonical receiver identity must establish whether funds
  // are fictional; never infer this from a token prefix or a return URL.
  const me = await request('GET', '/users/me', { accessToken });
  return String(me?.id) === String(collectorId) && me.site_id === 'MLB' && Array.isArray(me.tags) && me.tags.includes('test_user') === (mode === 'sandbox');
}
export function checkoutUrl(value, mode) { try { const url = new URL(value); const expected = mode === 'sandbox' ? ['www.mercadopago.com.br', 'mercadopago.com.br', 'sandbox.mercadopago.com.br'] : ['www.mercadopago.com.br', 'mercadopago.com.br']; if (url.protocol !== 'https:' || !expected.includes(url.hostname) || url.port || url.username || url.password) throw Error(); return url.href; } catch { throw failure(503, 'O link de pagamento não pôde ser validado. Tente consultar novamente.'); } }

const httpIssue = status => status === 401 || status === 403 ? 'not_authorized' : status === 429 ? 'rate_limited' : status >= 500 ? 'provider_unavailable' : 'provider_rejected';
function rejectionIssue(text) {
  let detail;
  try { detail = JSON.parse(text); } catch { return 'invalid_response'; }
  // Inspect fixed error channels only. Payer details, credentials, arbitrary
  // object values and provider text never become properties of the thrown error.
  const errors = [detail?.message, detail?.error];
  if (Array.isArray(detail?.cause)) for (const cause of detail.cause.slice(0, 20)) errors.push(cause?.code, cause?.description, cause?.field);
  if (errors.some(value => typeof value === 'string' && /\b(?:transaction_amount|min_allowed_amount|minimum[ _-]?amount)\b/i.test(value))) return 'amount_rejected';
  return detail?.error === 'invalid_request' ? 'invalid_request' : 'provider_rejected';
}

const diagnosticParams = ['preapproval_id', 'payment_id', 'collector_id', 'application_id', 'offset', 'limit', 'sort', 'criteria', 'payer_email', 'notification_url', 'back_url', 'external_reference', 'transaction_amount', 'frequency_type', 'frequency', 'currency_id', 'card_token_id', 'preapproval_plan_id', 'auto_recurring', 'status', 'reason'];
const requestId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value) ? value : undefined;
function providerDiagnostic(status, text, issue) {
  const diagnostic = { category: status === 401 || status === 403 ? 'authorization' : 'unknown', param: 'unknown', jsonValid: false, hasError: false, hasMessage: false, hasCause: false };
  let detail;
  if (typeof text !== 'string' || text.length > 10000) return Object.freeze(diagnostic);
  try { detail = JSON.parse(text); diagnostic.jsonValid = true; } catch { return Object.freeze(diagnostic); }
  const object = detail && typeof detail === 'object' && !Array.isArray(detail);
  diagnostic.hasError = Boolean(object && Object.hasOwn(detail, 'error'));
  diagnostic.hasMessage = Boolean(object && Object.hasOwn(detail, 'message'));
  diagnostic.hasCause = Boolean(object && Object.hasOwn(detail, 'cause'));
  const causes = Array.isArray(detail?.cause) ? detail.cause.slice(0, 20) : [];
  // Only fixed error channels inform these enums. No value from the response,
  // including an unknown code or field, is copied into the diagnostic object.
  const channels = [detail?.error, detail?.message, ...causes.flatMap(cause => [cause?.field, cause?.code, cause?.description])].filter(value => typeof value === 'string');
  const findParam = value => diagnosticParams.find(param => new RegExp(`(?:^|[^a-z0-9_])${param}(?:$|[^a-z0-9_])`, 'i').test(value)) ?? (/\b(?:x-idempotency-key|idempotency_key)\b/i.test(value) ? 'idempotency_key' : 'unknown');
  const explicit = causes.map(cause => cause?.field).filter(value => typeof value === 'string').map(findParam).find(param => param !== 'unknown');
  diagnostic.param = explicit ?? channels.map(findParam).find(param => param !== 'unknown') ?? (issue === 'amount_rejected' ? 'transaction_amount' : 'unknown');
  const mentions = pattern => channels.some(value => pattern.test(value));
  if (mentions(/\b(?:sandbox|live_mode|test_user|test[ _-](?:users?|accounts?|credentials?|tokens?)|(?:real|production|live)[ _-](?:users?|accounts?|credentials?|tokens?))\b/i)) diagnostic.category = 'environment';
  else if (mentions(/\b(?:oauth(?:_?exception)?|authorization_code|client_credentials|invalid_client|invalid_grant|invalid_token|unauthorized_client|unsupported_grant_type|access[ _-]token|refresh[ _-]token|client[ _-]id|client[ _-]secret|grant_type|code_verifier|redirect_uri)\b/i)) diagnostic.category = 'oauth';
  else if (status === 401 || status === 403 || mentions(/\b(?:unauthorized|forbidden|authorization|permissions?|not[ _-]authorized|access[ _-]denied)\b/i)) diagnostic.category = 'authorization';
  else if (diagnostic.param === 'payer_email' || mentions(/\bpayer\b/i)) diagnostic.category = 'payer';
  else if (diagnostic.param !== 'unknown' || mentions(/\b(?:invalid[ _-](?:request|parameters?|params?|key)|unknown[ _-](?:parameters?|params?|key)|unsupported[ _-](?:parameters?|params?|key)|bad[ _-]request)\b/i)) diagnostic.category = 'parameter';
  return Object.freeze(diagnostic);
}

function diagnosticError(error, diagnostic, providerRequestId) {
  // Keep diagnostics opt-in for audit consumers; ordinary error serialization
  // retains its existing shape and never includes the provider response.
  Object.defineProperty(error, 'providerDiagnostic', { value: diagnostic });
  if (providerRequestId) Object.defineProperty(error, 'providerRequestId', { value: providerRequestId });
  return error;
}

export function createMercadoPagoClient(config, transport) {
  return async (method, path, { accessToken, data, key } = {}) => {
    if (!/^\/(?:oauth\/token|users\/me|checkout\/preferences(?:\/[a-zA-Z0-9_-]+)?|v1\/payments(?:\/(?:search|[0-9]+))?|preapproval(?:\/[a-zA-Z0-9_-]{1,128})?|authorized_payments\/(?:search|[0-9]{1,32}))(?:\?[^\s]*)?$/.test(path)) throw new Error('MP_PATH_INVALID');
    if (transport) return transport(method, path, { accessToken, data, key });
    let providerStatus, providerRequestId, diagnostic = providerDiagnostic(), providerIssue = 'connection_failed';
    try {
      const response = await fetch('https://api.mercadopago.com' + path, { method, redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'X-Idempotency-Key': key } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
      providerStatus = response.status;
      providerRequestId = requestId(response.headers?.get?.('x-request-id'));
      diagnostic = providerDiagnostic(providerStatus);
      if (!response.ok) {
        providerIssue = httpIssue(providerStatus);
        if (providerStatus === 400 || providerStatus === 422) {
          providerIssue = 'connection_failed';
          const text = await response.text();
          providerIssue = text.length > 10000 ? 'invalid_response' : rejectionIssue(text);
          diagnostic = providerDiagnostic(providerStatus, text, providerIssue);
        }
        throw Error();
      }
      const text = await response.text();
      providerIssue = 'invalid_response';
      if (text.length > 2 * 1024 * 1024) throw Error();
      return JSON.parse(text);
    } catch {
      if (providerIssue === 'amount_rejected') throw diagnosticError(Object.assign(failure(422, 'O Mercado Pago recusou o valor informado. O preço permanece igual; peça ao profissional para conferir o mínimo aceito antes de tentar novamente.'), { providerStatus, providerIssue, amountRejected: true }), diagnostic, providerRequestId);
      const unauthorized = providerStatus === 401 || providerStatus === 403;
      const refusedReason = method === 'POST' && path === '/preapproval' && [400, 422].includes(providerStatus) && diagnostic.param === 'reason' && diagnostic.category === 'parameter';
      const message = refusedReason ? 'O Mercado Pago recusou a descrição deste plano. Sua solicitação foi preservada; peça à Raelapps para conferir antes de tentar novamente.' : unauthorized ? 'O Mercado Pago não autorizou esta operação. Confira ou reconecte sua conta.' : 'O Mercado Pago não respondeu agora. Consulte novamente; não refaça o pagamento.';
      throw diagnosticError(Object.assign(failure(unauthorized ? 409 : 503, message), { providerStatus, providerIssue }), diagnostic, providerRequestId);
    }
  };
}
