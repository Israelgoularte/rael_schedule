import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { readSettings } from './database.mjs';
import { digest, failure, rateLimit } from './security.mjs';
import { plainDate, localInstant } from './bookings.mjs';
import { cents } from './mercadopago-client.mjs';

const uuid = v => typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v);
const only = (v, keys) => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) throw failure(422, 'Confira os dados enviados.'); };
const number = v => Number(v ?? 0);
const netValue = e => e.kind === 'receipt' ? number(e.amount_cents) : -number(e.amount_cents);

// Called only after canonical payment ownership/amount/environment verification,
// inside the caller's existing tenant transaction. Bookings covered by a plan
// never call this routine: the recurring payment itself is the revenue event.
export async function recordProviderMoney(tx, { connectionId, payment, customerId, professionalId, appointmentId = null, subscriptionId = null, now = Date.now() }) {
  const key = digest(`${connectionId}:${payment.id}`), owner = digest(`${customerId}:${professionalId}:${appointmentId}:${subscriptionId}`);
  const updated = Date.parse(payment.date_last_updated ?? ''); if (!Number.isFinite(updated)) return;
  const [old] = await tx.query('SELECT * FROM financial_provider_snapshots WHERE payment_key = ?', [key]);
  if (old && old.owner_key !== owner) throw failure(409, 'O lançamento retornou outro vínculo. Confira a situação.');
  if (old && number(old.provider_updated_at) > updated) return;
  const net = payment.status === 'approved' ? Math.max(0, cents(payment.transaction_amount) - cents(payment.transaction_amount_refunded ?? 0)) : 0;
  const delta = net - number(old?.net_cents);
  if (delta) {
    const stamp = delta > 0 && !old?.net_cents ? Date.parse(payment.date_approved ?? '') : updated;
    const occurred = Number.isFinite(stamp) ? stamp : now, id = digest(`${key}:${updated}:${net}`);
    const [exists] = await tx.query('SELECT id FROM financial_entries WHERE id = ?', [id]);
    if (!exists) await tx.query('INSERT INTO financial_entries(id, request_key, signature, customer_id, professional_id, appointment_id, subscription_id, source, kind, method, amount_cents, occurred_at, date_source, actor_id, note, reverse_of, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, null, owner, customerId, professionalId, appointmentId, subscriptionId, subscriptionId ? 'subscription' : 'mercadopago', delta > 0 ? 'receipt' : 'refund', 'mercadopago', Math.abs(delta), occurred, Number.isFinite(stamp) ? 'provider' : 'recorded', null, delta > 0 ? 'Recebimento conferido no Mercado Pago' : 'Devolução ou ajuste conferido no Mercado Pago', null, now]);
  }
  if (old) await tx.query('UPDATE financial_provider_snapshots SET net_cents = ?, provider_updated_at = ? WHERE payment_key = ?', [net, updated, key]);
  else await tx.query('INSERT INTO financial_provider_snapshots(payment_key, owner_key, net_cents, provider_updated_at) VALUES (?, ?, ?, ?)', [key, owner, net, updated]);
}

export function createFinance(db, config, payments) {
  const now = config.now ?? (() => Date.now());
  const allow = u => { if (!['admin', 'reception', 'professional'].includes(u.role)) throw failure(403, 'Acesso não permitido.'); };
  async function period(user, args = {}) {
    allow(user); const settings = await readSettings(db), zone = settings.published?.business.timeZone ?? settings.draft.business.timeZone;
    const today = Temporal.Instant.fromEpochMilliseconds(now()).toZonedDateTimeISO(zone).toPlainDate();
    const from = args.from ? plainDate(args.from) : today.with({ day: 1 }), to = args.to ? plainDate(args.to) : today.with({ day: today.daysInMonth });
    if (Temporal.PlainDate.compare(from, to) > 0 || from.until(to).days > 365) throw failure(422, 'Escolha um período de até 366 dias, com início antes do fim.');
    const professionalId = user.role === 'professional' ? user.professional_id : args.professionalId || '';
    if (user.role === 'professional' && args.professionalId && args.professionalId !== user.professional_id) throw failure(403, 'Consulte apenas seu próprio movimento.');
    if (professionalId && !settings.draft.professionals.some(p => p.id === professionalId)) throw failure(422, 'Profissional não encontrado.');
    return { settings, zone, from: from.toString(), to: to.toString(), start: localInstant(from.toString(), '00:00', zone), end: localInstant(to.add({ days: 1 }).toString(), '00:00', zone), professionalId, professionals: settings.draft.professionals.filter(p => user.role !== 'professional' || p.id === professionalId).map(({ id, name, active }) => ({ id, name, active })) };
  }
  function scope(p, alias) { return p.professionalId ? { sql: ` AND ${alias}.professional_id = ?`, params: [p.professionalId] } : { sql: '', params: [] }; }
  async function appointment(tx, user, id) {
    allow(user); if (!uuid(id)) throw failure(422, 'Atendimento inválido.');
    const [row] = await tx.query('SELECT a.*, c.name AS customer_name FROM appointments a JOIN customers c ON c.id = a.customer_id WHERE a.id = ?', [id]);
    if (!row || user.role === 'professional' && row.professional_id !== user.professional_id) throw failure(404, 'Atendimento não encontrado no seu acesso.'); return row;
  }
  async function balance(tx, row) {
    const s = JSON.parse(row.snapshot_json), manual = await tx.query("SELECT * FROM financial_entries WHERE appointment_id = ? AND source = 'manual'", [row.id]);
    const online = await tx.query('SELECT p.* FROM mp_payments p JOIN mp_intents i ON i.id = p.intent_id WHERE i.appointment_id = ?', [row.id]);
    const manualNet = manual.reduce((n, e) => n + netValue(e), 0), onlineNet = online.reduce((n, e) => n + (e.status === 'approved' ? Math.max(0, number(e.amount_cents) - number(e.refunded_cents)) : 0), 0);
    const included = Boolean(s.subscription), chargeable = !included && ['confirmed', 'in_progress', 'completed'].includes(row.status), price = number(s.service.priceCents), net = manualNet + onlineNet;
    return { appointmentId: row.id, customerId: row.customer_id, customerName: row.customer_name, professionalId: row.professional_id, professionalName: s.professional.name, serviceName: s.service.name, startAt: number(row.starts_at), status: row.status, priceCents: price, coveredByPlan: included, requireOnline: Boolean(s.requirePayment), manualNetCents: manualNet, onlineNetCents: onlineNet, receivedCents: net, pendingCents: chargeable ? Math.max(0, price - net) : 0, estimatedCents: chargeable && !s.requirePayment ? Math.max(0, price - net) : 0, canRecord: chargeable && !s.requirePayment && price > net, needsReview: ['cancelled', 'no_show', 'expired'].includes(row.status) && net > 0 };
  }
  async function appointmentView(user, id) {
    const row = await appointment(db, user, id), entries = await db.query('SELECT f.*, u.name AS actor_name FROM financial_entries f LEFT JOIN users u ON u.id = f.actor_id WHERE f.appointment_id = ? ORDER BY f.created_at, f.id', [id]);
    const settings = await readSettings(db), zone = settings.published?.business.timeZone ?? settings.draft.business.timeZone;
    const refunded = Object.fromEntries(entries.filter(e => e.reverse_of).map(e => [e.reverse_of, 0])); for (const e of entries) if (e.reverse_of) refunded[e.reverse_of] += number(e.amount_cents);
    return { ...await balance(db, row), timeZone: zone, today: Temporal.Instant.fromEpochMilliseconds(now()).toZonedDateTimeISO(zone).toPlainDate().toString(), entries: entries.map(e => ({ ...entryView(e), refundableCents: e.source === 'manual' && e.kind === 'receipt' ? Math.max(0, number(e.amount_cents) - (refunded[e.id] ?? 0)) : 0, canRefund: user.role !== 'reception' && e.source === 'manual' && e.kind === 'receipt' })) };
  }
  function entryView(e) { return { id: e.id, appointmentId: e.appointment_id, subscriptionId: e.subscription_id, source: e.source, kind: e.kind, method: e.method, amountCents: number(e.amount_cents), occurredAt: number(e.occurred_at), dateSource: e.date_source, note: e.note, actorName: e.actor_name ?? '', customerName: e.customer_name, professionalName: e.professional_name }; }
  async function manual(user, input) {
    allow(user); only(input, ['appointmentId', 'amountCents', 'method', 'date', 'note', 'idempotencyKey', 'refundOf']);
    if (!uuid(input.idempotencyKey) || !Number.isSafeInteger(input.amountCents) || input.amountCents < 1 || input.amountCents > 100000000 || !['cash', 'pix', 'card', 'transfer', 'other'].includes(input.method) || typeof input.note !== 'string' || input.note.trim().length > 250 || /[\x00-\x1f]/.test(input.note)) throw failure(422, 'Confira valor, forma de pagamento e observação (até 250 caracteres).');
    if (input.refundOf && !/^[a-f0-9]{64}$/.test(input.refundOf)) throw failure(422, 'Lançamento de origem inválido.');
    if (input.refundOf && user.role === 'reception') throw failure(403, 'A devolução é registrada pelo administrador ou profissional responsável.');
    if (input.refundOf && input.note.trim().length < 3) throw failure(422, 'Descreva o motivo da devolução ou correção.');
    await rateLimit(db, `finance_manual:${user.id}`, 60, 60000);
    const key = digest(`${user.id}:${input.idempotencyKey}`), signature = digest(JSON.stringify(input));
    return db.transaction(async tx => {
      const settings = await readSettings(tx, true), [prior] = await tx.query('SELECT * FROM financial_entries WHERE request_key = ?', [key]);
      if (prior) { if (prior.signature !== signature) throw failure(409, 'Essa confirmação já foi usada com outro lançamento.'); return { id: prior.id, repeated: true }; }
      const row = await appointment(tx, user, input.appointmentId), b = await balance(tx, row);
      const zone = settings.published?.business.timeZone ?? settings.draft.business.timeZone, date = plainDate(input.date), today = Temporal.Instant.fromEpochMilliseconds(now()).toZonedDateTimeISO(zone).toPlainDate();
      if (Temporal.PlainDate.compare(date, today) > 0 || date.until(today).days > 365) throw failure(422, 'Use uma data de hoje ou dos últimos 365 dias.');
      const occurredAt = localInstant(input.date, '12:00', zone); // User reports a date, not an invented exact payment time.
      if (input.refundOf) {
        const [original] = await tx.query("SELECT * FROM financial_entries WHERE id = ? AND appointment_id = ? AND source = 'manual' AND kind = 'receipt'", [input.refundOf, row.id]);
        if (!original) throw failure(422, 'Escolha um recebimento manual deste atendimento.');
        const [sum] = await tx.query('SELECT SUM(amount_cents) AS amount FROM financial_entries WHERE reverse_of = ?', [original.id]);
        if (input.amountCents > number(original.amount_cents) - number(sum.amount)) throw failure(409, 'A devolução ultrapassa o saldo deste recebimento.');
        if (input.date < Temporal.Instant.fromEpochMilliseconds(number(original.occurred_at)).toZonedDateTimeISO(zone).toPlainDate().toString()) throw failure(422, 'A devolução não pode ter data anterior ao recebimento.');
      } else if (!b.canRecord || input.amountCents > b.pendingCents) throw failure(409, 'O valor ultrapassa o saldo ou este atendimento não aceita baixa manual. Planos e cobranças online são acompanhados separadamente.');
      const id = digest(randomUUID()), kind = input.refundOf ? 'refund' : 'receipt';
      await tx.query('INSERT INTO financial_entries(id, request_key, signature, customer_id, professional_id, appointment_id, subscription_id, source, kind, method, amount_cents, occurred_at, date_source, actor_id, note, reverse_of, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, key, signature, row.customer_id, row.professional_id, row.id, null, 'manual', kind, input.method, input.amountCents, occurredAt, 'reported_date', user.id, input.note.trim(), input.refundOf ?? null, now()]);
      await tx.query('INSERT INTO audit_events(id, actor_id, event_name, detail_json, created_at) VALUES (?, ?, ?, ?, ?)', [randomUUID(), user.id, input.refundOf ? 'manual_refund_recorded' : 'manual_receipt_recorded', JSON.stringify({ entryId: id, appointmentId: row.id, amountCents: input.amountCents }), now()]);
      return { id, repeated: false };
    });
  }
  async function report(user, args = {}, forDashboard = false) {
    const p = await period(user, args); await payments.housekeeping(); const aScope = scope(p, 'a'), fScope = scope(p, 'f');
    const offset = Number(args.offset ?? 0); if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw failure(422, 'Página inválida.');
    const appointmentOffset = Number(args.appointmentOffset ?? 0); if (!Number.isSafeInteger(appointmentOffset) || appointmentOffset < 0 || appointmentOffset > 100000) throw failure(422, 'Página inválida.');
    const params = [p.start, p.end, ...fScope.params], where = ' WHERE f.occurred_at >= ? AND f.occurred_at < ?' + fScope.sql;
    const sums = await db.query('SELECT source, kind, method, SUM(amount_cents) AS amount, COUNT(*) AS total FROM financial_entries f' + where + ' GROUP BY source, kind, method', params);
    const entries = await db.query('SELECT f.*, c.name AS customer_name, u.name AS actor_name FROM financial_entries f JOIN customers c ON c.id = f.customer_id LEFT JOIN users u ON u.id = f.actor_id' + where + ` ORDER BY f.occurred_at DESC, f.created_at DESC, f.id LIMIT 26 OFFSET ${offset}`, params);
    const rows = await db.query('SELECT a.*, c.name AS customer_name FROM appointments a JOIN customers c ON c.id = a.customer_id WHERE a.starts_at >= ? AND a.starts_at < ?' + aScope.sql + ' ORDER BY a.starts_at, a.id LIMIT 5001', [p.start, p.end, ...aScope.params]);
    if (rows.length > 5000) throw failure(422, 'Há muitos agendamentos. Reduza o período ou filtre por profissional.');
    // Aggregate once per request, not one database round trip for each appointment.
    const manualRows = await db.query("SELECT f.appointment_id, SUM(CASE WHEN f.kind = 'receipt' THEN f.amount_cents ELSE -f.amount_cents END) AS amount FROM financial_entries f JOIN appointments a ON a.id = f.appointment_id WHERE f.source = 'manual' AND a.starts_at >= ? AND a.starts_at < ?" + aScope.sql + ' GROUP BY f.appointment_id', [p.start, p.end, ...aScope.params]);
    const onlineRows = await db.query("SELECT i.appointment_id, SUM(CASE WHEN m.status = 'approved' THEN m.amount_cents - m.refunded_cents ELSE 0 END) AS amount FROM mp_payments m JOIN mp_intents i ON i.id = m.intent_id JOIN appointments a ON a.id = i.appointment_id WHERE a.starts_at >= ? AND a.starts_at < ?" + aScope.sql + ' GROUP BY i.appointment_id', [p.start, p.end, ...aScope.params]);
    const manualMap = new Map(manualRows.map(r => [r.appointment_id, number(r.amount)])), onlineMap = new Map(onlineRows.map(r => [r.appointment_id, number(r.amount)]));
    const balances = rows.map(row => { const s = JSON.parse(row.snapshot_json), net = (manualMap.get(row.id) ?? 0) + (onlineMap.get(row.id) ?? 0), chargeable = !s.subscription && ['confirmed', 'in_progress', 'completed'].includes(row.status), pending = chargeable ? Math.max(0, number(s.service.priceCents) - net) : 0; return { appointmentId: row.id, customerName: row.customer_name, professionalId: row.professional_id, professionalName: s.professional.name, serviceName: s.service.name, startAt: number(row.starts_at), status: row.status, priceCents: number(s.service.priceCents), receivedCents: net, pendingCents: pending, estimatedCents: !s.requirePayment ? pending : 0, coveredByPlan: Boolean(s.subscription), canRecord: chargeable && !s.requirePayment && pending > 0, needsReview: ['cancelled', 'no_show', 'expired'].includes(row.status) && net > 0 }; });
    const totals = { receiptsCents: 0, refundsCents: 0, manualNetCents: 0, onlineNetCents: 0, subscriptionNetCents: 0, pendingCents: balances.reduce((n, b) => n + b.pendingCents, 0), estimatedCents: balances.reduce((n, b) => n + b.estimatedCents, 0), completedEstimatedCents: balances.filter(b => b.status === 'completed').reduce((n, b) => n + b.estimatedCents, 0) };
    for (const sum of sums) {
      const net = sum.kind === 'receipt' ? number(sum.amount) : -number(sum.amount);
      totals[sum.kind === 'receipt' ? 'receiptsCents' : 'refundsCents'] += number(sum.amount);
      if (sum.source === 'manual' || sum.source === 'subscription' && sum.method !== 'mercadopago') totals.manualNetCents += net;
      if (sum.source === 'subscription') totals.subscriptionNetCents += net;
      else if (sum.source === 'mercadopago') totals.onlineNetCents += net;
    }
    totals.netCents = totals.receiptsCents - totals.refundsCents;
    return { from: p.from, to: p.to, timeZone: p.zone, today: Temporal.Instant.fromEpochMilliseconds(now()).toZonedDateTimeISO(p.zone).toPlainDate().toString(), professionalId: p.professionalId, professionals: p.professionals, totals, entries: entries.slice(0, 25).map(e => ({ ...entryView(e), professionalName: e.professional_id === 'business' ? 'Negócio' : p.professionals.find(v => v.id === e.professional_id)?.name ?? 'Profissional' })), hasMore: entries.length > 25, offset, appointments: forDashboard ? balances : balances.slice(appointmentOffset, appointmentOffset + 25), appointmentOffset, appointmentHasMore: balances.length > appointmentOffset + 25, appointmentTotal: balances.length, canRefund: user.role !== 'reception' };
  }
  async function dashboard(user, args) {
    const r = await report(user, args, true), p = await period(user, args), statuses = {}, byProfessional = new Map(r.professionals.map(v => [v.id, { ...v, appointments: 0, completed: 0, estimatedCents: 0 }]));
    for (const a of r.appointments) { statuses[a.status] = (statuses[a.status] ?? 0) + 1; const pro = byProfessional.get(a.professionalId); if (pro) { if (!['cancelled', 'expired'].includes(a.status)) pro.appointments++; if (a.status === 'completed') pro.completed++; pro.estimatedCents += a.estimatedCents; } }
    const cScope = user.role === 'professional' ? ' AND EXISTS (SELECT 1 FROM appointments a WHERE a.customer_id = c.id AND a.professional_id = ?)' : '';
    const [customers] = await db.query('SELECT COUNT(*) AS total FROM customers c WHERE c.created_at >= ? AND c.created_at < ?' + cScope, [p.start, p.end, ...(cScope ? [user.professional_id] : [])]);
    const paidScope = scope(p, 'f'), daily = await db.query('SELECT f.occurred_at, f.kind, f.amount_cents FROM financial_entries f WHERE f.occurred_at >= ? AND f.occurred_at < ?' + paidScope.sql + ' ORDER BY f.occurred_at LIMIT 10001', [p.start, p.end, ...paidScope.params]);
    if (daily.length > 10000) throw failure(422, 'Há muitos lançamentos. Reduza o período para consultar o painel.');
    const dates = new Map(); for (const e of daily) { const d = Temporal.Instant.fromEpochMilliseconds(number(e.occurred_at)).toZonedDateTimeISO(p.zone).toPlainDate().toString(); dates.set(d, (dates.get(d) ?? 0) + netValue(e)); }
    const aScope = scope(p, 'a'), appointments = await db.query("SELECT professional_id, starts_at, occupied_until FROM appointments a WHERE a.starts_at < ? AND a.occupied_until > ? AND a.status NOT IN ('cancelled','expired')" + aScope.sql + ' LIMIT 5001', [p.end, p.start, ...aScope.params]);
    const blocks = await db.query('SELECT * FROM calendar_blocks a WHERE a.active = 1 AND a.starts_at < ? AND a.ends_at > ?' + aScope.sql + ' LIMIT 2001', [p.end, p.start, ...aScope.params]);
    if (blocks.length > 2000 || appointments.length > 5000) throw failure(422, 'Reduza o período para calcular a ocupação.');
    let available = 0, occupied = 0;
    const unionLength = ranges => { const sorted = ranges.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]); let total = 0, last = [-Infinity, -Infinity]; for (const v of sorted) { if (v[0] > last[1]) { total += last[1] - last[0] || 0; last = v; } else last[1] = Math.max(last[1], v[1]); } return total + (last[1] - last[0] || 0); };
    const pros = p.settings.draft.professionals.filter(v => v.active && (!p.professionalId || v.id === p.professionalId));
    for (let day = plainDate(p.from); Temporal.PlainDate.compare(day, plainDate(p.to)) <= 0; day = day.add({ days: 1 })) for (const pro of pros) {
      const w = pro.week.find(w => w.day === day.dayOfWeek % 7); if (!w?.enabled) continue;
      const at = t => localInstant(day.toString(), t, p.zone), windows = w.breakStart !== w.breakEnd ? [[at(w.start), at(w.breakStart)], [at(w.breakEnd), at(w.end)]] : [[at(w.start), at(w.end)]];
      for (const [start, end] of windows) { const blocked = blocks.filter(b => b.professional_id === pro.id).map(b => [Math.max(start, number(b.starts_at)), Math.min(end, number(b.ends_at))]); available += Math.max(0, end - start - unionLength(blocked)); occupied += unionLength(appointments.filter(a => a.professional_id === pro.id).map(a => [Math.max(start, number(a.starts_at)), Math.min(end, number(a.occupied_until))])); }
    }
    return { ...r, appointments: undefined, statuses, newCustomers: number(customers.total), byProfessional: [...byProfessional.values()], occupancy: { availableMinutes: Math.round(available / 60000), occupiedMinutes: Math.round(occupied / 60000), percent: available ? Math.round(occupied / available * 1000) / 10 : null, basis: 'Expediente atual dos profissionais ativos, descontando pausas e bloqueios. Inclui intervalo técnico das reservas.' }, daily: [...dates].map(([date, netCents]) => ({ date, netCents })) };
  }
  return { report, dashboard, appointmentView, manual };
}
