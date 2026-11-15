import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFile, lstat, realpath, open, unlink } from 'node:fs/promises';
import { resolve, dirname, basename, join, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isMainModule } from '../src/cli-entry.mjs';

export const driveFileScope = 'https://www.googleapis.com/auth/drive.file';
export const backupFolderName = 'Raelapps - Backups cifrados';
const projectDirectory = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const runFile = promisify(execFile);
const messages = {
  ARGUMENTS: 'Informe --client-file, --output e --account, sem opções adicionais.',
  PRIVATE_PATH: 'Use caminhos absolutos privados, fora do projeto e da publicação, em uma pasta privada já existente.',
  PRIVATE_ACCESS: 'As permissões não estão protegidas. Restrinja a pasta e o arquivo ao proprietário antes de continuar.',
  CLIENT_FILE: 'Não foi possível ler um arquivo privado válido de cliente OAuth do tipo Desktop.',
  OUTPUT_EXISTS: 'O arquivo de destino já existe. Escolha um arquivo novo; nada será sobrescrito.',
  OUTPUT_WRITE: 'Não foi possível salvar a configuração privada. Nenhum sucesso foi confirmado.',
  OAUTH_LIBRARY: 'Não foi possível carregar a biblioteca oficial de autorização do Google.',
  LISTENER: 'Não foi possível abrir o retorno local em 127.0.0.1.',
  AUTH_URL: 'Não foi possível preparar um endereço de autorização restrito para o Google.',
  CANCELLED: 'Autorização cancelada. Nenhuma configuração foi concluída.',
  TIMEOUT: 'A autorização expirou. Execute novamente e conclua a autorização em até cinco minutos.',
  DENIED: 'A autorização foi recusada no Google. Nenhuma configuração foi concluída.',
  TOKEN_EXCHANGE: 'Não foi possível conferir a autorização recebida do Google.',
  REFRESH_TOKEN: 'O Google não retornou acesso offline. Refaça a autorização com consentimento explícito.',
  TOKEN_SCOPE: 'A autorização não está restrita à aplicação e ao acesso de arquivos solicitado. Nenhuma pasta foi criada.',
  ACCOUNT: 'A conta autorizada não corresponde à conta indicada. Nenhuma pasta foi criada.',
  FOLDER: 'Não foi possível confirmar a criação de uma pasta privada. Confira a conta antes de repetir.',
};
function fail(code) { return Object.assign(new Error(messages[code] || messages.OUTPUT_WRITE), { code, safeDriveAuthorization: true }); }
function safeError(error, fallback) { return error?.safeDriveAuthorization === true ? error : fail(fallback); }
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const within = (path, root) => samePath(path, root) || (process.platform === 'win32' ? path.toLowerCase().startsWith(root.toLowerCase() + sep) : path.startsWith(root + sep));
const email = value => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? value.trim().toLowerCase() : null;

