import { backupCommand, reportBackupCommandFailure } from './backup-job.mjs';
import { isMainModule } from '../src/cli-entry.mjs';

// Short, single-purpose entry for the Hostinger cron command-length limit.
// Only the authorized Aurora recovery drill is selected here. The shared command
// still authenticates the latest backup, requires a distinct empty scratch
// database, compares the restored rows and never enables sessions or payments.
const auroraRecoveryDrill = [
  'restore-drill',
  '--run', 'latest',
  '--source', 'aurora-teste',
  '--confirm-source', 'aurora-teste',
  '--destination', 'restauracao-teste',
  '--target-env', 'RAEL_RESTORE_TEST_JSON',
];

isMainModule(import.meta.url).then(main => {
  if (!main) return;
  if (process.argv.length > 2) throw Object.assign(new Error('Este comando executa somente o ensaio Aurora configurado.'), { code: 'INVALID_ARGUMENTS' });
  return backupCommand(auroraRecoveryDrill);
}).catch(reportBackupCommandFailure);
