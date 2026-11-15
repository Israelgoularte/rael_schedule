import { Temporal } from '@js-temporal/polyfill';
import { digest, failure } from './security.mjs';
import { plainDate, localInstant } from './bookings.mjs';

const number = value => Number(value ?? 0);

// Only canonical, verified license payments reach this function. Service money
// stays in financial_entries and is never included in the platform ledger.
export async function recordLicensePayment(tx, { cycleId, payment, mode, now, amountCents = 6000 }) {
  const updated = Date.parse(payment.date_last_updated ?? '');
  const key = digest(`${mode}:${payment.collector_id}:${payment.id}`);
  const [old] = await tx.query('SELECT * FROM license_money_snapshots WHERE payment_key = ?', [key]);
  if (old && old.cycle_id !== cycleId) throw failure(409, 'Recebimento da plataforma com outro vínculo. Confira a cobrança.');
  if (old && number(old.provider_updated_at) >= updated) return;
  const amount = amountCents, refunded = Math.round(Number(payment.transaction_amount_refunded ?? 0) * 100);
  const wasPaid = number(old?.received_cents) > 0;
  const received = ['approved', 'refunded', 'charged_back'].includes(payment.status) || wasPaid ? amount : 0;
  const reversed = received ? payment.status === 'approved' ? refunded : amount : 0;
  for (const [kind, delta, cumulative] of [['receipt', received - number(old?.received_cents), received], ['refund', reversed - number(old?.reversed_cents), reversed]]) {
    if (!delta) continue;
    const entryKind = delta > 0 ? kind : kind === 'refund' ? 'receipt' : 'refund';
    const approved = Date.parse(payment.date_approved ?? '');
    const occurredAt = kind === 'receipt' && !wasPaid && Number.isFinite(approved) ? approved : updated;
    await tx.query('INSERT INTO license_money_entries(id, cycle_id, mode, source, kind, amount_cents, occurred_at, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [digest(`${key}:${updated}:${kind}:${cumulative}`), cycleId, mode, 'mercadopago', entryKind, Math.abs(delta), occurredAt, entryKind === 'receipt' ? 'Mensalidade conferida no Mercado Pago' : 'Devolução ou ajuste conferido no Mercado Pago', now]);
  }
  if (old) await tx.query('UPDATE license_money_snapshots SET received_cents = ?, reversed_cents = ?, provider_updated_at = ? WHERE payment_key = ?', [received, reversed, updated, key]);
  else await tx.query('INSERT INTO license_money_snapshots(payment_key, cycle_id, received_cents, reversed_cents, provider_updated_at) VALUES (?, ?, ?, ?, ?)', [key, cycleId, received, reversed, updated]);
}

export async function recordManualLicenseMoney(tx, { cycleId, mode, now, amountCents = 6000 }) {
  await tx.query('INSERT INTO license_money_entries(id, cycle_id, mode, source, kind, amount_cents, occurred_at, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [digest(`manual:${cycleId}`), cycleId, mode, 'manual', 'receipt', amountCents, now, 'Mensalidade já recebida e conferida pela operação', now]);
}

export function platformPeriod(args, now) {
  const today = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO('America/Sao_Paulo').toPlainDate();
  const from = args.from ? plainDate(args.from) : today.with({ day: 1 });
  const to = args.to ? plainDate(args.to) : today.with({ day: today.daysInMonth });
  if (Temporal.PlainDate.compare(from, to) > 0 || from.until(to).days > 365) throw failure(422, 'Escolha um período de até 366 dias.');
  const offset = Number(args.offset ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw failure(422, 'Página inválida.');
  return { from: from.toString(), to: to.toString(), start: localInstant(from.toString(), '00:00', 'America/Sao_Paulo'), end: localInstant(to.add({ days: 1 }).toString(), '00:00', 'America/Sao_Paulo'), offset };
}

export async function licenseMoneyReport(db, mode, period, includeEntries = false) {
  const rows = await db.query('SELECT source, kind, SUM(amount_cents) AS amount FROM license_money_entries WHERE mode = ? AND occurred_at >= ? AND occurred_at < ? GROUP BY source, kind', [mode, period.start, period.end]);
  const totals = { receiptsCents: 0, reversalsCents: 0, onlineNetCents: 0, manualNetCents: 0 };
  for (const row of rows) {
    const value = number(row.amount), receipt = row.kind === 'receipt';
    totals[receipt ? 'receiptsCents' : 'reversalsCents'] += value;
    totals[row.source === 'manual' ? 'manualNetCents' : 'onlineNetCents'] += receipt ? value : -value;
  }
  totals.netCents = totals.receiptsCents - totals.reversalsCents;
  const entries = includeEntries ? await db.query(`SELECT id, cycle_id, source, kind, amount_cents, occurred_at, note FROM license_money_entries WHERE mode = ? AND occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at DESC, created_at DESC, id LIMIT 26 OFFSET ${period.offset}`, [mode, period.start, period.end]) : [];
  return { totals, entries: entries.slice(0, 25).map(row => ({ id: row.id, cycleId: row.cycle_id, source: row.source, kind: row.kind, amountCents: number(row.amount_cents), occurredAt: number(row.occurred_at), note: row.note })), hasMore: entries.length > 25 };
}