// Paths travel through an environment variable, never an interpolated shell command.
const aclScript = `
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('RAEL_DRIVE_ACL_TARGET','Process')
$action = [Environment]::GetEnvironmentVariable('RAEL_DRIVE_ACL_ACTION','Process')
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($action -eq 'protect-new-file') {
  $acl = New-Object Security.AccessControl.FileSecurity
  $acl.SetOwner($identity)
  $acl.SetAccessRuleProtection($true,$false)
  foreach ($sid in @($identity.Value,'S-1-5-18')) {
    $principal = New-Object Security.Principal.SecurityIdentifier($sid)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($principal,'FullControl','Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $target -AclObject $acl
}
$acl = Get-Acl -LiteralPath $target
$trusted = @($identity.Value,'S-1-5-18','S-1-5-32-544')
$privateRules = $true
foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $trusted -notcontains $rule.IdentityReference.Value) { $privateRules = $false }
}
@{protected=$acl.AreAccessRulesProtected;ownerAllowed=($trusted -contains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value);privateRules=$privateRules} | ConvertTo-Json -Compress
`;
async function windowsAcl(path, protect = false) {
  try {
    const environment = { ...process.env, RAEL_DRIVE_ACL_TARGET: path, RAEL_DRIVE_ACL_ACTION: protect ? 'protect-new-file' : 'inspect' };
    // A parent PowerShell 7 module path is incompatible with Windows PowerShell
    // 5.1. Let the child initialize its own standard security module path.
    for (const key of Object.keys(environment)) if (key.toLowerCase() === 'psmodulepath') delete environment[key];
    const { stdout } = await runFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', aclScript], { env: environment, windowsHide: true, timeout: 10000, maxBuffer: 8192 });
    return JSON.parse(stdout.trim());
  } catch { throw fail('PRIVATE_ACCESS'); }
}
export async function assertPrivateAccess(path, { directory = false, protectedAcl = false, platform = process.platform, inspectWindows = windowsAcl } = {}) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) throw fail('PRIVATE_ACCESS');
  if (platform === 'win32') {
    const acl = await inspectWindows(path);
    if (acl?.ownerAllowed !== true || acl.privateRules !== true || protectedAcl && acl.protected !== true) throw fail('PRIVATE_ACCESS');
  } else if ((info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) throw fail('PRIVATE_ACCESS');
}
async function privatePath(value, { existing = false } = {}) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || !isAbsolute(value) || /[\u0000-\u001f]/.test(value) || process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(value)) throw fail('PRIVATE_PATH');
  if (process.platform === 'win32' && value.slice(2).includes(':')) throw fail('PRIVATE_PATH');
  const absolute = resolve(value), blocked = path => within(path, projectDirectory) || path.split(/[\\/]+/).some(part => ['.git', 'dist', 'public', 'public_html', 'htdocs', 'wwwroot'].includes(part.toLowerCase()));
  let parent;
  try { parent = await realpath(dirname(absolute)); } catch { throw fail('PRIVATE_PATH'); }
  const canonical = join(parent, basename(absolute));
  if (blocked(absolute) || blocked(canonical)) throw fail('PRIVATE_PATH');
  if (existing) {
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || !samePath(await realpath(absolute), canonical)) throw fail('CLIENT_FILE');
  }
  return canonical;
}
async function ensureAbsent(path) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw fail('OUTPUT_WRITE'); }
  throw fail('OUTPUT_EXISTS');
}
async function readClient(path, checkAccess) {
  try {
    await checkAccess(dirname(path), { directory: true, protectedAcl: true });
    await checkAccess(path);
    const info = await lstat(path);
    if (info.size > 65536) throw fail('CLIENT_FILE');
    const data = JSON.parse(await readFile(path, 'utf8')), client = data?.installed;
    if (!client || data.web || !/^\d+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(client.client_id ?? '') || typeof client.client_secret !== 'string' || client.client_secret.length < 4 || client.client_secret.length > 1024 || /[\u0000-\u001f]/.test(client.client_secret)) throw fail('CLIENT_FILE');
    return { clientId: client.client_id, clientSecret: client.client_secret };
  } catch (error) { throw safeError(error, 'CLIENT_FILE'); }
}
async function saveConfiguration(path, value, { checkAccess, protectFile, checkActive }) {
  let file, created = false, identity;
  try {
    checkActive();
    const checked = await privatePath(path);
    if (!samePath(checked, path)) throw fail('PRIVATE_PATH');
    await checkAccess(dirname(path), { directory: true, protectedAcl: true });
    await ensureAbsent(path);
    file = await open(path, 'wx', 0o600); created = true; identity = await file.stat();
    if (process.platform !== 'win32') await file.chmod(0o600);
    await protectFile(path);
    await checkAccess(path, { protectedAcl: true });
    checkActive();
    await file.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await file.sync();
    await checkAccess(path, { protectedAcl: true });
    const final = await lstat(path);
    if (final.isSymbolicLink() || final.dev !== identity.dev || final.ino !== identity.ino || !samePath(await privatePath(path), path)) throw fail('OUTPUT_WRITE');
    checkActive();
  } catch (error) {
    if (file) { await file.close().catch(() => {}); file = null; }
    if (created) {
      const actual = await lstat(path).catch(() => null);
      if (actual && !actual.isSymbolicLink() && actual.dev === identity?.dev && actual.ino === identity?.ino) await unlink(path).catch(() => {});
    }
    throw error.code === 'EEXIST' ? fail('OUTPUT_EXISTS') : safeError(error, 'OUTPUT_WRITE');
  } finally { await file?.close().catch(() => {}); }
}
const defaultProtectFile = async path => { if (process.platform === 'win32') await windowsAcl(path, true); };

