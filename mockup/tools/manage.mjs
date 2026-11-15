import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validSlug } from '../src/configuration.mjs';
import { loadStandaloneConfiguration } from '../src/standalone.mjs';
import { openDatabase } from '../src/database.mjs';
import { provisionTenant, audit } from '../src/service.mjs';
import { token, digest, normalizeEmail } from '../src/security.mjs';
import { backupDatabase, restoreDatabase } from '../src/backup.mjs';
import { createLicense } from '../src/license.mjs';
import { hydrateManagedTenants } from '../src/tenant-registry.mjs';

const [command, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i += 2) { if (!rest[i].startsWith('--') || rest[i + 1] === undefined) throw new Error('Use pares --opção valor.'); args[rest[i].slice(2)] = rest[i + 1]; }
async function privateWrite(path, content) { const target = resolve(path); const publicDir = resolve(fileURLToPath(new URL('../dist', import.meta.url))); if (target === publicDir || target.startsWith(publicDir + sep)) throw new Error('Não grave segredos ou backups nos arquivos públicos.'); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, content, { mode: 0o600 }); await chmod(target, 0o600); console.log(`Arquivo privado gravado: ${target}`); }
if (command === 'init-local') {
  const slug = args.slug ?? 'validacao';
  if (!validSlug(slug)) throw new Error('Identificador inválido.');
  const origin = args.origin ?? 'http://127.0.0.1:3217';
  if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('A inicialização local só aceita endereço de loopback.');
  const dir = resolve(args.dir ?? '../.data');
  const manifestFile = resolve(dir, 'tenants.json');
  let entries = {};
  try { entries = JSON.parse(await readFile(manifestFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (Object.hasOwn(entries, slug)) throw new Error('O negócio já existe. Não sobrescrevemos acessos ou dados.');
  const value = token();
  entries[slug] = { driver: 'sqlite', path: resolve(dir, `${slug}.sqlite`), bootstrap: { name: args.name ?? 'Negócio de validação', ownerName: args.owner ?? 'Administrador de testes', ownerEmail: args.email ?? 'admin@example.com', activationHash: digest(value), expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 } };
  await privateWrite(manifestFile, JSON.stringify(entries, null, 2));
  await privateWrite(resolve(dir, `primeiro-acesso-${slug}.txt`), `${origin}/sistema/${slug}#ativar=${value}\n`);
  console.log(`Ative RAEL_SYSTEM_ENABLED=1, RAEL_TEST_MODE=1, RAEL_PUBLIC_ORIGIN=${origin} e RAEL_TENANTS_FILE=${manifestFile}. O link pessoal está no arquivo privado acima.`);
} else {
  const config = await loadStandaloneConfiguration();
  await hydrateManagedTenants(config);
  const entry = config.entries[args.slug];
  if (!Object.hasOwn(config.entries, args.slug)) throw new Error('Negócio não configurado.');
  const db = await openDatabase(entry);
  try {
    if (command === 'migrate') {
      if (entry.bootstrap) await provisionTenant(db, entry.bootstrap);
      await createLicense(db, args.slug, { ...config, license: entry.license ?? { enforced: false } }).initialize();
      console.log('Esquema e provisionamento conferidos.');
    } else if (command === 'backup') {
      if (!args.output) throw new Error('Informe --output fora dos arquivos públicos.');
      const output = resolve(args.output);
      if (output.toLowerCase().includes(`${process.platform === 'win32' ? '\\' : '/'}dist${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Não grave backups na publicação.');
      await privateWrite(output, await backupDatabase(db, process.env.RAEL_BACKUP_KEY));
    } else if (command === 'restore') {
      await restoreDatabase(db, await readFile(resolve(args.input), 'utf8'), process.env.RAEL_BACKUP_KEY);
      console.log('Backup restaurado em banco vazio. Sessões e links antigos foram descartados.');
    } else if (command === 'recover-admin') {
      if (!args.output) throw new Error('Informe --output para receber o link privado.');
      const email = normalizeEmail(args.email), value = token();
      await db.transaction(async tx => {
        const [user] = await tx.query("SELECT * FROM users WHERE email = ? AND role = 'admin' AND active = 1" + tx.lock, [email]);
        if (!user) throw new Error('Administrador não encontrado.');
        await tx.query('UPDATE account_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL', [Date.now(), user.id]);
        await tx.query('INSERT INTO account_tokens(token_hash, user_id, kind, expires_at, used_at) VALUES (?, ?, ?, ?, ?)', [digest(value), user.id, 'reset', Date.now() + 30 * 60 * 1000, null]);
        await audit(tx, null, 'operator_admin_recovery_created', { userId: user.id });
      });
      await privateWrite(args.output, `${config.origin}/sistema/${args.slug}#recuperar=${value}\n`);
      console.log('Link válido por 30 minutos; compartilhar somente após verificar a identidade do administrador. Nenhum e-mail foi enviado.');
    } else throw new Error('Comando desconhecido. Use init-local, migrate, backup, restore ou recover-admin.');
  } finally { await db.close(); }
}
