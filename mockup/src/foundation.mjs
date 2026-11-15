import { openDatabase } from './database.mjs';
import { provisionTenant, createService } from './service.mjs';
import { passwordHash, failure, rateLimit } from './security.mjs';
import { createOperations } from './operations.mjs';
import { countLandingView } from './traffic.mjs';
import { createPlatformNotifications } from './platform-notifications.mjs';
import { createOnboarding } from './onboarding.mjs';
import { createIntegrationSettings } from './integrations.mjs';
import { safeFailureCategory, safeMaintenanceFailure, maintenanceCorrelation } from './observability.mjs';
import { platformBillingForTenant, platformWebhookUrl, platformCollectorIds } from './platform-billing.mjs';
import { tenantTestMode, tenantPaymentsLiveApproved } from './configuration.mjs';
import { createTenantRegistry } from './tenant-registry.mjs';
import { createAutomaticOnboarding } from './automatic-onboarding.mjs';
import { publicShareIdentity, renderPublicShareImage } from './share-preview.mjs';
import { createPublicShareReader, publicShareRecordQuery } from './share-preview-data.mjs';
import { createTenantRuntime } from './tenant-runtime.mjs';
import { createRecoveryMailer } from './recovery-mail.mjs';
import { createPasswordRecovery } from './password-recovery.mjs';

const json = (res, status, body) => { const bytes = Buffer.from(JSON.stringify(body)); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length }).end(bytes); };
async function body(req, limit = 256 * 1024) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw failure(415, 'Envie dados no formato esperado.');
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw failure(413, 'O conteúdo ficou muito grande. Reduza a imagem ou os textos e tente novamente.');
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw failure(400, 'Não foi possível ler os dados. Recarregue e tente novamente.'); }
}
const cookies = req => Object.fromEntries(String(req.headers.cookie ?? '').split(';').map(pair => pair.trim().split(/=(.*)/s).slice(0, 2)).filter(pair => pair.length === 2));

