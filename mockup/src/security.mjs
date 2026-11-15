import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
const passwordCapacityError = () => failure(503, 'O acesso está temporariamente ocupado. Aguarde alguns segundos e tente novamente.');

// Password work shares one bounded budget across all tenants in this process.
// A queued request that times out never starts expensive work later.
export function createPasswordWorkLimiter({ concurrency = 2, maxQueued = 16, timeoutMs = 3000 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(maxQueued) || maxQueued < 0 || !Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('Capacidade de senhas inválida.');
  let running = 0;
  const queue = [];
  async function execute(task) {
    running++;
    try { return await task(); }
    finally {
      running--;
      while (running < concurrency && queue.length) {
        const next = queue.shift(); clearTimeout(next.timer);
        execute(next.task).then(next.resolve, next.reject);
      }
    }
  }
  return task => {
    if (running < concurrency) return execute(task);
    if (queue.length >= maxQueued) return Promise.reject(passwordCapacityError());
    return new Promise((resolve, reject) => {
      const item = { task, resolve, reject, timer: null };
      item.timer = setTimeout(() => {
        const index = queue.indexOf(item);
        if (index !== -1) { queue.splice(index, 1); reject(passwordCapacityError()); }
      }, timeoutMs);
      queue.push(item);
    });
  };
}
const passwordWork = createPasswordWorkLimiter();
export const token = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');
export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw Object.assign(new Error('Use uma senha com 8 a 128 caracteres.'), { status: 422 });
  const salt = randomBytes(16).toString('hex');
  const key = await passwordWork(() => scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }));
  return `scrypt:32768:8:1:${salt}:${key.toString('hex')}`;
}
export async function checkPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const parts = String(stored ?? '').split(':');
  if (parts.length !== 6 || parts.slice(0, 4).join(':') !== 'scrypt:32768:8:1') return false;
  const key = await passwordWork(() => scrypt(password, parts[4], 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }));
  return equal(key.toString('hex'), parts[5]);
}
export const normalizeEmail = value => String(value ?? '').trim().toLowerCase();
export const isEmail = value => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
export const failure = (status, message) => Object.assign(new Error(message), { status });
// Durable per-business budget shared by login, registration and password reset.
// Do not use an unverified forwarded IP: shared hosting may expose one proxy IP.
export const passwordAttempt = db => rateLimit(db, 'password_work:minute', 60, 60000);
export async function rateLimit(db, scope, limit = 8, windowMs = 15 * 60 * 1000) {
  const key = digest(scope), now = Date.now();
  await db.transaction(async tx => {
    await tx.query('SELECT id FROM business_settings WHERE id = 1' + tx.lock);
    const [row] = await tx.query('SELECT * FROM auth_attempts WHERE attempt_key = ?' + tx.lock, [key]);
    if (!row) {
      await tx.query('INSERT INTO auth_attempts(attempt_key, hits, window_start) VALUES (?, ?, ?)', [key, 1, now]);
    } else if (now - Number(row.window_start) >= windowMs) {
      await tx.query('UPDATE auth_attempts SET hits = ?, window_start = ? WHERE attempt_key = ?', [1, now, key]);
    } else {
      if (Number(row.hits) >= limit) throw failure(429, 'Muitas tentativas. Aguarde alguns minutos e tente novamente.');
      await tx.query('UPDATE auth_attempts SET hits = hits + 1 WHERE attempt_key = ?', [key]);
    }
    await tx.query('DELETE FROM auth_attempts WHERE window_start < ?', [now - 48 * 60 * 60 * 1000]);
  });
}
