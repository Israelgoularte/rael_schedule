import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { loadStandaloneConfiguration } from './src/standalone.mjs';
import { createFoundation } from './src/foundation.mjs';
import { createObservability } from './src/observability.mjs';
import { renderLanding } from './src/landing.mjs';
import { injectPublicShareMetadata } from './src/share-preview.mjs';

const publicFiles = new Map([
  ['/index.html', 'text/html; charset=utf-8'],
  ['/entrada.js', 'text/javascript; charset=utf-8'],
  ['/entrada.css', 'text/css; charset=utf-8'],
  ['/styles.css', 'text/css; charset=utf-8'],
  ['/theme.css', 'text/css; charset=utf-8'],
  ['/theme.js', 'text/javascript; charset=utf-8'],
  ['/workspace.js', 'text/javascript; charset=utf-8'],
  ['/workspace.css', 'text/css; charset=utf-8'],
  ['/notifications.js', 'text/javascript; charset=utf-8'],
  ['/notifications.css', 'text/css; charset=utf-8'],
  ['/notifications-sw.js', 'text/javascript; charset=utf-8'],
  ['/notification-icon.png', 'image/png'],
  ['/notification-badge.png', 'image/png'],
  ['/app-logo-v4.png', 'image/png'],
  ['/app-icon-v4-192.png', 'image/png'],
  ['/app-icon-v4-512.png', 'image/png'],
  ['/manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['/favicon.svg', 'image/svg+xml'],
  ['/robots.txt', 'text/plain; charset=utf-8'],
  ['/version.json', 'application/json; charset=utf-8'],
  ['/sistema.html', 'text/html; charset=utf-8'],
  ['/sistema.js', 'text/javascript; charset=utf-8'],
  ['/recovery.js', 'text/javascript; charset=utf-8'],
  ['/recovery.css', 'text/css; charset=utf-8'],
  ['/sistema.css', 'text/css; charset=utf-8'],
  ['/agendar.html', 'text/html; charset=utf-8'],
  ['/agendar.js', 'text/javascript; charset=utf-8'],
  ['/agendar.css', 'text/css; charset=utf-8'],
  ['/agenda.js', 'text/javascript; charset=utf-8'],
  ['/pagamento.js', 'text/javascript; charset=utf-8'],
  ['/assinaturas.html', 'text/html; charset=utf-8'],
  ['/assinaturas.js', 'text/javascript; charset=utf-8'],
  ['/assinaturas.css', 'text/css; charset=utf-8'],
  ['/gestao.html', 'text/html; charset=utf-8'],
  ['/gestao.css', 'text/css; charset=utf-8'],
  ['/gestao.js', 'text/javascript; charset=utf-8'],
  ['/gestao-csv.js', 'text/javascript; charset=utf-8'],
  ['/metadata.js', 'text/javascript; charset=utf-8'],
  ['/mp-config.html', 'text/html; charset=utf-8'],
  ['/mp-config.js', 'text/javascript; charset=utf-8'],
  ['/mp-config.css', 'text/css; charset=utf-8'],
  ['/termos.html', 'text/html; charset=utf-8'],
  ['/privacidade.html', 'text/html; charset=utf-8'],
  ['/legal.css', 'text/css; charset=utf-8'],
  ['/legal-links.css', 'text/css; charset=utf-8'],
]);
// LiteSpeed loads the entry with require(); keep the ESM graph free of top-level await.
async function start() {
const config = await loadStandaloneConfiguration();
const [standaloneSlug] = Object.keys(config.entries);
const foundation = await createFoundation(config);
await foundation.initializeStandalone(standaloneSlug);
const observability = createObservability({ foundation });
let maintenanceRunning = false;
const paymentMaintenance = setInterval(async () => { if (maintenanceRunning) return; maintenanceRunning = true; try { await foundation.maintenance(); } catch (error) { observability.failure('maintenance_failed', error); } finally { maintenanceRunning = false; } }, 60000);
paymentMaintenance.unref();
const notificationDelivery = setInterval(() => { foundation.dispatchNotifications().catch(error => observability.failure('notification_delivery_failed', error)); }, 5000);
notificationDelivery.unref();
const recoveryDelivery = setInterval(() => { foundation.dispatchRecoveryEmails().catch(error => observability.failure('recovery_delivery_failed', error)); }, 5000);
recoveryDelivery.unref();
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('PORT deve ser uma porta válida.');
}

const server = createServer(async (req, res) => {
  observability.track(req, res);
  try {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Apply HTTPS policy before API, health, redirects and errors can return.
  // Trust the validated deployment origin, never a forwarded browser header.
  if (config.production && config.origin.startsWith('https://')) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cache-Control', 'no-cache');
  let pathname;
  let requestUrl;
  try {
    requestUrl = new URL(req.url, 'http://localhost');
    pathname = requestUrl.pathname;
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (/^\/(?:onboarding|operacao|internal-operations)(?:\/|$)|^\/payments\/platform(?:\/|$)|^\/internal\/[^/]+\/(?:license|account\/closure)(?:\/|$)|^\/sistema\/[^/]+\/assinatura\/?$/.test(pathname)) {
    res.writeHead(404).end();
    return;
  }
  if (await observability.handle(req, res, requestUrl)) return;
  if (await foundation.handle(req, res, requestUrl)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  if (pathname === '/index.html') {
    res.writeHead(308, { Location: '/' }).end();
    return;
  }
  const publicShareRoute = /^\/(negocio|planos)\/([a-z0-9][a-z0-9-]{1,47})\/?$/.exec(pathname);
  const sharePreview = publicShareRoute ? await foundation.publicSharePreview(publicShareRoute[2]) : null;
  const notificationManifest = /^\/manifest\/(sistema|negocio|planos)\/([a-z0-9][a-z0-9-]{1,47})\.webmanifest$/.exec(pathname);
  if (notificationManifest) {
    const [, area, slug] = notificationManifest;
    const start = `/${area === 'planos' ? 'negocio' : area}/${slug}`;
    const bytes = Buffer.from(JSON.stringify({ id: start, name: 'Rael Agendamentos', short_name: 'Rael', lang: 'pt-BR', start_url: start, scope: '/', display: 'standalone', background_color: '#171713', theme_color: '#d5ae58', icons: [{ src: '/app-icon-v4-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: '/app-icon-v4-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }] }));
    res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': bytes.length }).end(req.method === 'HEAD' ? undefined : bytes);
    return;
  }
  const legacyPlansRoute = /^\/sistema\/([a-z0-9][a-z0-9-]{1,47})\/planos\/?$/.exec(pathname);
  if (legacyPlansRoute) {
    res.writeHead(308, { Location: `/sistema/${legacyPlansRoute[1]}/assinaturas${requestUrl.search}`, 'Cache-Control': 'no-store' }).end();
    return;
  }
  if (/^\/(?:termos|privacidade)\/?$/.test(pathname)) {
    pathname = pathname.startsWith('/termos') ? '/termos.html' : '/privacidade.html';
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  }
  if (pathname === '/sistema' || pathname === '/sistema/') {
    res.writeHead(303, { Location: '/sistema/' + standaloneSlug, 'Cache-Control': 'no-store' }).end();
    return;
  }
  if (pathname === '/codigo-fonte') {
    if (!config.sourceUrl) { res.writeHead(404).end(); return; }
    res.writeHead(302, { Location: config.sourceUrl, 'Cache-Control': 'no-store' }).end();
    return;
  }
  const systemPage = /^\/sistema\/([a-z0-9-]+)(?:\/(assinaturas|clientes|financeiro|painel|recebimentos))?\/?$/.exec(pathname);
  if (systemPage?.[1] === standaloneSlug) {
    const area = systemPage[2];
    pathname = area === 'recebimentos' ? '/mp-config.html' : area === 'assinaturas' ? '/assinaturas.html' : area ? '/gestao.html' : '/sistema.html';
  } else if (publicShareRoute?.[2] === standaloneSlug) {
    pathname = publicShareRoute[1] === 'planos' ? '/assinaturas.html' : '/agendar.html';
  }
  if (pathname === '/') pathname = '/index.html';
  const contentType = publicFiles.get(pathname);
  if (!contentType) {
    res.writeHead(404).end();
    return;
  }
  // Apply the same protections to friendly routes and direct HTML aliases.
  // A static alias must not make the signup or account pages embeddable.
  if (contentType.startsWith('text/html')) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  }
  if (pathname === '/notifications-sw.js') {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self'");
  }
  try {
    let bytes = await readFile(new URL(`./dist${pathname}`, import.meta.url));
    if (sharePreview) bytes = Buffer.from(injectPublicShareMetadata(bytes.toString('utf8'), { ...sharePreview, origin: config.origin, area: publicShareRoute[1], slug: publicShareRoute[2] }));
    if (pathname === '/index.html') {
      const data = await foundation.publicLanding(standaloneSlug);
      bytes = Buffer.from(renderLanding(bytes.toString('utf8'), { slug: standaloneSlug, origin: config.origin, data }));
      if (data && config.production) res.setHeader('X-Robots-Tag', 'index, follow');
    }
    if (config.sourceUrl && contentType.startsWith('text/html')) {
      bytes = Buffer.from(bytes.toString('utf8').replace('</body>', '<footer class="rael-legal-footer"><a href="/codigo-fonte">Código-fonte</a></footer></body>'));
    }
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': bytes.length });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch {
    res.writeHead(500).end();
    console.error('Falha ao carregar um arquivo público do mockup.');
  }
  } catch (error) {
    observability.failure('request_failed', error);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify({ error: 'Não foi possível concluir agora. Tente novamente em instantes.' }));
    else res.end();
  }
});

server.listen(port, process.env.HOST ?? '0.0.0.0', () => {
  console.log(`Rael Agendamentos: porta ${server.address().port}`);
  // Private startup evidence for runtime patch and restart audits. No config,
  // tenant identifiers or credentials are included in this operational event.
  console.log(JSON.stringify({ event: 'runtime_started', timestamp: Date.now(), nodeVersion: process.version }));
  // Check SMTP authentication once after startup without sending a message or
  // delaying HTTP readiness. Only fixed classifications reach the private log.
  foundation.verifyRecoveryEmail().catch(() => observability.failure('recovery_smtp_check_failed', { code: 'SMTP_CHECK_FAILED' }));
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 50;
server.on('error', error => {
  console.error('Não foi possível iniciar o servidor:', error.code);
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { clearInterval(paymentMaintenance); clearInterval(notificationDelivery); clearInterval(recoveryDelivery); server.close(async () => { await foundation.close(); }); });
}
}
start().catch(error => {
  console.error('Falha ao iniciar o sistema:', /^[A-Z0-9_]{1,60}$/.test(error.code ?? '') ? error.code : 'CONFIGURATION_ERROR');
  process.exitCode = 1;
});