/** Only called locally. Importing this module opens no socket and loads no OAuth library. */
export async function startDriveAuthorization({ clientFile, output, account, timeoutMs = 300000, signal, onStatus } = {}, dependencies = {}) {
  const expectedEmail = email(account);
  if (!expectedEmail || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000) throw fail('ARGUMENTS');
  const checkAccess = dependencies.checkAccess ?? assertPrivateAccess, protectFile = dependencies.protectFile ?? defaultProtectFile;
  const [clientPath, outputPath] = await Promise.all([privatePath(clientFile, { existing: true }), privatePath(output)]).catch(error => { throw safeError(error, 'PRIVATE_PATH'); });
  await checkAccess(dirname(outputPath), { directory: true, protectedAcl: true }); await ensureAbsent(outputPath);
  const client = await readClient(clientPath, checkAccess);
  if (signal?.aborted) throw fail('CANCELLED');
  let OAuth2Client;
  try { ({ OAuth2Client } = await (dependencies.loadOAuth ?? (() => import('google-auth-library')))()); if (typeof OAuth2Client !== 'function') throw Error(); }
  catch { throw fail('OAUTH_LIBRARY'); }
  const state = randomBytes(32).toString('base64url'), verifier = randomBytes(64).toString('base64url'), challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  const controller = new AbortController();
  let claimed = false, settled = false, auth, redirectUri, callbackOrigin, timer, resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; }); done.catch(() => {});
  const notify = status => { try { onStatus?.(status); } catch {} };
  const checkActive = () => { if (settled || controller.signal.aborted) throw fail('CANCELLED'); };
  const server = (dependencies.createServer ?? createServer)((request, response) => { handle(request, response).catch(() => finish(fail('TOKEN_EXCHANGE'), response)); });
  server.requestTimeout = 15000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxRequestsPerSocket = 1; server.maxConnections = 8;
  function reply(response, status, message) {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', Connection: 'close' });
    response.end(message);
  }
  async function finish(error, response) {
    if (settled) return;
    settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
    controller.abort();
    if (response) reply(response, error ? 400 : 200, error ? 'Não foi possível concluir a configuração. Volte ao terminal para conferir a orientação.' : 'Configuração privada salva. Pode fechar esta aba e voltar ao terminal.');
    const closed = new Promise(resolve => server.close(resolve));
    if (!response) server.closeAllConnections?.();
    await closed;
    if (error) { notify(error.code === 'CANCELLED' ? 'cancelled' : 'failed'); rejectDone(safeError(error, 'TOKEN_EXCHANGE')); }
    else { notify('complete'); resolveDone({ output: outputPath, folderCreated: true }); }
  }
  function abort() { void finish(fail('CANCELLED')); }
  async function step(operation, code) {
    checkActive();
    try { const result = await operation(); checkActive(); return result; }
    catch (error) { throw safeError(error, code); }
  }
  async function handle(request, response) {
    if (request.method !== 'GET') { reply(response, 405, 'Método não permitido.'); return; }
    if (!redirectUri || request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== new URL(redirectUri).host || request.headers.origin && request.headers.origin !== callbackOrigin) { reply(response, 403, 'Retorno local inválido.'); return; }
    let url;
    try { if (typeof request.url !== 'string' || request.url.length > 8192) throw Error(); url = new URL(request.url, callbackOrigin); } catch { reply(response, 400, 'Retorno inválido.'); return; }
    if (url.origin !== callbackOrigin || url.pathname !== '/oauth2callback' || url.hash) { reply(response, 404, 'Endereço não encontrado.'); return; }
    const supplied = url.searchParams.get('state');
    if (url.searchParams.getAll('state').length !== 1 || !/^[a-zA-Z0-9_-]{43}$/.test(supplied ?? '') || !timingSafeEqual(Buffer.from(supplied), Buffer.from(state))) { reply(response, 400, 'Confirmação inválida. Use o link de autorização do terminal.'); return; }
    if (claimed || settled) { reply(response, 409, 'Este retorno já foi recebido. Confira o terminal.'); return; }
    if (url.searchParams.has('error') && !url.searchParams.has('code')) { claimed = true; await finish(fail('DENIED'), response); return; }
    const code = url.searchParams.get('code');
    if (url.searchParams.getAll('code').length !== 1 || !code || code.length > 4096 || /[\u0000-\u001f]/.test(code) || url.searchParams.has('error')) { reply(response, 400, 'Código de autorização inválido.'); return; }
    claimed = true;
    try {
      notify('checking_authorization');
      const result = await step(() => auth.getToken({ code, codeVerifier: verifier, redirect_uri: redirectUri }), 'TOKEN_EXCHANGE');
      const tokens = result?.tokens;
      if (typeof tokens?.access_token !== 'string' || !tokens.access_token || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) throw fail('REFRESH_TOKEN');
      auth.setCredentials(tokens);
      const info = await step(() => auth.getTokenInfo(tokens.access_token), 'TOKEN_SCOPE');
      if (info?.aud !== client.clientId || !Array.isArray(info.scopes) || info.scopes.length !== 1 || info.scopes[0] !== driveFileScope || !Number.isFinite(info.expiry_date) || info.expiry_date <= Date.now()) throw fail('TOKEN_SCOPE');
      notify('checking_account');
      const about = await step(() => auth.request({ url: 'https://www.googleapis.com/drive/v3/about', method: 'GET', params: { fields: 'user(emailAddress,me)' }, timeout: 15000, retry: false, signal: controller.signal }), 'ACCOUNT');
      if (email(about?.data?.user?.emailAddress) !== expectedEmail || about.data.user.me === false) throw fail('ACCOUNT');
      checkActive(); notify('creating_folder');
      const created = await step(() => auth.request({ url: 'https://www.googleapis.com/drive/v3/files', method: 'POST', params: { fields: 'id,name,mimeType,ownedByMe,shared,trashed,driveId' }, data: { name: backupFolderName, mimeType: 'application/vnd.google-apps.folder', description: 'Backups cifrados do Rael Agendamentos. A chave de recuperação permanece fora do Drive.' }, timeout: 15000, retry: false, signal: controller.signal }), 'FOLDER');
      const folder = created?.data;
      if (!/^[a-zA-Z0-9_-]{10,200}$/.test(folder?.id ?? '') || folder.name !== backupFolderName || folder.mimeType !== 'application/vnd.google-apps.folder' || folder.ownedByMe !== true || folder.shared !== false || folder.trashed === true || folder.driveId) throw fail('FOLDER');
      checkActive(); notify('saving_configuration');
      await saveConfiguration(outputPath, { clientId: client.clientId, clientSecret: client.clientSecret, refreshToken: tokens.refresh_token, folderId: folder.id, expectedEmail }, { checkAccess, protectFile, checkActive });
      checkActive(); await finish(null, response);
    } catch (error) { await finish(safeError(error, 'TOKEN_EXCHANGE'), response); }
  }
  await new Promise((resolve, reject) => { server.once('error', () => reject(fail('LISTENER'))); server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve); });
  const address = server.address(); redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`; callbackOrigin = new URL(redirectUri).origin;
  try {
    if (signal?.aborted) throw fail('CANCELLED');
    auth = new OAuth2Client({ ...client, redirectUri, transporterOptions: { timeout: 15000, retry: false, signal: controller.signal } });
    // Library token helpers set their own retry defaults. Override at the final
    // transport boundary too, without logging requests, tokens or raw errors.
    if (typeof auth.transporter?.request === 'function') {
      const transport = auth.transporter.request.bind(auth.transporter);
      auth.transporter.request = options => {
        checkActive();
        const url = new URL(String(options.url));
        if (!['https://oauth2.googleapis.com/token', 'https://oauth2.googleapis.com/tokeninfo', 'https://www.googleapis.com/drive/v3/about', 'https://www.googleapis.com/drive/v3/files'].includes(url.origin + url.pathname) || url.username || url.password || url.hash) throw fail('TOKEN_EXCHANGE');
        return transport({ ...options, signal: controller.signal, timeout: 15000, maxRedirects: 0, retry: false, retryConfig: { retry: 0, noResponseRetries: 0 } });
      };
    }
    const authorizationUrl = auth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', include_granted_scopes: false, scope: [driveFileScope], state, login_hint: expectedEmail, code_challenge: challenge, code_challenge_method: 'S256' });
    const url = new URL(authorizationUrl);
    if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth' || url.searchParams.get('scope') !== driveFileScope || url.searchParams.get('state') !== state || url.searchParams.get('redirect_uri') !== redirectUri || url.searchParams.get('code_challenge') !== challenge || url.searchParams.get('code_challenge_method') !== 'S256' || url.searchParams.get('include_granted_scopes') !== 'false' || url.searchParams.get('access_type') !== 'offline' || url.searchParams.get('prompt') !== 'consent' || url.searchParams.get('response_type') !== 'code' || url.searchParams.get('client_id') !== client.clientId || url.searchParams.has('client_secret')) throw fail('AUTH_URL');
    timer = setTimeout(() => { void finish(fail('TIMEOUT')); }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    notify('waiting');
    return { authorizationUrl, redirectUri, done, cancel: abort };
  } catch (error) { await finish(safeError(error, 'AUTH_URL')); throw safeError(error, 'AUTH_URL'); }
}

export async function main(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!['--client-file', '--output', '--account'].includes(key) || Object.hasOwn(args, key) || typeof argv[index + 1] !== 'string' || argv[index + 1].startsWith('--')) throw fail('ARGUMENTS');
    args[key] = argv[index + 1];
  }
  if (Object.keys(args).length !== 3) throw fail('ARGUMENTS');
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const statuses = { checking_authorization: 'Conferindo a autorização.', checking_account: 'Conferindo a conta indicada.', creating_folder: 'Criando a pasta privada do aplicativo.', saving_configuration: 'Salvando a configuração privada.' };
    const flow = await startDriveAuthorization({ clientFile: args['--client-file'], output: args['--output'], account: args['--account'], signal: controller.signal, onStatus: status => { if (statuses[status]) process.stdout.write(statuses[status] + '\n'); } });
    process.stdout.write('Abra este endereço no Chrome do perfil autorizado e confira a conta antes de permitir:\n' + flow.authorizationUrl + '\nAguardando autorização local por até cinco minutos. Ctrl+C cancela.\n');
    await flow.done;
    process.stdout.write('Configuração privada salva. Nenhum backup foi enviado por este comando.\n');
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
if (await isMainModule(import.meta.url)) main().catch(error => { const safe = safeError(error, 'OUTPUT_WRITE'); process.stderr.write(`${safe.code}: ${safe.message}\n`); process.exitCode = 1; });
