import { createHash } from 'node:crypto';
import sharp from 'sharp';

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const imageCache = new Map();
const imageSize = 512;

// Only values selected from the published business record reach this helper.
// The image version includes the tenant, so two businesses can never share an
// image URL even when they happen to use the same name or bitmap.
export function publicShareIdentity(slug, publishedBusiness, logoVersion = null) {
  const businessName = typeof publishedBusiness?.name === 'string' ? publishedBusiness.name.trim() : '';
  if (!businessName) return null;
  const description = typeof publishedBusiness.description === 'string' ? publishedBusiness.description.trim().slice(0, 240) : '';
  const version = createHash('sha256').update(JSON.stringify([slug, businessName, description, logoVersion])).digest('hex').slice(0, 32);
  return { businessName, description, version, imagePath: `/social/${slug}/${version}.png` };
}

export function injectPublicShareMetadata(html, { origin, area, slug, businessName, description, imagePath }) {
  const company = businessName;
  const title = area === 'planos' ? `Planos e assinaturas · ${company}` : `Agende seu horário · ${company}`;
  const summary = description || (area === 'planos'
    ? `Conheça os planos e assinaturas de ${company}. Confira os serviços incluídos e escolha seu plano.`
    : `Agende seu atendimento com ${company}. Escolha o serviço, o profissional e o melhor horário para você.`);
  // Never use the request Host, query, fragment, or attribution metadata here.
  const pageUrl = new URL(`/${area}/${slug}`, origin).href;
  const imageUrl = new URL(imagePath, origin).href;
  const tags = [
    ['name', 'description', summary],
    ['property', 'og:type', 'website'],
    ['property', 'og:locale', 'pt_BR'],
    ['property', 'og:site_name', company],
    ['property', 'og:title', title],
    ['property', 'og:description', summary],
    ['property', 'og:url', pageUrl],
    ['property', 'og:image', imageUrl],
    ['property', 'og:image:secure_url', imageUrl],
    ['property', 'og:image:type', 'image/png'],
    ['property', 'og:image:width', String(imageSize)],
    ['property', 'og:image:height', String(imageSize)],
    ['property', 'og:image:alt', `Logo de ${company}`],
    ['name', 'twitter:card', 'summary'],
    ['name', 'twitter:title', title],
    ['name', 'twitter:description', summary],
    ['name', 'twitter:image', imageUrl],
    ['name', 'twitter:image:alt', `Logo de ${company}`],
  ].map(([attribute, name, value]) => `<meta ${attribute}="${name}" content="${escapeHtml(value)}">`).join('\n');
  const head = html.match(/<head\b[^>]*>[\s\S]*?<\/head>/i)?.[0];
  if (!head) return html;
  let personalized = head
    .replace(/<meta\b(?=[^>]*(?:property|name)\s*=\s*["'](?:description|og:[^"']+|twitter:[^"']+)["'])[^>]*>/gi, '')
    .replace(/<link\b(?=[^>]*rel\s*=\s*["'](?:canonical|(?:shortcut\s+)?icon)["'])[^>]*>/gi, '');
  personalized = /<title\b[^>]*>[\s\S]*?<\/title>/i.test(personalized)
    ? personalized.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, () => `<title>${escapeHtml(title)}</title>`)
    : personalized.replace(/<\/head>/i, () => `<title>${escapeHtml(title)}</title>\n</head>`);
  personalized = personalized.replace(/<\/head>/i, () => `${tags}\n<link rel="canonical" href="${escapeHtml(pageUrl)}">\n<link rel="icon" type="image/png" href="${escapeHtml(imageUrl)}">\n</head>`);
  return html.replace(head, () => personalized);
}

export async function renderPublicShareImage(identity, logoBytes = null) {
  const cached = imageCache.get(identity.version);
  if (cached) return cached;
  const pending = (async () => {
    if (logoBytes) {
      // Existing public logos are normalized raster WebP. A PNG avoids requiring
      // a sharing crawler to decode WebP, and contain preserves the whole logo.
      return sharp(logoBytes, { failOn: 'warning', limitInputPixels: 20000000, animated: false })
        .resize(imageSize, imageSize, { fit: 'contain', background: '#ffffff' })
        .flatten({ background: '#ffffff' }).png({ compressionLevel: 8 }).toBuffer();
    }
    const initial = Array.from(identity.businessName.trim())[0]?.toLocaleUpperCase('pt-BR') || '?';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" rx="40" fill="#f4f2ed"/><text x="256" y="278" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="240" font-weight="700" fill="#33332d">${escapeHtml(initial)}</text></svg>`;
    return sharp(Buffer.from(svg)).png({ compressionLevel: 8 }).toBuffer();
  })();
  // Bounded per-process cache; no images or uploaded files are written to disk.
  if (imageCache.size >= 16) imageCache.delete(imageCache.keys().next().value);
  imageCache.set(identity.version, pending);
  try { return await pending; }
  catch (error) { if (imageCache.get(identity.version) === pending) imageCache.delete(identity.version); throw error; }
}
