import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

// Technical exports of the approved artwork, without changing its composition.
const source = await readFile(new URL('../../assets/branding/rael-agendamentos-logo-v4.png', import.meta.url));
const root = new URL('../dist/', import.meta.url);
for (const [name, size] of [['app-logo-v4.png', 512], ['app-icon-v4-192.png', 192], ['app-icon-v4-512.png', 512], ['notification-icon.png', 192]]) {
  await sharp(source).resize(size, size, { fit: 'contain' }).png({ compressionLevel: 9 }).toFile(fileURLToPath(new URL(name, root)));
}
const favicon = await sharp(source).resize(64, 64, { fit: 'contain' }).png({ compressionLevel: 9 }).toBuffer();
await writeFile(new URL('favicon.svg', root), `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><image width="64" height="64" href="data:image/png;base64,${favicon.toString('base64')}"/></svg>\n`);
console.log('Logo aprovada exportada em 512/192 e favicon 64; selo monocromático de notificação preservado.');
