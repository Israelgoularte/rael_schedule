import { resolve } from 'node:path';
import { validSlug, tenantTestMode } from './configuration.mjs';
import { platformBillingForTenant } from './platform-billing.mjs';
import { openDatabase, readSettings } from './database.mjs';
import { secretBox } from './mercadopago-client.mjs';
import { digest, failure } from './security.mjs';
import { mysqlEntriesConflict } from './mysql-isolation.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const known = new WeakMap();
const registryError = () => Object.assign(failure(503, 'O registro protegido dos negócios precisa ser conferido pela plataforma.'), { code: 'TENANT_REGISTRY_INVALID' });
const conflict = () => Object.assign(failure(409, 'O endereço, cadastro ou banco já está reservado para outro negócio.'), { code: 'TENANT_REGISTRY_CONFLICT' });
const invalid = () => Object.assign(failure(422, 'A configuração do novo negócio está incompleta ou não é permitida.'), { code: 'TENANT_REGISTRY_ENTRY_INVALID' });
const safeFailure = error => ['TENANT_REGISTRY_INVALID', 'TENANT_REGISTRY_CONFLICT', 'TENANT_REGISTRY_ENTRY_INVALID'].includes(error?.code) ? error : registryError();
const canonical = value => JSON.stringify(sort(value));
function sort(value) { return Array.isArray(value) ? value.map(sort) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value; }
const safeString = (value, max = 255) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

export async function applyTenantLifecycleTombstones(config, db) {
  if (!config.enabled || !config.operations?.tenant) return { removed: [] };
  const rows = await db.query('SELECT slug, state FROM tenant_lifecycle');
  const removed = [];
  for (const row of rows) if (row.slug !== config.operations.tenant && ['deleting', 'attention', 'deleted'].includes(row.state)) {
    if (Object.hasOwn(config.entries, row.slug)) { delete config.entries[row.slug]; removed.push(row.slug); }
  }
  return { removed };
}

function normalizedEntry(config, slug, input) {
  if (!object(input) || Object.keys(input).some(key => !['driver', 'host', 'port', 'database', 'user', 'password', 'ssl', 'ca', 'testMode', 'payments', 'license', 'path'].includes(key)) || typeof input.testMode !== 'boolean') throw invalid();
  let entry;
  if (input.driver === 'mysql') {
    if (input.path !== undefined || !safeString(input.host, 253) || !/^[a-zA-Z0-9.:-]+$/.test(input.host) || !safeString(input.database, 64) || !/^[a-zA-Z0-9_]+$/.test(input.database) || !safeString(input.user, 64) || !/^[a-zA-Z0-9_]+$/.test(input.user) || !safeString(input.password, 4096) || input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) || input.ssl !== undefined && typeof input.ssl !== 'boolean' || input.ca !== undefined && (input.ssl !== true || typeof input.ca !== 'string' || input.ca.length === 0 || input.ca.length > 65536 || /\x00/.test(input.ca))) throw invalid();
    entry = { driver: 'mysql', host: input.host.toLowerCase(), port: input.port ?? 3306, database: input.database, user: input.user, password: input.password, ssl: input.ssl ?? false, ...(input.ca === undefined ? {} : { ca: input.ca }) };
  } else if (input.driver === 'sqlite') {
    let local = false; try { local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.origin).hostname); } catch { /* An absent origin cannot enable local storage. */ }
    if (config.production || !local || !safeString(input.path, 4096) || ['host', 'port', 'ssl', 'ca'].some(key => input[key] !== undefined)) throw invalid();
    const providerMetadata = ['database', 'user', 'password'].some(key => input[key] !== undefined);
    if (providerMetadata && (!safeString(input.database, 64) || !/^[a-zA-Z0-9_]+$/.test(input.database) || !safeString(input.user, 64) || !/^[a-zA-Z0-9_]+$/.test(input.user) || !safeString(input.password, 4096))) throw invalid();
    entry = { driver: 'sqlite', path: resolve(input.path), ...(providerMetadata ? { database: input.database, user: input.user, password: input.password } : {}) };
  } else throw invalid();
  const effectiveTest = tenantTestMode({ ...config, entries: { [slug]: input } }, slug);
  const payments = input.payments === undefined ? { enabled: false, mode: effectiveTest ? 'sandbox' : 'live' } : input.payments;
  if (!object(payments) || Object.keys(payments).some(key => !['enabled', 'mode', 'holdMinutes'].includes(key)) || payments.enabled !== false || !['sandbox', 'live'].includes(payments.mode ?? 'sandbox') || payments.holdMinutes !== undefined && (!Number.isInteger(payments.holdMinutes) || payments.holdMinutes < 15 || payments.holdMinutes > 60)) throw invalid();
  const license = input.license;
  if (!object(license) || Object.keys(license).some(key => !['enforced', 'billingMode'].includes(key)) || license.enforced !== true || license.billingMode !== undefined && !['sandbox', 'live'].includes(license.billingMode)) throw invalid();
  entry.testMode = input.testMode;
  entry.payments = { enabled: false, mode: payments.mode ?? (effectiveTest ? 'sandbox' : 'live'), holdMinutes: payments.holdMinutes ?? 30 };
  entry.license = { enforced: true, ...(license.billingMode === undefined ? {} : { billingMode: license.billingMode }) };
  const billing = platformBillingForTenant({ ...config, entries: { [slug]: entry } }, slug);
  if (effectiveTest && (entry.license.billingMode === 'live' || billing.enabled && billing.mode === 'live')) throw invalid();
  return entry;
}

