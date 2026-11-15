import { access, copyFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
for (const file of ['termos.html', 'privacidade.html', 'legal.css']) {
  await copyFile(new URL(`legal/${file}`, root), new URL(`dist/${file}`, root));
}
for (const file of ['dist/metadata.js', 'dist/legal-links.css', 'dist/index.html', 'dist/vitrine.css', 'dist/acesso-cliente.html', 'dist/entrada.js', 'dist/entrada.css', 'dist/styles.css', 'dist/favicon.svg',
  'dist/robots.txt', 'dist/version.json', 'dist/theme.css', 'dist/theme.js', 'dist/workspace.js', 'dist/workspace.css', 'dist/notifications.js', 'dist/notifications.css', 'dist/notifications-sw.js', 'dist/notification-icon.png', 'dist/notification-badge.png', 'dist/app-logo-v4.png', 'dist/app-icon-v4-192.png', 'dist/app-icon-v4-512.png', 'dist/manifest.webmanifest', 'dist/sistema.html', 'dist/sistema.css', 'dist/sistema.js', 'dist/recovery.js', 'dist/recovery.css', 'dist/agendar.html', 'dist/agendar.css', 'dist/agendar.js', 'dist/agenda.js', 'dist/pagamento.js', 'dist/assinaturas.html', 'dist/assinaturas.css', 'dist/assinaturas.js', 'dist/gestao.html', 'dist/gestao.css', 'dist/gestao.js', 'dist/traffic-view.js', 'dist/gestao-csv.js', 'dist/mp-config.html', 'dist/mp-config.css', 'dist/mp-config.js', 'server.js']) {
  await access(new URL(file, root));
}
for (const file of ['server.js', 'dist/entrada.js', 'dist/metadata.js', 'dist/mp-config.js', 'dist/theme.js', 'dist/workspace.js', 'dist/notifications.js', 'dist/notifications-sw.js', 'dist/recovery.js', 'dist/sistema.js', 'dist/agendar.js', 'dist/agenda.js', 'dist/pagamento.js', 'dist/assinaturas.js', 'dist/gestao.js', 'dist/traffic-view.js', 'dist/gestao-csv.js', ...(await readdir(new URL('src/', root))).filter(name => name.endsWith('.mjs')).map(name => `src/${name}`), ...(await readdir(new URL('tools/', root))).filter(name => name.endsWith('.mjs')).map(name => `tools/${name}`)]) {
  execFileSync(process.execPath, ['--check', fileURLToPath(new URL(file, root))], { stdio: 'inherit' });
}
console.log('Base e frontend verificados. Inicialização: node server.js.');
