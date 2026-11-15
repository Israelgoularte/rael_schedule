import { readFile, writeFile, mkdir, readdir, lstat, open, rename, unlink } from 'node:fs/promises';
import { resolve, dirname, join, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { verifyBackupRun, readBackupKey, privateLocation } from './backup-job.mjs';
import { isMainModule } from '../src/cli-entry.mjs';

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_BACKUP_LIMITS = Object.freeze({ maxDurationMs: 26 * 60_000, requestTimeoutMs: 60_000, maxFileBytes: 64 * 1024 * 1024, maxBatchBytes: 256 * 1024 * 1024, multipartBytes: 5 * 1024 * 1024, maxFiles: 998 });
const applicationRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const api = 'https://www.googleapis.com';
const runPattern = /^run-\d{8}T\d{6}Z-[a-f0-9]{12}$/;
const idPattern = /^[A-Za-z0-9_-]{10,200}$/;
const hex = /^[a-f0-9]{64}$/;
const markerName = '.rael-drive-backup.json';
const lockName = '.drive-backup.lock';
const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
const inside = (path, parent) => fold(path) === fold(parent) || fold(path).startsWith(fold(parent) + sep);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const isIso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const knownCodes = new Set(['DRIVE_INVALID_CONFIG', 'DRIVE_SCOPE', 'DRIVE_ACCOUNT', 'DRIVE_PRIVATE_FOLDER', 'DRIVE_REMOTE_MISMATCH', 'DRIVE_REMOTE_CONTENT', 'DRIVE_HTTP', 'DRIVE_AUTH', 'DRIVE_PERMISSION', 'DRIVE_REDIRECT', 'DRIVE_TRANSPORT', 'DRIVE_TIMEOUT', 'DRIVE_DEADLINE', 'DRIVE_LIMIT', 'DRIVE_INVALID_BACKUP', 'DRIVE_LOCAL_CHANGED', 'DRIVE_UNSAFE_PATH', 'DRIVE_UNSAFE_STATE', 'DRIVE_STATE_CHANGED', 'DRIVE_LOCKED', 'DRIVE_LOCAL_IO', 'DRIVE_ARGUMENTS']);
function failure(code) { return Object.assign(new Error(`Cópia cifrada não concluída (${code}).`), { code }); }
function sanitize(error) { return failure(knownCodes.has(error?.code) ? error.code : 'DRIVE_LOCAL_IO'); }
function requireValue(condition, code) { if (!condition) throw failure(code); }
async function info(path) { try { return await lstat(path); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; } }
async function noLinks(path) {
  let current = resolve(path);
  while (true) {
    const details = await info(current); requireValue(!details?.isSymbolicLink(), 'DRIVE_UNSAFE_PATH');
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}
async function privatePath(path) {
  requireValue(typeof path === 'string' && path.trim().length > 0, 'DRIVE_UNSAFE_PATH');
  await noLinks(path);
  let actual; try { actual = await privateLocation(path); } catch { throw failure('DRIVE_UNSAFE_PATH'); }
  requireValue(!inside(actual, applicationRoot) && !actual.split(/[\\/]+/).some(part => ['public', 'www'].includes(part.toLowerCase())), 'DRIVE_UNSAFE_PATH');
  return actual;
}
async function regular(path, maximum, privateMode = false) {
  await noLinks(path); const details = await lstat(path);
  requireValue(details.isFile() && !details.isSymbolicLink() && details.nlink === 1 && details.size <= maximum && (!privateMode || process.platform === 'win32' || !(details.mode & 0o077)), 'DRIVE_UNSAFE_STATE');
  return details;
}
function signature(value, key, domain) { return createHmac('sha256', Buffer.from(key, 'hex')).update(`rael-drive-backup-${domain}-v1\0`).update(JSON.stringify(value)).digest('hex'); }
function signed(value, key, domain) { return { ...value, authentication: signature(value, key, domain) }; }
function validSignature(value, key, domain) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !hex.test(value.authentication ?? '')) return false;
  const { authentication, ...unsigned } = value;
  return timingSafeEqual(Buffer.from(authentication, 'hex'), Buffer.from(signature(unsigned, key, domain), 'hex'));
}
function exactKeys(value, keys) { return value && Object.keys(value).sort().join(',') === [...keys, 'authentication'].sort().join(','); }
async function readSigned(path, key, domain, validate) {
  const details = await info(path); if (!details) return null;
  await regular(path, 1024 * 1024, true);
  const bytes = await readFile(path); let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw failure('DRIVE_UNSAFE_STATE'); }
  requireValue(validSignature(value, key, domain) && validate(value), 'DRIVE_UNSAFE_STATE');
  return { value, bytes, details };
}
async function atomicSigned(path, value, key, domain, previous) {
  const parent = dirname(path); await noLinks(parent);
  const current = await info(path);
  if (previous) requireValue(current && current.ino === previous.details.ino && current.dev === previous.details.dev && current.nlink === 1 && (await readFile(path)).equals(previous.bytes), 'DRIVE_STATE_CHANGED');
  else requireValue(!current, 'DRIVE_STATE_CHANGED');
  const bytes = Buffer.from(JSON.stringify(signed(value, key, domain)) + '\n');
  const temporary = join(parent, '.drive-writing-' + randomUUID()); let handle;
  try {
    handle = await open(temporary, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    await noLinks(path); const beforeReplace = await info(path);
    if (previous) requireValue(beforeReplace && beforeReplace.ino === previous.details.ino && beforeReplace.dev === previous.details.dev && beforeReplace.nlink === 1 && (await readFile(path)).equals(previous.bytes), 'DRIVE_STATE_CHANGED');
    else requireValue(!beforeReplace, 'DRIVE_STATE_CHANGED');
    await rename(temporary, path);
    // Sync the containing directory where supported, so an ID reservation is durable before POST.
    if (process.platform !== 'win32') { const directory = await open(parent, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
    return { value: signed(value, key, domain), bytes, details: await lstat(path) };
  } finally { if (handle) await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}
function settingsFrom(value) {
  let settings = value; if (typeof value === 'string') { try { settings = JSON.parse(value); } catch { throw failure('DRIVE_INVALID_CONFIG'); } }
  const keys = ['clientId', 'clientSecret', 'refreshToken', 'folderId', 'expectedEmail'];
  requireValue(settings && typeof settings === 'object' && !Array.isArray(settings) && Object.keys(settings).sort().join(',') === keys.sort().join(','), 'DRIVE_INVALID_CONFIG');
  requireValue(typeof settings.clientId === 'string' && /^[A-Za-z0-9._-]{8,250}\.apps\.googleusercontent\.com$/.test(settings.clientId) && typeof settings.clientSecret === 'string' && /^[A-Za-z0-9_-]{8,250}$/.test(settings.clientSecret) && typeof settings.refreshToken === 'string' && /^[A-Za-z0-9._~+\/=-]{12,4096}$/.test(settings.refreshToken) && idPattern.test(settings.folderId ?? '') && typeof settings.expectedEmail === 'string' && /^[^\s@]{1,128}@[^\s@]{1,128}\.[^\s@]{2,64}$/.test(settings.expectedEmail), 'DRIVE_INVALID_CONFIG');
  return { ...settings, expectedEmail: settings.expectedEmail.toLowerCase() };
}
function limit(value, maximum) { requireValue(Number.isSafeInteger(value) && value > 0 && value <= maximum, 'DRIVE_LIMIT'); return value; }
function guardedUrl(value, oauth = false, resumable = false) {
  let url; try { url = new URL(value); } catch { throw failure('DRIVE_REDIRECT'); }
  const safeBase = url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash;
  const safePath = oauth ? url.hostname === 'oauth2.googleapis.com' && ['/token', '/tokeninfo'].includes(url.pathname) && !url.search
    : url.hostname === 'www.googleapis.com' && (resumable ? url.pathname === '/upload/drive/v3/files' && [...url.searchParams.keys()].every(key => ['uploadType', 'upload_id', 'fields', 'alt'].includes(key)) && url.searchParams.getAll('upload_id').length === 1 && /^[A-Za-z0-9._~-]{1,2000}$/.test(url.searchParams.get('upload_id')) && (!url.searchParams.has('uploadType') || url.searchParams.get('uploadType') === 'resumable')
      : /^\/drive\/v3\/(?:about|files(?:\/[A-Za-z0-9_-]+)?(?:\/permissions)?)$/.test(url.pathname) || url.pathname === '/upload/drive/v3/files');
  requireValue(safeBase && safePath, 'DRIVE_REDIRECT'); return url.href;
}
async function responseBytes(response, maximum, hashOnly = false) {
  const length = response.headers?.get?.('content-length');
  requireValue(length == null || /^\d+$/.test(length) && Number(length) <= maximum, 'DRIVE_REMOTE_CONTENT');
  let size = 0; const chunks = [], hash = createHash('sha256');
  if (!response.body) return hashOnly ? { bytes: 0, sha256: hash.digest('hex') } : Buffer.alloc(0);
  const stream = response.body;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      requireValue(size <= maximum, 'DRIVE_REMOTE_CONTENT'); hash.update(bytes); if (!hashOnly) chunks.push(bytes);
    }
  } catch (error) { try { await stream.cancel?.(); } catch {} throw error; }
  return hashOnly ? { bytes: size, sha256: hash.digest('hex') } : Buffer.concat(chunks, size);
}
function transport({ fetchImpl, now, deadline, requestTimeoutMs }) {
  const check = () => requireValue(now() < deadline, 'DRIVE_DEADLINE');
  async function timed(operation) {
    check(); const remaining = deadline - now(), duration = Math.min(requestTimeoutMs, remaining), controller = new AbortController();
    let timer;
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure(remaining <= requestTimeoutMs ? 'DRIVE_DEADLINE' : 'DRIVE_TIMEOUT')); }, duration); });
      const result = await Promise.race([operation(controller.signal), timeout]); check(); return result;
    } catch (error) { throw knownCodes.has(error?.code) ? error : failure('DRIVE_TRANSPORT'); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  async function request(url, { method = 'GET', headers = {}, body, oauth = false, resumable = false, allow = [], media } = {}) {
    const target = guardedUrl(url, oauth, resumable);
    return timed(async signal => {
      const response = await fetchImpl(target, { method, headers, body, signal, redirect: 'error' });
      requireValue(!response.redirected && (response.status < 300 || response.status >= 400), 'DRIVE_REDIRECT');
      if (response.url) guardedUrl(response.url, oauth, resumable);
      if (!response.ok && !allow.includes(response.status)) {
        // Never read or expose Google error bodies, which can contain request details.
        await response.body?.cancel?.().catch(() => {});
        throw failure(response.status === 401 ? 'DRIVE_AUTH' : response.status === 403 ? 'DRIVE_PERMISSION' : 'DRIVE_HTTP');
      }
      if (!response.ok) { await response.body?.cancel?.().catch(() => {}); return { status: response.status, data: null, headers: response.headers }; }
      if (media) return { status: response.status, data: await responseBytes(response, media.bytes, true), headers: response.headers };
      const bytes = await responseBytes(response, 256 * 1024); let data = null;
      if (bytes.length) { try { data = JSON.parse(bytes.toString('utf8')); } catch { throw failure('DRIVE_HTTP'); } }
      return { status: response.status, data, headers: response.headers };
    });
  }
  return { check, timed, request };
}

