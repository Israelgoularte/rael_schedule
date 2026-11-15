import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { readSettings } from './database.mjs';
import { failure, digest, rateLimit } from './security.mjs';
import { paymentEnvironmentMatches, createMercadoPagoClient, cents, checkoutUrl, verifyNotification } from './mercadopago-client.mjs';
import { recordLicensePayment, recordManualLicenseMoney } from './platform-finance.mjs';
import { readTenantRetention } from './tenant-retention.mjs';

const providerId = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
const numeric = v => /^\d{1,32}$/.test(String(v ?? ''));
const ref = id => `rael_license_${id}`;
const only = (v, keys) => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) throw failure(422, 'Confira os dados enviados.'); };
const monthEnd = (start, zone) => Temporal.Instant.fromEpochMilliseconds(start).toZonedDateTimeISO(zone).add({ months: 1 }).epochMilliseconds;
const plans = Object.freeze({ standard: Object.freeze({ id: 'standard', name: 'Plano mensal', priceCents: 6000 }), test: Object.freeze({ id: 'test', name: 'Plano de teste', priceCents: 500 }) });
const planFor = id => { const plan = Object.hasOwn(plans, id ?? '') ? plans[id] : null; if (!plan) throw failure(422, 'Escolha um plano válido.'); return plan; };
const contractAmount = row => Number(row?.amount_cents ?? 6000);

