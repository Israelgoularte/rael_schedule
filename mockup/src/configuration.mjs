import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { platformBillingForTenant } from './platform-billing.mjs';
import { createECDH } from 'node:crypto';
import { mysqlEntriesConflict } from './mysql-isolation.mjs';
import { parsePaymentSelfTest } from './payment-self-test.mjs';
import { parseRecoveryMail } from './recovery-mail.mjs';

function browserNotifications(env) {
  const publicKey = env.RAEL_PUSH_PUBLIC_KEY || '', privateKey = env.RAEL_PUSH_PRIVATE_KEY || '';
  if (!publicKey && !privateKey) return null;
  const subject = env.RAEL_PUSH_SUBJECT;
  try {
    if (!/^[A-Za-z0-9_-]{87}$/.test(publicKey) || !/^[A-Za-z0-9_-]{43}$/.test(privateKey)) throw Error();
    const publicBytes = Buffer.from(publicKey, 'base64url'), privateBytes = Buffer.from(privateKey, 'base64url');
    const pair = createECDH('prime256v1'); pair.setPrivateKey(privateBytes);
    if (privateBytes.length !== 32 || publicBytes.length !== 65 || !pair.getPublicKey().equals(publicBytes)) throw Error();
    const contact = new URL(subject);
    if (subject.length > 254 || /[\s\x00-\x1f\x7f]/.test(subject) || !['https:', 'mailto:'].includes(contact.protocol) || contact.username || contact.password || contact.hash || contact.search || contact.protocol === 'mailto:' && !/^[^@]+@[^@]+\.[^@]+$/.test(contact.pathname)) throw Error();
  } catch { throw new Error('Configure um par válido de chaves privadas de notificações e um contato da plataforma.'); }
  return { publicKey, privateKey, subject };
}

