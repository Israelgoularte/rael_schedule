import sharp from 'sharp';
import { failure } from './security.mjs';
sharp.cache({ memory: 8, files: 0, items: 16 });
sharp.concurrency(1);
let processing = 0;

// Re-encode raster images; original metadata and filenames are never published.
export async function normalizeImage(data, kind) {
  if (typeof data !== 'string' || data.length > 2800000) throw failure(422, 'Escolha uma imagem JPG, PNG ou WebP de até 2 MB após o ajuste.');
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
  if (!match) throw failure(422, 'Use uma imagem JPG, PNG ou WebP válida.');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw failure(422, 'A imagem precisa ter até 2 MB após o ajuste.');
  if (processing >= 2) throw failure(429, 'Há imagens sendo salvas. Aguarde alguns segundos e tente novamente.');
  processing++;
  try {
    const image = sharp(bytes, { failOn: 'warning', limitInputPixels: 20000000, animated: false });
    const meta = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(meta.format) || meta.format !== match[1] || (meta.pages ?? 1) > 1) throw new Error('Unsupported raster');
    const output = await image.rotate().resize(512, 512, { fit: kind === 'logo' ? 'inside' : 'cover', withoutEnlargement: true }).webp({ quality: 82, effort: 3 }).toBuffer();
    if (output.length > 512 * 1024) throw new Error('Output too large');
    return output.toString('base64');
  } catch { throw failure(422, 'Não foi possível ler essa imagem. Escolha outro arquivo JPG, PNG ou WebP.'); }
  finally { processing--; }
}
