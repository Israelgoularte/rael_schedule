import { stat } from 'node:fs/promises';
import { failure } from './security.mjs';

export const publicShareRecordQuery = "SELECT s.published_json, i.version, i.image_base64 FROM business_settings s LEFT JOIN business_images i ON i.image_key = 'logo' WHERE s.id = 1";
const capacityError = () => Object.assign(failure(503, 'A prévia do negócio está temporariamente ocupada. Aguarde alguns segundos e tente novamente.'), { code: 'SHARE_PREVIEW_BUSY' });

// This budget belongs only to cold public preview reads. It never consumes the
// password-work budget, and caps additional connections across all tenants.
export function createPublicShareReadLimiter({ concurrency = 2, maxQueued = 16, timeoutMs = 3000 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(maxQueued) || maxQueued < 0 || !Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('Capacidade de prévias inválida.');
  let running = 0;
  const queue = [];
  async function execute(task) {
    running++;
    try { return await task(); }
    finally {
      running--;
      while (running < concurrency && queue.length) {
        const next = queue.shift();
        clearTimeout(next.timer);
        execute(next.task).then(next.resolve, next.reject);
      }
    }
  }
  return task => {
    if (running < concurrency) return execute(task);
    if (queue.length >= maxQueued) return Promise.reject(capacityError());
    return new Promise((resolve, reject) => {
      const item = { task, resolve, reject, timer: null };
      item.timer = setTimeout(() => {
        const index = queue.indexOf(item);
        if (index !== -1) { queue.splice(index, 1); reject(capacityError()); }
      }, timeoutMs);
      queue.push(item);
    });
  };
}
const coldShareReadWork = createPublicShareReadLimiter();

// Never migrate, provision, or initialize a license for a sharing crawler.
export async function readExistingPublicShareRecord(entry) {
  if (entry.driver === 'sqlite') {
    try { if (!(await stat(entry.path)).isFile()) return null; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const { DatabaseSync } = await import('node:sqlite');
    const connection = new DatabaseSync(entry.path, { readOnly: true, timeout: 1000 });
    try { return connection.prepare(publicShareRecordQuery).get() ?? null; }
    finally { connection.close(); }
  }
  if (entry.driver !== 'mysql') throw new Error('Banco da prévia inválido.');
  const { createConnection } = await import('mysql2/promise');
  const connection = await createConnection({ host: entry.host, port: entry.port ?? 3306, user: entry.user, password: entry.password, database: entry.database, charset: 'utf8mb4', connectTimeout: 3000, multipleStatements: false, ...(entry.ssl ? { ssl: { rejectUnauthorized: true, ...(entry.ca ? { ca: entry.ca } : {}) } } : {}) });
  try { const [rows] = await connection.execute({ sql: publicShareRecordQuery, timeout: 3000 }); return rows[0] ?? null; }
  finally { connection.destroy(); }
}

export function createPublicShareReader({ readRecord = readExistingPublicShareRecord, work = coldShareReadWork } = {}) {
  const inFlight = new Map();
  return (slug, entry) => {
    if (inFlight.has(slug)) return inFlight.get(slug);
    // One row includes the published identity and logo. Concurrent HTML and
    // image requests can therefore share a single cold read for this tenant.
    const pending = work(() => readRecord(entry));
    inFlight.set(slug, pending);
    const clear = () => { if (inFlight.get(slug) === pending) inFlight.delete(slug); };
    pending.then(clear, clear);
    // Only in-flight work is shared. A later request reads the current version
    // immediately, including logo removal and a newly published business name.
    return pending;
  };
}
