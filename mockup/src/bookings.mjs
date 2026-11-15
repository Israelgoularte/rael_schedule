import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { readSettings } from './database.mjs';
import { failure, digest, token, equal, isEmail, normalizeEmail, passwordHash, checkPassword, passwordAttempt, rateLimit } from './security.mjs';
import { normalizeMetadata, readMetadata } from './metadata.mjs';
import { bookingMetadata, findLandingVisit, visitParam } from './traffic.mjs';
import { notifyAppointment } from './notification-events.mjs';

const minuteMs = 60000;
const dayMs = 24 * 60 * minuteMs;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const only = (value, keys) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw failure(422, 'Confira os dados enviados.'); };
export function plainDate(value) { try { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Error(); return Temporal.PlainDate.from(value); } catch { throw failure(422, 'Escolha uma data válida.'); } }
export function localInstant(date, time, zone) {
  try {
    const d = plainDate(date);
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw Error();
    const [hour, minute] = time.split(':').map(Number);
    return Temporal.ZonedDateTime.from({ timeZone: zone, year: d.year, month: d.month, day: d.day, hour, minute }, { disambiguation: 'reject' }).epochMilliseconds;
  } catch { throw failure(422, 'Esse horário não existe ou é ambíguo no fuso do negócio. Escolha outro.'); }
}
const dateAt = (at, zone) => Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(zone).toPlainDate();
const timeMinutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
const timeText = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
const overlaps = (start, end, row) => start < Number(row.ends_at ?? row.occupied_until) && end > Number(row.starts_at);
const blockPeriodPriority = ['occupied', 'blocked', 'break', 'available'];

function blockDayPeriods(date, zone, day, rows, start, end) {
  const changes = new Map([[start, []], [end, []]]);
  function addInterval(status, from, until) {
    from = Math.max(start, from);
    until = Math.min(end, until);
    if (!(from < until)) return;
    for (const [at, delta] of [[from, 1], [until, -1]]) {
      if (!changes.has(at)) changes.set(at, []);
      changes.get(at).push([status, delta]);
    }
  }
  if (day?.enabled && day.start < day.end) {
    // The preview still shows existing appointments and blocks if a clock
    // change makes a configured boundary invalid on this particular date.
    const boundary = time => {
      try { return localInstant(date.toString(), time, zone); }
      catch { return NaN; }
    };
    const open = boundary(day.start), close = boundary(day.end);
    addInterval('available', open, close);
    if (day.breakStart < day.breakEnd) {
      addInterval('break', Math.max(open, boundary(day.breakStart)), Math.min(close, boundary(day.breakEnd)));
    }
  }
  for (const row of rows) addInterval(row.status, Number(row.starts_at), Number(row.ends_at));

  const points = [...changes.keys()].sort((a, b) => a - b), active = new Map(), periods = [];
  for (let index = 0; index < points.length - 1; index++) {
    const from = points[index], until = points[index + 1];
    for (const [status, delta] of changes.get(from)) active.set(status, (active.get(status) ?? 0) + delta);
    const status = blockPeriodPriority.find(value => active.get(value) > 0) ?? 'outside';
    const previous = periods.at(-1);
    if (previous?.status === status) previous.until = until;
    else periods.push({ status, from, until });
  }
  function localLabel(at) {
    const local = Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(zone);
    return { date: local.toPlainDate().toString(), time: timeText(local.hour * 60 + local.minute) };
  }
  return periods.map(({ status, from, until }) => {
    const first = localLabel(from), last = localLabel(until);
    return { status, startDate: first.date, startTime: first.time, endDate: last.date, endTime: last.time };
  });
}

const contact = input => {
  const name = typeof input.name === 'string' ? input.name.trim() : '', email = normalizeEmail(input.email);
  let phone = typeof input.phone === 'string' ? input.phone.replace(/\D/g, '') : '';
  if (phone.length === 10 || phone.length === 11) phone = '55' + phone;
  if (name.length < 2 || name.length > 120 || /[\x00-\x1f]/.test(name) || !isEmail(email) || !/^\d{12,15}$/.test(phone)) throw failure(422, 'Confira nome, WhatsApp com DDD e e-mail.');
  return { name, email, phone };
};

