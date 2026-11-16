import { proConfiguration } from './pro-destinations.mjs';
import { digest } from './security.mjs';
import { loadConfiguration, validSlug } from './configuration.mjs';

export async function loadStandaloneConfiguration(env = process.env) {
  const slug = env.APP_SLUG || 'agenda';
  if (!validSlug(slug)) throw new Error('APP_SLUG deve ter de 2 a 48 caracteres, usando letras minúsculas, números e hífens.');
  if (!env.APP_ORIGIN) throw new Error('Configure APP_ORIGIN com a URL pública, sem barra final.');

  const local = env.NODE_ENV !== 'production' && env.APP_LOCAL_DB;
  const entry = local ? { driver: 'sqlite', path: local } : {
    driver: 'mysql',
    host: env.DB_HOST,
    port: Number(env.DB_PORT || 3306),
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    ssl: env.DB_TLS === '1',
    ca: env.DB_CA || undefined
  };
  if (!local && (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535)) {
    throw new Error('DB_PORT inválida.');
  }
  const bootstrap = [env.APP_BUSINESS_NAME, env.APP_OWNER_NAME, env.APP_OWNER_EMAIL, env.APP_SETUP_TOKEN];
  if (bootstrap.some(Boolean)) {
    const expiry = Date.parse(env.APP_SETUP_EXPIRES || '');
    if (!bootstrap.every(Boolean) || !/^[a-zA-Z0-9_-]{43,100}$/.test(bootstrap[3]) || !Number.isSafeInteger(expiry)) {
      throw new Error('Configure os quatro campos de instalação e APP_SETUP_EXPIRES com data ISO 8601.');
    }
    entry.bootstrap = {
      name: bootstrap[0], ownerName: bootstrap[1], ownerEmail: bootstrap[2],
      activationHash: digest(bootstrap[3]), expiresAt: expiry, trial: false
    };
  }
  const config = await loadConfiguration({
    NODE_ENV: env.NODE_ENV,
    RAEL_SYSTEM_ENABLED: '1',
    RAEL_TEST_MODE: env.RAEL_TEST_MODE,
    RAEL_PUBLIC_ORIGIN: env.APP_ORIGIN,
    RAEL_TENANTS_JSON: JSON.stringify({ [slug]: entry }),
    RAEL_INTEGRATION_KEY: env.RAEL_INTEGRATION_KEY,
    RAEL_PUSH_SUBJECT: env.RAEL_PUSH_SUBJECT,
    RAEL_PUSH_PUBLIC_KEY: env.RAEL_PUSH_PUBLIC_KEY,
    RAEL_PUSH_PRIVATE_KEY: env.RAEL_PUSH_PRIVATE_KEY,
    ...Object.fromEntries(Object.entries(env).filter(([key, value]) => value && (key === 'RAEL_RECOVERY_EMAIL_ENABLED' || /^RAEL_SMTP_(HOST|PORT|USER|PASSWORD)$/.test(key)))),
    RAEL_MP_LIVE_APPROVED: env.RAEL_MP_LIVE_APPROVED
  });
  let sourceUrl = env.APP_SOURCE_URL;
  if (sourceUrl) {
    const url = new URL(sourceUrl);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('APP_SOURCE_URL deve ser uma URL HTTPS.');
    sourceUrl = url.href;
  }
  const publicName = (env.APP_PUBLIC_NAME || env.APP_BUSINESS_NAME || '').trim().slice(0, 120);
  return { ...config, sourceUrl, publicName, standalone: true, installationLicensing: env.APP_LICENSE_MODE === 'test', pro: proConfiguration(env, config.origin) };
}