export function createLicense(db, slug, config) {
  const billing = config.platformBilling ?? { enabled: false, mode: config.testMode ? 'sandbox' : 'live' }, enforced = config.license?.enforced === true, now = config.now ?? (() => Date.now());
  const request = createMercadoPagoClient(billing, config.platformTransport), mode = billing.mode ?? 'sandbox';
  const configured = () => Boolean(billing.enabled && billing.accessToken && billing.collectorId && billing.webhookSecret);
  const admin = user => { if (user.role !== 'admin') throw failure(403, 'A assinatura da plataforma é administrada pelo responsável do negócio.'); };
  const requireOperator = user => {
    const operations = typeof config.operationsConfig === 'function' ? config.operationsConfig() : config.operations;
    if (!config.enabled || !operations || user.tenant !== operations.tenant || user.role !== 'admin' || !operations.userIds.includes(user.id)) throw failure(403, 'Acesso reservado à operação da plataforma.');
  };
  const ready = () => { if (!enforced || !configured()) throw failure(503, 'A cobrança da plataforma ainda não foi ativada neste negócio. Nenhuma cobrança foi criada.'); };
  async function audit(tx, actor, event, details = {}) { await tx.query('INSERT INTO audit_events(id, actor_id, event_name, detail_json, created_at) VALUES (?, ?, ?, ?, ?)', [randomUUID(), actor, event, JSON.stringify(details), now()]); }
  async function current(tx = db) { const [row] = await tx.query('SELECT * FROM license_contracts WHERE mode = ? ORDER BY created_at DESC, id DESC LIMIT 1', [mode]); return row; }
  async function pendingManualCredit(tx = db) {
    const [row] = await tx.query("SELECT starts_at, ends_at FROM license_cycles WHERE valid = 1 AND source = 'manual' AND mode = ? AND ends_at > ? ORDER BY starts_at LIMIT 1", [mode, now()]);
    return row;
  }
  async function testPlan(tx = db) {
    const [row] = await tx.query('SELECT test_visible, revision FROM license_offer_controls WHERE mode = ?', [mode]);
    return { ...plans.test, visible: Number(row?.test_visible ?? 0) === 1, revision: Number(row?.revision ?? 0) };
  }
  async function manualPeriod(tx, settings, result) {
    let startAt = Math.max(now(), result.paidUntil ?? 0, result.trialEndsAt ?? 0);
    const rows = await tx.query('SELECT starts_at, ends_at FROM license_cycles WHERE valid = 1 AND mode = ? ORDER BY starts_at, ends_at', [mode]);
    // Paid cycles can begin after the trial. Extend the contiguous horizon so
    // another confirmed receipt adds a month instead of overlapping that credit.
    for (const row of rows) if (Number(row.starts_at) <= startAt && Number(row.ends_at) > startAt) startAt = Number(row.ends_at);
    const zone = settings.published?.business.timeZone ?? settings.draft.business.timeZone;
    const endAt = monthEnd(startAt, zone);
    return { startAt, endAt, conflict: rows.some(row => Number(row.starts_at) < endAt && Number(row.ends_at) > startAt) };
  }
  async function setTestPlan(operator, input, transaction) {
    requireOperator(operator); only(input, ['visible', 'revision']);
    if (typeof input.visible !== 'boolean' || !Number.isSafeInteger(input.revision) || input.revision < 0 || !enforced) throw failure(422, 'Confira a liberação do plano de teste.');
    const work = async tx => {
      await readSettings(tx, true); const previous = await testPlan(tx);
      if (previous.revision !== input.revision) throw failure(409, 'A liberação mudou. Atualize a licença antes de continuar.');
      if (previous.revision) await tx.query('UPDATE license_offer_controls SET test_visible = ?, revision = revision + 1, updated_by = ?, updated_at = ? WHERE mode = ?', [Number(input.visible), operator.id, now(), mode]);
      else await tx.query('INSERT INTO license_offer_controls(mode, test_visible, revision, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)', [mode, Number(input.visible), 1, operator.id, now()]);
      await audit(tx, operator.id, 'platform_test_plan_visibility_changed', { operatorTenant: operator.tenant, mode, visible: input.visible, revision: previous.revision + 1 });
      return { ok: true, testPlan: await testPlan(tx) };
    };
    return transaction ? work(transaction) : db.transaction(work);
  }
  async function trialExtensionEligibility(tx) {
    const [trial] = await tx.query('SELECT starts_at, ends_at FROM license_trial WHERE id = 1');
    const endsAt = trial ? Number(trial.ends_at) : null, startedAt = trial ? Number(trial.starts_at) : null;
    const operations = typeof config.operationsConfig === 'function' ? config.operationsConfig() : config.operations;
    let blockedReason = slug === operations?.tenant ? 'A gestão da Raelapps é protegida. A prorrogação é exclusiva para os clientes da plataforma.' : !enforced ? 'A licença deste negócio não usa o teste gratuito controlado pela plataforma.' : !trial || !Number.isSafeInteger(startedAt) || startedAt <= 0 || startedAt > now() || !Number.isSafeInteger(endsAt) || endsAt < startedAt ? 'O período de teste deste negócio precisa ser conferido.' : '';
    if (!blockedReason) {
      const retention = await readTenantRetention(tx, await state(tx), now());
      const [manualFuture] = await tx.query("SELECT id FROM license_cycles WHERE source = 'manual' AND valid = 1 AND ends_at > ? LIMIT 1", [now()]);
      const [paidCycle] = await tx.query("SELECT id FROM license_cycles WHERE valid = 1 OR status IN ('approved', 'refunded', 'charged_back') LIMIT 1");
      const [contract] = await tx.query("SELECT id FROM license_contracts WHERE status <> 'cancelled' OR resolution <> '' OR provider_id IS NULL OR create_state <> 'ready' OR lease_until > ? OR check_lease_until > ? LIMIT 1", [now(), now()]);
      const [pending] = await tx.query("SELECT id FROM license_cycles WHERE source = 'mercadopago' AND status NOT IN ('approved', 'rejected', 'cancelled', 'refunded', 'charged_back') LIMIT 1");
      blockedReason = manualFuture ? 'Este negócio possui um período manual pago ainda vigente ou futuro.' : retention.hasPaidHistory || paidCycle ? 'Este negócio já possui histórico de licença paga. A prorrogação é exclusiva para o teste gratuito.' : contract || pending ? 'Há uma contratação ou pendência no Mercado Pago. Confira a licença antes de prorrogar o teste.' : '';
    }
    return { canExtend: !blockedReason, blockedReason, currentEndsAt: endsAt, minDays: 1, maxDays: 365 };
  }
  async function trialExtension(operator, transaction) {
    requireOperator(operator); const tx = transaction ?? db, eligibility = await trialExtensionEligibility(tx);
    const rows = await tx.query('SELECT id, days, note, previous_ends_at, base_at, ends_at, extended_at, operator_id FROM license_trial_extensions ORDER BY extended_at DESC, id DESC LIMIT 26');
    return { ...eligibility, history: rows.slice(0, 25).map(row => ({ id: row.id, days: Number(row.days), note: row.note, previousEndsAt: Number(row.previous_ends_at), baseAt: Number(row.base_at), endsAt: Number(row.ends_at), extendedAt: Number(row.extended_at), operatorId: row.operator_id })), historyLimited: rows.length > 25 };
  }
  async function extendTrial(operator, input, transaction) {
    requireOperator(operator); only(input, ['days', 'note', 'expectedEndsAt', 'idempotencyKey']);
    if (!Number.isSafeInteger(input.days) || input.days < 1 || input.days > 365 || typeof input.note !== 'string' || input.note.trim().length < 3 || input.note.length > 500 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(input.note.replace(/[\r\n\t]/g, '')) || !Number.isSafeInteger(input.expectedEndsAt) || input.expectedEndsAt <= 0 || typeof input.idempotencyKey !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.idempotencyKey)) throw failure(422, 'Informe de 1 a 365 dias inteiros, o motivo de 3 a 500 caracteres e o prazo atual do teste.');
    const note = input.note.trim(), key = digest(`license-trial-extension:${slug}:${operator.tenant}:${operator.id}:${input.idempotencyKey}`), signature = digest(JSON.stringify({ slug, days: input.days, note, expectedEndsAt: input.expectedEndsAt }));
    const resultFor = (row, replayed = false) => ({ ok: true, ...(replayed ? { replayed: true } : {}), previousEndsAt: Number(row.previous_ends_at), endsAt: Number(row.ends_at) });
    const work = async tx => {
      await readSettings(tx, true); requireOperator(operator);
      const [prior] = await tx.query('SELECT * FROM license_trial_extensions WHERE request_key = ?', [key]);
      if (prior) { if (prior.signature !== signature) throw failure(409, 'Esta confirmação já foi usada para outra prorrogação.'); return resultFor(prior, true); }
      const eligibility = await trialExtensionEligibility(tx);
      if (!eligibility.canExtend) throw failure(409, eligibility.blockedReason);
      if (eligibility.currentEndsAt !== input.expectedEndsAt) throw failure(409, 'O prazo de teste mudou. Atualize a licença antes de prorrogar.');
      const extendedAt = now(), baseAt = Math.max(extendedAt, eligibility.currentEndsAt), endsAt = baseAt + input.days * 86400000;
      if (!Number.isSafeInteger(endsAt)) throw failure(422, 'O novo prazo do teste precisa ser conferido.');
      const id = randomUUID();
      await tx.query('INSERT INTO license_trial_extensions(id, request_key, signature, days, note, previous_ends_at, base_at, ends_at, extended_at, operator_id, operator_tenant) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, key, signature, input.days, note, eligibility.currentEndsAt, baseAt, endsAt, extendedAt, operator.id, operator.tenant]);
      await tx.query('UPDATE license_trial SET ends_at = ? WHERE id = 1', [endsAt]);
      await audit(tx, operator.id, 'platform_trial_extended', { id, operatorTenant: operator.tenant, days: input.days, note, previousEndsAt: eligibility.currentEndsAt, baseAt, endsAt, extendedAt });
      return resultFor({ previous_ends_at: eligibility.currentEndsAt, ends_at: endsAt });
    };
    return transaction ? work(transaction) : db.transaction(work);
  }
  async function initialize() {
    if (!enforced) return;
    await db.transaction(async tx => {
      await readSettings(tx, true);
      const [trial] = await tx.query('SELECT id FROM license_trial WHERE id = 1');
      if (!trial) { const startedAt = now(); await tx.query('INSERT INTO license_trial(id, starts_at, ends_at) VALUES (?, ?, ?)', [1, startedAt, startedAt + 7 * 86400000]); await audit(tx, null, 'platform_trial_started', { days: 7 }); }
    });
  }
  async function state(tx = db) {
    if (!enforced) return { state: 'validation', canBook: true, enforced: false, priceCents: 6000, maxProfessionals: 3, configured: false, paidUntil: null, graceUntil: null, renewalCancelled: false, graceDays: 3, resolution: '', notice: null };
    const c = await current(tx), [trial] = await tx.query('SELECT * FROM license_trial WHERE id = 1'), rows = await tx.query('SELECT starts_at, ends_at, contract_id, amount_cents, plan_id FROM license_cycles WHERE valid = 1 AND mode = ? ORDER BY starts_at', [mode]);
    let paidUntil = rows.filter(r => Number(r.starts_at) <= now()).reduce((end, r) => Math.max(end, Number(r.ends_at)), 0);
    if (paidUntil >= now()) for (const r of rows) if (Number(r.starts_at) <= paidUntil && Number(r.ends_at) > paidUntil) paidUntil = Number(r.ends_at);
    const recurringCoverage = Boolean(c?.provider_id && rows.some(r => r.contract_id === c.id && Number(r.ends_at) === paidUntil)), cancelled = c?.status === 'cancelled' && recurringCoverage;
    const renewing = recurringCoverage && c.status !== 'cancelled', graceUntil = renewing ? paidUntil + 3 * 86400000 : 0;
    const trialActive = Boolean(trial && Number(trial.starts_at) <= now() && now() < Number(trial.ends_at));
    const value = c?.resolution ? 'suspended' : paidUntil > now() ? 'active' : trialActive ? 'trial' : cancelled ? 'cancelled' : !paidUntil ? 'awaiting_payment' : now() < graceUntil ? 'overdue' : 'suspended';
    const [unpaid] = c ? await tx.query('SELECT status, starts_at FROM license_cycles WHERE contract_id = ? AND valid = 0 ORDER BY starts_at DESC LIMIT 1', [c.id]) : [];
    const renewalFailed = renewing && unpaid?.status === 'rejected' && Number(unpaid.starts_at) >= paidUntil - 300000;
    const trialEndsAt = trial ? Number(trial.ends_at) : null;
    const notice = c?.resolution ? { kind: 'suspended', deadline: null } : value === 'overdue' ? { kind: renewalFailed ? 'renewal_failed' : 'renewal_pending', deadline: graceUntil } : value === 'suspended' || value === 'cancelled' || value === 'awaiting_payment' ? { kind: 'blocked', deadline: null } : value === 'trial' ? { kind: 'trial', deadline: trialEndsAt } : cancelled ? { kind: 'cancelled', deadline: paidUntil } : renewing ? { kind: renewalFailed ? 'renewal_failed' : 'renewal', deadline: renewalFailed ? graceUntil : paidUntil } : { kind: 'manual', deadline: paidUntil };
    const covered = rows.find(r => Number(r.starts_at) <= now() && Number(r.ends_at) > now());
    notice.priceCents = c && c.status !== 'cancelled' ? contractAmount(c) : Number(covered?.amount_cents ?? 6000);
    return { state: value, canBook: ['active', 'overdue', 'trial'].includes(value), enforced: true, priceCents: c && c.status !== 'cancelled' ? contractAmount(c) : Number(covered?.amount_cents ?? 6000), maxProfessionals: 3, configured: configured(), mode, paidUntil: paidUntil || null, graceUntil: graceUntil || null, graceDays: 3, renewalCancelled: cancelled, resolution: c?.resolution ?? '', trialStartedAt: trial ? Number(trial.starts_at) : null, trialEndsAt, trialDaysRemaining: value === 'trial' ? Math.ceil((trialEndsAt - now()) / 86400000) : 0, renewalFailed, renewing, notice };
  }
  async function assertBooking(tx = db) { const result = await state(tx); if (!result.canBook) throw failure(409, 'Este negócio está temporariamente indisponível para novos agendamentos. Entre em contato com o responsável.'); }
  async function view(user) {
    admin(user); const settings = await readSettings(db), c = await current(), result = await state();
    const cycles = await db.query('SELECT * FROM license_cycles WHERE mode = ? ORDER BY starts_at DESC, created_at DESC LIMIT 25', [mode]), offer = await testPlan();
    const manualPreview = await manualPeriod(db, settings, result), canRecordManual = result.enforced && !c?.resolution && (!c || c.status === 'cancelled') && !manualPreview.conflict;
    const manualCredit = await pendingManualCredit();
    const startBlockedReason = !result.configured ? 'A contratação pelo Mercado Pago ainda não está disponível.' : c?.resolution ? 'Confira a pendência financeira antes de contratar outra assinatura.' : result.paidUntil > now() ? 'Seu período pago ainda está válido. A contratação ficará disponível ao final.' : manualCredit ? 'Este negócio já tem uma mensalidade manual paga para um período futuro. Aguarde o fim dos períodos pagos antes de contratar pelo Mercado Pago.' : c && !['cancelled', 'pending'].includes(c.status) ? 'Você já tem uma assinatura em acompanhamento. Atualize a situação antes de contratar outra.' : '';
    return { ...result, availablePlans: [plans.standard, ...(offer.visible ? [plans.test] : [])], activeProfessionals: settings.draft.professionals.filter(p => p.active).length, contractStatus: c?.status ?? null, contractPlanId: c?.plan_id ?? (c ? 'standard' : null), contractPriceCents: c ? contractAmount(c) : null, canRecordManual, manualBlockReason: canRecordManual ? '' : c?.resolution ? 'Confira a pendência financeira antes de ativar uma licença manual.' : c && c.status !== 'cancelled' ? 'Cancele a renovação no Mercado Pago e atualize a situação antes de registrar um recebimento manual.' : manualPreview.conflict ? 'Já existe um período futuro que se sobrepõe a este mês. Confira os períodos antes de registrar outro recebimento.' : 'A licença deste negócio não é controlada pela plataforma.', manualPreview, canStart: !startBlockedReason, startBlockedReason, scheduledCoverageStartsAt: manualCredit ? Number(manualCredit.starts_at) : null, canCancel: Boolean(c?.provider_id && c.status !== 'cancelled' && result.configured), history: cycles.map(r => ({ id: r.id, source: r.source, planId: r.plan_id ?? 'standard', paymentMethod: r.payment_method ?? 'other', amountCents: Number(r.amount_cents), startAt: Number(r.starts_at), endAt: Number(r.ends_at), status: r.status, valid: Boolean(r.valid), paidAt: r.paid_at ? Number(r.paid_at) : null, note: r.note })), historyLimited: cycles.length === 25 };
  }
  // Read only. Operations authorizes the operator before exposing this bounded
  // projection. Never return raw provider payloads, HMACs or request identifiers.
  async function webhookReceipts() {
    const rows = await db.query('SELECT id, detail_json, created_at FROM audit_events WHERE event_name = ? ORDER BY created_at DESC, id DESC LIMIT 101', ['platform_webhook_reconciled']);
    const types = ['subscription_preapproval', 'subscription_authorized_payment', 'payment'];
    const outcomes = ['contract_verified', 'invoice_paid_verified', 'invoice_unpaid_verified', 'stale_ignored'];
    const matching = [];
    for (const row of rows.slice(0, 100)) {
      if (typeof row.detail_json !== 'string' || row.detail_json.length > 2048) continue;
      let receipt; try { receipt = JSON.parse(row.detail_json); } catch { continue; }
      const receivedAt = Number(row.created_at);
      if (!receipt || receipt.mode !== mode || !types.includes(receipt.type) || !outcomes.includes(receipt.outcome) || !providerId(receipt.resourceId) || !Number.isSafeInteger(receivedAt) || receivedAt < 0) continue;
      matching.push({ receivedAt, type: receipt.type, resourceId: receipt.resourceId, outcome: receipt.outcome });
    }
    return { mode, entries: matching.slice(0, 10), limited: matching.length > 10 || rows.length > 100, checkedAt: now() };
  }
  function validate(p, row) {
    const a = p?.auto_recurring;
    if (!providerId(p?.id) || String(p.collector_id) !== String(billing.collectorId) || p.external_reference !== ref(row.id) || !a || cents(a.transaction_amount) !== contractAmount(row) || a.currency_id !== 'BRL' || Number(a.frequency) !== 1 || a.frequency_type !== 'months' || !['pending', 'authorized', 'paused', 'cancelled'].includes(p.status) || !Number.isFinite(Date.parse(p.last_modified ?? ''))) throw failure(409, 'A cobrança retornou outras condições e precisa de conferência. Nenhuma licença será liberada por esse retorno.');
  }
  async function start(user, input) {
    admin(user); ready(); only(input, ['accepted', 'planId', 'trialUpgradeAccepted']); const selected = planFor(input.planId ?? 'standard'); if (input.accepted !== true || input.trialUpgradeAccepted !== undefined && typeof input.trialUpgradeAccepted !== 'boolean') throw failure(422, 'Confirme o valor do plano e a renovação automática antes de continuar.');
    await rateLimit(db, `license_start:${user.id}`, 10, 60000);
    const row = await db.transaction(async tx => {
      const settings = await readSettings(tx, true), c = await current(tx), s = await state(tx);
      if (c?.resolution) throw failure(409, 'Há uma pendência para conferir antes de contratar outra assinatura.');
      if (s.paidUntil > now()) throw failure(409, 'Seu período pago ainda está válido. A contratação ficará disponível ao final.');
      if (await pendingManualCredit(tx)) throw failure(409, 'Este negócio já tem uma mensalidade manual paga para um período futuro. Aguarde o fim dos períodos pagos antes de contratar pelo Mercado Pago.');
      if (s.state === 'trial' && input.trialUpgradeAccepted !== true) throw failure(422, 'Confirme que deseja a cobrança imediata e encerrar o teste gratuito após a aprovação do pagamento.');
      if (c && c.status !== 'cancelled') {
        if ((c.plan_id ?? 'standard') !== selected.id) throw failure(409, 'Há uma contratação em andamento de outro plano. Confira essa contratação antes de escolher outro plano.');
        if (c.provider_id) return { ...c, existing: true };
        if (Number(c.lease_until) > now()) throw failure(409, 'A assinatura está sendo preparada. Consulte novamente em alguns segundos.');
        await tx.query('UPDATE license_contracts SET lease_until = ? WHERE id = ?', [now() + 60000, c.id]); return { ...c, uncertain: true };
      }
      if (selected.id === 'test' && !(await testPlan(tx)).visible) throw failure(403, 'Este plano não está disponível para este negócio.');
      const id = randomUUID(), zone = settings.published?.business.timeZone ?? settings.draft.business.timeZone, createdAt = Math.max(now(), Number(c?.created_at ?? 0) + 1);
      await tx.query('INSERT INTO license_contracts(id, payer_email, mode, provider_id, collector_id, status, checkout_url, create_state, lease_until, check_lease_until, next_check_at, provider_updated_at, resolution, grace_days, time_zone, created_at, updated_at, plan_id, amount_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, user.email, mode, null, String(billing.collectorId), 'pending', null, 'creating', now() + 60000, 0, now() + 120000, 0, '', 3, zone, createdAt, now(), selected.id, selected.priceCents]);
      await audit(tx, user.id, 'platform_license_terms_accepted', { contractId: id, planId: selected.id, priceCents: selected.priceCents, maxProfessionals: 3, frequency: 'monthly', billingStartsImmediately: true, trialUpgradeAccepted: s.state === 'trial' && input.trialUpgradeAccepted === true, trialEndsAtAtAcceptance: s.trialEndsAt }); const [created] = await tx.query('SELECT * FROM license_contracts WHERE id = ?', [id]); return created;
    });
    if (row.existing) { if (row.status !== 'pending') throw failure(409, 'A assinatura já existe. Atualize a situação e consulte o ciclo pago.'); return { url: checkoutUrl(row.checkout_url, mode) }; }
    try {
      const me = await request('GET', '/users/me', { accessToken: billing.accessToken });
      if (String(me.id) !== String(billing.collectorId) || me.site_id !== 'MLB' || !Array.isArray(me.tags) || me.tags.includes('test_user') !== (mode === 'sandbox')) throw failure(409, 'O recebedor da plataforma não corresponde ao ambiente configurado.');
      let p;
      if (row.uncertain) { const found = await request('GET', '/preapproval/search?' + new URLSearchParams({ external_reference: ref(row.id), limit: '10' }), { accessToken: billing.accessToken }); const matches = found.results?.filter(p => p.external_reference === ref(row.id)); if (matches?.length !== 1 || !providerId(matches[0].id)) throw failure(409, 'A criação anterior ainda precisa ser conferida. Não inicie outra assinatura.'); p = await request('GET', '/preapproval/' + matches[0].id, { accessToken: billing.accessToken }); }
      else p = await request('POST', '/preapproval', { accessToken: billing.accessToken, key: row.id, data: { reason: 'Rael Agendamentos · até 3 profissionais', external_reference: ref(row.id), payer_email: row.payer_email, auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: contractAmount(row) / 100, currency_id: 'BRL' }, status: 'pending', back_url: `${config.origin}/sistema/${slug}/assinatura?retorno=1`, notification_url: config.platformWebhookUrl ?? `${config.origin}/payments/platform/webhook/${slug}` } });
      validate(p, row); const url = checkoutUrl(p.init_point, mode);
      await db.transaction(async tx => { await readSettings(tx, true); await tx.query('UPDATE license_contracts SET provider_id = ?, status = ?, checkout_url = ?, create_state = ?, lease_until = 0, provider_updated_at = ?, updated_at = ? WHERE id = ?', [p.id, p.status, url, 'ready', Date.parse(p.last_modified), now(), row.id]); }); return { url };
    } catch (error) { await db.query('UPDATE license_contracts SET create_state = ?, lease_until = 0 WHERE id = ?', ['uncertain', row.id]); throw error; }
  }
  async function reconcileContract(id) {
    if (!providerId(id)) throw failure(422, 'Assinatura inválida.');
    const p = await request('GET', '/preapproval/' + id, { accessToken: billing.accessToken }); const match = /^rael_license_([a-f0-9-]{36})$/.exec(p?.external_reference ?? ''); if (!match) return;
    return db.transaction(async tx => {
      await readSettings(tx, true); const [row] = await tx.query('SELECT * FROM license_contracts WHERE id = ? AND mode = ?', [match[1], mode]); if (!row) return;
      try { validate(p, row); if (p.id !== id || row.provider_id && row.provider_id !== id) throw Error(); } catch { await tx.query('UPDATE license_contracts SET resolution = ? WHERE id = ?', ['verification_required', row.id]); return; }
      if (Date.parse(p.last_modified) < Number(row.provider_updated_at) || row.status === 'cancelled' && p.status !== 'cancelled') return { contractId: row.id, outcome: 'stale_ignored' };
      await tx.query('UPDATE license_contracts SET provider_id = ?, status = ?, provider_updated_at = ?, updated_at = ? WHERE id = ?', [id, p.status, Date.parse(p.last_modified), now(), row.id]);
      return { contractId: row.id, outcome: 'contract_verified' };
    });
  }
  async function reconcileInvoice(id) {
    if (!numeric(id)) throw failure(422, 'Fatura inválida.');
    const i = await request('GET', '/authorized_payments/' + id, { accessToken: billing.accessToken }); if (String(i?.id) !== String(id) || !providerId(i.preapproval_id)) throw failure(409, 'A fatura precisa ser conferida.');
    const [c] = await db.query('SELECT * FROM license_contracts WHERE provider_id = ? AND mode = ?', [i.preapproval_id, mode]); if (!c) return;
    const contractCheck = await reconcileContract(c.provider_id); if (!numeric(i.payment?.id)) return;
    const p = await request('GET', '/v1/payments/' + i.payment.id, { accessToken: billing.accessToken }), start = Date.parse(i.debit_date ?? ''), updated = Date.parse(p.date_last_updated ?? ''); let end; try { end = monthEnd(start, c.time_zone); } catch { end = NaN; }
    const environmentMatches = await paymentEnvironmentMatches(p, mode, billing.collectorId, billing.accessToken, request);
    return db.transaction(async tx => {
      await readSettings(tx, true);
      if (String(p.id) !== String(i.payment.id) || String(p.collector_id) !== String(billing.collectorId) || !environmentMatches || i.currency_id !== 'BRL' || p.currency_id !== 'BRL' || cents(i.transaction_amount) !== contractAmount(c) || cents(p.transaction_amount) !== contractAmount(c) || !Number.isFinite(updated) || !Number.isFinite(end) || start < Number(c.created_at) - 86400000 || p.external_reference && p.external_reference !== ref(c.id)) { await tx.query('UPDATE license_contracts SET resolution = ? WHERE id = ?', ['verification_required', c.id]); return; }
      const cycleId = digest(`${c.id}:${start}`), [old] = await tx.query('SELECT * FROM license_cycles WHERE id = ?', [cycleId]);
      if (old && Number(old.provider_updated_at) > updated) return contractCheck?.contractId === c.id ? { contractId: c.id, paymentId: String(p.id), outcome: 'stale_ignored' } : undefined;
      if (old && (old.invoice_id !== String(id) || old.payment_id !== String(p.id) && old.valid)) { await tx.query('UPDATE license_contracts SET resolution = ? WHERE id = ?', ['duplicate_cycle_review', c.id]); return; }
      const refunded = cents(p.transaction_amount_refunded ?? 0);
      if (!Number.isSafeInteger(refunded) || refunded < 0 || refunded > contractAmount(c)) { await tx.query('UPDATE license_contracts SET resolution = ? WHERE id = ?', ['verification_required', c.id]); return; }
      const providerPaid = p.status === 'approved' && refunded === 0, stamp = Date.parse(p.date_approved ?? '') || updated;
      const [manualOverlap] = providerPaid ? await tx.query("SELECT id FROM license_cycles WHERE valid = 1 AND source = 'manual' AND mode = ? AND starts_at < ? AND ends_at > ? LIMIT 1", [mode, end, start]) : [];
      const paid = providerPaid && !manualOverlap;
      if (old) { if (old.payment_id !== String(p.id)) await audit(tx, null, 'platform_license_payment_retry', { cycleId, previousPaymentId: old.payment_id, paymentId: String(p.id) }); await tx.query('UPDATE license_cycles SET payment_id = ?, valid = ?, status = ?, provider_updated_at = ?, paid_at = ? WHERE id = ?', [String(p.id), Number(paid), p.status, updated, providerPaid ? stamp : old.paid_at, cycleId]); }
      else await tx.query('INSERT INTO license_cycles(id, contract_id, source, mode, invoice_id, payment_id, amount_cents, starts_at, ends_at, valid, status, paid_at, provider_updated_at, request_key, signature, actor_id, note, created_at, plan_id, payment_method) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [cycleId, c.id, 'mercadopago', mode, String(id), String(p.id), contractAmount(c), start, end, Number(paid), p.status, providerPaid ? stamp : null, updated, null, digest(`${c.id}:${p.id}`), null, 'Mensalidade da plataforma Rael', now(), c.plan_id ?? 'standard', 'mercadopago']);
      await recordLicensePayment(tx, { cycleId, payment: p, mode, now: now(), amountCents: contractAmount(c) });
      if (manualOverlap) {
        const [locked] = await tx.query('SELECT resolution FROM license_contracts WHERE id = ?', [c.id]);
        if (locked.resolution !== 'manual_overlap_review') await audit(tx, null, 'platform_license_manual_overlap_review', { contractId: c.id, cycleId, paymentId: String(p.id), manualCycleId: manualOverlap.id });
        await tx.query('UPDATE license_contracts SET resolution = ? WHERE id = ?', ['manual_overlap_review', c.id]);
      } else if (old?.valid && !paid || refunded > 0 || ['refunded', 'charged_back'].includes(p.status)) await tx.query('UPDATE license_contracts SET resolution = ? WHERE id = ?', ['payment_review', c.id]);
      // A voluntary checkout ends the free trial only after a canonical paid
      // cycle currently grants access. Authorization and future/unpaid cycles
      // leave its original deadline intact. This durable change is never undone
      // by cancellation, refund, restart or notification redelivery.
      const activeContract = paid && start <= now() && now() < end ? await current(tx) : null;
      if (activeContract?.id === c.id && !activeContract.resolution) {
        const [trial] = await tx.query('SELECT starts_at, ends_at FROM license_trial WHERE id = 1');
        if (trial && Number(trial.starts_at) <= now() && now() < Number(trial.ends_at)) {
          const endedAt = now();
          await tx.query('UPDATE license_trial SET ends_at = ? WHERE id = 1', [endedAt]);
          await audit(tx, null, 'platform_trial_ended_by_subscription', { contractId: c.id, cycleId, paymentId: String(p.id), originalEndsAt: Number(trial.ends_at), newEndsAt: endedAt, paidAt: stamp, planId: c.plan_id ?? 'standard', amountCents: contractAmount(c) });
        }
      }
      if (contractCheck?.contractId === c.id) return { contractId: c.id, paymentId: String(p.id), outcome: providerPaid ? 'invoice_paid_verified' : 'invoice_unpaid_verified' };
    });
  }
  async function refresh(user) { admin(user); ready(); await rateLimit(db, `license_refresh:${user.id}`, 20, 60000); const c = await current(); if (c) await reconcile(c); return view(user); }
  async function reconcile(c) {
    const claim = await db.transaction(async tx => { await readSettings(tx, true); const [row] = await tx.query('SELECT * FROM license_contracts WHERE id = ?', [c.id]); if (!row.provider_id || Number(row.check_lease_until) > now()) return null; await tx.query('UPDATE license_contracts SET check_lease_until = ?, next_check_at = ? WHERE id = ?', [now() + 90000, now() + 5 * 60000, c.id]); return row; }); if (!claim) return;
    try { await reconcileContract(claim.provider_id); const result = await request('GET', '/authorized_payments/search?' + new URLSearchParams({ preapproval_id: claim.provider_id, limit: '12', sort: 'debit_date', criteria: 'desc' }), { accessToken: billing.accessToken }); if (!Array.isArray(result.results)) throw failure(503, 'Não foi possível conferir as mensalidades.'); for (const i of result.results.slice(0, 3)) if (numeric(i.id)) await reconcileInvoice(String(i.id)); const active = await db.query('SELECT invoice_id FROM license_cycles WHERE contract_id = ? AND ends_at > ? LIMIT 2', [claim.id, now()]); for (const i of active) if (i.invoice_id && !result.results.some(v => String(v.id) === i.invoice_id)) await reconcileInvoice(i.invoice_id); }
    finally { await db.query('UPDATE license_contracts SET check_lease_until = 0 WHERE id = ?', [c.id]); }
  }
  async function cancel(user, { authorizeProvider = work => work() } = {}) {
    admin(user); ready(); const c = await current(); if (!c?.provider_id) throw failure(409, 'Não há renovação identificada para cancelar. Confira uma criação pendente antes de continuar.');
    if (c.status !== 'cancelled') { await authorizeProvider(() => request('PUT', '/preapproval/' + c.provider_id, { accessToken: billing.accessToken, data: { status: 'cancelled' } })); await reconcileContract(c.provider_id); }
    if ((await current()).status !== 'cancelled') throw failure(409, 'O Mercado Pago ainda não confirmou o cancelamento. Atualize a situação.'); await db.transaction(tx => audit(tx, user.id, 'platform_license_renewal_cancelled', { contractId: c.id })); return view(user);
  }
  async function notification(headers, query, body) {
    ready(); verifyNotification(headers, query['data.id'], billing.webhookSecret, now()); if (String(body.data?.id) !== query['data.id']) throw failure(422, 'Notificação inválida.');
    let checked;
    if (body.type === 'subscription_preapproval') checked = await reconcileContract(query['data.id']);
    else if (body.type === 'subscription_authorized_payment') checked = await reconcileInvoice(query['data.id']);
    else if (body.type === 'payment' && numeric(query['data.id'])) {
      const found = await request('GET', '/authorized_payments/search?' + new URLSearchParams({ payment_id: query['data.id'], limit: '5' }), { accessToken: billing.accessToken });
      for (const i of (found.results ?? []).slice(0, 5)) if (numeric(i.id)) {
        const result = await reconcileInvoice(String(i.id));
        if (result?.paymentId === query['data.id']) checked = result;
      }
    }
    else throw failure(422, 'Tipo de notificação inválido.');
    // An HTTP 200 can also acknowledge an ignored/unknown resource. Only a
    // matched canonical reconciliation produces this receipt, never a claim
    // that authorization alone paid a cycle. UI refresh and sweep cannot emit it.
    if (!checked) return;
    const hash = digest(`platform-webhook:${mode}:${body.type}:${query['data.id']}:${headers['x-request-id']}`), id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
    await db.transaction(async tx => {
      await readSettings(tx, true);
      const [existing] = await tx.query('SELECT id FROM audit_events WHERE id = ?', [id]);
      if (existing) return;
      await tx.query('INSERT INTO audit_events(id, actor_id, event_name, detail_json, created_at) VALUES (?, ?, ?, ?, ?)', [id, null, 'platform_webhook_reconciled', JSON.stringify({ type: body.type, resourceId: query['data.id'], mode, requestIdHash: digest(headers['x-request-id']), outcome: checked.outcome }), now()]);
    });
  }
  async function manual(operator, input, transaction) {
    requireOperator(operator); only(input, ['idempotencyKey', 'note', 'planId', 'paymentMethod']);
    const selected = planFor(input.planId ?? 'standard'), paymentMethod = input.paymentMethod ?? 'other';
    if (!enforced || !/^[a-f0-9-]{36}$/.test(input.idempotencyKey ?? '') || typeof input.note !== 'string' || input.note.trim().length < 3 || input.note.length > 250 || !['pix', 'cash', 'bank_transfer', 'external', 'other'].includes(paymentMethod)) throw failure(422, 'Informe o plano recebido, a forma de recebimento e uma observação para auditoria.');
    const resultFor = row => ({ ok: true, cycleId: row.id, startAt: Number(row.starts_at), endAt: Number(row.ends_at), amountCents: Number(row.amount_cents), planId: row.plan_id ?? 'standard', paymentMethod: row.payment_method ?? 'other', scheduled: Number(row.starts_at) > now() });
    const work = async tx => {
      const settings = await readSettings(tx, true), c = await current(tx), key = digest(`${operator.id}:${input.idempotencyKey}`), signature = digest(JSON.stringify({ idempotencyKey: input.idempotencyKey, note: input.note.trim(), planId: selected.id, paymentMethod }));
      const [prior] = await tx.query('SELECT * FROM license_cycles WHERE request_key = ?', [key]);
      if (prior) {
        const legacyMatches = input.planId === undefined && input.paymentMethod === undefined && prior.signature === digest(JSON.stringify(input));
        if (prior.signature !== signature && !legacyMatches) throw failure(409, 'Essa confirmação já foi usada com outro registro.');
        return resultFor(prior);
      }
      if (c?.resolution || c && c.status !== 'cancelled') throw failure(409, 'Há uma assinatura recorrente em acompanhamento. Não registre outra mensalidade manual para o mesmo período.');
      const s = await state(tx), period = await manualPeriod(tx, settings, s);
      if (period.conflict) throw failure(409, 'Já existe um período futuro que se sobrepõe a este mês. Confira os períodos antes de registrar outro recebimento.');
      const { startAt: start, endAt: end } = period, id = digest(randomUUID());
      await tx.query('INSERT INTO license_cycles(id, contract_id, source, mode, invoice_id, payment_id, amount_cents, starts_at, ends_at, valid, status, paid_at, provider_updated_at, request_key, signature, actor_id, note, created_at, plan_id, payment_method) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, null, 'manual', mode, null, null, selected.priceCents, start, end, 1, 'approved', now(), now(), key, signature, operator.id, input.note.trim(), now(), selected.id, paymentMethod]);
      await recordManualLicenseMoney(tx, { cycleId: id, mode, now: now(), amountCents: selected.priceCents });
      await audit(tx, operator.id, 'platform_license_manual_receipt', { cycleId: id, operatorTenant: operator.tenant, planId: selected.id, amountCents: selected.priceCents, paymentMethod, startAt: start, endAt: end });
      return resultFor({ id, starts_at: start, ends_at: end, amount_cents: selected.priceCents, plan_id: selected.id, payment_method: paymentMethod });
    };
    return transaction ? work(transaction) : db.transaction(work);
  }
  async function sweep() { if (!configured() || !enforced) return; const [c] = await db.query('SELECT * FROM license_contracts WHERE mode = ? AND provider_id IS NOT NULL AND next_check_at <= ? ORDER BY next_check_at LIMIT 1', [mode, now()]); if (c) try { await reconcile(c); } catch (error) { try { config.onMaintenanceFailure?.('license', error); } catch { /* Monitoring cannot interrupt durable retry. */ } } }
  return { initialize, view, testPlan, setTestPlan, trialExtension, extendTrial, webhookReceipts, state, assertBooking, start, refresh, cancel, notification, manual, sweep };
}
