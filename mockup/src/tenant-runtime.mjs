import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { readSettings } from './database.mjs';
import { failure } from './security.mjs';

const blockedStates = new Set(['deleting', 'attention', 'deleted']);
const unavailable = () => Object.assign(failure(410, 'Este negócio está em processo de exclusão ou já foi encerrado. Fale com a Raelapps.'), { code: 'TENANT_RETIRED' });
const occupied = () => Object.assign(failure(409, 'Ainda existem operações do negócio em andamento. Aguarde e confira a exclusão novamente.'), { code: 'TENANT_BUSY' });

// Each operation holds a durable lease across await/provider calls. A committed
// deletion intent fences new work in every Node worker, then waits for holders.
// Expiration alone NEVER proves that an operation stopped. Orphans are removed
// only when the owning PID is proven absent on this same host.
export function createTenantRuntime({ config, database, now = () => Date.now(), pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const context = new AsyncLocalStorage(), instance = randomUUID(), host = hostname();
  const wrappers = new WeakMap(), dbWrappers = new WeakMap(), active = new Set();
  const enabled = slug => Boolean(config.enabled && config.operations?.tenant && slug !== config.operations.tenant);
  const bypass = slug => context.getStore()?.bypass?.has(slug);
  async function lifecycle(slug) {
    if (!enabled(slug)) return null;
    const db = await database();
    const [row] = await db.query('SELECT * FROM tenant_lifecycle WHERE slug = ?', [slug]);
    return row ?? null;
  }
  async function check(slug) { const row = await lifecycle(slug); if (blockedStates.has(row?.state) && !bypass(slug)) throw unavailable(); return row; }
  async function withTenant(slug, work) {
    if (!enabled(slug) || bypass(slug) || context.getStore()?.held?.has(slug)) return work();
    const db = await database(), token = randomUUID(), at = now();
    await db.transaction(async tx => {
      await readSettings(tx, true);
      const [row] = await tx.query('SELECT state FROM tenant_lifecycle WHERE slug = ?', [slug]);
      if (blockedStates.has(row?.state)) throw unavailable();
      await tx.query('INSERT INTO tenant_runtime_leases(token,slug,instance_id,host,pid,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,?)', [token, slug, instance, host, process.pid, at, at, at + 120000]);
    });
    active.add(token);
    let heartbeatRunning = false;
    const heartbeat = setInterval(async () => {
      if (heartbeatRunning) return;
      heartbeatRunning = true;
      try { const at = now(); await db.query('UPDATE tenant_runtime_leases SET updated_at = ?, expires_at = ? WHERE token = ? AND instance_id = ?', [at, at + 120000, token, instance]); }
      catch { /* A missing heartbeat cannot authorize deletion; the row stays. */ }
      finally { heartbeatRunning = false; }
    }, 10000);
    heartbeat.unref?.();
    const held = new Set(context.getStore()?.held ?? []); held.add(slug);
    try { return await context.run({ ...context.getStore(), held }, work); }
    finally {
      clearInterval(heartbeat); active.delete(token);
      try { await db.query('DELETE FROM tenant_runtime_leases WHERE token = ? AND instance_id = ?', [token, instance]); }
      catch { /* Fail closed for removal until an operator checks the lease. */ }
    }
  }
  function wrap(slug, object) {
    if (!object || typeof object !== 'object') return object;
    let bySlug = wrappers.get(object); if (!bySlug) { bySlug = new Map(); wrappers.set(object, bySlug); }
    if (bySlug.has(slug)) return bySlug.get(slug);
    const functions = new Map();
    const proxy = new Proxy(object, { get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value === 'function') {
        // Synchronous contracts (userView, csrf validation, configured) retain
        // their synchronous shape; every exported asynchronous action is gated.
        if (functions.get(property)?.value !== value) functions.set(property, { value, callable: value.constructor?.name === 'AsyncFunction'
          ? (...args) => withTenant(slug, () => Reflect.apply(value, target, args))
          : value.bind(target) });
        return functions.get(property).callable;
      }
      return value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype ? wrap(slug, value) : value;
    } });
    bySlug.set(slug, proxy); return proxy;
  }
  function wrapDatabase(slug, db) {
    if (!enabled(slug)) return db;
    let bySlug = dbWrappers.get(db); if (!bySlug) { bySlug = new Map(); dbWrappers.set(db, bySlug); }
    if (!bySlug.has(slug)) bySlug.set(slug, { ...db, query: (...args) => withTenant(slug, () => db.query(...args)), transaction: (...args) => withTenant(slug, () => db.transaction(...args)) });
    return bySlug.get(slug);
  }
  async function withTenantQuiesced(slug, work) {
    if (!enabled(slug)) throw failure(403, 'A conta central da Raelapps não pode ser excluída.');
    if (context.getStore()?.held?.has(slug)) throw occupied();
    const db = await database(), intent = await lifecycle(slug);
    if (!blockedStates.has(intent?.state)) throw failure(409, 'Registre a intenção de exclusão antes de isolar o negócio.');
    const started = now();
    while (true) {
      const rows = await db.query('SELECT token,host,pid,instance_id,expires_at FROM tenant_runtime_leases WHERE slug = ?', [slug]);
      let remaining = 0;
      for (const row of rows) {
        let absent = false;
        if (row.host === host && Number.isInteger(Number(row.pid)) && Number(row.pid) > 0 && Number(row.pid) !== process.pid) {
          try { process.kill(Number(row.pid), 0); }
          catch (error) { absent = error.code === 'ESRCH'; }
        }
        if (absent) await db.query('DELETE FROM tenant_runtime_leases WHERE token = ? AND instance_id = ?', [row.token, row.instance_id]);
        else remaining++;
      }
      if (!remaining) break;
      if (now() - started >= 15000) throw occupied();
      await pause(100);
    }
    const allowed = new Set(context.getStore()?.bypass ?? []); allowed.add(slug);
    return context.run({ ...context.getStore(), bypass: allowed }, work);
  }
  async function close() {
    if (!config.operations?.tenant) return;
    try { const db = await database(); if (!active.size) await db.query('DELETE FROM tenant_runtime_leases WHERE instance_id = ?', [instance]); }
    catch { /* A shutdown must not change a deletion decision. */ }
  }
  return { lifecycle, check, withTenant, wrap, wrapDatabase, withTenantQuiesced, close };
}