export function createBookings(db, slug, config, dummyHash, payments, subscriptions, license) {
  const now = config.now ?? (() => Date.now());
  const customerCookie = `${config.origin.startsWith('https://') ? '__Host-' : ''}rael_customer_${slug}`;
  const customerView = row => ({ id: row.id, name: row.name, email: row.email, phone: row.phone });
  async function customerSession(raw) {
    if (typeof raw !== 'string' || raw.length > 100) throw failure(401, 'Entre na sua conta para consultar seus agendamentos.');
    const [row] = await db.query('SELECT c.*, s.csrf, s.expires_at FROM customer_sessions s JOIN customers c ON c.id = s.customer_id WHERE s.token_hash = ?', [digest(raw)]);
    if (!row || Number(row.expires_at) <= now()) throw failure(401, 'Sua sessão terminou. Entre novamente.');
    return row;
  }
  async function newSession(customer) {
    const value = token(), csrf = token();
    await db.transaction(async tx => {
      await readSettings(tx, true);
      const [current] = await tx.query('SELECT password_hash FROM customers WHERE id = ?', [customer.id]);
      if (!current?.password_hash || current.password_hash !== customer.password_hash) throw failure(401, 'Seu acesso mudou. Entre novamente com a senha atual.');
      await tx.query('DELETE FROM customer_sessions WHERE expires_at < ?', [now()]);
      await tx.query('INSERT INTO customer_sessions(token_hash, customer_id, csrf, expires_at) VALUES (?, ?, ?, ?)', [digest(value), customer.id, csrf, now() + 12 * 60 * minuteMs]);
    });
    return { value, csrf, customer: customerView(customer) };
  }
  async function register(input) {
    only(input, ['name', 'phone', 'email', 'password']);
    await rateLimit(db, 'customer_register', 30, 60 * minuteMs);
    await passwordAttempt(db);
    const data = contact(input), encoded = await passwordHash(input.password);
    const record = await db.transaction(async tx => {
      await readSettings(tx, true);
      const [exists] = await tx.query('SELECT id FROM customers WHERE email = ?', [data.email]);
      if (exists) throw failure(409, 'Esse e-mail já possui cadastro. Entre com sua senha ou solicite recuperação ao negócio.');
      const row = { id: randomUUID(), ...data, password_hash: encoded };
      await tx.query('INSERT INTO customers(id, name, phone, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)', [row.id, row.name, row.phone, row.email, encoded, now()]);
      return row;
    });
    return newSession(record);
  }
  async function login(input) {
    only(input, ['email', 'password']);
    const email = normalizeEmail(input.email);
    await rateLimit(db, `customer_login:${email}`, 6);
    await passwordAttempt(db);
    const [row] = await db.query('SELECT * FROM customers WHERE email = ?', [email]);
    if (!await checkPassword(input.password, row?.password_hash ?? dummyHash) || !row?.password_hash) throw failure(401, 'E-mail ou senha não conferem.');
    return newSession(row);
  }
  function authorize(actor, row) {
    if (actor.customer) { if (row.customer_id !== actor.customer.id) throw failure(404, 'Agendamento não encontrado.'); }
    else if (!actor.staff || (actor.staff.role === 'professional' && row.professional_id !== actor.staff.professional_id)) throw failure(403, 'Este agendamento não pertence ao seu acesso.');
  }
  function canEdit(actor, row) {
    authorize(actor, row);
    if (row.status === 'awaiting_payment') return;
    if (row.status !== 'confirmed') throw failure(409, 'Este agendamento não pode mais ser alterado.');
    const snapshot = JSON.parse(row.snapshot_json);
    if (actor.customer && now() >= Number(row.starts_at) - snapshot.cancelHours * 60 * minuteMs) throw failure(409, 'O prazo para alterar online terminou. Entre em contato com o negócio.');
  }
  function view(row, staff = false) {
    const s = JSON.parse(row.snapshot_json);
    const editable = row.status === 'confirmed' && now() < Number(row.starts_at) - s.cancelHours * 60 * minuteMs;
    return { id: row.id, revision: Number(row.revision), customerId: staff ? row.customer_id : undefined, professionalId: row.professional_id, serviceId: row.service_id, startAt: Number(row.starts_at), endAt: Number(row.ends_at), status: row.status, snapshot: s, canCancel: editable || row.status === 'awaiting_payment', canReschedule: editable, payment: s.requirePayment ? { state: row.payment_state ?? 'waiting', expiresAt: Number(row.payment_expires_at ?? 0), resolution: row.payment_resolution ?? '' } : null,
      ...(staff ? { customer: { name: row.customer_name, phone: row.customer_phone, email: row.customer_email }, metadata: readMetadata(row.metadata_json) } : {}) };
  }
  async function event(tx, row, actor, name, detail = {}) {
    const id = randomUUID();
    await tx.query('INSERT INTO booking_events(id, appointment_id, actor_type, actor_id, event_name, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, row.id, actor.customer ? 'customer' : 'staff', actor.customer?.id ?? actor.staff.id, name, JSON.stringify(detail), now()]);
    return id;
  }
  async function context(tx, settings, serviceId, professionalId, original = null, coverage = null) {
    if (!uuid(serviceId) || !uuid(professionalId)) throw failure(422, 'Escolha um serviço e um profissional.');
    const published = settings.published;
    if (!published) throw failure(409, 'O negócio ainda não liberou o agendamento online.');
    const service = published.services.find(s => s.id === serviceId && s.online);
    const professional = published.professionals.find(p => p.id === professionalId);
    const active = settings.draft.professionals.some(p => p.id === professionalId && p.active);
    if (!service || !professional || !active || !service.professionalIds.includes(professionalId)) throw failure(409, 'Esse serviço ou profissional não está mais disponível. Escolha outra opção.');
    const [preference] = await tx.query('SELECT require_payment FROM receiving_preferences WHERE professional_id = ?', [professionalId]);
    const connection = preference?.require_payment && !original && !coverage ? await payments.connectionFor(tx, professionalId) : null;
    if (preference?.require_payment && !original && !coverage && !connection?.ready) throw failure(409, 'Este profissional exige antecipação e ainda não está disponível para reservar online.');
    if (original && JSON.parse(original.snapshot_json).requirePayment && professionalId !== original.professional_id) throw failure(409, 'Para preservar o recebedor do pagamento, remarque com o mesmo profissional. Uma troca precisa ser acompanhada pelo negócio.');
    if (original?.status === 'awaiting_payment') throw failure(409, 'Conclua o pagamento ou cancele a reserva temporária antes de remarcar.');
    const old = original ? JSON.parse(original.snapshot_json) : null;
    const effective = old?.service ?? { id: service.id, name: service.name, priceCents: service.priceCents, durationMinutes: service.durationMinutes, gapMinutes: service.gapMinutes };
    if (effective.priceCents === null || effective.durationMinutes < 5) throw failure(409, 'O serviço precisa ser atualizado pelo negócio.');
    const snapshot = { service: effective, professional: { id: professional.id, name: professional.name }, business: { ...(old?.business ?? { name: published.business.name, mode: published.business.mode, address: published.business.address, timeZone: published.business.timeZone, phone: published.business.phone, email: published.business.email, onlineInstructions: published.business.onlineInstructions ?? '' }), timeZone: published.business.timeZone }, cancelHours: old?.cancelHours ?? published.rules.cancelHours, requirePayment: old ? old.requirePayment : !coverage && Boolean(preference?.require_payment), ...(old?.receiver ? { receiver: old.receiver } : connection ? { receiver: { id: connection.collectorId, name: connection.name, connectionId: connection.id, mode: connection.mode } } : {}) };
    if (snapshot.requirePayment && effective.priceCents < 1) throw failure(409, 'O pagamento antecipado exige um valor maior que zero. Confira o serviço com o negócio.');
    const quote = { ...effective, requiresPayment: snapshot.requirePayment, receiver: snapshot.receiver ? { name: snapshot.receiver.name, id: snapshot.receiver.id } : null, professionalName: professional.name, timeZone: published.business.timeZone, cancelHours: snapshot.cancelHours };
    const signature = digest(JSON.stringify({ snapshot, rules: published.rules, professionalId, ...(coverage ? { subscriptionId: coverage.id } : {}) }));
    return { published, professional, snapshot, connection, quote: { ...quote, signature }, zone: published.business.timeZone };
  }
  async function available(tx, settings, args, actor = {}) {
    const date = plainDate(args.date), original = args.appointmentId ? await owned(tx, args.appointmentId, actor) : null;
    if (original) canEdit(actor, original);
    else await license.assertBooking(tx);
    if (args.subscriptionId !== undefined && (!uuid(args.subscriptionId) || !actor.customer || original)) throw failure(422, 'Escolha uma assinatura da sua própria conta.');
    if (actor.staff?.role === 'professional' && args.professionalId !== actor.staff.professional_id) throw failure(403, 'Escolha seu próprio expediente.');
    const coverage = args.subscriptionId ? await subscriptions.coverage(tx, args.subscriptionId, actor.customer.id, args.serviceId, args.professionalId) : null;
    const ctx = await context(tx, settings, original?.service_id ?? args.serviceId, args.professionalId, original, coverage);
    const today = dateAt(now(), ctx.zone), last = today.add({ days: ctx.published.rules.advanceDays });
    if (Temporal.PlainDate.compare(date, today) < 0 || Temporal.PlainDate.compare(date, last) > 0) throw failure(422, 'Escolha uma data dentro do período permitido pelo negócio.');
    const day = ctx.professional.week.find(d => d.day === date.dayOfWeek % 7);
    const start = localInstant(date.toString(), '00:00', ctx.zone), end = localInstant(date.add({ days: 1 }).toString(), '00:00', ctx.zone);
    const appointments = await tx.query("SELECT id, starts_at, occupied_until FROM appointments WHERE professional_id = ? AND status NOT IN ('cancelled', 'expired') AND starts_at < ? AND occupied_until > ?", [args.professionalId, end, start]);
    const blocks = await tx.query('SELECT starts_at, ends_at FROM calendar_blocks WHERE professional_id = ? AND active = 1 AND starts_at < ? AND ends_at > ?', [args.professionalId, end, start]);
    const slots = [], length = ctx.snapshot.service.durationMinutes + ctx.snapshot.service.gapMinutes;
    if (day?.enabled) for (let t = timeMinutes(day.start); t + length <= timeMinutes(day.end); t += 15) {
      if (day.breakStart !== day.breakEnd && t < timeMinutes(day.breakEnd) && t + length > timeMinutes(day.breakStart)) continue;
      let at; try { at = localInstant(date.toString(), timeText(t), ctx.zone); } catch { continue; }
      if (at <= now() || at < now() + ctx.published.rules.noticeMinutes * minuteMs) continue;
      if (coverage && (at < coverage.startAt || at >= coverage.endAt)) continue;
      const until = at + length * minuteMs;
      if (appointments.some(row => row.id !== original?.id && at < Number(row.occupied_until) && until > Number(row.starts_at)) || blocks.some(row => overlaps(at, until, row))) continue;
      slots.push({ startAt: at, time: timeText(t) });
    }
    return { date: date.toString(), timeZone: ctx.zone, slots, quote: ctx.quote, today: today.toString(), lastDate: last.toString(), ctx, original };
  }
  async function owned(tx, id, actor) {
    if (!uuid(id)) throw failure(422, 'Agendamento inválido.');
    const [row] = await tx.query('SELECT a.*, i.state AS payment_state, i.expires_at AS payment_expires_at, i.resolution AS payment_resolution FROM appointments a LEFT JOIN mp_intents i ON i.appointment_id = a.id WHERE a.id = ?', [id]);
    if (!row) throw failure(404, 'Agendamento não encontrado.');
    authorize(actor, row); return row;
  }
  async function availability(args, actor = {}) {
    const result = await db.transaction(async tx => { const settings = await readSettings(tx, true); await payments.expire(tx); return available(tx, settings, args, actor); });
    const { ctx, original, ...publicResult } = result; return publicResult;
  }
  async function reserve(actor, input, reschedule = false) {
    only(input, reschedule ? ['appointmentId', 'professionalId', 'startAt', 'quote', 'idempotencyKey', 'revision'] : ['serviceId', 'professionalId', 'startAt', 'quote', 'idempotencyKey', 'customer', 'subscriptionId', 'metadata']);
    const metadata = reschedule ? null : normalizeMetadata(input.metadata);
    if (input.subscriptionId !== undefined && (!uuid(input.subscriptionId) || !actor.customer)) throw failure(422, 'Escolha uma assinatura da sua própria conta.');
    if (!uuid(input.idempotencyKey) || !Number.isSafeInteger(input.startAt) || input.startAt < 0 || input.startAt > 4102444800000 || typeof input.quote !== 'string') throw failure(422, 'Confira o horário escolhido e tente novamente.');
    const customerData = !reschedule && actor.staff ? contact(input.customer ?? {}) : null;
    if (!actor.customer && !actor.staff) throw failure(401, 'Entre na sua conta para confirmar.');
    await rateLimit(db, `reserve:${actor.customer?.id ?? actor.staff.id}`, 60, 60 * minuteMs);
    return db.transaction(async tx => {
      // One row serializes all interval-changing operations, including across Node replicas.
      const settings = await readSettings(tx, true); await payments.expire(tx);
      // Empty metadata can retry a pre-migration request, while actual
      // attribution changes must never reuse an accepted confirmation key.
      const signature = digest(JSON.stringify(reschedule ? input : { ...input, metadata })), requestKey = digest(`${actor.customer?.id ?? actor.staff.id}:${reschedule ? 'move' : 'create'}:${input.idempotencyKey}`);
      const { metadata: ignoredMetadata, ...legacyInput } = input;
      const legacySignature = !reschedule && !Object.keys(metadata).length ? digest(JSON.stringify(legacyInput)) : null;
      const [previous] = await tx.query('SELECT * FROM booking_requests WHERE request_key = ?', [requestKey]);
      if (previous) {
        if (previous.signature !== signature && previous.signature !== legacySignature) throw failure(409, 'Essa confirmação já foi usada com outra escolha. Atualize a reserva.');
        const row = await owned(tx, previous.appointment_id, actor); return { appointment: view(row), created: false };
      }
      const original = reschedule ? await owned(tx, input.appointmentId, actor) : null;
      if (original) { canEdit(actor, original); if (input.revision !== Number(original.revision)) throw failure(409, 'O agendamento mudou. Atualize antes de remarcar.'); }
      const serviceId = original?.service_id ?? input.serviceId;
      const publishedZone = settings.published?.business.timeZone;
      if (!publishedZone) throw failure(409, 'Agendamento online ainda não disponível.');
      const result = await available(tx, settings, { serviceId, professionalId: input.professionalId, date: dateAt(input.startAt, publishedZone).toString(), ...(original ? { appointmentId: original.id } : input.subscriptionId ? { subscriptionId: input.subscriptionId } : {}) }, actor);
      if (result.quote.signature !== input.quote) throw failure(409, 'As condições do serviço mudaram. Revise os valores e horários antes de confirmar.');
      if (!result.slots.some(s => s.startAt === input.startAt)) throw failure(409, 'Esse horário acabou de ficar indisponível. Escolha outro.');
      let customer = actor.customer;
      if (original) { const [row] = await tx.query('SELECT * FROM customers WHERE id = ?', [original.customer_id]); customer = row; }
      if (customerData) {
        [customer] = await tx.query('SELECT * FROM customers WHERE email = ?', [customerData.email]);
        if (!customer) { customer = { id: randomUUID(), ...customerData }; await tx.query('INSERT INTO customers(id, name, phone, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)', [customer.id, customer.name, customer.phone, customer.email, null, now()]); }
      }
      const end = input.startAt + result.ctx.snapshot.service.durationMinutes * minuteMs, until = end + result.ctx.snapshot.service.gapMinutes * minuteMs;
      const other = await tx.query("SELECT id FROM appointments WHERE customer_id = ? AND status NOT IN ('cancelled', 'expired') AND starts_at < ? AND ends_at > ?", [customer.id, end, input.startAt]);
      if (other.some(row => row.id !== original?.id)) throw failure(409, 'Este cliente já possui um agendamento nesse intervalo.');
      let id = original?.id ?? randomUUID();
      const usage = await subscriptions.consume(tx, input.subscriptionId, id, customer.id, serviceId, input.professionalId, input.startAt, result.ctx.snapshot, original ? JSON.parse(original.snapshot_json) : null);
      if (original) await tx.query('UPDATE appointments SET professional_id = ?, starts_at = ?, ends_at = ?, occupied_until = ?, snapshot_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?', [input.professionalId, input.startAt, end, until, JSON.stringify(result.ctx.snapshot), now(), id]);
      else {
        const occurredAt = now();
        const visit = actor.customer ? await findLandingVisit(tx, metadata[visitParam], occurredAt) : null;
        await tx.query('INSERT INTO appointments(id, customer_id, professional_id, service_id, starts_at, ends_at, occupied_until, status, revision, snapshot_json, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, customer.id, input.professionalId, serviceId, input.startAt, end, until, result.ctx.snapshot.requirePayment ? 'awaiting_payment' : 'confirmed', 0, JSON.stringify(result.ctx.snapshot), JSON.stringify(bookingMetadata(metadata, visit)), occurredAt, occurredAt]);
        if (visit) await tx.query('INSERT INTO landing_visit_bookings(appointment_id, visit_key) VALUES (?, ?)', [id, visit.visitKey]);
      }
      await subscriptions.recordUsage(tx, id, usage);
      if (!original) await payments.hold(tx, id, result.ctx);
      await tx.query('INSERT INTO booking_requests(request_key, customer_id, signature, kind, appointment_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', [requestKey, customer.id, signature, reschedule ? 'reschedule' : 'create', id, now()]);
      const [row] = await tx.query('SELECT a.*, i.state AS payment_state, i.expires_at AS payment_expires_at, i.resolution AS payment_resolution FROM appointments a LEFT JOIN mp_intents i ON i.appointment_id = a.id WHERE a.id = ?', [id]);
      const eventKey = await event(tx, row, actor, original ? 'rescheduled' : result.ctx.snapshot.requirePayment ? 'awaiting_payment' : 'confirmed', original ? { previousStartAt: Number(original.starts_at), previousProfessionalId: original.professional_id } : {});
      await notifyAppointment(tx, { slug, appointmentId: id, eventKey, type: original ? 'rescheduled' : 'created', now: now() });
      return { appointment: view(row), created: !original };
    });
  }
  async function customerAppointments(customer, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw failure(422, 'Página inválida.');
    await payments.housekeeping();
    const rows = await db.query('SELECT a.*, i.state AS payment_state, i.expires_at AS payment_expires_at, i.resolution AS payment_resolution FROM appointments a LEFT JOIN mp_intents i ON i.appointment_id = a.id WHERE a.customer_id = ? ORDER BY a.starts_at DESC, a.id LIMIT 51 OFFSET ' + offset, [customer.id]);
    return { appointments: rows.slice(0, 50).map(row => view(row)), hasMore: rows.length > 50, offset };
  }
  async function changeStatus(actor, input) {
    only(input, ['appointmentId', 'revision', 'status']);
    if (!['cancelled', 'in_progress', 'completed', 'no_show'].includes(input.status) || (actor.customer && input.status !== 'cancelled')) throw failure(403, 'Ação não permitida nesse acesso.');
    return db.transaction(async tx => {
      await readSettings(tx, true); await payments.expire(tx);
      const row = await owned(tx, input.appointmentId, actor);
      if (row.status === input.status) return { appointment: view(row) };
      if (Number(row.revision) !== input.revision) throw failure(409, 'O agendamento mudou. Atualize antes de continuar.');
      if (actor.customer) canEdit(actor, row);
      const transitions = { awaiting_payment: ['cancelled'], confirmed: ['cancelled', 'in_progress', 'completed', 'no_show'], in_progress: ['completed', 'cancelled'] };
      if (!transitions[row.status]?.includes(input.status)) throw failure(409, 'Essa mudança não é permitida para a situação atual.');
      if (input.status !== 'cancelled' && now() < Number(row.starts_at) - (input.status === 'in_progress' ? 15 * minuteMs : 0)) throw failure(409, 'Esse atendimento ainda não chegou ao horário previsto.');
      await tx.query('UPDATE appointments SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ?', [input.status, now(), row.id]);
      if (input.status === 'cancelled') { await payments.cancelled(tx, row.id); await subscriptions.release(tx, row); }
      const eventKey = await event(tx, row, actor, input.status);
      if (input.status === 'cancelled') await notifyAppointment(tx, { slug, appointmentId: row.id, eventKey, type: 'cancelled', now: now() });
      return { appointment: view({ ...row, status: input.status, revision: Number(row.revision) + 1 }) };
    });
  }
  async function agenda(staff, args) {
    await payments.housekeeping();
    const settings = await readSettings(db), zone = settings.published?.business.timeZone ?? settings.draft.business.timeZone;
    const date = args.date ? plainDate(args.date) : dateAt(now(), zone), days = Number(args.days ?? 1);
    if (![1, 7].includes(days)) throw failure(422, 'Escolha dia ou semana.');
    const professionalId = staff.role === 'professional' ? staff.professional_id : args.professionalId;
    if (professionalId && !uuid(professionalId)) throw failure(422, 'Profissional inválido.');
    const start = localInstant(date.toString(), '00:00', zone), end = localInstant(date.add({ days }).toString(), '00:00', zone);
    const filter = professionalId ? ' AND a.professional_id = ?' : '', params = [end, start, ...(professionalId ? [professionalId] : [])];
    const rows = await db.query('SELECT a.*, i.state AS payment_state, i.expires_at AS payment_expires_at, i.resolution AS payment_resolution, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email FROM appointments a JOIN customers c ON c.id = a.customer_id LEFT JOIN mp_intents i ON i.appointment_id = a.id WHERE a.starts_at < ? AND a.ends_at > ?' + filter + ' ORDER BY a.starts_at, a.id LIMIT 2001', params);
    const blocks = await db.query('SELECT * FROM calendar_blocks a WHERE a.active = 1 AND a.starts_at < ? AND a.ends_at > ?' + filter + ' ORDER BY a.starts_at LIMIT 2001', params);
    return { date: date.toString(), days, timeZone: zone, appointments: rows.slice(0, 2000).map(row => view(row, true)), blocks: blocks.slice(0, 2000).map(b => ({ id: b.id, professionalId: b.professional_id, startAt: Number(b.starts_at), endAt: Number(b.ends_at), reason: b.reason })), truncated: rows.length > 2000 || blocks.length > 2000, professionals: settings.draft.professionals.filter(p => staff.role !== 'professional' || p.id === staff.professional_id).map(({ id, name, active }) => ({ id, name, active })), businessName: settings.draft.business.name };
  }
  async function blockPreview(staff, args) {
    const { professionalId } = args;
    if (!uuid(professionalId) || (staff.role === 'professional' && professionalId !== staff.professional_id)) throw failure(403, 'Escolha um profissional permitido no seu acesso.');
    const date = plainDate(args.date);
    const settings = await readSettings(db), zone = settings.published?.business.timeZone ?? settings.draft.business.timeZone;
    const professional = settings.draft.professionals.find(p => p.id === professionalId);
    if (!professional) throw failure(422, 'Profissional não encontrado.');
    const schedule = settings.published?.professionals.find(p => p.id === professionalId) ?? professional;
    const day = professional.active ? schedule.week.find(entry => entry.day === date.dayOfWeek % 7) : null;
    const start = date.toZonedDateTime(zone).epochMilliseconds;
    const end = date.add({ days: 1 }).toZonedDateTime(zone).epochMilliseconds;
    const rows = await db.query(`
      SELECT 'occupied' AS status, a.starts_at, a.occupied_until AS ends_at
      FROM appointments a
      WHERE a.professional_id = ? AND a.starts_at < ? AND a.occupied_until > ?
        AND a.status NOT IN ('cancelled', 'expired')
        AND NOT (a.status = 'awaiting_payment' AND EXISTS (
          SELECT 1 FROM mp_intents i WHERE i.appointment_id = a.id AND i.expires_at <= ?
        ))
      UNION ALL
      SELECT 'blocked' AS status, starts_at, ends_at FROM calendar_blocks
      WHERE professional_id = ? AND active = 1 AND starts_at < ? AND ends_at > ?
    `, [professionalId, end, start, now(), professionalId, end, start]);
    return {
      date: date.toString(), professionalId, timeZone: zone,
      ...(end - start !== dayMs ? { clockChange: true } : {}),
      periods: blockDayPeriods(date, zone, day, rows, start, end),
    };
  }
  async function addBlock(staff, input) {
    only(input, ['professionalId', 'startDate', 'startTime', 'endDate', 'endTime', 'reason']);
    if (!uuid(input.professionalId) || (staff.role === 'professional' && input.professionalId !== staff.professional_id)) throw failure(403, 'Escolha um profissional permitido no seu acesso.');
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length < 2 || reason.length > 200) throw failure(422, 'Descreva o motivo do bloqueio.');
    return db.transaction(async tx => {
      const settings = await readSettings(tx, true), zone = settings.published?.business.timeZone ?? settings.draft.business.timeZone;
      await payments.expire(tx);
      if (!settings.draft.professionals.some(p => p.id === input.professionalId)) throw failure(422, 'Profissional não encontrado.');
      const start = localInstant(input.startDate, input.startTime, zone), end = localInstant(input.endDate, input.endTime, zone);
      if (end <= start || end - start > 366 * 86400000) throw failure(422, 'Confira início e fim do bloqueio. O período máximo é um ano.');
      const rows = await tx.query("SELECT id FROM appointments WHERE professional_id = ? AND status NOT IN ('cancelled', 'expired') AND starts_at < ? AND occupied_until > ? LIMIT 1", [input.professionalId, end, start]);
      if (rows.length) throw failure(409, 'Há agendamento nesse intervalo. Remarque ou cancele o atendimento antes de bloquear.');
      const id = randomUUID();
      await tx.query('INSERT INTO calendar_blocks(id, professional_id, starts_at, ends_at, reason, active, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, input.professionalId, start, end, reason, 1, staff.id, now()]);
      return { id };
    });
  }
  async function removeBlock(staff, id) {
    if (!uuid(id)) throw failure(422, 'Bloqueio inválido.');
    return db.transaction(async tx => { await readSettings(tx, true); const [b] = await tx.query('SELECT * FROM calendar_blocks WHERE id = ?', [id]); if (!b || (staff.role === 'professional' && b.professional_id !== staff.professional_id)) throw failure(403, 'Bloqueio não permitido nesse acesso.'); await tx.query('UPDATE calendar_blocks SET active = 0 WHERE id = ?', [id]); return { ok: true }; });
  }
  async function resetLink(staff, customerId) {
    if (staff.role !== 'admin' || !uuid(customerId)) throw failure(403, 'A recuperação do cliente é assistida pelo administrador.');
    await rateLimit(db, 'customer_recovery', 20, 60 * minuteMs);
    const value = token();
    await db.transaction(async tx => { await readSettings(tx, true); const [row] = await tx.query('SELECT id FROM customers WHERE id = ?', [customerId]); if (!row) throw failure(404, 'Cliente não encontrado.'); await tx.query('UPDATE customer_tokens SET used_at = ? WHERE customer_id = ? AND used_at IS NULL', [now(), customerId]); await tx.query('INSERT INTO customer_tokens(token_hash, customer_id, expires_at, used_at) VALUES (?, ?, ?, ?)', [digest(value), customerId, now() + 30 * minuteMs, null]); });
    return { url: `${config.origin}/negocio/${slug}#recuperar-cliente=${value}`, expiresInMinutes: 30 };
  }
  async function reset(input) {
    only(input, ['token', 'password']); await rateLimit(db, 'customer_reset', 30);
    if (typeof input.token !== 'string' || input.token.length > 100) throw failure(422, 'Link inválido.');
    await passwordAttempt(db);
    const encoded = await passwordHash(input.password);
    await db.transaction(async tx => { await readSettings(tx, true); const [row] = await tx.query('SELECT * FROM customer_tokens WHERE token_hash = ?', [digest(input.token)]); if (!row || row.used_at !== null || Number(row.expires_at) <= now()) throw failure(422, 'Esse link foi usado ou expirou. Solicite outro ao negócio.'); await tx.query('UPDATE customers SET password_hash = ? WHERE id = ?', [encoded, row.customer_id]); await tx.query('UPDATE customer_tokens SET used_at = ? WHERE customer_id = ? AND used_at IS NULL', [now(), row.customer_id]); await tx.query('DELETE FROM customer_sessions WHERE customer_id = ?', [row.customer_id]); });
    return { ok: true };
  }
  return { customerCookie, customerView, customerSession, register, login, availability, reserve, customerAppointments, changeStatus, agenda, blockPreview, addBlock, removeBlock, resetLink, reset,
    verifyCsrf(customer, value) { if (!equal(customer.csrf, value)) throw failure(403, 'Recarregue a página antes de continuar.'); },
    async logout(raw) { await db.query('DELETE FROM customer_sessions WHERE token_hash = ?', [digest(raw ?? '')]); },
    async catalogInfo(settings, catalog) {
      const licenseState = await license.state();
      const today = dateAt(now(), catalog.business.timeZone), prefs = await db.query('SELECT professional_id, require_payment FROM receiving_preferences');
      const professionals = [];
      for (const p of catalog.professionals.filter(p => settings.draft.professionals.some(d => d.id === p.id && d.active))) {
        const requiresPayment = Boolean(prefs.find(r => r.professional_id === p.id)?.require_payment), connection = requiresPayment ? await payments.connectionFor(db, p.id) : null;
        professionals.push({ ...p, requiresPayment, receiver: connection?.ready ? { name: connection.name, id: connection.collectorId } : null, bookingAllowed: licenseState.canBook && (!requiresPayment || connection.ready), subscriptionBookingAllowed: licenseState.canBook, unavailableReason: !licenseState.canBook ? 'Novos agendamentos estão temporariamente indisponíveis. Entre em contato com o negócio.' : requiresPayment && !connection.ready ? 'Agendamento online indisponível para este profissional no momento.' : '' });
      }
      return { ...catalog, professionals, bookingEnabled: professionals.some(p => p.bookingAllowed && catalog.services.some(s => s.professionalIds.includes(p.id))), bookingCalendar: { today: today.toString(), lastDate: today.add({ days: catalog.rules.advanceDays }).toString(), timeZone: catalog.business.timeZone } };
    },
  };
}
