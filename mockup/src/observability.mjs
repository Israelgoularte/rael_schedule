import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { readDriveBackupStatus } from '../tools/drive-backup.mjs';

const json = (res, code, value, head = false) => {
  const bytes = Buffer.from(JSON.stringify(value));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(head ? undefined : bytes);
};
export function safeFailureCategory(error) {
  const code = String(error?.code ?? '');
  if (/^(?:ER_|SQLITE_)/.test(code)) return 'database';
  if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'PROTOCOL_SEQUENCE_TIMEOUT'].includes(code) || error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'connection';
  if (Number(error?.status) === 401 || Number(error?.status) === 403) return 'authorization';
  if (Number(error?.status) >= 400) return 'provider_or_validation';
  return 'unexpected';
}
const maintenanceComponents = new Set(['database', 'payments', 'subscriptions', 'license', 'notifications', 'recovery_email']);
const providerIssues = new Set(['not_authorized', 'rate_limited', 'provider_unavailable', 'provider_rejected', 'invalid_response', 'invalid_request', 'connection_failed', 'amount_rejected']);
// Read own data properties only. A diagnostic must not invoke a getter, copy a
// provider body or stringify an arbitrary object supplied with an error.
function errorData(error, key) {
  try { const descriptor = error && Object.getOwnPropertyDescriptor(error, key); return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined; }
  catch { return undefined; }
}
export function safeMaintenanceFailure(component, error) {
  const status = errorData(error, 'providerStatus'), issue = errorData(error, 'providerIssue');
  return { component: maintenanceComponents.has(component) ? component : 'unknown', providerStatus: Number.isInteger(status) && status >= 400 && status <= 599 ? status : null, providerIssue: providerIssues.has(issue) ? issue : 'unknown' };
}
export function maintenanceCorrelation(key, slug) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/i.test(key) || typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{1,47}$/.test(slug)) return null;
  return createHmac('sha256', Buffer.from(key, 'hex')).update('rael:maintenance:tenant:v1\0').update(slug).digest('hex').slice(0, 24);
}
const sha = value => createHash('sha256').update(value).digest();
export function createObservability({ foundation, env = process.env, now = () => Date.now(), logger = value => console.error(JSON.stringify(value)), probeCacheMs = 60000, driveBackupReader = readDriveBackupStatus } = {}) {
  const token = env.RAEL_MONITOR_TOKEN ?? '';
  if (token && (token.length < 32 || token.length > 256 || /\s/.test(token))) throw new Error('Configure um token privado de monitoramento com 32 a 256 caracteres, sem espaços.');
  const startedAt = now(), durations = [];
  const requests = { total: 0, serverErrors: 0, inFlight: 0 };
  let probePromise = null, probeResult = null, probeAt = 0, lastReadinessState = null;
  const emit = value => { try { logger({ timestamp: now(), ...value }); } catch { /* Observability must not interrupt service. */ } };
  const authorized = req => {
    if (!token) return false;
    const candidate = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    return candidate.length <= 300 && timingSafeEqual(sha(candidate), sha(`Bearer ${token}`));
  };
  async function database() {
    if (probeResult && now() - probeAt < probeCacheMs) return probeResult;
    if (!probePromise) {
      probePromise = (async () => {
        try { await foundation.probeDatabase(); probeResult = { status: 'ok' }; }
        catch (error) { probeResult = { status: 'failed', category: safeFailureCategory(error) }; }
        probeAt = now(); return probeResult;
      })().finally(() => { probePromise = null; });
    }
    return probePromise;
  }
  async function backup() {
    const result = (check, latestSuccessfulRunId = null) => ({ check, latestSuccessfulRunId });
    if (!env.RAEL_BACKUP_STATUS_FILE) return result({ status: 'not_configured' });
    try {
      const info = await stat(env.RAEL_BACKUP_STATUS_FILE);
      if (!info.isFile() || info.size > 16384) return result({ status: 'invalid' });
      const value = JSON.parse(await readFile(env.RAEL_BACKUP_STATUS_FILE, 'utf8'));
      // Accept the job's explicit successful completion, never an arbitrary mtime.
      const state = value.state ?? value.status;
      if (!['ok', 'success', 'running', 'failed', 'error', 'partial'].includes(state)) return result({ status: 'invalid' });
      const rawAt = value.lastSuccessfulAt ?? value.lastSuccessAt ?? (state === 'ok' || state === 'success' ? value.completedAt : 0);
      const at = typeof rawAt === 'string' ? Date.parse(rawAt) : Number(rawAt);
      if (!Number.isFinite(at) || at <= 0 || at > now() + 60000) return result({ status: 'missing_success' });
      const maxAge = Math.max(1, Math.min(168, Number(env.RAEL_BACKUP_MAX_AGE_HOURS) || 26)) * 3600000;
      const failed = ['failed', 'error', 'partial'].includes(state), started = typeof value.startedAt === 'string' ? Date.parse(value.startedAt) : Number(value.startedAt);
      const stuck = state === 'running' && (!Number.isFinite(started) || started > now() + 60000 || now() - started > 1800000);
      const retentionWarnings = Number.isSafeInteger(value.retentionWarnings) && value.retentionWarnings > 0 ? value.retentionWarnings : 0;
      const latestSuccessfulRunId = ['ok', 'success'].includes(state) && /^run-\d{8}T\d{6}Z-[a-f0-9]{12}$/.test(value.jobId ?? '') ? value.jobId : null;
      return result({ status: failed ? 'failed' : stuck ? 'stuck' : now() - at > maxAge ? 'stale' : retentionWarnings ? 'warning' : 'ok', lastSuccessfulAt: at, ageSeconds: Math.max(0, Math.floor((now() - at) / 1000)), retentionWarnings }, latestSuccessfulRunId);
    } catch { return result({ status: 'unavailable' }); }
  }
  async function driveBackup(latestLocalRunId) {
    const required = env.RAEL_MONITOR_REQUIRE_DRIVE_BACKUP === '1';
    const check = { status: 'not_configured', required, lastSuccessfulAt: null, ageSeconds: null, filesVerified: 0 };
    if (!env.RAEL_DRIVE_BACKUP_JSON) return check;
    try {
      // This reader authenticates private local status only; readiness never contacts Google.
      const value = await driveBackupReader({ env, stateDirectory: env.RAEL_DRIVE_BACKUP_STATE_DIRECTORY });
      if (!value || !['disabled', 'missing', 'running', 'ok', 'failed'].includes(value.state)) return { ...check, status: 'invalid' };
      if (value.state === 'disabled') return check;
      if (value.state === 'missing') return { ...check, status: 'missing' };
      if (!Number.isSafeInteger(value.filesVerified) || value.filesVerified < 0 || value.filesVerified > 998) return { ...check, status: 'invalid' };
      check.filesVerified = value.filesVerified;
      const at = typeof value.lastSuccessfulAt === 'string' ? Date.parse(value.lastSuccessfulAt) : NaN;
      if (value.lastSuccessfulAt !== null && (!Number.isFinite(at) || at <= 0 || at > now() + 60000)) return { ...check, status: 'invalid' };
      if (Number.isFinite(at)) { check.lastSuccessfulAt = at; check.ageSeconds = Math.max(0, Math.floor((now() - at) / 1000)); }
      if (value.state === 'failed') return { ...check, status: 'failed' };
      const started = typeof value.startedAt === 'string' ? Date.parse(value.startedAt) : NaN;
      if (value.state === 'running' && (!Number.isFinite(started) || started > now() + 60000 || now() - started > 1800000)) return { ...check, status: 'stuck' };
      const maxAge = Math.max(1, Math.min(168, Number(env.RAEL_BACKUP_MAX_AGE_HOURS) || 26)) * 3600000;
      if (Number.isFinite(at) && now() - at > maxAge) return { ...check, status: 'stale' };
      if (value.state === 'running') return { ...check, status: 'pending' };
      if (!Number.isFinite(at)) return { ...check, status: 'missing' };
      if (!value.filesVerified || !/^run-\d{8}T\d{6}Z-[a-f0-9]{12}$/.test(value.lastRunId ?? '')) return { ...check, status: 'invalid' };
      return { ...check, status: latestLocalRunId && value.lastRunId === latestLocalRunId ? 'ok' : 'pending' };
    } catch { return { ...check, status: 'invalid' }; }
  }
  async function snapshot() {
    const [db, localBackup, registration] = await Promise.all([database(), backup(), foundation.provisioningStatus ? foundation.provisioningStatus().catch(() => ({ status: 'degraded' })) : { status: 'disabled' }]);
    const backups = localBackup.check, driveBackups = await driveBackup(localBackup.latestSuccessfulRunId);
    const maintenance = foundation.maintenanceStatus?.() ?? { status: 'not_configured' };
    const backupRequired = env.RAEL_MONITOR_REQUIRE_BACKUP === '1';
    const ready = db.status === 'ok' && !['degraded', 'stale'].includes(maintenance.status) && registration.status !== 'degraded' && (!backupRequired || backups.status === 'ok') && (!driveBackups.required || driveBackups.status === 'ok');
    const sorted = [...durations].sort((a, b) => a - b), memory = process.memoryUsage();
    const status = ready ? 'ok' : 'degraded';
    if (status !== lastReadinessState) { emit({ event: 'readiness_changed', status, database: db.status, maintenance: maintenance.status, backup: backups.status, driveBackup: driveBackups.status }); lastReadinessState = status; }
    return { status, checkedAt: now(), checks: { database: { ...db, scope: 'control_database_only', cachedForSeconds: Math.max(0, Math.floor((now() - probeAt) / 1000)) }, maintenance, registration, backup: { ...backups, required: backupRequired }, driveBackup: driveBackups }, metrics: { uptimeSeconds: Math.max(0, Math.floor((now() - startedAt) / 1000)), requests: { ...requests, durationSampleSize: sorted.length, p95DurationMs: sorted.length ? sorted[Math.ceil(sorted.length * .95) - 1] : 0 }, memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed } } };
  }
  return {
    track(req, res) {
      const start = performance.now(); requests.total++; requests.inFlight++;
      let done = false;
      const finish = () => {
        if (done) return; done = true; requests.inFlight = Math.max(0, requests.inFlight - 1);
        durations.push(Math.round((performance.now() - start) * 10) / 10); if (durations.length > 256) durations.shift();
        if (res.statusCode >= 500) { requests.serverErrors++; if (requests.serverErrors === 1 || requests.serverErrors % 10 === 0) emit({ event: 'http_server_error', statusCode: res.statusCode, count: requests.serverErrors }); }
      };
      res.once('finish', finish); res.once('close', finish);
    },
    async handle(req, res, url) {
      if (!['/health/live', '/health/ready'].includes(url.pathname)) return false;
      if (url.pathname === '/health/ready' && !authorized(req)) { json(res, 404, { error: 'Não encontrado.' }, req.method === 'HEAD'); return true; }
      if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); json(res, 405, { error: 'Ação não permitida.' }); return true; }
      if (url.pathname === '/health/live') json(res, 200, { status: 'ok' }, req.method === 'HEAD');
      else { const value = await snapshot(); json(res, value.status === 'ok' ? 200 : 503, value, req.method === 'HEAD'); }
      return true;
    },
    failure(event, error) { emit({ event: ['request_failed', 'maintenance_failed'].includes(event) ? event : 'operation_failed', category: safeFailureCategory(error) }); },
    snapshot,
  };
}
