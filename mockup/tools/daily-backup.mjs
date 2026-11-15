import { runBackupJob } from './backup-job.mjs';
import { runDriveBackup } from './drive-backup.mjs';
import { isMainModule } from '../src/cli-entry.mjs';
import { performance } from 'node:perf_hooks';

const codes = Object.freeze({ local: 'DAILY_LOCAL_BACKUP_FAILED', drive: 'DAILY_DRIVE_BACKUP_FAILED' });
const maximumDurationMs = 26 * 60_000;
const count = value => Number.isSafeInteger(value) && value >= 0;
function failed(stage) { return Object.assign(new Error('O backup diário não foi concluído. Consulte o status privado.'), { stage, code: codes[stage] }); }

// Never inspect Drive credentials before protecting the current local data.
// A failed external copy does not remove or replace the verified local batch.
export async function runDailyBackup({ env = process.env, runLocalBackup = runBackupJob, runExternalBackup = runDriveBackup, now = () => performance.now(), maxDurationMs = maximumDurationMs } = {}) {
  let local, started, budget;
  try {
    if (typeof now !== 'function' || !Number.isSafeInteger(maxDurationMs) || maxDurationMs <= 0) throw failed('local');
    budget = Math.min(maximumDurationMs, maxDurationMs);
    started = now();
    if (!Number.isFinite(started)) throw failed('local');
    if (typeof env.RAEL_BACKUP_DIRECTORY !== 'string' || !env.RAEL_BACKUP_DIRECTORY.trim()) throw failed('local');
    local = await runLocalBackup({ directory: env.RAEL_BACKUP_DIRECTORY, keyFile: env.RAEL_BACKUP_KEY_FILE, statusFile: env.RAEL_BACKUP_STATUS_FILE, retentionDays: 30, env });
    if (typeof local?.directory !== 'string' || !local.directory.trim() || !count(local.tenantCount) || local.tenantCount < 1) throw failed('local');
  } catch { throw failed('local'); }
  let external;
  try {
    const elapsed = now() - started, remaining = Math.floor(budget - elapsed);
    if (!Number.isFinite(elapsed) || elapsed < 0 || remaining <= 0) throw failed('drive');
    external = await runExternalBackup({ runDirectory: local.directory, env, maxDurationMs: remaining });
    const completedElapsed = now() - started;
    if (!Number.isFinite(completedElapsed) || completedElapsed < elapsed || completedElapsed >= budget) throw failed('drive');
    if (external?.state !== 'ok' || !count(external.fileCount) || external.fileCount < 1 || external.verifiedFiles !== external.fileCount || !count(external.totalBytes) || external.totalBytes < 1) throw failed('drive');
  } catch { throw failed('drive'); }
  return { state: 'ok', local: { tenantCount: local.tenantCount, removedRuns: count(local.removedRuns) ? local.removedRuns : 0, retentionWarnings: count(local.retentionWarnings) ? local.retentionWarnings : 0 }, drive: { fileCount: external.fileCount, verifiedFiles: external.verifiedFiles, totalBytes: external.totalBytes } };
}

export function reportDailyBackupFailure(error) {
  const stage = error?.stage === 'drive' ? 'drive' : 'local';
  console.error(JSON.stringify({ stage, state: 'failed', errorCode: codes[stage] }));
  process.exitCode = 1;
}

isMainModule(import.meta.url).then(async main => {
  if (!main) return;
  if (process.argv.length !== 2) throw failed('local');
  console.log(JSON.stringify(await runDailyBackup()));
}).catch(reportDailyBackupFailure);