export const validSlug = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{1,47}$/.test(value) && !value.endsWith('-');
export const tenantTestMode = (config, slug) => Boolean(config.testMode || config.entries?.[slug]?.testMode === true);
export const tenantPaymentsLiveApproved = (config, slug) => !tenantTestMode(config, slug) && (config.paymentsLiveApproved === true || Array.isArray(config.paymentsLiveApprovedSlugs) && config.paymentsLiveApprovedSlugs.includes(slug));
function paymentLiveApprovedSlugs(env) {
  const raw = env.RAEL_MP_LIVE_APPROVED_SLUGS_JSON;
  if (raw === undefined) return [];
  try {
    if (typeof raw !== 'string' || raw.length > 65536) throw Error();
    const slugs = JSON.parse(raw);
    if (!Array.isArray(slugs) || slugs.length > 1000 || slugs.some(slug => !validSlug(slug)) || new Set(slugs).size !== slugs.length) throw Error();
    // Managed tenants can be hydrated after loading the static manifest.
    return slugs;
  } catch { throw new Error('Lista de liberação real dos negócios inválida.'); }
}
function paymentDiagnostics(raw, loadedAt) {
  if (raw === undefined) return null;
  try {
    if (typeof raw !== 'string' || raw.length > 4096) throw Error();
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4 || Object.keys(value).some(key => !['tenant', 'subscriptionId', 'expiresAt', 'maxAttempts'].includes(key)) || !validSlug(value.tenant) || !/^[a-f0-9-]{36}$/.test(value.subscriptionId ?? '') || value.maxAttempts !== 2 || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 1 || value.expiresAt > loadedAt + 2 * 60 * 60 * 1000) throw Error();
    return Object.freeze({ ...value });
  } catch { throw new Error('Configuração temporária de diagnóstico de recebimentos inválida.'); }
}
function businessPayments(value, testMode, liveApproved) {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('Configuração de recebimento do negócio inválida.');
  const raw = value ?? {};
  if (Object.keys(raw).some(key => !['enabled', 'mode', 'holdMinutes', 'clientId', 'clientSecret', 'encryptionKey', 'webhookSecret'].includes(key))) throw new Error('Configuração de recebimento do negócio inválida.');
  if (raw.clientId !== undefined && (typeof raw.clientId !== 'string' || !/^\d{4,32}$/.test(raw.clientId)) || raw.encryptionKey !== undefined && (typeof raw.encryptionKey !== 'string' || !/^[a-f0-9]{64}$/i.test(raw.encryptionKey))) throw new Error('Configuração de recebimento do negócio inválida.');
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error('A ativação do recebimento deve ser definida para o próprio negócio.');
  const payments = { ...raw, enabled: raw.enabled === true, mode: raw.mode ?? 'sandbox', holdMinutes: Number(raw.holdMinutes ?? 30) };
  if (!['sandbox', 'live'].includes(payments.mode) || !Number.isInteger(payments.holdMinutes) || payments.holdMinutes < 15 || payments.holdMinutes > 60) throw new Error('Configuração de recebimento do negócio inválida.');
  if (payments.enabled && (!/^\d{4,32}$/.test(payments.clientId ?? '') || typeof payments.clientSecret !== 'string' || !payments.clientSecret || !/^[a-f0-9]{64}$/i.test(payments.encryptionKey ?? '') || typeof payments.webhookSecret !== 'string' || !payments.webhookSecret)) throw new Error('Configuração de recebimento do negócio incompleta.');
  if (payments.enabled && payments.mode === 'live' && (!liveApproved || testMode)) throw new Error('Recebimentos reais dependem de homologação e liberação explícita.');
  return payments;
}
function validatePlatformBilling(value, env) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['enabled', 'mode', 'accessToken', 'collectorId', 'webhookSecret'].includes(k)) || typeof value.enabled !== 'boolean' || !['sandbox', 'live'].includes(value.mode)) throw new Error('Configuração da cobrança da plataforma inválida.');
  if (value.enabled && (!/^\d{1,32}$/.test(value.collectorId ?? '') || typeof value.accessToken !== 'string' || !value.accessToken || value.accessToken.length > 4096 || typeof value.webhookSecret !== 'string' || !value.webhookSecret)) throw new Error('Credenciais de cobrança da plataforma incompletas.');
  if (value.enabled && value.mode === 'live' && (env.RAEL_TEST_MODE === '1' || env.RAEL_PLATFORM_LIVE_APPROVED !== '1')) throw new Error('A cobrança real da licença exige homologação e liberação explícita.');
}
export async function loadConfiguration(env = process.env) {
  const loadedAt = Date.now();
  const production = env.NODE_ENV === 'production';
  const enabled = env.RAEL_SYSTEM_ENABLED === '1';
  const testMode = env.RAEL_TEST_MODE === '1';
  const paymentsLiveApproved = env.RAEL_MP_LIVE_APPROVED === '1', paymentsLiveApprovedSlugs = paymentLiveApprovedSlugs(env);
  const notifications = browserNotifications(env);
  const recoveryMail = parseRecoveryMail(env);
  const integrationKey = env.RAEL_INTEGRATION_KEY || null;
  if (integrationKey !== null && !/^[a-f0-9]{64}$/i.test(integrationKey)) throw new Error('Chave privada de integrações inválida.');
  if (recoveryMail && !integrationKey) throw new Error('Configure a chave privada de integrações antes de ativar a recuperação por e-mail.');
  let platformBilling = { enabled: false, mode: testMode ? 'sandbox' : 'live' }, platformBillingLive = null, operations = null, onboarding = null;
  try {
    if (env.RAEL_PLATFORM_BILLING_JSON) { const raw = JSON.parse(env.RAEL_PLATFORM_BILLING_JSON); if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error(); platformBilling = { ...platformBilling, ...raw }; }
    if (env.RAEL_PLATFORM_BILLING_LIVE_JSON) { const raw = JSON.parse(env.RAEL_PLATFORM_BILLING_LIVE_JSON); if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error(); platformBillingLive = { enabled: false, mode: 'live', ...raw }; }
    if (env.RAEL_OPERATIONS_JSON) operations = JSON.parse(env.RAEL_OPERATIONS_JSON);
    if (env.RAEL_ONBOARDING_JSON) onboarding = JSON.parse(env.RAEL_ONBOARDING_JSON);
  } catch { throw new Error('Configuração privada da operação inválida.'); }
  validatePlatformBilling(platformBilling, env);
  if (platformBillingLive) {
    if (platformBillingLive.mode !== 'live') throw new Error('A configuração adicional de cobrança real deve usar mode live.');
    validatePlatformBilling(platformBillingLive, env);
    if (platformBilling.enabled && platformBilling.mode === 'live') throw new Error('A cobrança real já usa a configuração original. Não adicione outra configuração real sem migração assistida.');
    if (platformBillingLive.enabled && platformBilling.enabled && String(platformBillingLive.collectorId) === String(platformBilling.collectorId)) throw new Error('A cobrança real deve usar uma conta diferente da homologação existente.');
  }
  const paymentsSelfTest = parsePaymentSelfTest(env.RAEL_MP_SELF_TEST_JSON, { platformBilling, platformBillingLive }, loadedAt);
  const diagnosticPayments = paymentDiagnostics(env.RAEL_MP_DIAGNOSTIC_JSON, loadedAt);
  const origin = env.RAEL_PUBLIC_ORIGIN ?? (production ? '' : 'http://127.0.0.1:3217');
  if (enabled && (!origin || new URL(origin).origin !== origin || (production && !origin.startsWith('https://')))) throw new Error('Configure uma origem pública válida.');
  let entries = {};
  if (enabled) {
    if (env.RAEL_TENANTS_JSON || env.RAEL_TENANTS_FILE) {
      try { entries = JSON.parse(env.RAEL_TENANTS_JSON || await readFile(resolve(env.RAEL_TENANTS_FILE), 'utf8')); }
      catch { throw new Error('Não foi possível ler o manifesto privado dos negócios.'); }
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Manifesto privado inválido.');
    }
    else throw new Error('Configure os negócios antes de ativar o sistema.');
  }
  if (Object.keys(env).some(key => key.startsWith('RAEL_MP_') && !['RAEL_MP_LIVE_APPROVED', 'RAEL_MP_LIVE_APPROVED_SLUGS_JSON', 'RAEL_MP_SELF_TEST_JSON', 'RAEL_MP_DIAGNOSTIC_JSON'].includes(key))) throw new Error('Mercado Pago exige configuração exclusiva em payments de cada negócio; credenciais globais não são permitidas.');
  const seenDatabases = new Set(), seenUsers = new Set(), seenApplications = new Set(), seenEncryptionKeys = new Set(), checkedEntries = [];
  for (const [slug, entry] of Object.entries(entries)) {
    if (!validSlug(slug) || !entry || typeof entry !== 'object') throw new Error('Configuração de negócio inválida.');
    if (entry.testMode !== undefined && typeof entry.testMode !== 'boolean') throw new Error('O modo de testes do negócio deve ser booleano.');
    if (entry.driver === 'sqlite') {
      if (production || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) throw new Error('Produção exige MySQL; persistência local é somente para desenvolvimento local.');
      entry.path = resolve(entry.path);
    } else if (entry.driver !== 'mysql' || typeof entry.host !== 'string' || !entry.host || typeof entry.database !== 'string' || !/^[a-zA-Z0-9_]{1,64}$/.test(entry.database) || typeof entry.user !== 'string' || !/^[a-zA-Z0-9_]{1,64}$/.test(entry.user) || !entry.password) throw new Error('Credenciais de banco incompletas ou identificadores inválidos.');
    const databaseKey = entry.driver === 'sqlite' ? entry.path : `${entry.host}:${entry.port ?? 3306}/${entry.database}`;
    const userKey = entry.driver === 'mysql' ? `${entry.host}:${entry.port ?? 3306}/${entry.user}` : entry.path;
    if (seenDatabases.has(databaseKey) || seenUsers.has(userKey) || checkedEntries.some(other => mysqlEntriesConflict(other, entry))) throw new Error('Cada negócio precisa de banco e usuário exclusivos, sem sobreposição de nomes ou permissões.');
    seenDatabases.add(databaseKey); seenUsers.add(userKey);
    checkedEntries.push(entry);
    const effectiveTestMode = tenantTestMode({ testMode, entries }, slug);
    entry.payments = businessPayments(entry.payments, effectiveTestMode, tenantPaymentsLiveApproved({ testMode, entries, paymentsLiveApproved, paymentsLiveApprovedSlugs }, slug));
    if (entry.license !== undefined && (!entry.license || typeof entry.license !== 'object' || Array.isArray(entry.license) || Object.keys(entry.license).some(k => !['enforced', 'billingMode'].includes(k)) || typeof entry.license.enforced !== 'boolean' || entry.license.billingMode !== undefined && !['sandbox', 'live'].includes(entry.license.billingMode))) throw new Error('Configuração da licença inválida.');
    const selectedBilling = platformBillingForTenant({ testMode, entries, platformBilling, platformBillingLive }, slug);
    if (effectiveTestMode && (entry.license?.billingMode === 'live' || selectedBilling.enabled && selectedBilling.mode === 'live')) throw new Error('Negócios fictícios não podem selecionar a cobrança real da plataforma.');
    if (entry.payments.clientId) {
      if (seenApplications.has(String(entry.payments.clientId))) throw new Error('Cada negócio precisa de aplicação Mercado Pago exclusiva.');
      seenApplications.add(String(entry.payments.clientId));
    }
    if (entry.payments.encryptionKey) {
      if (seenEncryptionKeys.has(entry.payments.encryptionKey.toLowerCase())) throw new Error('Cada negócio precisa de chave de proteção de recebimento exclusiva.');
      seenEncryptionKeys.add(entry.payments.encryptionKey.toLowerCase());
    }
  }
  if (operations && (typeof operations !== 'object' || Array.isArray(operations) || Object.keys(operations).some(k => !['tenant', 'userIds'].includes(k)) || !Object.hasOwn(entries, operations.tenant) || !Array.isArray(operations.userIds) || !operations.userIds.length || operations.userIds.length > 5 || operations.userIds.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)))) throw new Error('Operação exige negócio e administradores autorizados explicitamente.');
  if (onboarding !== null) {
    if (!onboarding || typeof onboarding !== 'object' || Array.isArray(onboarding) || Object.keys(onboarding).some(k => !['enabled', 'token', 'account', 'domain', 'host', 'maxTenants', 'maxDaily', 'maxDatabases', 'mode'].includes(k)) || typeof onboarding.enabled !== 'boolean' || !operations || !integrationKey) throw new Error('Configuração privada do cadastro automático inválida.');
    onboarding = { maxTenants: 100, maxDaily: 10, maxDatabases: 145, mode: testMode ? 'sandbox' : 'live', ...onboarding };
    for (const [key, max] of [['maxTenants', 1000], ['maxDaily', 100], ['maxDatabases', 1000]]) if (!Number.isSafeInteger(onboarding[key]) || onboarding[key] < 1 || onboarding[key] > max) throw new Error('Limites do cadastro automático inválidos.');
    if (!['live', 'sandbox'].includes(onboarding.mode) || onboarding.enabled && onboarding.mode === 'live' && testMode) throw new Error('Cadastro real exige separar explicitamente os negócios fictícios antes da ativação.');
    if (onboarding.enabled && (typeof onboarding.token !== 'string' || onboarding.token.length < 16 || onboarding.token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(onboarding.token) || !/^u\d{6,14}$/.test(onboarding.account ?? '') || onboarding.domain !== new URL(origin).hostname || typeof onboarding.host !== 'string' || !/^[a-zA-Z0-9.-]{1,253}$/.test(onboarding.host))) throw new Error('Configure a credencial privada e a conta da hospedagem antes de ativar o cadastro automático.');
  }
  if (diagnosticPayments && (!enabled || testMode || !operations)) throw new Error('O diagnóstico temporário exige operação autenticada e ambiente real separado.');
  return { enabled, production, origin, entries, testMode, platformBilling, platformBillingLive, operations, integrationKey, onboarding, notifications, recoveryMail, paymentsLiveApproved, paymentsLiveApprovedSlugs, paymentsSelfTest, paymentDiagnostics: diagnosticPayments };
}
