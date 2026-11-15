import { failure } from './security.mjs';
import { createMercadoPagoClient, verifyNotification } from './mercadopago-client.mjs';
import { platformBillingForTenant } from './platform-billing.mjs';

const providerId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const numeric = value => /^\d{1,32}$/.test(String(value ?? ''));

// Each platform billing configuration has its own receiver and notification URL.
// Resolve the business only from canonical provider resources and a known local
// contract; no business supplied by the webhook payload can grant access.
export function createPlatformNotifications(config, get, database, { live = false } = {}) {
  return async (headers, query, payload) => {
    const billing = live ? config.platformBillingLive : config.platformBilling;
    if (!config.enabled || !billing?.enabled || !billing.accessToken || !billing.collectorId || !billing.webhookSecret) throw failure(503, 'Cobrança não configurada.');
    const id = query['data.id'];
    verifyNotification(headers, id, billing.webhookSecret, config.now?.() ?? Date.now());
    if (String(payload.data?.id) !== id) throw failure(422, 'Notificação inválida.');
    const request = createMercadoPagoClient(billing, config.platformTransport), auth = { accessToken: billing.accessToken };
    let contractId;
    if (payload.type === 'subscription_preapproval' && providerId(id)) contractId = id;
    else if (payload.type === 'subscription_authorized_payment' && numeric(id)) {
      const invoice = await request('GET', '/authorized_payments/' + id, auth);
      if (String(invoice?.id) !== id || !providerId(invoice.preapproval_id)) throw failure(409, 'Fatura não identificada.');
      contractId = invoice.preapproval_id;
    } else if (payload.type === 'payment' && numeric(id)) {
      const payment = await request('GET', '/v1/payments/' + id, auth);
      if (String(payment?.id) !== id || String(payment.collector_id) !== String(billing.collectorId)) throw failure(409, 'Recebedor não identificado.');
      const found = await request('GET', '/authorized_payments/search?' + new URLSearchParams({ payment_id: id, limit: '5' }), auth);
      if (!Array.isArray(found.results) || found.results.length > 5 || Number(found.paging?.total ?? found.results.length) > 5) throw failure(409, 'Pagamento precisa de conferência.');
      const ids = [...new Set(found.results.filter(i => String(i.payment?.id) === id).map(i => i.preapproval_id))];
      if (!ids.length) return;
      if (ids.length !== 1 || !providerId(ids[0])) throw failure(409, 'Pagamento precisa de conferência.');
      contractId = ids[0];
    } else if (payload.type === 'subscription_preapproval_plan') return;
    else throw failure(422, 'Tipo de notificação inválido.');

    const contract = await request('GET', '/preapproval/' + contractId, auth);
    if (contract?.id !== contractId || String(contract.collector_id) !== String(billing.collectorId)) throw failure(409, 'Recebedor não identificado.');
    const reference = /^rael_license_([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(contract.external_reference ?? '');
    if (!reference) return;
    const slugs = Object.keys(config.entries).filter(slug => config.entries[slug].license?.enforced === true && platformBillingForTenant(config, slug) === billing);
    if (slugs.length > 100) throw failure(503, 'Amplie a rotina de notificações antes de adicionar novos clientes.');
    const matches = [];
    for (const slug of slugs) {
      if (config.lifecycleForTenant && ['deleting', 'attention', 'deleted'].includes((await config.lifecycleForTenant(slug))?.state)) continue;
      const db = await database(slug);
      const rows = await db.query('SELECT id FROM license_contracts WHERE id = ? AND mode = ? AND provider_id = ? AND collector_id = ?', [reference[1], billing.mode, contractId, String(billing.collectorId)]);
      if (rows.length) matches.push(slug);
    }
    if (matches.length > 1) throw failure(409, 'Contrato duplicado precisa de conferência.');
    if (matches.length === 1) await (await get(matches[0])).license.notification(headers, query, payload);
  };
}
