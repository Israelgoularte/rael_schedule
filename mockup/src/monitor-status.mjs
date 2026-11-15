import { readFile, writeFile, mkdir, rename, realpath, lstat, open, unlink } from 'node:fs/promises';
import { dirname, resolve, join, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';

const applicationRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
const inside = (path, root) => fold(path) === fold(root) || fold(path).startsWith(fold(root) + sep);
const same = (a, b) => fold(a) === fold(b);
const allowedChecks = new Set(['ok', 'failed', 'degraded', 'stale', 'warning', 'waiting', 'disabled', 'not_configured', 'unavailable', 'missing_success', 'invalid', 'stuck', 'unknown']);
const isIso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const format = 'rael-monitor-status';
const signature = (value, token) => createHmac('sha256', token).update('rael-monitor-status-v1\0').update(JSON.stringify(value)).digest('hex');
function invalid() { throw new Error('Destino privado de monitoramento inválido.'); }
async function info(path) { try { return await lstat(path); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; } }
async function canonical(path) {
  const absolute = resolve(path); let cursor = absolute; const suffix = [];
  while (true) {
    try { return join(await realpath(cursor), ...suffix); }
    catch (error) { if (error.code !== 'ENOENT') throw error; const parent = dirname(cursor); if (parent === cursor) throw error; suffix.unshift(basename(cursor)); cursor = parent; }
  }
}
async function rejectSymlinks(path) {
  let cursor = resolve(path);
  while (true) { const details = await info(cursor); if (details?.isSymbolicLink()) invalid(); const parent = dirname(cursor); if (parent === cursor) break; cursor = parent; }
}
async function privateLocation(path) {
  const absolute = resolve(path), actual = await canonical(absolute), appReal = await canonical(applicationRoot);
  const unsafe = value => inside(value, applicationRoot) || inside(value, appReal) || value.split(/[\\/]+/).some(part => ['dist', 'public_html', 'htdocs', 'wwwroot', 'www', 'public'].includes(part.toLowerCase()));
  if (unsafe(absolute) || unsafe(actual)) invalid();
  await rejectSymlinks(absolute); return actual;
}
function envFiles(execArgs) {
  const files = [];
  for (let i = 0; i < execArgs.length; i++) {
    if (/^--env-file(?:-if-exists)?=/.test(execArgs[i])) files.push(execArgs[i].slice(execArgs[i].indexOf('=') + 1));
    else if (/^--env-file(?:-if-exists)?$/.test(execArgs[i]) && execArgs[i + 1]) files.push(execArgs[++i]);
  }
  return files;
}
async function protectedLocations(env, execArgs) {
  const files = [], directories = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || typeof value !== 'string' || name === 'RAEL_MONITOR_STATUS_FILE' || name === 'RAEL_MONITOR_DIRECTORY') continue;
    if (/^RAEL_.*(?:_FILE|_PATH)$/.test(name)) files.push(value);
    if (/^RAEL_.*(?:_DIRECTORY|_DIR|_ROOT)$/.test(name)) directories.push(value);
  }
  const environmentFiles = [...envFiles(execArgs), ...['RAEL_ENV_FILE', 'RAEL_CONFIG_FILE'].map(key => env[key]).filter(Boolean)];
  files.push(...environmentFiles);
  // The hPanel configuration directory is never a status destination.
  directories.push(...environmentFiles.map(file => dirname(resolve(file))));
  if (env.RAEL_BACKUP_STATUS_FILE) directories.push(dirname(resolve(env.RAEL_BACKUP_STATUS_FILE)));
  let tenants = {};
  if (env.RAEL_TENANTS_JSON) tenants = JSON.parse(env.RAEL_TENANTS_JSON);
  else if (env.RAEL_TENANTS_FILE) {
    const details = await info(env.RAEL_TENANTS_FILE);
    if (details) { if (!details.isFile() || details.isSymbolicLink() || details.size > 8 * 1024 * 1024) invalid(); tenants = JSON.parse(await readFile(env.RAEL_TENANTS_FILE, 'utf8')); }
  }
  if (!tenants || typeof tenants !== 'object' || Array.isArray(tenants)) invalid();
  for (const entry of Object.values(tenants)) if (entry?.driver === 'sqlite' && typeof entry.path === 'string') files.push(entry.path, entry.path + '-wal', entry.path + '-shm');
  return { files: await Promise.all(files.map(canonical)), directories: await Promise.all(directories.map(canonical)) };
}
function validStatus(value, token) {
  const keys = ['format', 'version', 'state', 'httpStatus', 'checks', 'checkedAt', 'lastSuccessfulAt', 'consecutiveFailures', 'authentication'];
  if (!value || Object.keys(value).sort().join(',') !== keys.sort().join(',') || value.format !== format || value.version !== 1 || !['ok', 'failed'].includes(value.state) || !(value.httpStatus === null || Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) || !value.checks || Object.keys(value.checks).sort().join(',') !== 'backup,database,maintenance' || !Object.values(value.checks).every(v => allowedChecks.has(v)) || !isIso(value.checkedAt) || value.lastSuccessfulAt !== null && !isIso(value.lastSuccessfulAt) || !Number.isSafeInteger(value.consecutiveFailures) || value.consecutiveFailures < 0 || value.consecutiveFailures > 1000000 || value.state === 'ok' && (value.consecutiveFailures !== 0 || value.lastSuccessfulAt !== value.checkedAt) || value.state === 'failed' && value.consecutiveFailures < 1 || !/^[a-f0-9]{64}$/.test(value.authentication ?? '')) return false;
  const { authentication, ...unsigned } = value;
  return timingSafeEqual(Buffer.from(authentication, 'hex'), Buffer.from(signature(unsigned, token), 'hex'));
}
export async function writeMonitorStatus({ path, env, token, result, checkedAt, execArgs = process.execArgv }) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 256 || /\s/.test(token)) invalid();
  if (!['status.json', 'monitor-status.json'].includes(basename(path).toLowerCase())) invalid();
  const destination = await privateLocation(path), parent = dirname(destination);
  if (parent === dirname(parent)) invalid();
  if (env.RAEL_MONITOR_DIRECTORY) { const root = await privateLocation(env.RAEL_MONITOR_DIRECTORY); if (!inside(destination, root) || same(destination, root)) invalid(); }
  const protectedPaths = await protectedLocations(env, execArgs);
  if (protectedPaths.files.some(file => same(file, destination)) || protectedPaths.directories.some(dir => inside(destination, dir))) invalid();
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await rejectSymlinks(path);
  const lockPath = destination + '.lock';
  const lock = await open(lockPath, 'wx', 0o600);
  let temporary;
  try {
    const previousInfo = await info(destination); let prior = null, previousBytes = null;
    if (previousInfo) {
      if (!previousInfo.isFile() || previousInfo.isSymbolicLink() || previousInfo.nlink !== 1 || previousInfo.size > 16384 || process.platform !== 'win32' && (previousInfo.mode & 0o077)) invalid();
      previousBytes = await readFile(destination); prior = JSON.parse(previousBytes.toString('utf8'));
      if (!validStatus(prior, token)) invalid();
    }
    const unsigned = { format, version: 1, ...result, checkedAt, lastSuccessfulAt: result.state === 'ok' ? checkedAt : prior?.lastSuccessfulAt ?? null, consecutiveFailures: result.state === 'failed' ? Math.min(1000000, (prior?.consecutiveFailures ?? 0) + 1) : 0 };
    const stored = { ...unsigned, authentication: signature(unsigned, token) };
    if (!validStatus(stored, token)) invalid();
    temporary = join(parent, '.monitor-writing-' + randomUUID());
    await writeFile(temporary, JSON.stringify(stored) + '\n', { flag: 'wx', mode: 0o600 });
    // Recheck the target and its ancestors immediately before replacing our own status.
    await rejectSymlinks(path);
    const currentInfo = await info(destination);
    if (previousInfo ? !currentInfo || currentInfo.ino !== previousInfo.ino || currentInfo.dev !== previousInfo.dev || currentInfo.nlink !== 1 || !(await readFile(destination)).equals(previousBytes) : currentInfo) invalid();
    await rename(temporary, destination); temporary = null;
    return { stored, prior };
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
    await lock.close(); await unlink(lockPath);
  }
}