function keys(entry) {
  if (entry?.driver === 'sqlite' && typeof entry.path === 'string') {
    const path = resolve(entry.path), location = process.platform === 'win32' ? path.toLowerCase() : path, pathKey = digest('sqlite:' + location);
    const providerUser = entry.user ? digest('sqlite-provider-user:' + entry.user) : pathKey;
    return { databaseKey: pathKey, userKey: providerUser, databaseAliases: [pathKey, ...(entry.database ? [digest('sqlite-provider-database:' + entry.database)] : [])], userAliases: [pathKey, providerUser] };
  }
  if (entry?.driver !== 'mysql' || !entry.host || !entry.database || !entry.user) throw registryError();
  const server = `${String(entry.host).toLowerCase()}:${entry.port ?? 3306}/`;
  const databaseKey = digest('mysql:' + server + entry.database), userKey = digest('mysql:' + server + entry.user);
  return { databaseKey, userKey, databaseAliases: [databaseKey], userAliases: [userKey] };
}
const overlaps = (a, b) => a.databaseAliases.some(key => b.databaseAliases.includes(key)) || a.userAliases.some(key => b.userAliases.includes(key));

export function createTenantRegistry(config, getRegistryDb) {
  if (!known.has(config)) known.set(config, { statics: new Map(Object.entries(config.entries ?? {})), managed: new Set() });
  const metadata = known.get(config), now = config.now ?? (() => Date.now());
  let lastRefresh = -Infinity, pending = null;
  const available = () => Boolean(config.enabled && config.onboarding != null);
  const box = (slug, registrationId) => secretBox(config.integrationKey, `rael:tenant-registry:v1:${slug}:${registrationId}`);
  function staticEntries() {
    for (const [slug, entry] of Object.entries(config.entries ?? {})) if (!metadata.managed.has(slug)) metadata.statics.set(slug, entry);
    return metadata.statics;
  }
  function decode(row) {
    if (!object(row) || !validSlug(row.slug) || !uuid(row.registration_id) || typeof row.entry_cipher !== 'string' || row.entry_cipher.length > 262144 || !Number.isSafeInteger(Number(row.created_at)) || Number(row.created_at) < 0) throw registryError();
    const envelope = JSON.parse(row.entry_cipher);
    if (!object(envelope) || Object.keys(envelope).some(key => !['version', 'cipher'].includes(key)) || envelope.version !== 1 || typeof envelope.cipher !== 'string' || !envelope.cipher) throw registryError();
    const entry = normalizedEntry(config, row.slug, box(row.slug, row.registration_id).open(envelope.cipher)), identity = keys(entry);
    if (identity.databaseKey !== row.database_key || identity.userKey !== row.user_key) throw registryError();
    return { slug: row.slug, registrationId: row.registration_id, entry, ...identity };
  }
  function validateRows(rows) {
    if (!Array.isArray(rows)) throw registryError();
    const statics = staticEntries(), databases = new Set(), users = new Set(), ids = new Set(), slugs = new Set(), checkedEntries = [];
    for (const entry of statics.values()) {
      if (checkedEntries.some(other => mysqlEntriesConflict(other, entry))) throw conflict();
      const key = keys(entry); key.databaseAliases.forEach(value => databases.add(value)); key.userAliases.forEach(value => users.add(value)); checkedEntries.push(entry);
    }
    return rows.map(row => {
      const value = decode(row);
      if (statics.has(value.slug) || slugs.has(value.slug) || ids.has(value.registrationId) || value.databaseAliases.some(key => databases.has(key)) || value.userAliases.some(key => users.has(key)) || checkedEntries.some(other => mysqlEntriesConflict(other, value.entry))) throw conflict();
      slugs.add(value.slug); ids.add(value.registrationId); value.databaseAliases.forEach(key => databases.add(key)); value.userAliases.forEach(key => users.add(key));
      checkedEntries.push(value.entry);
      return value;
    });
  }
  async function refresh({ force = false } = {}) {
    if (!available()) return { changed: false, count: metadata.managed.size };
    if (pending) return pending;
    if (!force && Date.now() - lastRefresh < 2000) return { changed: false, count: metadata.managed.size };
    pending = (async () => {
      const db = await getRegistryDb(), rows = await db.query('SELECT slug, registration_id, database_key, user_key, entry_cipher, created_at FROM managed_tenants ORDER BY slug');
      const tombstones = await db.query("SELECT slug FROM tenant_lifecycle WHERE state = 'deleted'");
      const deleted = new Set(tombstones.map(row => row.slug));
      const values = validateRows(rows.filter(row => !deleted.has(row.slug))), active = new Set(values.map(value => value.slug));
      let changed = false;
      for (const slug of deleted) if (slug !== config.operations?.tenant && Object.hasOwn(config.entries, slug)) { delete config.entries[slug]; changed = true; }
      for (const slug of metadata.managed) if (!active.has(slug)) { delete config.entries[slug]; changed = true; }
      for (const value of values) {
        if (!Object.hasOwn(config.entries, value.slug) || canonical(config.entries[value.slug]) !== canonical(value.entry)) { config.entries[value.slug] = value.entry; changed = true; }
      }
      metadata.managed = active; lastRefresh = Date.now();
      return { changed, count: values.length };
    })().catch(error => { throw safeFailure(error); }).finally(() => { pending = null; });
    return pending;
  }
  async function register(slug, registrationId, input, transaction) {
    try {
      if (!available() || !validSlug(slug) || !uuid(registrationId)) throw invalid();
      const entry = normalizedEntry(config, slug, input), identity = keys(entry);
      const write = async tx => {
        await readSettings(tx, true);
        const [removed] = await tx.query("SELECT slug FROM tenant_lifecycle WHERE slug = ? AND state IN ('deleting','attention','deleted')", [slug]);
        if (removed) throw conflict();
        const rows = validateRows(await tx.query('SELECT slug, registration_id, database_key, user_key, entry_cipher, created_at FROM managed_tenants ORDER BY slug'));
        const existing = rows.find(row => row.registrationId === registrationId);
        if (existing) {
          if (existing.slug !== slug || canonical(existing.entry) !== canonical(entry)) throw conflict();
          return { slug, registrationId, created: false };
        }
        const statics = staticEntries();
        if (statics.has(slug) || [...statics.values()].some(value => overlaps(keys(value), identity) || mysqlEntriesConflict(value, entry)) || rows.some(value => value.slug === slug || overlaps(value, identity) || mysqlEntriesConflict(value.entry, entry))) throw conflict();
        const entryCipher = JSON.stringify({ version: 1, cipher: box(slug, registrationId).seal(entry) });
        await tx.query('INSERT INTO managed_tenants(slug, registration_id, database_key, user_key, entry_cipher, created_at) VALUES (?, ?, ?, ?, ?, ?)', [slug, registrationId, identity.databaseKey, identity.userKey, entryCipher, now()]);
        return { slug, registrationId, created: true };
      };
      const result = transaction ? await write(transaction) : await (await getRegistryDb()).transaction(write);
      lastRefresh = -Infinity;
      return result;
    } catch (error) { throw safeFailure(error); }
  }
  return { refresh, register };
}

export async function hydrateManagedTenants(config, { databaseFactory = openDatabase } = {}) {
  if (!config.enabled) return { changed: false, count: 0 };
  const slug = config.operations?.tenant;
  if (!slug && config.onboarding == null) return { changed: false, count: 0 };
  if (!slug || !Object.hasOwn(config.entries ?? {}, slug)) throw registryError();
  let db;
  try {
    db = await databaseFactory(config.entries[slug]);
    const result = config.onboarding == null ? { changed: false, count: 0 } : await createTenantRegistry(config, () => db).refresh({ force: true });
    const suppressed = await applyTenantLifecycleTombstones(config, db);
    return { ...result, changed: result.changed || suppressed.removed.length > 0 };
  } catch (error) { throw safeFailure(error); }
  finally { if (db) try { await db.close(); } catch { throw registryError(); } }
}