export async function createFoundation(config) {
  const services = new Map();
  const recoveryMailer = createRecoveryMailer(config, { transport: config.recoveryMailTransport });
  let recoveryDispatch = null;
  const runtime = createTenantRuntime({ config, database: registryDatabase, now: config.now });
  config.lifecycleForTenant = runtime.lifecycle;
  const retired = new Set();
  const coldShareRead = createPublicShareReader();
  const notificationQueue = new Map();
  let notificationDispatch = null, closed = false;
  const notificationNow = config.now ?? (() => Date.now());
  function wakeNotifications(slug, at = notificationNow()) {
    if (!closed && config.notifications) notificationQueue.set(slug, Math.min(notificationQueue.get(slug) ?? Infinity, at));
  }
  async function dispatchNotifications() {
    if (closed) return;
    if (notificationDispatch) return notificationDispatch;
    const due = [...notificationQueue].filter(([, at]) => at <= notificationNow()).slice(0, 2);
    if (!due.length) return;
    for (const [slug] of due) notificationQueue.delete(slug);
    notificationDispatch = Promise.allSettled(due.map(async ([slug]) => {
      try {
        const cached = services.get(slug); if (!cached) return;
        const { service } = await cached, result = await runtime.withTenant(slug, () => service.notifications.deliver());
        if (result.nextAt !== null) wakeNotifications(slug, result.nextAt);
      } catch (error) {
        if (error.code === 'TENANT_RETIRED') { retired.add(slug); maintenanceReports.delete(slug); return; }
        wakeNotifications(slug, notificationNow() + 30000);
        maintenanceLog({ event: 'notification_dispatch_failed', timestamp: Date.now(), category: safeFailureCategory(error) });
      }
    })).finally(() => { notificationDispatch = null; });
    return notificationDispatch;
  }
  let maintenanceCursor = 0;
  const maintenanceStartedAt = Date.now(), maintenanceReports = new Map();
  const maintenanceLog = value => { try { (config.monitorLogger ?? (v => console.error(JSON.stringify(v))))(value); } catch { /* Monitoring cannot stop maintenance. */ } };
  function maintenanceFailure(slug, component, error) {
    const report = maintenanceReports.get(slug);
    if (!report) return;
    const detail = safeMaintenanceFailure(component, error);
    report.failed = true; report.category = safeFailureCategory(error);
    if (!report.components.includes(detail.component)) report.components.push(detail.component);
    const previous = report.failures.findIndex(value => value.component === detail.component);
    if (previous !== -1) report.failures[previous] = detail;
    else if (report.failures.length < 7) report.failures.push(detail);
  }
  async function probeDatabase() {
    if (!config.enabled || !Object.keys(config.entries).length) throw Object.assign(new Error('Sistema não configurado.'), { code: 'MONITOR_NOT_CONFIGURED' });
    const entry = config.entries[config.operations?.tenant ?? Object.keys(config.entries)[0]];
    // A readiness check never provisions a tenant or executes schema migrations.
    if (entry.driver === 'mysql') {
      const { createConnection } = await import('mysql2/promise');
      const connection = await createConnection({ host: entry.host, port: entry.port ?? 3306, user: entry.user, password: entry.password, database: entry.database, connectTimeout: 3000, multipleStatements: false, ...(entry.ssl ? { ssl: { rejectUnauthorized: true, ...(entry.ca ? { ca: entry.ca } : {}) } } : {}) });
      try { await connection.query({ sql: 'SELECT 1 AS ready', timeout: 3000 }); }
      finally { connection.destroy(); }
    } else {
      const { DatabaseSync } = await import('node:sqlite');
      const connection = new DatabaseSync(entry.path, { readOnly: true, timeout: 1000 });
      try { connection.prepare('SELECT 1 AS ready').get(); } finally { connection.close(); }
    }
  }
  const dummyHash = config.enabled ? await passwordHash('Uma frase fictícia para validar o tempo de acesso.') : null;
  const platformNotifications = createPlatformNotifications(config, get, databaseFor);
  const platformLiveNotifications = createPlatformNotifications(config, get, databaseFor, { live: true });
  const onboarding = createOnboarding(config, get, databaseFor);
  const registry = createTenantRegistry(config, registryDatabase);
  const automaticOnboarding = createAutomaticOnboarding(config, { database: registryDatabase, registry, getService: get });
  const operations = createOperations(config, get, databaseFor, { retryAutomatic: automaticOnboarding.retry, withTenant: runtime.withTenant, withTenantQuiesced: runtime.withTenantQuiesced, retireTenant, finalizeTenant });
  async function databaseFor(slug) { await get(slug); return runtime.wrapDatabase(slug, (await services.get(slug)).db); }
  async function retireTenant(slug) {
    if (slug === config.operations?.tenant) throw failure(403, 'A gestão da Raelapps é protegida.');
    await runtime.check(slug);
    notificationQueue.delete(slug); maintenanceReports.delete(slug); retired.add(slug);
    const pending = services.get(slug);
    if (pending) { services.delete(slug); await (await pending).db.close(); }
  }
  async function finalizeTenant(slug) {
    if (slug === config.operations?.tenant || (await runtime.lifecycle(slug))?.state !== 'deleted') throw failure(409, 'A exclusão ainda não foi confirmada.');
    if (services.has(slug)) { const pending = services.get(slug); services.delete(slug); await (await pending).db.close(); }
    notificationQueue.delete(slug); maintenanceReports.delete(slug); retired.add(slug); delete config.entries[slug];
  }
  async function registryDatabase() {
    const slug = config.operations?.tenant ?? (Object.keys(config.entries).length === 1 ? Object.keys(config.entries)[0] : null);
    if (!slug) throw failure(503, 'O registro exclusivo dos negócios ainda está sendo preparado.');
    return (await ensure(slug)).db;
  }
  async function wakeRecovery(slug) {
    const central = await registryDatabase();
    await central.transaction(async tx => {
      await tx.query('SELECT id FROM business_settings WHERE id = 1' + tx.lock);
      const [row] = await tx.query('SELECT * FROM password_recovery_dispatch WHERE slug = ?' + tx.lock, [slug]);
      if (row) await tx.query('UPDATE password_recovery_dispatch SET revision = revision + 1, next_check_at = ? WHERE slug = ?', [Math.min(Number(row.next_check_at), notificationNow()), slug]);
      else await tx.query('INSERT INTO password_recovery_dispatch(slug,revision,next_check_at) VALUES (?,?,?)', [slug, 1, notificationNow()]);
    });
  }
  async function dispatchRecoveryEmails() {
    if (closed || !config.enabled) return;
    if (recoveryDispatch) return recoveryDispatch;
    recoveryDispatch = (async () => {
      const central = await registryDatabase();
      const rows = await central.query('SELECT * FROM password_recovery_dispatch WHERE next_check_at <= ? ORDER BY next_check_at, slug LIMIT 2', [notificationNow()]);
      for (const row of rows) {
        let nextAt = null;
        try {
          const service = await get(row.slug);
          nextAt = (await service.emailRecovery.sweep()).nextAt;
        } catch (error) {
          if (error.code !== 'TENANT_RETIRED' && error.status !== 404) {
            nextAt = notificationNow() + 30000;
            maintenanceLog({ event: 'recovery_dispatch_failed', category: safeFailureCategory(error) });
          }
        }
        await central.transaction(async tx => {
          await tx.query('SELECT id FROM business_settings WHERE id = 1' + tx.lock);
          if (nextAt === null) await tx.query('DELETE FROM password_recovery_dispatch WHERE slug = ? AND revision = ?', [row.slug, row.revision]);
          else await tx.query('UPDATE password_recovery_dispatch SET next_check_at = ? WHERE slug = ? AND revision = ?', [nextAt, row.slug, row.revision]);
        });
      }
    })().finally(() => { recoveryDispatch = null; });
    return recoveryDispatch;
  }
  async function ensure(slug) {
    if (!Object.hasOwn(config.entries, slug)) throw failure(404, 'Negócio não encontrado. Confira o endereço do seu convite.');
    const entry = config.entries[slug];
    if (!services.has(slug)) {
      const pending = (async () => {
        const db = await openDatabase(entry);
        try {
          if (entry.bootstrap) await provisionTenant(db, entry.bootstrap, config.now);
          const payments = { ...(entry.payments ?? { enabled: false, mode: 'sandbox', holdMinutes: 30 }) };
          const tenantConfig = { ...config, testMode: tenantTestMode(config, slug), paymentsLiveApproved: tenantPaymentsLiveApproved(config, slug), platformCollectorIds: platformCollectorIds(config), paymentsSelfTest: config.paymentsSelfTest?.tenant === slug ? config.paymentsSelfTest : null };
          const service = createService(db, slug, { ...tenantConfig, operationsConfig: () => config.operations, platformBilling: platformBillingForTenant(config, slug), platformWebhookUrl: platformWebhookUrl(config, slug), license: entry.license ?? { enforced: false }, payments, onMaintenanceFailure: (component, error) => maintenanceFailure(slug, component, error) }, dummyHash);
          service.emailRecovery = createPasswordRecovery(db, slug, { ...tenantConfig, monitorLogger: maintenanceLog, operationsConfig: () => config.operations }, { mailer: recoveryMailer, consumeGlobalBudget: async () => rateLimit(await registryDatabase(), 'password_recovery_sender_hour', 200, 3600000) });
          service.integration = createIntegrationSettings(db, slug, tenantConfig, payments, { registryDatabase, authorizeWrite: service.assertCurrentSession });
          await service.license.initialize();
          return { db, service };
        } catch (error) { await db.close(); throw error; }
      })();
      services.set(slug, pending);
      pending.catch(() => { if (services.get(slug) === pending) services.delete(slug); });
    }
    return services.get(slug);
  }
  async function get(slug) {
    if (config.onboarding && slug !== config.operations?.tenant) await registry.refresh();
    return runtime.withTenant(slug, async () => {
    const { service } = await ensure(slug);
    await service.integration.refresh();
    // A request or webhook wakes only its already-open tenant. Delivery runs
    // after the committed mutation, independently of the slow payment sweep.
    wakeNotifications(slug);
    return runtime.wrap(slug, service);
    });
  }
  async function publicShareSource(slug, includeImage = false) {
    if (!config.enabled) return null;
    if (config.onboarding && slug !== config.operations?.tenant) await registry.refresh();
    // Unknown URLs never create a service, database, or business. In particular,
    // do not call the authenticated setup endpoint or the payment-aware catalog.
    if (!Object.hasOwn(config.entries, slug)) return null;
    return runtime.withTenant(slug, async () => {
    let row;
    if (services.has(slug)) {
      const { db } = await services.get(slug);
      [row] = await db.query(publicShareRecordQuery);
    } else {
      // A sharing crawler must never run migrations, bootstrap a business, or
      // initialize its license. Share in-flight reads, with a separate bounded
      // budget for cold database connections across the process.
      row = await coldShareRead(slug, config.entries[slug]);
    }
    if (!row?.published_json) return null;
    const published = JSON.parse(row.published_json);
    const identity = publicShareIdentity(slug, published.business, row.version ?? null);
    return identity ? { identity, published, logoVersion: row.version, ...(includeImage ? { logoBytes: row.image_base64 ? Buffer.from(row.image_base64, 'base64') : null } : {}) } : null;
    });
  }
  async function publicShareImage(slug, version) {
    const source = await publicShareSource(slug, true);
    if (!source || source.identity.version !== version) throw failure(404, 'Imagem não encontrada.');
    return renderPublicShareImage(source.identity, source.logoBytes);
  }
  return {
    async initializeStandalone(slug) { await ensure(slug); },
    async publicLanding(slug, { photos = false } = {}) {
      const source = await publicShareSource(slug);
      if (!photos || !source) return source;
      const activeIds = new Set((source.published.professionals ?? []).map(person => person.id));
      const { db } = await ensure(slug);
      const images = await db.query("SELECT image_key, version FROM business_images WHERE image_key <> 'logo'");
      return { ...source, coverVersion: images.find(image => image.image_key === 'cover')?.version,
        photoVersions: Object.fromEntries(images
        .filter(image => activeIds.has(image.image_key))
        .map(image => [image.image_key, image.version])) };
    },
    async recordLandingView(slug, utms) {
      const { db } = await ensure(slug);
      await countLandingView(db, utms, (config.now ?? Date.now)());
    },
    async publicSharePreview(slug) { return (await publicShareSource(slug))?.identity ?? null; },
    publicShareImage,
    async handle(req, res, url) {
      const socialImage = /^\/social\/([a-z0-9][a-z0-9-]{1,47})\/([a-f0-9]{32})\.png$/.exec(url.pathname);
      if (socialImage) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        try {
          if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); throw failure(405, 'Ação não permitida.'); }
          const bytes = await publicShareImage(socialImage[1], socialImage[2]);
          res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length, 'Cache-Control': 'public, max-age=86400' }).end(req.method === 'HEAD' ? undefined : bytes);
        } catch (error) { json(res, error.status ?? 500, { error: error.status ? error.message : 'Imagem indisponível.' }); }
        return true;
      }
      if (url.pathname === '/internal-operations/entry') {
        res.setHeader('Cache-Control', 'no-store');
        try { json(res, 200, operations.entry(req, Object.fromEntries(url.searchParams))); }
        catch (error) { if (error.status === 405) res.setHeader('Allow', 'GET'); json(res, error.status ?? 500, { error: error.status ? error.message : 'Não foi possível consultar o acesso.' }); }
        return true;
      }
      if (config.onboarding && /^\/(internal|internal-operations|payments)(?:\/|$)/.test(url.pathname)) {
        try { await registry.refresh(); }
        catch { json(res, 503, { error: 'O registro dos negócios está temporariamente indisponível. Tente novamente em instantes.' }); return true; }
      }
      if (url.pathname === '/onboarding/config') {
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'GET') json(res, 405, { error: 'Ação não permitida.' });
        else json(res, 200, { automatic: automaticOnboarding.available(), available: Boolean(config.enabled && config.operations && (!config.onboarding || config.onboarding.enabled)) });
        return true;
      }
      if (url.pathname === '/onboarding/status') {
        res.setHeader('Cache-Control', 'no-store');
        try {
          if (req.method !== 'POST') throw failure(405, 'Ação não permitida.');
          if (req.headers.origin !== config.origin) throw failure(403, 'Abra o sistema pelo endereço oficial antes de continuar.');
          json(res, 200, await automaticOnboarding.status(await body(req, 1024), { ip: req.socket.remoteAddress }));
        } catch (error) { json(res, error.status ?? 503, { error: error.status ? error.message : 'Não foi possível consultar a preparação agora.' }); }
        return true;
      }
      if (url.pathname === '/onboarding/requests') {
        res.setHeader('Cache-Control', 'no-store');
        try {
          if (req.method !== 'POST') throw failure(405, 'Ação não permitida.');
          if (req.headers.origin !== config.origin) throw failure(403, 'Abra o sistema pelo endereço oficial antes de continuar.');
          const data = await body(req, 32768);
          if (config.onboarding && !automaticOnboarding.available()) throw failure(503, 'Novos cadastros estão temporariamente indisponíveis. Tente novamente mais tarde.');
          json(res, 202, await (automaticOnboarding.available() ? automaticOnboarding : onboarding).request(data, { ip: req.socket.remoteAddress }));
        } catch (error) { json(res, error.status ?? 503, { error: error.status ? error.message : 'Não foi possível receber a solicitação. Tente novamente mais tarde.', ...(error.status === 409 && error.code === 'slug_unavailable' && error.field === 'slug' ? { code: 'slug_unavailable', field: 'slug' } : {}) }); }
        return true;
      }
      const operationPath = /^\/internal-operations\/(.+)$/.exec(url.pathname);
      if (operationPath) {
        res.setHeader('Cache-Control', 'no-store');
        try { json(res, 200, await operations.handle(req, operationPath[1], Object.fromEntries(url.searchParams), req.method === 'POST' ? await body(req, 8192) : null)); }
        catch (error) { json(res, error.status ?? 500, { error: error.status ? error.message : 'Não foi possível concluir a operação.' }); }
        return true;
      }
      if (url.pathname === '/payments/platform/webhook' || url.pathname === '/payments/platform/live/webhook') {
        res.setHeader('Cache-Control', 'no-store');
        try { if (req.method !== 'POST') throw failure(405, 'Ação não permitida.'); const notify = url.pathname === '/payments/platform/live/webhook' ? platformLiveNotifications : platformNotifications; await notify(req.headers, Object.fromEntries(url.searchParams), await body(req, 16384)); json(res, 200, { received: true }); }
        catch (error) { json(res, error.status ?? 503, { error: error.status === 401 ? 'Notificação não autenticada.' : 'Não foi possível conferir a notificação.' }); }
        finally { for (const slug of services.keys()) wakeNotifications(slug); }
        return true;
      }
      const platformNotification = /^\/payments\/platform\/webhook\/([a-z0-9][a-z0-9-]{1,47})$/.exec(url.pathname);
      if (platformNotification) {
        res.setHeader('Cache-Control', 'no-store');
        try { if (!config.enabled || req.method !== 'POST') throw failure(405, 'Ação não permitida.'); const service = await get(platformNotification[1]); await service.license.notification(req.headers, Object.fromEntries(url.searchParams), await body(req, 16384)); json(res, 200, { received: true }); }
        catch (error) { json(res, error.status ?? 503, { error: error.status === 401 ? 'Notificação não autenticada.' : 'Não foi possível conferir a notificação.' }); }
        finally { if (services.has(platformNotification[1])) wakeNotifications(platformNotification[1]); }
        return true;
      }
      if (url.pathname === '/payments/mercadopago/callback') {
        res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
        const args = Object.fromEntries(url.searchParams), slug = typeof args.state === 'string' ? args.state.split('.')[0] : '';
        try {
          if (!config.enabled || req.method !== 'GET' || !Object.hasOwn(config.entries, slug)) throw failure(422, 'Pedido de conexão inválido. Volte ao seu perfil e tente novamente.');
          const service = await get(slug), raw = cookies(req)[service.cookieName], user = await service.session(raw), result = await service.payments.callback(user, raw, args);
          const destination = args.state.startsWith(slug + '.business.') ? `/sistema/${slug}/recebimentos` : `/sistema/${slug}`;
          res.writeHead(303, { Location: `${destination}?recebimento=${result.connected ? 'conectado' : 'cancelado'}` }).end();
        } catch (error) {
          // Log only a fixed classification, never provider payloads, codes or tokens.
          if (error.mpAuthorizationIssue) console.warn('MP_AUTHORIZATION_REJECTED', JSON.stringify({ tenant: slug, reason: error.mpAuthorizationIssue }));
          if (Object.hasOwn(config.entries, slug)) res.writeHead(303, { Location: `/sistema/${slug}${args.state?.startsWith(slug + '.business.') ? '/recebimentos' : ''}?recebimento=erro&motivo=${encodeURIComponent(error.status ? error.message : 'Não foi possível concluir a conexão. Inicie novamente pelo seu perfil.')}` }).end();
          else json(res, error.status ?? 500, { error: 'Pedido de conexão inválido. Volte ao seu perfil.' });
        }
        return true;
      }
      const subscriptionNotification = /^\/payments\/mercadopago\/subscriptions\/([a-z0-9][a-z0-9-]{1,47})\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (subscriptionNotification) {
        res.setHeader('Cache-Control', 'no-store');
        try { if (!config.enabled || req.method !== 'POST') throw failure(405, 'Ação não permitida.'); const service = await get(subscriptionNotification[1]); await service.subscriptions.notification(subscriptionNotification[2], req.headers, Object.fromEntries(url.searchParams), await body(req, 16384)); json(res, 200, { received: true }); }
        catch (error) { json(res, error.status ?? 503, { error: error.status === 401 ? 'Notificação não autenticada.' : 'Não foi possível conferir a notificação agora.' }); }
        finally { if (services.has(subscriptionNotification[1])) wakeNotifications(subscriptionNotification[1]); }
        return true;
      }
      const notification = /^\/payments\/mercadopago\/webhook\/([a-z0-9][a-z0-9-]{1,47})(?:\/([a-f0-9-]{36}))?$/.exec(url.pathname);
      if (notification) {
        res.setHeader('Cache-Control', 'no-store');
        try {
          if (!config.enabled || req.method !== 'POST') throw failure(405, 'Ação não permitida.');
          const service = await get(notification[1]), payload = await body(req, 16384), query = Object.fromEntries(url.searchParams);
          if (notification[2]) await service.payments.notification(notification[2], req.headers, query, payload);
          else if (payload.type === 'payment') {
            await service.payments.notificationByCollector(req.headers, query, payload);
            await service.subscriptions.notificationByCollector(req.headers, query, payload);
          } else if (['subscription_preapproval', 'subscription_authorized_payment'].includes(payload.type)) await service.subscriptions.notificationByCollector(req.headers, query, payload);
          else throw failure(422, 'Tipo de notificação não reconhecido.');
          json(res, 200, { received: true });
        } catch (error) { json(res, error.status ?? 503, { error: error.status === 401 ? 'Notificação não autenticada.' : 'Não foi possível conferir a notificação agora.' }); }
        finally { if (services.has(notification[1])) wakeNotifications(notification[1]); }
        return true;
      }
      const media = /^\/media\/([a-z0-9][a-z0-9-]{1,47})\/(logo|cover|[a-f0-9-]{36})\/([a-f0-9-]{36})\.webp$/.exec(url.pathname);
      if (media) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        try {
          if (!config.enabled) throw failure(503, 'Ambiente indisponível.');
          if (!['GET', 'HEAD'].includes(req.method)) throw failure(405, 'Ação não permitida.');
          const service = await get(media[1]);
          const bytes = await service.image(media[2], media[3], cookies(req)[service.cookieName]);
          res.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': bytes.length }).end(req.method === 'HEAD' ? undefined : bytes);
        } catch (error) { json(res, error.status ?? 500, { error: error.status ? error.message : 'Imagem indisponível.' }); }
        return true;
      }
      const match = /^\/internal\/([a-z0-9][a-z0-9-]{1,47})\/(.+)$/.exec(url.pathname);
      if (!match) return false;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Frame-Options', 'DENY');
      try {
        if (!config.enabled) throw failure(503, 'O ambiente está sendo preparado. A demonstração continua disponível na página inicial.');
        if (!['GET', 'POST', 'PUT', 'PATCH'].includes(req.method)) throw failure(405, 'Ação não permitida.');
        if (req.method !== 'GET' && req.headers.origin !== config.origin) throw failure(403, 'Abra o sistema pelo endereço oficial antes de continuar.');
        const [, slug, path] = match;
        if (path === 'meta' && req.method === 'GET') {
          await runtime.check(slug);
          if (!Object.hasOwn(config.entries, slug)) throw failure(404, 'Negócio não encontrado.');
          json(res, 200, { testMode: tenantTestMode(config, slug), automaticEmail: false, recoveryEmail: Boolean(recoveryMailer.enabled && config.integrationKey && !tenantTestMode(config, slug) && config.operations?.tenant !== slug) }); return true;
        }
        const service = await get(slug);
        const secure = config.origin.startsWith('https://') ? '; Secure' : '';
        if (['password-recovery', 'customer/password-recovery'].includes(path) && req.method === 'POST') {
          const result = await service.emailRecovery.request(await body(req, 1024), path.startsWith('customer/') ? 'customer' : 'staff');
          await wakeRecovery(slug);
          json(res, 200, result); return true;
        }
        if (path === 'login' && req.method === 'POST') {
          const data = await body(req), result = await service.login(data.email, data.password);
          res.setHeader('Set-Cookie', `${service.cookieName}=${result.value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${secure}`);
          json(res, 200, { user: result.user, csrf: result.csrf }); return true;
        }
        if (path === 'activate' && req.method === 'POST') {
          const data = await body(req);
          if (!['invite', 'reset'].includes(data.kind)) throw failure(422, 'Link inválido.');
          await service.activate(data.token, data.password, data.kind);
          json(res, 200, { message: 'Senha definida. Entre com seu e-mail e a nova senha.' }); return true;
        }
        if (path === 'catalog' && req.method === 'GET') { json(res, 200, await service.publicCatalog()); return true; }
        const customerRaw = cookies(req)[service.booking.customerCookie];
        if (path === 'customer/notifications' || path.startsWith('customer/notifications/')) {
          const customer = await service.booking.customerSession(customerRaw);
          if (req.method !== 'GET' || req.headers['x-csrf-token'] !== undefined) service.booking.verifyCsrf(customer, req.headers['x-csrf-token']);
          const action = path.slice('customer/notifications'.length), actor = { customer };
          if (action === '' && req.method === 'GET') { json(res, 200, await service.notifications.list(actor, Object.fromEntries(url.searchParams))); return true; }
          if (action === '/config' && req.method === 'GET') { json(res, 200, await service.notifications.settings(actor)); return true; }
          const method = { '/read': 'read', '/push': 'push', '/push-remove': 'pushRemove', '/test': 'test' }[action];
          if (method && req.method === 'POST') { json(res, 200, await service.notifications[method](actor, await body(req, 8192))); return true; }
          throw failure(405, 'Ação não permitida.');
        }
        if (path === 'subscription-plans' && req.method === 'GET') { let customer; if (customerRaw) try { customer = await service.booking.customerSession(customerRaw); } catch (error) { if (error.status !== 401) throw error; } json(res, 200, await service.subscriptions.plans(undefined, customer)); return true; }
        if (path.startsWith('customer/subscriptions')) {
          const customer = await service.booking.customerSession(customerRaw);
          if (req.method !== 'GET') service.booking.verifyCsrf(customer, req.headers['x-csrf-token']);
          if (path === 'customer/subscriptions' && req.method === 'GET') { json(res, 200, await service.subscriptions.list({ customer })); return true; }
          if (path === 'customer/subscriptions/start' && req.method === 'POST') { json(res, 200, await service.subscriptions.start(customer, await body(req))); return true; }
          if (path === 'customer/subscriptions/refresh' && req.method === 'POST') { json(res, 200, await service.subscriptions.refresh({ customer }, (await body(req)).subscriptionId)); return true; }
          if (path === 'customer/subscriptions/cancel' && req.method === 'POST') { json(res, 200, await service.subscriptions.cancel({ customer }, await body(req))); return true; }
          if (path === 'customer/subscriptions/withdraw' && req.method === 'POST') { json(res, 200, await service.subscriptions.withdraw({ customer }, await body(req))); return true; }
          throw failure(405, 'Ação não permitida.');
        }
        if (['customer/register', 'customer/login'].includes(path) && req.method === 'POST') {
          const result = await service.booking[path.endsWith('register') ? 'register' : 'login'](await body(req));
          res.setHeader('Set-Cookie', `${service.booking.customerCookie}=${result.value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${secure}`);
          json(res, path.endsWith('register') ? 201 : 200, { customer: result.customer, csrf: result.csrf }); return true;
        }
        if (path === 'customer/reset' && req.method === 'POST') { json(res, 200, await service.booking.reset(await body(req))); return true; }
        if (path === 'availability' && req.method === 'GET') {
          const args = Object.fromEntries(url.searchParams);
          const actor = args.appointmentId || args.subscriptionId ? { customer: await service.booking.customerSession(customerRaw) } : {};
          json(res, 200, await service.booking.availability(args, actor)); return true;
        }
        if (['customer/session', 'customer/logout', 'customer/appointments', 'customer/reserve', 'customer/reschedule', 'customer/status', 'customer/payment', 'customer/checkout', 'customer/payment-refresh'].includes(path)) {
          const customer = await service.booking.customerSession(customerRaw);
          if (req.method !== 'GET') service.booking.verifyCsrf(customer, req.headers['x-csrf-token']);
          if (path === 'customer/session' && req.method === 'GET') { json(res, 200, { customer: service.booking.customerView(customer), csrf: customer.csrf }); return true; }
          if (path === 'customer/logout' && req.method === 'POST') { await service.notifications.revokeSession({ customer }); await service.booking.logout(customerRaw); res.setHeader('Set-Cookie', `${service.booking.customerCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`); json(res, 200, { ok: true }); return true; }
          if (path === 'customer/appointments' && req.method === 'GET') { json(res, 200, await service.booking.customerAppointments(customer, Number(url.searchParams.get('offset') ?? 0))); return true; }
          if (path === 'customer/payment' && req.method === 'GET') { json(res, 200, await service.payments.paymentStatus({ customer }, url.searchParams.get('appointmentId'))); return true; }
          if (path === 'customer/payment-refresh' && req.method === 'POST') { json(res, 200, await service.payments.paymentStatus({ customer }, (await body(req)).appointmentId, true)); return true; }
          if (path === 'customer/checkout' && req.method === 'POST') { json(res, 200, await service.payments.beginCheckout({ customer }, (await body(req)).appointmentId)); return true; }
          if (['customer/reserve', 'customer/reschedule'].includes(path) && req.method === 'POST') { const result = await service.booking.reserve({ customer }, await body(req, 32768), path.endsWith('reschedule')); json(res, result.created ? 201 : 200, result); return true; }
          if (path === 'customer/status' && req.method === 'POST') { json(res, 200, await service.booking.changeStatus({ customer }, await body(req))); return true; }
          throw failure(405, 'Ação não permitida.');
        }
        const rawToken = cookies(req)[service.cookieName];
        const user = await service.session(rawToken);
        if (req.method !== 'GET') service.verifyCsrf(user, req.headers['x-csrf-token']);
        if (path === 'notifications' || path.startsWith('notifications/')) {
          if (req.method === 'GET' && req.headers['x-csrf-token'] !== undefined) service.verifyCsrf(user, req.headers['x-csrf-token']);
          const action = path.slice('notifications'.length), actor = { staff: user };
          if (action === '' && req.method === 'GET') { json(res, 200, await service.notifications.list(actor, Object.fromEntries(url.searchParams))); return true; }
          if (action === '/config' && req.method === 'GET') { json(res, 200, await service.notifications.settings(actor)); return true; }
          const method = { '/read': 'read', '/push': 'push', '/push-remove': 'pushRemove', '/test': 'test' }[action];
          if (method && req.method === 'POST') { json(res, 200, await service.notifications[method](actor, await body(req, 8192))); return true; }
          throw failure(405, 'Ação não permitida.');
        }
        if (path === 'integration' && req.method === 'GET') { json(res, 200, await service.integration.view(user)); return true; }
        if (path === 'integration' && req.method === 'POST') { json(res, 200, await service.integration.save(user, await body(req, 16384))); return true; }
        if (path === 'license' && req.method === 'GET') { json(res, 200, { ...await service.license.view(user), ...(user.role === 'admin' && config.operations?.tenant && slug !== config.operations.tenant && operations.lifecycle ? { accountClosure: await operations.lifecycle.viewClosure(slug, { ...user, tenant: slug }) } : {}) }); return true; }
        if (path === 'account/closure') {
          if (user.role !== 'admin' || !config.operations?.tenant || !operations.lifecycle) throw failure(403, 'Somente o gestor deste negócio pode solicitar o encerramento.');
          const actor = { ...user, tenant: slug };
          if (req.method === 'GET') { json(res, 200, await operations.lifecycle.viewClosure(slug, actor)); return true; }
          if (req.method === 'POST') { json(res, 200, await operations.lifecycle.requestClosure(slug, actor, await body(req, 4096))); return true; }
          throw failure(405, 'Ação não permitida.');
        }
        if (path === 'license/notice' && req.method === 'GET') { if (user.role !== 'admin') throw failure(403, 'Somente o responsável acompanha a licença.'); json(res, 200, { notice: (await service.license.state()).notice }); return true; }
        if (['license/start', 'license/cancel', 'license/refresh'].includes(path) && req.method === 'POST') { const data = await body(req); if (path !== 'license/start' && Object.keys(data).length) throw failure(422, 'Confira os dados enviados.'); json(res, 200, path === 'license/start' ? config.operations?.tenant && slug !== config.operations.tenant && operations.lifecycle ? await operations.lifecycle.withLicensePurchaseAllowed(slug, { ...user, tenant: slug }, () => service.license.start(user, data)) : await service.license.start(user, data) : path === 'license/cancel' ? await service.license.cancel(user) : await service.license.refresh(user)); return true; }
        if (path === 'customers' && req.method === 'GET') { json(res, 200, await service.customers.list(user, Object.fromEntries(url.searchParams))); return true; }
        if (path === 'customers/detail' && req.method === 'GET') { json(res, 200, await service.customers.detail(user, Object.fromEntries(url.searchParams))); return true; }
        if (path === 'customers/save' && req.method === 'POST') { json(res, 200, await service.customers.save(user, await body(req))); return true; }
        if (path === 'customers/export' && req.method === 'POST') { const args = await body(req); json(res, 200, await service.customers.list(user, args, true)); return true; }
        if (path === 'customers/import-preview' && req.method === 'POST') { json(res, 200, await service.customers.preview(user, await body(req))); return true; }
        if (path === 'customers/import' && req.method === 'POST') { json(res, 200, await service.customers.importRows(user, await body(req))); return true; }
        if (path === 'finance' && req.method === 'GET') { json(res, 200, await service.finance.report(user, Object.fromEntries(url.searchParams))); return true; }
        if (path === 'finance/appointment' && req.method === 'GET') { json(res, 200, await service.finance.appointmentView(user, url.searchParams.get('id'))); return true; }
        if (path === 'finance/manual' && req.method === 'POST') { json(res, 200, await service.finance.manual(user, await body(req))); return true; }
        if (path === 'dashboard' && req.method === 'GET') { json(res, 200, await service.finance.dashboard(user, Object.fromEntries(url.searchParams))); return true; }
        if (path === 'traffic' && req.method === 'GET') { json(res, 200, await service.traffic(user, Number(url.searchParams.get('days') ?? 30))); return true; }
        if (path === 'subscriptions' && req.method === 'GET') { json(res, 200, { ...await service.subscriptions.plans(user), ...await service.subscriptions.list({ staff: user }) }); return true; }
        if (path === 'subscriptions/overview' && req.method === 'GET') { json(res, 200, await service.subscriptions.overview(user, Object.fromEntries(url.searchParams))); return true; }
        if (path === 'subscriptions/plan-members' && req.method === 'GET') { json(res, 200, await service.subscriptions.planMembers(user, Object.fromEntries(url.searchParams))); return true; }
        if (path === 'subscriptions/plan' && req.method === 'POST') { json(res, 201, await service.subscriptions.createPlan(user, await body(req))); return true; }
        if (path === 'subscriptions/plan-update' && req.method === 'POST') { json(res, 200, await service.subscriptions.updatePlan(user, await body(req))); return true; }
        if (path === 'subscriptions/plan-status' && req.method === 'POST') { json(res, 200, await service.subscriptions.archive(user, await body(req))); return true; }
        if (path === 'subscriptions/refresh' && req.method === 'POST') { json(res, 200, await service.subscriptions.refresh({ staff: user }, (await body(req)).subscriptionId)); return true; }
        if (path === 'subscriptions/cancel' && req.method === 'POST') { json(res, 200, await service.subscriptions.cancel({ staff: user }, await body(req))); return true; }
        if (path === 'subscriptions/manual-receipt' && req.method === 'POST') { json(res, 200, await service.subscriptions.manualReceipt(user, await body(req))); return true; }
        if (path === 'subscriptions/manual-status' && req.method === 'POST') { json(res, 200, await service.subscriptions.manualStatus(user, await body(req))); return true; }
        if (path === 'subscriptions/renewal-policy' && req.method === 'POST') { json(res, 200, await service.subscriptions.renewalPolicy(user, await body(req))); return true; }
        if (path === 'subscription-receiving' && req.method === 'GET') { json(res, 200, await service.payments.subscriptionReceiving(user)); return true; }
        if (path === 'subscription-receiving' && req.method === 'POST') { json(res, 200, await service.payments.setSubscriptionReceiving(user, await body(req, 2048))); return true; }
        if (['subscription-receiving/connect', 'subscription-receiving/check', 'subscription-receiving/disconnect'].includes(path) && req.method === 'POST') {
          if (Object.keys(await body(req, 2048)).length) throw failure(422, 'Confira os dados enviados.');
          json(res, 200, path.endsWith('/connect') ? await service.payments.startBusiness(user, rawToken) : path.endsWith('/check') ? await service.payments.checkBusiness(user) : await service.payments.disconnectBusiness(user)); return true;
        }
        if (path === 'mp/status' && req.method === 'GET') { json(res, 200, await service.payments.status(user)); return true; }
        if (path === 'mp/check' && req.method === 'POST') { if (Object.keys(await body(req)).length) throw failure(422, 'Confira os dados enviados.'); json(res, 200, await service.payments.checkConnection(user)); return true; }
        if (['mp/connect', 'mp/disconnect'].includes(path) && req.method === 'POST') { if (Object.keys(await body(req)).length) throw failure(422, 'Cada profissional conecta somente a própria conta.'); json(res, 200, path === 'mp/connect' ? await service.payments.start(user, rawToken) : await service.payments.disconnect(user)); return true; }
        if (path === 'agenda/payment' && req.method === 'GET') { json(res, 200, await service.payments.paymentStatus({ staff: user }, url.searchParams.get('appointmentId'))); return true; }
        if (path === 'agenda/payment-refresh' && req.method === 'POST') { json(res, 200, await service.payments.paymentStatus({ staff: user }, (await body(req)).appointmentId, true)); return true; }
        if (path === 'agenda/checkout' && req.method === 'POST') { json(res, 200, await service.payments.beginCheckout({ staff: user }, (await body(req)).appointmentId)); return true; }
        if (path === 'agenda' && req.method === 'GET') { json(res, 200, await service.booking.agenda(user, Object.fromEntries(url.searchParams))); return true; }
        if (path === 'agenda/availability' && req.method === 'GET') { json(res, 200, await service.booking.availability(Object.fromEntries(url.searchParams), { staff: user })); return true; }
        if (['agenda/reserve', 'agenda/reschedule'].includes(path) && req.method === 'POST') { const result = await service.booking.reserve({ staff: user }, await body(req, 32768), path.endsWith('reschedule')); json(res, result.created ? 201 : 200, result); return true; }
        if (path === 'agenda/status' && req.method === 'POST') { json(res, 200, await service.booking.changeStatus({ staff: user }, await body(req))); return true; }
        if (path === 'agenda/block-preview' && req.method === 'GET') { json(res, 200, await service.booking.blockPreview(user, Object.fromEntries(url.searchParams))); return true; }
        if (path === 'agenda/block' && req.method === 'POST') { json(res, 201, await service.booking.addBlock(user, await body(req))); return true; }
        if (path === 'agenda/unblock' && req.method === 'POST') { json(res, 200, await service.booking.removeBlock(user, (await body(req)).id)); return true; }
        if (path === 'agenda/customer-recovery' && req.method === 'POST') { const data = await body(req); if (data.identityConfirmed !== true) throw failure(422, 'Confirme a identidade do cliente antes de gerar a recuperação.'); json(res, 201, await service.booking.resetLink(user, data.customerId)); return true; }
        if (path === 'session' && req.method === 'GET') { json(res, 200, { user: service.userView(user), businessName: await service.businessName(), csrf: user.csrf, testMode: tenantTestMode(config, slug), operationsAvailable: operations.allowed(slug, user) }); return true; }
        if (path === 'account/password' && req.method === 'POST') {
          const result = await service.changePassword(user, await body(req));
          res.setHeader('Set-Cookie', `${service.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
          json(res, 200, result); return true;
        }
        if (path === 'logout' && req.method === 'POST') {
          await service.notifications.revokeSession({ staff: user });
          await service.logout(rawToken);
          res.setHeader('Set-Cookie', `${service.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
          json(res, 200, { ok: true }); return true;
        }
        if (path === 'setup' && req.method === 'GET') { json(res, 200, await service.snapshot(user)); return true; }
        if (path === 'setup' && req.method === 'PUT') { json(res, 200, await service.save(user, await body(req))); return true; }
        if (['profile-photo', 'business-logo', 'business-cover'].includes(path) && req.method === 'PUT') {
          const kind = { 'profile-photo': 'photo', 'business-logo': 'logo', 'business-cover': 'cover' }[path];
          json(res, 200, await service.saveImage(user, kind, await body(req, 3 * 1024 * 1024))); return true;
        }
        if (path === 'publish' && req.method === 'POST') { json(res, 200, await service.publish(user, (await body(req)).revision)); return true; }
        if (path === 'team/invite' && req.method === 'POST') { json(res, 201, await service.invite(user, await body(req))); return true; }
        if (path === 'team/recovery' && req.method === 'POST') {
          const data = await body(req);
          if (Object.keys(data).some(key => !['userId', 'identityConfirmed'].includes(key)) || (data.identityConfirmed !== undefined && data.identityConfirmed !== true)) throw failure(422, 'Confira a identidade da pessoa antes de gerar a recuperação.');
          json(res, 201, await service.recovery(user, data.userId)); return true;
        }
        if (path === 'team/status' && req.method === 'POST') { const data = await body(req); json(res, 200, await service.accessStatus(user, data.userId, data.active)); return true; }
        if (path === 'receiving' && req.method === 'PATCH') {
          const data = await body(req);
          // Never accept a target professional or a connection state from the browser.
          if (Object.keys(data).some(key => !['required', 'revision'].includes(key))) throw failure(422, 'A regra só pode ser alterada pelo próprio profissional.');
          json(res, 200, await service.ownReceiving(user, data.required, data.revision)); return true;
        }
        if (path === 'hours' && req.method === 'PATCH') {
          const data = await body(req);
          if (Object.keys(data).some(key => !['week', 'revision'].includes(key))) throw failure(422, 'Só é possível alterar o próprio expediente.');
          json(res, 200, await service.ownHours(user, data.week, data.revision)); return true;
        }
        throw failure(404, 'Ação não encontrada.');
      } catch (error) {
        const status = Number.isInteger(error.status) ? error.status : 500;
        if (status === 500) console.error('Falha no sistema:', /^[A-Z0-9_]{1,60}$/.test(error.code ?? '') ? error.code : 'UNEXPECTED_ERROR');
        json(res, status, { error: status === 500 ? 'Não foi possível concluir agora. Tente novamente em instantes.' : error.message });
      }
      finally { if (services.has(match[1])) wakeNotifications(match[1]); }
      return true;
    },
    async close() { closed = true; notificationQueue.clear(); if (notificationDispatch) await notificationDispatch; if (recoveryDispatch) await recoveryDispatch; recoveryMailer.close(); await automaticOnboarding.close(); await runtime.close(); await Promise.allSettled([...services.values()].map(async promise => (await promise).db.close())); },
    async maintenance() {
      if (config.onboarding) await registry.refresh();
      const slugs = Object.keys(config.entries); if (!config.enabled || !slugs.length) return;
      const slug = slugs[maintenanceCursor++ % slugs.length], prior = maintenanceReports.get(slug);
      if (['deleting', 'attention', 'deleted'].includes((await runtime.lifecycle(slug))?.state)) { retired.add(slug); maintenanceReports.delete(slug); notificationQueue.delete(slug); return { ran: false, retired: true }; }
      const report = { lastAttemptAt: Date.now(), lastSuccessAt: prior?.lastSuccessAt ?? null, consecutiveFailures: prior?.consecutiveFailures ?? 0, failed: false, components: [], failures: [], category: null };
      maintenanceReports.set(slug, report);
      try {
        const service = await get(slug);
        for (const [component, module] of [['payments', service.payments], ['subscriptions', service.subscriptions], ['license', service.license], ['notifications', service.notifications], ['recovery_email', service.emailRecovery]]) {
          try { await module.sweep(component === 'notifications' ? { deliver: false } : undefined); } catch (error) { maintenanceFailure(slug, component, error); }
        }
      } catch (error) { maintenanceFailure(slug, 'database', error); }
      finally { if (services.has(slug)) wakeNotifications(slug); }
      if (report.failed) {
        report.consecutiveFailures++;
        if ([1, 3].includes(report.consecutiveFailures) || report.consecutiveFailures % 10 === 0) {
          const correlation = maintenanceCorrelation(config.integrationKey, slug);
          maintenanceLog({ event: 'maintenance_failed', timestamp: Date.now(), severity: report.consecutiveFailures >= 3 ? 'error' : 'warning', consecutiveFailures: report.consecutiveFailures, components: report.components, category: report.category, failures: report.failures, ...(correlation ? { correlation } : {}) });
        }
      } else { report.consecutiveFailures = 0; report.lastSuccessAt = Date.now(); if (prior?.failed) { const correlation = maintenanceCorrelation(config.integrationKey, slug); maintenanceLog({ event: 'maintenance_recovered', timestamp: Date.now(), ...(correlation ? { correlation } : {}) }); } }
      return { ran: true, ok: !report.failed };
    },
    maintenanceStatus() {
      const rows = [...maintenanceReports.values()], count = Object.keys(config.entries).filter(slug => !retired.has(slug)).length, time = Date.now();
      const lastAttemptAt = rows.length ? Math.max(...rows.map(r => r.lastAttemptAt)) : null;
      const overdueDatabases = Object.keys(config.entries).filter(slug => !retired.has(slug) && time - (maintenanceReports.get(slug)?.lastAttemptAt ?? maintenanceStartedAt) > count * 60000 + 120000).length;
      const stale = config.enabled && count && (time - (lastAttemptAt ?? maintenanceStartedAt) > 180000 || overdueDatabases > 0);
      return { status: !config.enabled ? 'disabled' : rows.some(r => r.failed) ? 'degraded' : stale ? 'stale' : !rows.length ? 'waiting' : 'ok', configuredDatabases: count, visitedDatabases: rows.length, overdueDatabases, failedDatabases: rows.filter(r => r.failed).length, maxConsecutiveFailures: Math.max(0, ...rows.map(r => r.consecutiveFailures)), lastAttemptAt, lastSuccessAt: rows.some(r => r.lastSuccessAt) ? Math.max(...rows.map(r => r.lastSuccessAt ?? 0)) : null, expectedFullPassSeconds: count * 60 };
    },
    probeDatabase,
    getService: get,
    dispatchNotifications,
    dispatchRecoveryEmails,
    async verifyRecoveryEmail() {
      try {
        const result = await recoveryMailer.verify();
        if (result.enabled) maintenanceLog({ event: 'recovery_smtp_check', ready: true });
        return result;
      } catch (error) {
        const category = ['auth', 'connection', 'tls', 'rejected'].includes(error.category) ? error.category : 'delivery_failed';
        const smtpCode = Number.isSafeInteger(error.responseCode) && error.responseCode >= 400 && error.responseCode <= 599 ? error.responseCode : null;
        const result = { enabled: true, ready: false, category, ...(smtpCode ? { smtpCode } : {}) };
        maintenanceLog({ event: 'recovery_smtp_check', ...result });
        return result;
      }
    },
    provisionRegistrations: automaticOnboarding.run,
    provisioningStatus: automaticOnboarding.health,
  };
}