// The official OAuth client performs refresh/token-info only through the same
// fixed-origin, no-redirect, deadline-limited transporter used for file requests.
export async function googleDriveToken(settings, { request }) {
  const { OAuth2Client } = await import('google-auth-library');
  const client = new OAuth2Client({ clientId: settings.clientId, clientSecret: settings.clientSecret, credentials: { refresh_token: settings.refreshToken }, useAuthRequestParameters: false, transporter: { async request(options) {
    requireValue(options.method === 'POST', 'DRIVE_AUTH');
    const result = await request(options.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...Object.fromEntries(new Headers(options.headers ?? {})) }, body: options.data?.toString(), oauth: true });
    return { data: result.data, status: result.status, headers: result.headers };
  } } });
  const { token } = await client.getAccessToken();
  const details = await client.getTokenInfo(token);
  return { token, scopes: details.scopes };
}

async function localBatch(runDirectory, key, limits) {
  const directory = await privatePath(runDirectory), details = await lstat(directory);
  requireValue(details.isDirectory() && runPattern.test(basename(directory)), 'DRIVE_INVALID_BACKUP');
  const names = await readdir(directory); requireValue(names.length >= 3 && names.length <= limits.maxFiles, 'DRIVE_LIMIT');
  let total = 0; const identities = new Map();
  for (const name of names) {
    requireValue(/^[a-z0-9][a-z0-9.-]{1,100}$/.test(name) && basename(name) === name, 'DRIVE_INVALID_BACKUP');
    const stat = await regular(join(directory, name), Number.MAX_SAFE_INTEGER); total += stat.size;
    requireValue(stat.size > 0 && stat.size <= limits.maxFileBytes && total <= limits.maxBatchBytes, 'DRIVE_LIMIT');
    identities.set(name, { dev: stat.dev, ino: stat.ino });
  }
  let verified; try { verified = await verifyBackupRun(directory, key); } catch { throw failure('DRIVE_INVALID_BACKUP'); }
  const expected = [...verified.manifest.tenants, verified.manifest.configuration];
  const manifest = await readFile(join(directory, 'manifest.json'));
  const files = [...expected.map(item => ({ name: item.file, bytes: item.bytes, sha256: item.sha256 })), { name: 'manifest.json', bytes: manifest.length, sha256: sha256(manifest) }];
  const byName = new Map(files.map(file => [file.name, file])), expectedNames = new Set(byName.keys());
  // The decrypted vault returned by verification is intentionally not retained.
  verified = null;
  async function checkedBytes(file) {
    const path = join(directory, file.name), identity = identities.get(file.name);
    const sameFile = stat => identity && stat.dev === identity.dev && stat.ino === identity.ino && stat.isFile() && stat.nlink === 1 && stat.size === file.bytes;
    requireValue(sameFile(await regular(path, limits.maxFileBytes)), 'DRIVE_LOCAL_CHANGED');
    const handle = await open(path, 'r');
    try {
      requireValue(sameFile(await handle.stat()), 'DRIVE_LOCAL_CHANGED');
      const bytes = await handle.readFile();
      requireValue(sameFile(await handle.stat()) && bytes.length === file.bytes && sha256(bytes) === file.sha256, 'DRIVE_LOCAL_CHANGED');
      requireValue(sameFile(await regular(path, limits.maxFileBytes)), 'DRIVE_LOCAL_CHANGED');
      return bytes;
    } finally { await handle.close(); }
  }
  async function unchanged(target) {
    await noLinks(directory); const current = await readdir(directory);
    requireValue(current.length === expectedNames.size && current.every(name => expectedNames.has(name)), 'DRIVE_LOCAL_CHANGED');
    if (target) {
      const file = byName.get(target.name);
      requireValue(file && file.bytes === target.bytes && file.sha256 === target.sha256, 'DRIVE_LOCAL_CHANGED');
      return checkedBytes(file);
    }
    for (const file of files) await checkedBytes(file);
  }
  await unchanged();
  return { directory, runId: basename(directory), files, bytes: total, manifestHash: sha256(manifest), unchanged };
}
async function prepareState(directory, { run, key, binding, env, keyFile }) {
  const root = await privatePath(directory);
  requireValue(!inside(root, run.directory) && !inside(run.directory, root) && (!keyFile || !inside(await privatePath(keyFile), root)), 'DRIVE_UNSAFE_PATH');
  // Do not allow a dedicated state directory to claim the private environment/configuration directory.
  for (const [name, value] of Object.entries(env)) if (typeof value === 'string' && value && /^RAEL_.*(?:_FILE|_PATH)$/.test(name) && !['RAEL_DRIVE_BACKUP_STATE_DIRECTORY'].includes(name)) {
    const protectedPath = await privatePath(value); requireValue(!inside(protectedPath, root), 'DRIVE_UNSAFE_PATH');
  }
  await mkdir(root, { recursive: true, mode: 0o700 }); await noLinks(directory);
  const stat = await lstat(root); requireValue(stat.isDirectory() && (process.platform === 'win32' || !(stat.mode & 0o077)), 'DRIVE_UNSAFE_PATH');
  const lockPath = join(root, lockName); let lock;
  try { lock = await open(lockPath, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw failure('DRIVE_LOCKED'); throw error; }
  const lockedInfo = await lock.stat();
  async function release() {
    await lock.close();
    const current = await info(lockPath);
    if (current && current.ino === lockedInfo.ino && current.dev === lockedInfo.dev && !current.isSymbolicLink()) await unlink(lockPath);
  }
  try {
    const markerPath = join(root, markerName);
    let marker = await readSigned(markerPath, key, 'root', value => exactKeys(value, ['format', 'version', 'binding']) && value.format === 'rael-drive-backup-root' && value.version === 1 && value.binding === binding);
    if (!marker) {
      requireValue((await readdir(root)).every(name => name === lockName), 'DRIVE_UNSAFE_STATE');
      marker = await atomicSigned(markerPath, { format: 'rael-drive-backup-root', version: 1, binding }, key, 'root', null);
    }
    return { root, release };
  } catch (error) { await release(); throw error; }
}
function statusValid(value, binding) {
  return exactKeys(value, ['format', 'version', 'binding', 'state', 'jobId', 'startedAt', 'completedAt', 'lastSuccessfulAt', 'lastSuccessfulJobId', 'fileCount', 'verifiedFiles', 'totalBytes', 'errorCode']) && value.format === 'rael-drive-backup-status' && value.version === 1 && value.binding === binding && ['running', 'ok', 'failed'].includes(value.state) && runPattern.test(value.jobId ?? '') && isIso(value.startedAt) && (value.completedAt === null || isIso(value.completedAt)) && (value.lastSuccessfulAt === null || isIso(value.lastSuccessfulAt)) && (value.lastSuccessfulJobId === null || runPattern.test(value.lastSuccessfulJobId)) && Number.isSafeInteger(value.fileCount) && value.fileCount >= 3 && Number.isSafeInteger(value.verifiedFiles) && value.verifiedFiles >= 0 && value.verifiedFiles <= value.fileCount && Number.isSafeInteger(value.totalBytes) && value.totalBytes > 0 && (value.errorCode === null || knownCodes.has(value.errorCode));
}
function stateValid(value, run, binding, folderId) {
  if (!exactKeys(value, ['format', 'version', 'binding', 'runId', 'rootFolderId', 'manifestSha256', 'folderId', 'files', 'createdAt', 'completedAt']) || value.format !== 'rael-drive-backup-state' || value.version !== 1 || value.binding !== binding || value.runId !== run.runId || value.rootFolderId !== folderId || value.manifestSha256 !== run.manifestHash || !idPattern.test(value.folderId ?? '') || !isIso(value.createdAt) || value.completedAt !== null && !isIso(value.completedAt) || !Array.isArray(value.files) || value.files.length !== run.files.length) return false;
  const ids = new Set([folderId, value.folderId]); if (ids.size !== 2) return false;
  return value.files.every((file, index) => {
    const expected = run.files[index];
    if (Object.keys(file).sort().join(',') !== 'bytes,id,name,sha256,verifiedAt' || !idPattern.test(file.id ?? '') || ids.has(file.id) || file.name !== expected.name || file.sha256 !== expected.sha256 || file.bytes !== expected.bytes || file.verifiedAt !== null && !isIso(file.verifiedAt)) return false;
    ids.add(file.id); return true;
  });
}
function fileFields() { return 'id,name,mimeType,trashed,driveId,ownedByMe,owners(emailAddress),shared,parents,capabilities(canAddChildren),appProperties,size'; }
function remoteClient(http, accessToken, settings) {
  const headers = { authorization: `Bearer ${accessToken}` };
  const get = (path, options = {}) => http.request(api + path, { ...options, headers: { ...headers, ...options.headers } });
  async function metadata(id) { return get(`/drive/v3/files/${id}?fields=${encodeURIComponent(fileFields())}`, { allow: [404] }); }
  async function permissions(id) {
    const { data } = await get(`/drive/v3/files/${id}/permissions?pageSize=100&fields=${encodeURIComponent('permissions(id,type,role,emailAddress,deleted,pendingOwner),nextPageToken')}`);
    requireValue(data && Array.isArray(data.permissions) && data.permissions.length === 1 && !data.nextPageToken && data.permissions.every(item => item.type === 'user' && item.role === 'owner' && item.emailAddress?.toLowerCase() === settings.expectedEmail && !item.deleted && !item.pendingOwner), 'DRIVE_PRIVATE_FOLDER');
  }
  async function privateObject(id, { folder = false, expected } = {}) {
    const result = await metadata(id); if (result.status === 404) return null;
    const object = result.data;
    requireValue(object?.id === id && object.trashed === false && object.ownedByMe === true && object.shared === false && !object.driveId && Array.isArray(object.owners) && object.owners.length === 1 && object.owners[0].emailAddress?.toLowerCase() === settings.expectedEmail && object.mimeType === (folder ? 'application/vnd.google-apps.folder' : expected?.mimeType ?? 'application/octet-stream') && (!folder || object.capabilities?.canAddChildren === true), 'DRIVE_PRIVATE_FOLDER');
    if (expected) {
      requireValue(object.name === expected.name && Array.isArray(object.parents) && object.parents.length === 1 && object.parents[0] === expected.parent && object.appProperties && Object.keys(expected.properties).every(key => object.appProperties[key] === expected.properties[key]) && (folder || /^\d+$/.test(String(object.size)) && Number(object.size) === expected.bytes), 'DRIVE_REMOTE_MISMATCH');
    }
    await permissions(id); return object;
  }
  async function upload(id, file, parent, properties, bytes) {
    const mimeType = file.name === 'manifest.json' ? 'application/json' : 'application/octet-stream';
    const metadata = { id, name: file.name, parents: [parent], mimeType, appProperties: properties };
    if (bytes.length < DRIVE_BACKUP_LIMITS.multipartBytes) {
      const boundary = 'rael_' + randomUUID().replaceAll('-', '');
      const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
      return get('/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body, allow: [409] });
    }
    const initiated = await get('/upload/drive/v3/files?uploadType=resumable&fields=id', { method: 'POST', headers: { 'content-type': 'application/json', 'x-upload-content-type': mimeType, 'x-upload-content-length': String(bytes.length) }, body: JSON.stringify(metadata), allow: [409] });
    if (initiated.status === 409) return initiated;
    const location = guardedUrl(initiated.headers?.get?.('location'), false, true);
    return http.request(location, { method: 'PUT', headers: { ...headers, 'content-type': mimeType, 'content-length': String(bytes.length) }, body: bytes, resumable: true, allow: [409] });
  }
  return { get, privateObject, upload };
}

export async function runDriveBackup({ runDirectory, stateDirectory, keyFile, env = process.env, settings, getToken = googleDriveToken, fetchImpl = globalThis.fetch, now = Date.now, maxDurationMs = DRIVE_BACKUP_LIMITS.maxDurationMs, requestTimeoutMs = DRIVE_BACKUP_LIMITS.requestTimeoutMs, maxFileBytes = DRIVE_BACKUP_LIMITS.maxFileBytes, maxBatchBytes = DRIVE_BACKUP_LIMITS.maxBatchBytes } = {}) {
  if (!settings && !env.RAEL_DRIVE_BACKUP_JSON) return { state: 'disabled', code: 'DRIVE_NOT_CONFIGURED' };
  const configuration = settingsFrom(settings ?? env.RAEL_DRIVE_BACKUP_JSON);
  const limits = { maxDurationMs: limit(maxDurationMs, DRIVE_BACKUP_LIMITS.maxDurationMs), requestTimeoutMs: limit(requestTimeoutMs, DRIVE_BACKUP_LIMITS.requestTimeoutMs), maxFileBytes: limit(maxFileBytes, DRIVE_BACKUP_LIMITS.maxFileBytes), maxBatchBytes: limit(maxBatchBytes, DRIVE_BACKUP_LIMITS.maxBatchBytes), maxFiles: DRIVE_BACKUP_LIMITS.maxFiles };
  const clock = () => Number(now()); const started = clock(), startedAt = new Date(started).toISOString();
  const http = transport({ fetchImpl, now: clock, deadline: started + limits.maxDurationMs, requestTimeoutMs: limits.requestTimeoutMs });
  let storage, statusRecord, stateRecord, statePath, statusPath, run, key, binding; let verifiedFiles = 0;
  const timestamp = () => new Date(clock()).toISOString();
  async function writeStatus(state, code = null) {
    const last = statusRecord?.value;
    const value = { format: 'rael-drive-backup-status', version: 1, binding, state, jobId: run.runId, startedAt, completedAt: state === 'running' ? null : timestamp(), lastSuccessfulAt: state === 'ok' ? timestamp() : last?.lastSuccessfulAt ?? null, lastSuccessfulJobId: state === 'ok' ? run.runId : last?.lastSuccessfulJobId ?? null, fileCount: run.files.length, verifiedFiles, totalBytes: run.bytes, errorCode: code };
    statusRecord = await atomicSigned(statusPath, value, key, 'status', statusRecord);
  }
  try {
    requireValue(typeof fetchImpl === 'function' && typeof getToken === 'function', 'DRIVE_INVALID_CONFIG');
    key = await readBackupKey(keyFile ?? env.RAEL_BACKUP_KEY_FILE, runDirectory, env);
    run = await localBatch(runDirectory, key, limits); http.check();
    binding = sha256(JSON.stringify({ clientId: configuration.clientId, folderId: configuration.folderId, expectedEmail: configuration.expectedEmail }));
    storage = await prepareState(stateDirectory ?? env.RAEL_DRIVE_BACKUP_STATE_DIRECTORY, { run, key, binding, env, keyFile: keyFile ?? env.RAEL_BACKUP_KEY_FILE });
    statusPath = join(storage.root, 'status.json'); statePath = join(storage.root, run.runId + '.json');
    statusRecord = await readSigned(statusPath, key, 'status', value => statusValid(value, binding));
    stateRecord = await readSigned(statePath, key, 'state', value => stateValid(value, run, binding, configuration.folderId));
    await writeStatus('running');
    const authentication = await http.timed(signal => getToken(configuration, { request: http.request, signal, scope: DRIVE_FILE_SCOPE }));
    const accessToken = typeof authentication === 'string' ? authentication : authentication?.token ?? authentication?.accessToken;
    requireValue(typeof accessToken === 'string' && /^[A-Za-z0-9._~+\/=-]{12,4096}$/.test(accessToken), 'DRIVE_AUTH');
    let scopes = authentication?.scopes ?? authentication?.scope;
    if (!scopes) scopes = (await http.request('https://oauth2.googleapis.com/tokeninfo', { method: 'POST', oauth: true, headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/x-www-form-urlencoded' } })).data?.scope;
    if (typeof scopes === 'string') scopes = scopes.split(/\s+/).filter(Boolean);
    requireValue(Array.isArray(scopes) && scopes.length === 1 && scopes[0] === DRIVE_FILE_SCOPE, 'DRIVE_SCOPE');
    const remote = remoteClient(http, accessToken, configuration);
    const identity = await remote.get('/drive/v3/about?fields=user(emailAddress)');
    requireValue(identity.data?.user?.emailAddress?.toLowerCase() === configuration.expectedEmail, 'DRIVE_ACCOUNT');
    const rootFolder = async () => requireValue(await remote.privateObject(configuration.folderId, { folder: true }), 'DRIVE_PRIVATE_FOLDER');
    await rootFolder();
    if (!stateRecord) {
      const generated = await remote.get(`/drive/v3/files/generateIds?count=${run.files.length + 1}&space=drive&type=files`), ids = generated.data?.ids;
      requireValue(Array.isArray(ids) && ids.length === run.files.length + 1 && ids.every(id => idPattern.test(id)) && new Set([...ids, configuration.folderId]).size === ids.length + 1, 'DRIVE_REMOTE_MISMATCH');
      const state = { format: 'rael-drive-backup-state', version: 1, binding, runId: run.runId, rootFolderId: configuration.folderId, manifestSha256: run.manifestHash, folderId: ids[0], files: run.files.map((file, index) => ({ ...file, id: ids[index + 1], verifiedAt: null })), createdAt: timestamp(), completedAt: null };
      stateRecord = await atomicSigned(statePath, state, key, 'state', null);
    }
    const properties = { raelBackup: 'v1', binding, run: sha256(run.runId) };
    const folderExpected = { name: run.runId, parent: configuration.folderId, properties: { ...properties, manifest: run.manifestHash } };
    let folder = await remote.privateObject(stateRecord.value.folderId, { folder: true, expected: folderExpected });
    if (!folder) {
      await run.unchanged(); http.check();
      await remote.get('/drive/v3/files?fields=id', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: stateRecord.value.folderId, name: run.runId, parents: [configuration.folderId], mimeType: 'application/vnd.google-apps.folder', appProperties: folderExpected.properties }), allow: [409] });
      folder = await remote.privateObject(stateRecord.value.folderId, { folder: true, expected: folderExpected }); requireValue(folder, 'DRIVE_REMOTE_MISMATCH');
    }
    for (let index = 0; index < run.files.length; index++) {
      const item = stateRecord.value.files[index], manifest = item.name === 'manifest.json';
      http.check();
      if (manifest) { await rootFolder(); await remote.privateObject(stateRecord.value.folderId, { folder: true, expected: folderExpected }); }
      const expected = { name: item.name, bytes: item.bytes, parent: stateRecord.value.folderId, properties: { ...properties, sha256: item.sha256 }, mimeType: manifest ? 'application/json' : 'application/octet-stream' };
      let object = await remote.privateObject(item.id, { expected });
      // Recheck every source before publishing the manifest, then validate the
      // exact final bytes used by this upload without rereading the whole batch.
      if (manifest) await run.unchanged();
      const bytes = await run.unchanged(item); http.check();
      if (!object) {
        await remote.upload(item.id, item, stateRecord.value.folderId, expected.properties, bytes);
        object = await remote.privateObject(item.id, { expected }); requireValue(object, 'DRIVE_REMOTE_MISMATCH');
      }
      const readback = await remote.get(`/drive/v3/files/${item.id}?alt=media`, { media: item });
      requireValue(readback.data.bytes === item.bytes && readback.data.sha256 === item.sha256, 'DRIVE_REMOTE_CONTENT');
      verifiedFiles++;
      const { authentication: ignored, ...next } = stateRecord.value;
      next.files = next.files.map((file, current) => current === index ? { ...file, verifiedAt: timestamp() } : file);
      stateRecord = await atomicSigned(statePath, next, key, 'state', stateRecord); await writeStatus('running');
    }
    await rootFolder(); await remote.privateObject(stateRecord.value.folderId, { folder: true, expected: folderExpected });
    for (const item of stateRecord.value.files) await remote.privateObject(item.id, { expected: { name: item.name, bytes: item.bytes, parent: stateRecord.value.folderId, properties: { ...properties, sha256: item.sha256 }, mimeType: item.name === 'manifest.json' ? 'application/json' : 'application/octet-stream' } });
    const children = await remote.get(`/drive/v3/files?q=${encodeURIComponent(`'${stateRecord.value.folderId}' in parents and trashed = false`)}&pageSize=1000&fields=${encodeURIComponent('files(id),nextPageToken')}`);
    const expectedIds = new Set(stateRecord.value.files.map(file => file.id));
    requireValue(!children.data?.nextPageToken && Array.isArray(children.data?.files) && children.data.files.length === expectedIds.size && children.data.files.every(file => expectedIds.has(file.id)) && new Set(children.data.files.map(file => file.id)).size === expectedIds.size, 'DRIVE_REMOTE_MISMATCH');
    await run.unchanged(); http.check(); const { authentication: ignored, ...complete } = stateRecord.value; complete.completedAt = timestamp();
    stateRecord = await atomicSigned(statePath, complete, key, 'state', stateRecord); await writeStatus('ok');
    return { state: 'ok', jobId: run.runId, fileCount: run.files.length, verifiedFiles, totalBytes: run.bytes };
  } catch (error) {
    const safe = sanitize(error);
    if (storage && statusPath && run && binding && key) {
      // A foreign/corrupt status is never overwritten, including during failure reporting.
      try {
        const existing = await readSigned(statusPath, key, 'status', value => statusValid(value, binding));
        if (statusRecord && existing?.bytes.equals(statusRecord.bytes)) await writeStatus('failed', safe.code);
      } catch {}
    }
    throw safe;
  } finally { try { await storage?.release(); } catch (error) { throw sanitize(error); } }
}

export async function readDriveBackupStatus({ stateDirectory, key, keyFile, env = process.env, settings } = {}) {
  const empty = state => ({ state, startedAt: null, lastSuccessfulAt: null, lastRunId: null, filesVerified: 0, errorCode: null });
  if (!settings && !env.RAEL_DRIVE_BACKUP_JSON) return empty('disabled');
  try {
    const configuration = settingsFrom(settings ?? env.RAEL_DRIVE_BACKUP_JSON);
    const encryptionKey = key ?? await readBackupKey(keyFile ?? env.RAEL_BACKUP_KEY_FILE, null, env);
    requireValue(typeof encryptionKey === 'string' && /^[a-f0-9]{64}$/i.test(encryptionKey), 'DRIVE_INVALID_CONFIG');
    const binding = sha256(JSON.stringify({ clientId: configuration.clientId, folderId: configuration.folderId, expectedEmail: configuration.expectedEmail }));
    const root = await privatePath(stateDirectory ?? env.RAEL_DRIVE_BACKUP_STATE_DIRECTORY);
    const marker = await readSigned(join(root, markerName), encryptionKey, 'root', value => exactKeys(value, ['format', 'version', 'binding']) && value.format === 'rael-drive-backup-root' && value.version === 1 && value.binding === binding);
    if (!marker) { requireValue(!await info(root), 'DRIVE_UNSAFE_STATE'); return empty('missing'); }
    const status = await readSigned(join(root, 'status.json'), encryptionKey, 'status', value => statusValid(value, binding));
    if (!status) return empty('missing');
    return { state: status.value.state, startedAt: status.value.startedAt, lastSuccessfulAt: status.value.lastSuccessfulAt, lastRunId: status.value.jobId, filesVerified: status.value.verifiedFiles, errorCode: status.value.errorCode };
  } catch (error) { throw sanitize(error); }
}

async function latestRun(args, env) {
  if (args.run !== 'latest') return args.run;
  const directory = args.directory ?? env.RAEL_BACKUP_DIRECTORY; requireValue(directory, 'DRIVE_ARGUMENTS');
  const root = await privatePath(directory), statusFile = await privatePath(env.RAEL_BACKUP_STATUS_FILE ?? join(root, 'status.json'));
  await regular(statusFile, 16384); let status; try { status = JSON.parse(await readFile(statusFile, 'utf8')); } catch { throw failure('DRIVE_INVALID_BACKUP'); }
  requireValue(status.state === 'ok' && runPattern.test(status.jobId ?? ''), 'DRIVE_INVALID_BACKUP'); return join(root, status.jobId);
}
export async function driveBackupCommand(argv = process.argv.slice(2), options = {}) {
  const env = options.env ?? process.env;
  if (!env.RAEL_DRIVE_BACKUP_JSON && !options.settings) { const result = { state: 'disabled', code: 'DRIVE_NOT_CONFIGURED' }; (options.log ?? console.log)(JSON.stringify(result)); return result; }
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    requireValue(['--run', '--directory', '--state-directory', '--key-file'].includes(argv[i]) && typeof argv[i + 1] === 'string' && !Object.hasOwn(args, argv[i].slice(2)), 'DRIVE_ARGUMENTS'); args[argv[i].slice(2)] = argv[i + 1];
  }
  requireValue(args.run, 'DRIVE_ARGUMENTS');
  const result = await runDriveBackup({ ...options, env, runDirectory: await latestRun(args, env), stateDirectory: args['state-directory'] ?? env.RAEL_DRIVE_BACKUP_STATE_DIRECTORY, keyFile: args['key-file'] ?? env.RAEL_BACKUP_KEY_FILE });
  (options.log ?? console.log)(JSON.stringify(result)); return result;
}
export function reportDriveBackupFailure(error) { const safe = sanitize(error); console.error(`Cópia cifrada não concluída (${safe.code}).`); process.exitCode = 1; }
isMainModule(import.meta.url).then(main => main ? driveBackupCommand() : undefined).catch(reportDriveBackupFailure);
