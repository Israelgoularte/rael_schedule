import { readFile, writeFile, mkdir, readdir, lstat, realpath, rename, unlink, rmdir, open } from 'node:fs/promises';
import { resolve, dirname, join, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { loadConfiguration, validSlug } from '../src/configuration.mjs';
import { isMainModule } from '../src/cli-entry.mjs';
import { openDatabase } from '../src/database.mjs';
import { hydrateManagedTenants } from '../src/tenant-registry.mjs';
import { backupDatabaseSnapshot, databaseFingerprint, decryptBackupPayload, encryptBackupPayload, inspectDatabaseBackup, restoreDatabase, verifyRestoredDatabase } from '../src/backup.mjs';

const rootMarker = '.rael-backup-root.json';
const format = 'rael-backup-batch';
const runPattern = /^run-\d{8}T\d{6}Z-[a-f0-9]{12}$/;
const publicDirectory = fileURLToPath(new URL('../dist', import.meta.url));
const inside = (path, parent) => path === parent || path.startsWith(parent + sep);
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function error(code, message) { return Object.assign(new Error(message), { code }); }
function isInside(path, parent) { return inside(process.platform === 'win32' ? path.toLowerCase() : path, process.platform === 'win32' ? parent.toLowerCase() : parent); }

// Resolve the existing prefix too: lexical checks alone miss a symlink to dist.
export async function privateLocation(path) {
  const absolute = resolve(path);
  let ancestor = absolute, suffix = [];
  while (true) {
    try { ancestor = await realpath(ancestor); break; }
    catch (failure) { if (failure.code !== 'ENOENT') throw failure; const parent = dirname(ancestor); if (parent === ancestor) throw failure; suffix.unshift(basename(ancestor)); ancestor = parent; }
  }
  const canonical = join(ancestor, ...suffix);
  const publicReal = await realpath(publicDirectory);
  const unsafe = candidate => isInside(candidate, publicDirectory) || isInside(candidate, publicReal) || candidate.split(/[\\/]+/).some(part => ['dist', 'public_html', 'htdocs', 'wwwroot'].includes(part.toLowerCase()));
  if (unsafe(absolute) || unsafe(canonical)) throw error('PUBLIC_PATH', 'Use um caminho privado fora da publicação.');
  return canonical;
}
async function regularFile(path) {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) throw error('UNSAFE_FILE', 'Arquivo privado inválido.');
  return details;
}
async function atomicPrivateWrite(path, content) {
  const target = await privateLocation(path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try { await regularFile(target); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
  const temporary = join(dirname(target), `.writing-${randomBytes(10).toString('hex')}`);
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } finally { try { await unlink(temporary); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; } }
}
export async function readBackupKey(keyFile, backupRoot, env = process.env) {
  if (!keyFile) {
    if (!/^[a-f0-9]{64}$/i.test(env.RAEL_BACKUP_KEY ?? '')) throw error('INVALID_KEY', 'Configure RAEL_BACKUP_KEY no ambiente privado ou informe um arquivo de chave.');
    return env.RAEL_BACKUP_KEY;
  }
  const path = await privateLocation(keyFile);
  if (backupRoot && isInside(path, await privateLocation(backupRoot))) throw error('KEY_WITH_BACKUP', 'Guarde a chave fora da pasta dos backups.');
  const details = await regularFile(path);
  if (process.platform !== 'win32' && (details.mode & 0o077)) throw error('KEY_PERMISSIONS', 'A chave deve permitir leitura apenas ao proprietário (0600).');
  const key = (await readFile(path, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/i.test(key)) throw error('INVALID_KEY', 'A chave privada deve conter 32 bytes em hexadecimal.');
  return key;
}
async function prepareRoot(path) {
  const root = await privateLocation(path);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const details = await lstat(root);
  if (!details.isDirectory() || details.isSymbolicLink()) throw error('UNSAFE_ROOT', 'Pasta de backup inválida.');
  const markerPath = join(root, rootMarker);
  try {
    await regularFile(markerPath);
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    if (marker.format !== format || marker.version !== 1 || !/^[a-f0-9]{32}$/.test(marker.id)) throw error('UNSAFE_ROOT', 'Pasta não pertence ao job de backup.');
  } catch (failure) {
    if (failure.code !== 'ENOENT') throw failure;
    if ((await readdir(root)).length) throw error('UNSAFE_ROOT', 'Escolha uma pasta vazia exclusiva para o job.');
    await writeFile(markerPath, JSON.stringify({ format, version: 1, id: randomBytes(16).toString('hex') }), { flag: 'wx', mode: 0o600 });
  }
  return root;
}
function signingKey(key) { return createHmac('sha256', Buffer.from(key, 'hex')).update('rael-backup-manifest-signing-key-v1').digest(); }
function signature(manifest, key) { const { authentication: ignored, ...unsigned } = manifest; return createHmac('sha256', signingKey(key)).update(JSON.stringify(unsigned)).digest('hex'); }
function checkManifest(manifest, key) {
  if (manifest?.format !== format || manifest.version !== 1 || !runPattern.test(manifest.id ?? '') || !Array.isArray(manifest.tenants) || manifest.tenants.length === 0 || manifest.tenants.length !== manifest.tenantCount || !Number.isFinite(Date.parse(manifest.completedAt)) || !Number.isFinite(Date.parse(manifest.createdAt)) || !/^[a-f0-9]{64}$/.test(manifest.authentication ?? '') || !timingSafeEqual(Buffer.from(manifest.authentication, 'hex'), Buffer.from(signature(manifest, key), 'hex'))) throw error('INVALID_MANIFEST', 'Manifesto inválido ou não autenticado.');
  const names = new Set(['manifest.json']);
  for (const file of [...manifest.tenants, manifest.configuration]) {
    if (!file || typeof file.file !== 'string' || basename(file.file) !== file.file || !/^[a-z0-9][a-z0-9.-]{1,100}$/.test(file.file) || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '') || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || names.has(file.file)) throw error('INVALID_MANIFEST', 'Arquivo de manifesto inválido.');
    names.add(file.file);
  }
  const slugs = new Set();
  for (const tenant of manifest.tenants) {
    if (!validSlug(tenant.slug) || !/^[a-f0-9]{64}$/.test(tenant.sourceFingerprint ?? '') || slugs.has(tenant.slug)) throw error('INVALID_MANIFEST', 'Origem de manifesto inválida.');
    slugs.add(tenant.slug);
  }
  return names;
}
export async function verifyBackupRun(runDirectory, key) {
  // Check the lexical entry before realpath: resolving it first would hide a
  // junction/symlink and could let retention follow a run outside its own root.
  const lexicalInfo = await lstat(resolve(runDirectory));
  if (!lexicalInfo.isDirectory() || lexicalInfo.isSymbolicLink()) throw error('UNSAFE_RUN', 'Pasta de lote inválida.');
  const path = await privateLocation(runDirectory), info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !runPattern.test(basename(path))) throw error('UNSAFE_RUN', 'Pasta de lote inválida.');
  await regularFile(join(path, 'manifest.json'));
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
  const names = checkManifest(manifest, key);
  if (manifest.id !== basename(path)) throw error('INVALID_MANIFEST', 'A identidade do lote não corresponde à pasta.');
  const actualNames = await readdir(path);
  if (actualNames.length !== names.size || actualNames.some(name => !names.has(name))) throw error('UNEXPECTED_FILES', 'O lote contém arquivos inesperados.');
  const content = {};
  for (const item of [...manifest.tenants, manifest.configuration]) {
    const target = join(path, item.file), details = await regularFile(target);
    if (details.size !== item.bytes) throw error('INTEGRITY_FAILED', 'Tamanho de backup divergente.');
    const bytes = await readFile(target);
    if (hash(bytes) !== item.sha256) throw error('INTEGRITY_FAILED', 'Integridade de backup divergente.');
    content[item.file] = bytes.toString('utf8');
  }
  for (const item of manifest.tenants) {
    const inspected = inspectDatabaseBackup(content[item.file], key);
    if (inspected.version !== 2 || inspected.source.slug !== item.slug || inspected.source.fingerprint !== item.sourceFingerprint) throw error('SOURCE_MISMATCH', 'Origem do backup divergente.');
  }
  const configuration = decryptBackupPayload(content[manifest.configuration.file], key, 'configuration');
  if (configuration.kind !== 'private-configuration' || configuration.runId !== manifest.id || !configuration.entries || !Array.isArray(configuration.databases) || configuration.databases.length !== manifest.tenants.length) throw error('CONFIGURATION_MISMATCH', 'Configuração privada divergente.');
  for (const item of manifest.tenants) {
    if (!Object.hasOwn(configuration.entries, item.slug) || databaseFingerprint(configuration.entries[item.slug]) !== item.sourceFingerprint || configuration.databases.filter(db => db.slug === item.slug && db.fingerprint === item.sourceFingerprint).length !== 1) throw error('CONFIGURATION_MISMATCH', 'Configuração privada não corresponde aos negócios.');
  }
  return { manifest, configuration, content };
}
async function pruneVerifiedRuns(root, key, cutoff, preserveId) {
  let removed = 0, warnings = 0;
  for (const name of await readdir(root)) {
    if (!runPattern.test(name) || name === preserveId) continue;
    const directory = join(root, name);
    let verified;
    try {
      const details = await lstat(directory), canonical = await realpath(directory);
      if (!details.isDirectory() || details.isSymbolicLink() || !isInside(canonical, root) || samePath(canonical, root)) throw error('UNSAFE_RUN', 'O expurgo não segue links ou caminhos fora da raiz.');
      verified = await verifyBackupRun(directory, key);
    }
    catch { warnings++; continue; } // Never remove incomplete, foreign, corrupt or symlinked files.
    if (Date.parse(verified.manifest.createdAt) >= cutoff) continue;
    const names = ['manifest.json', ...verified.manifest.tenants.map(item => item.file), verified.manifest.configuration.file];
    // Files only, no recursive directory deletion, and every name came from the authenticated manifest.
    for (const file of names) {
      const details = await lstat(directory), canonical = await realpath(directory);
      if (!details.isDirectory() || details.isSymbolicLink() || !isInside(canonical, root) || samePath(canonical, root)) throw error('UNSAFE_RUN', 'O expurgo não segue links ou caminhos fora da raiz.');
      await unlink(join(directory, file));
    }
    await rmdir(directory); removed++;
  }
  return { removed, warnings };
}
function privateEnvironment(env, entries) {
  const selected = Object.fromEntries(Object.entries(env).filter(([name]) => (name.startsWith('RAEL_') && !name.startsWith('RAEL_BACKUP_')) || ['NODE_ENV', 'PORT', 'HOST'].includes(name)));
  // Never carry a removed tenant's old credential out of a stale static env.
  // The authenticated vault's filtered manifest is authoritative on recovery.
  if (entries && (selected.RAEL_TENANTS_JSON || selected.RAEL_TENANTS_FILE)) {
    selected.RAEL_TENANTS_JSON = JSON.stringify(entries);
    delete selected.RAEL_TENANTS_FILE;
  }
  return selected;
}
export async function runBackupJob({ directory, keyFile, statusFile, retentionDays = 30, config, env = process.env, databaseFactory = openDatabase, now = () => new Date() }) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 30) throw error('INVALID_RETENTION', 'Retenção deve estar entre 1 e 30 dias.');
  const root = await prepareRoot(directory), key = await readBackupKey(keyFile, root, env);
  const statusPath = await privateLocation(statusFile || env.RAEL_BACKUP_STATUS_FILE || join(root, 'status.json'));
  if (isInside(statusPath, root) && !samePath(statusPath, join(root, 'status.json'))) throw error('UNSAFE_STATUS', 'Dentro da pasta de backup, use somente status.json.');
  if (keyFile && samePath(statusPath, await privateLocation(keyFile))) throw error('UNSAFE_STATUS', 'O status não pode sobrescrever a chave.');
  const lockPath = join(root, '.backup-job.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (failure) { if (failure.code === 'EEXIST') throw error('BACKUP_LOCKED', 'Outro backup está em execução ou exige conferência de um lock antigo.'); throw failure; }
  let status;
  try {
    const started = now(), id = `run-${started.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}-${randomBytes(6).toString('hex')}`;
    await lock.writeFile(JSON.stringify({ jobId: id, pid: process.pid, startedAt: started.toISOString() }));
    let previous = null;
    try {
      await regularFile(statusPath); previous = JSON.parse(await readFile(statusPath, 'utf8'));
      if (previous?.version !== 1 || !['running', 'ok', 'failed'].includes(previous.state) || !runPattern.test(previous.jobId ?? '')) throw error('UNSAFE_STATUS', 'O status existente não pertence ao job de backup.');
    } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
    status = { version: 1, state: 'running', jobId: id, startedAt: started.toISOString(), completedAt: null, lastSuccessfulAt: previous?.lastSuccessfulAt ?? null, completedTenants: 0, totalTenants: 0, errorCode: null, retentionWarnings: 0 };
    await atomicPrivateWrite(statusPath, JSON.stringify(status));
    const settings = config ?? await loadConfiguration(env);
    await hydrateManagedTenants(settings, { databaseFactory });
    const entries = Object.entries(settings.entries);
    if (!settings.enabled || !entries.length) throw error('NO_TENANTS', 'Configure os negócios antes de executar o backup.');
    status.totalTenants = entries.length;
    const runPath = join(root, id);
    await mkdir(runPath, { mode: 0o700 });
    const manifest = { format, version: 1, id, createdAt: started.toISOString(), completedAt: null, tenantCount: entries.length, tenants: [], configuration: null };
    const vault = { version: 2, kind: 'private-configuration', runId: id, createdAt: started.toISOString(), environment: privateEnvironment(env, settings.entries), entries: settings.entries, databases: [] };
    for (const [slug, entry] of entries) {
      if (!validSlug(slug)) throw error('INVALID_TENANT', 'Negócio inválido.');
      const source = { slug, fingerprint: databaseFingerprint(entry) }, db = await databaseFactory(entry);
      let snapshot;
      try { snapshot = await backupDatabaseSnapshot(db, key, source); } finally { await db.close(); }
      const file = `${slug}.database.backup`, bytes = Buffer.from(snapshot.database);
      await atomicPrivateWrite(join(runPath, file), bytes);
      manifest.tenants.push({ slug, file, sourceFingerprint: source.fingerprint, sha256: hash(bytes), bytes: bytes.length });
      vault.databases.push({ slug, fingerprint: source.fingerprint, privateConfiguration: snapshot.privateConfiguration });
      status.completedTenants++;
      await atomicPrivateWrite(statusPath, JSON.stringify(status));
    }
    const vaultBytes = Buffer.from(encryptBackupPayload(vault, key, 'configuration'));
    await atomicPrivateWrite(join(runPath, 'configuration.backup'), vaultBytes);
    manifest.configuration = { file: 'configuration.backup', sha256: hash(vaultBytes), bytes: vaultBytes.length };
    manifest.completedAt = now().toISOString(); manifest.authentication = signature(manifest, key);
    await atomicPrivateWrite(join(runPath, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await verifyBackupRun(runPath, key);
    const retention = await pruneVerifiedRuns(root, key, started.getTime() - retentionDays * 86400000, id);
    status = { ...status, state: 'ok', completedAt: now().toISOString(), lastSuccessfulAt: manifest.completedAt, retentionWarnings: retention.warnings };
    await atomicPrivateWrite(statusPath, JSON.stringify(status));
    return { jobId: id, directory: runPath, tenantCount: entries.length, removedRuns: retention.removed, retentionWarnings: retention.warnings };
  } catch (failure) {
    if (status) { status = { ...status, state: 'failed', completedAt: now().toISOString(), errorCode: 'BACKUP_FAILED' }; try { await atomicPrivateWrite(statusPath, JSON.stringify(status)); } catch { /* CLI exit and external age alarm still detect failure. */ } }
    throw failure;
  } finally { await lock.close(); await unlink(lockPath); }
}

// A recovery drill never adds a tenant to the live manifest and never activates
// billing. The destination must be a distinct, empty scratch database.
export async function restoreBackupDrill({ runDirectory, keyFile, key, source, confirmSource, destination = 'restauracao-teste', targetEntry, config, env = process.env, databaseFactory = openDatabase }) {
  if (!validSlug(source) || confirmSource !== source || destination !== 'restauracao-teste') throw error('SOURCE_CONFIRMATION', 'Confirme a origem e use o destino restauracao-teste.');
  const encryptionKey = key ?? await readBackupKey(keyFile, runDirectory, env), verified = await verifyBackupRun(runDirectory, encryptionKey);
  const item = verified.manifest.tenants.find(tenant => tenant.slug === source);
  if (!item) throw error('SOURCE_MISMATCH', 'Origem ausente no lote.');
  const settings = config ?? await loadConfiguration(env);
  await hydrateManagedTenants(settings, { databaseFactory });
  if (!targetEntry || typeof targetEntry !== 'object' || Array.isArray(targetEntry) || !['mysql', 'sqlite'].includes(targetEntry.driver)) throw error('INVALID_DESTINATION', 'Configuração de banco de teste inválida.');
  if (targetEntry.driver === 'sqlite') {
    if (settings.production || !targetEntry.path) throw error('INVALID_DESTINATION', 'Produção exige um MySQL separado para o ensaio.');
    targetEntry = { ...targetEntry, path: resolve(targetEntry.path) };
  } else if (!targetEntry.host || !targetEntry.database || !targetEntry.user || !targetEntry.password) throw error('INVALID_DESTINATION', 'Configuração MySQL de teste incompleta.');
  for (const entry of [...Object.values(settings.entries), ...Object.values(verified.configuration.entries)]) {
    const sameDatabase = entry.driver === targetEntry.driver && (entry.driver === 'mysql'
      ? String(entry.database).toLowerCase() === String(targetEntry.database).toLowerCase()
      : samePath(resolve(entry.path), resolve(targetEntry.path)));
    if (sameDatabase) throw error('ORIGINAL_DESTINATION', 'O ensaio não pode usar um banco original, mesmo com outro usuário ou endereço.');
  }
  const db = await databaseFactory(targetEntry);
  try {
    await restoreDatabase(db, verified.content[item.file], encryptionKey, { confirmSource, sourceFingerprint: item.sourceFingerprint, destinationSlug: destination, allowDifferentDestination: destination });
    const result = await verifyRestoredDatabase(db, verified.content[item.file], encryptionKey);
    return { version: 1, state: 'ok', completedAt: new Date().toISOString(), jobId: verified.manifest.id, sourceSlug: source, destination, ...result };
  } finally { await db.close(); }
}
async function resolveRunArgument(args) {
  if (args.run !== 'latest') return args.run;
  const root = await privateLocation(args.directory || process.env.RAEL_BACKUP_DIRECTORY || '');
  if (!args.directory && !process.env.RAEL_BACKUP_DIRECTORY) throw error('INVALID_ARGUMENTS', 'Informe a pasta dos backups para selecionar latest.');
  const statusFile = await privateLocation(args['status-file'] || process.env.RAEL_BACKUP_STATUS_FILE || join(root, 'status.json'));
  await regularFile(statusFile);
  const status = JSON.parse(await readFile(statusFile, 'utf8'));
  if (status.state !== 'ok' || !runPattern.test(status.jobId ?? '')) throw error('NO_SUCCESSFUL_RUN', 'A última tentativa precisa estar concluída e verificada.');
  return join(root, status.jobId);
}
async function prepareRestoreReport(path) {
  const report = await privateLocation(path);
  if (!/^restore-status(?:-[a-z0-9-]{1,48})?\.json$/.test(basename(report))) throw error('UNSAFE_OUTPUT', 'Use um arquivo próprio chamado restore-status.json para o relatório.');
  try {
    await regularFile(report);
    const previous = JSON.parse(await readFile(report, 'utf8'));
    if (previous?.version !== 1 || previous.kind !== 'restore-drill' || !['ok', 'failed'].includes(previous.state)) throw error('UNSAFE_OUTPUT', 'O arquivo existente não é um relatório do ensaio.');
  } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
  return report;
}

export async function backupCommand(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv, args = {};
  for (let i = 0; i < rest.length; i += 2) { if (!rest[i]?.startsWith('--') || rest[i + 1] === undefined || Object.hasOwn(args, rest[i].slice(2))) throw error('INVALID_ARGUMENTS', 'Use pares --opção valor sem repetição.'); args[rest[i].slice(2)] = rest[i + 1]; }
  const allowed = ['directory', 'key-file', 'status-file', 'retention-days', 'run', 'source', 'destination', 'confirm-source', 'allow-different-destination', 'output', 'target-env', 'report-file'];
  if (Object.keys(args).some(name => !allowed.includes(name))) throw error('INVALID_ARGUMENTS', 'Opção desconhecida.');
  const keyFile = args['key-file'] || process.env.RAEL_BACKUP_KEY_FILE;
  if (!keyFile && !process.env.RAEL_BACKUP_KEY) throw error('INVALID_KEY', 'Configure RAEL_BACKUP_KEY ou informe --key-file com o caminho privado da chave.');
  if (command === 'run') {
    const directory = args.directory || process.env.RAEL_BACKUP_DIRECTORY;
    if (!directory) throw error('INVALID_ARGUMENTS', 'Informe --directory com uma pasta privada exclusiva.');
    const result = await runBackupJob({ directory, keyFile, statusFile: args['status-file'], retentionDays: Number(args['retention-days'] ?? 30) });
    console.log(JSON.stringify({ state: 'ok', ...result }));
  } else if (['verify', 'restore', 'config-export', 'restore-drill'].includes(command)) {
    if (!args.run) throw error('INVALID_ARGUMENTS', 'Informe --run com a pasta do lote.');
    const runDirectory = await resolveRunArgument(args), key = await readBackupKey(keyFile, runDirectory), verified = await verifyBackupRun(runDirectory, key);
    if (command === 'verify') console.log(JSON.stringify({ state: 'verified', jobId: verified.manifest.id, tenantCount: verified.manifest.tenantCount }));
    else if (command === 'restore-drill') {
      if (args['target-env'] !== 'RAEL_RESTORE_TEST_JSON') throw error('INVALID_DESTINATION', 'Use --target-env RAEL_RESTORE_TEST_JSON com o banco descartável de teste.');
      const root = args.directory || process.env.RAEL_BACKUP_DIRECTORY;
      const reportFile = args['report-file'] || (root ? join(root, 'restore-status.json') : null);
      if (!reportFile) throw error('INVALID_ARGUMENTS', 'Informe --report-file privado para registrar o resultado do ensaio.');
      const report = await prepareRestoreReport(reportFile);
      if (isInside(report, await privateLocation(runDirectory)) || (keyFile && samePath(report, await privateLocation(keyFile)))) throw error('UNSAFE_OUTPUT', 'O relatório deve ficar fora do lote e não pode sobrescrever a chave.');
      try {
        const targetEntry = JSON.parse(process.env.RAEL_RESTORE_TEST_JSON || 'null');
        const result = await restoreBackupDrill({ runDirectory, key, source: args.source, confirmSource: args['confirm-source'], destination: args.destination, targetEntry });
        await atomicPrivateWrite(report, JSON.stringify({ ...result, kind: 'restore-drill' }, null, 2));
        console.log(JSON.stringify({ state: result.state, matched: result.matched, integrationsActivated: false, jobId: result.jobId }));
      } catch (failure) {
        await atomicPrivateWrite(report, JSON.stringify({ version: 1, kind: 'restore-drill', state: 'failed', completedAt: new Date().toISOString(), errorCode: 'RESTORE_DRILL_FAILED' }));
        throw failure;
      }
    }
    else if (command === 'config-export') {
      if (!args.output) throw error('INVALID_ARGUMENTS', 'Informe um arquivo privado em --output.');
      const output = await privateLocation(args.output), run = await privateLocation(runDirectory);
      if (isInside(output, run) || (keyFile && samePath(output, await privateLocation(keyFile)))) throw error('UNSAFE_OUTPUT', 'Exporte fora do lote e sem sobrescrever a chave.');
      try { await lstat(output); throw error('OUTPUT_EXISTS', 'A exportação não sobrescreve arquivos existentes.'); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
      await atomicPrivateWrite(output, JSON.stringify(verified.configuration, null, 2));
      console.log('Configuração descriptografada gravada em arquivo privado. Proteja o arquivo e remova-o após a recuperação.');
    } else {
      if (!validSlug(args.source) || !validSlug(args.destination) || args['confirm-source'] !== args.source) throw error('SOURCE_CONFIRMATION', 'Informe --source, --destination e --confirm-source com a origem exata.');
      const item = verified.manifest.tenants.find(tenant => tenant.slug === args.source);
      if (!item) throw error('SOURCE_MISMATCH', 'Origem ausente no lote.');
      const config = await loadConfiguration();
      await hydrateManagedTenants(config);
      const entry = config.entries[args.destination];
      if (!entry) throw error('DESTINATION_MISSING', 'Configure o banco vazio de destino antes de restaurar.');
      if (args.destination !== args.source && args['allow-different-destination'] !== args.destination) throw error('DESTINATION_CONFIRMATION', 'Confirme explicitamente a mudança de negócio com --allow-different-destination.');
      const db = await openDatabase(entry);
      try { await restoreDatabase(db, verified.content[item.file], key, { confirmSource: args.source, sourceFingerprint: item.sourceFingerprint, destinationSlug: args.destination, allowDifferentDestination: args['allow-different-destination'] }); }
      finally { await db.close(); }
      console.log('Dados restaurados em banco vazio. Sessões, links e credenciais de integração não foram ativados. Confira a configuração privada antes de liberar o negócio.');
    }
  } else throw error('INVALID_ARGUMENTS', 'Comandos: run, verify, restore-drill, restore, config-export.');
}
export function reportBackupCommandFailure(failure) {
  const code = /^[A-Z0-9_]{1,60}$/.test(failure.code ?? '') ? failure.code : 'BACKUP_FAILED';
  console.error(`Operação de backup falhou (${code}). Consulte o status privado e o procedimento operacional; detalhes sensíveis não são impressos.`);
  process.exitCode = 1;
}
isMainModule(import.meta.url).then(main => main ? backupCommand() : undefined).catch(reportBackupCommandFailure);
