import { readFile } from 'node:fs/promises';
import { writeMonitorStatus } from '../src/monitor-status.mjs';
import { isMainModule } from '../src/cli-entry.mjs';

export async function checkHealth({ env = process.env, fetchImpl = fetch, now = () => Date.now() } = {}) {
  let code = 1, result, prior = null, token = '';
  try {
    token = env.RAEL_MONITOR_TOKEN ?? (env.RAEL_MONITOR_TOKEN_FILE ? (await readFile(env.RAEL_MONITOR_TOKEN_FILE, 'utf8')).trim() : '');
    if (token.length < 32 || token.length > 256 || /\s/.test(token)) throw new Error('Invalid token.');
    const origin = new URL(env.RAEL_PUBLIC_ORIGIN ?? '');
    if (origin.origin !== env.RAEL_PUBLIC_ORIGIN || origin.username || origin.password || origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error('Invalid origin.');
    const response = await fetchImpl(new URL('/health/ready', origin), { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(8000) });
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 65536) { await response.body.cancel?.().catch(() => {}); throw new Error('Invalid response.'); } chunks.push(chunk); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const checks = value?.checks;
    const ok = response.status === 200 && value?.status === 'ok' && checks?.database?.status === 'ok' && ['ok', 'waiting'].includes(checks?.maintenance?.status) && typeof checks?.backup?.required === 'boolean' && (!checks.backup.required || checks.backup.status === 'ok'); code = ok ? 0 : 1;
    const statusOf = value => ['ok', 'failed', 'degraded', 'stale', 'warning', 'waiting', 'disabled', 'not_configured', 'unavailable', 'missing_success', 'invalid', 'stuck'].includes(value?.status) ? value.status : 'unknown';
    result = { state: ok ? 'ok' : 'failed', httpStatus: response.status, checks: { database: statusOf(value.checks?.database), maintenance: statusOf(value.checks?.maintenance), backup: statusOf(value.checks?.backup) } };
  } catch { result = { state: 'failed', httpStatus: null, checks: { database: 'unknown', maintenance: 'unknown', backup: 'unknown' } }; }
  const timestamp = new Date(now()).toISOString();
  const statusFile = env.RAEL_MONITOR_STATUS_FILE;
  if (statusFile) {
    try {
      const saved = await writeMonitorStatus({ path: statusFile, env, token, result, checkedAt: timestamp });
      prior = saved.prior;
      const { authentication, ...safe } = saved.stored; result = safe;
    } catch { code = 1; result = { ...result, state: 'failed', statusWriteFailed: true }; }
  }
  const event = result.state !== 'ok' ? 'health_check_failed' : prior?.state === 'failed' ? 'health_check_recovered' : 'health_check_ok';
  return { code, result: { ...result, event, timestamp } };
}
isMainModule(import.meta.url).then(async main => {
  if (!main) return;
  const { code, result } = await checkHealth(); console.log(JSON.stringify(result)); process.exitCode = code;
}).catch(() => { console.error('Falha ao iniciar a sonda de monitoramento. Consulte a configuração privada.'); process.exitCode = 1; });
