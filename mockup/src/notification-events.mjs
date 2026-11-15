import { digest } from './security.mjs';

const bookingTypes = { created: ['Novo agendamento', 'Um atendimento foi agendado.'], rescheduled: ['Agendamento remarcado', 'O dia ou horário de um atendimento mudou.'], cancelled: ['Agendamento cancelado', 'Um atendimento foi cancelado.'], confirmed: ['Pagamento confirmado', 'O pagamento do atendimento foi aprovado.'], payment_expired: ['Prazo de pagamento encerrado', 'Uma reserva não foi confirmada dentro do prazo de pagamento.'] };
const subscriptionTypes = { requested: ['Nova adesão a um plano', 'Uma adesão a um plano foi registrada.'], active: ['Plano com período confirmado', 'Um período pago do plano foi confirmado. Confira as datas na assinatura.'], renewal_disabled: ['Renovação do plano interrompida', 'As próximas renovações foram interrompidas. Confira a situação do plano.'], suspended: ['Uso do plano suspenso', 'O uso de uma assinatura foi suspenso.'], cancelled: ['Assinatura encerrada', 'Uma assinatura foi encerrada.'] };
const licenseTypes = { trial_expiring: ['Seu teste está terminando', 'Confira a contratação da plataforma para continuar usando sua agenda.'], renewal_due: ['Renovação da plataforma próxima', 'Confira a próxima mensalidade da plataforma.'], overdue: ['Mensalidade precisa de atenção', 'Regularize a mensalidade dentro do prazo exibido na gestão.'], blocked: ['Acesso aos agendamentos bloqueado', 'Confira a mensalidade da plataforma para regularizar o acesso.'], retention_30: ['Seu negócio está inativo há 30 dias', 'A licença ou o teste gratuito venceu há pelo menos 30 dias. Após 90 dias de inatividade, os dados poderão ser excluídos manualmente pela Raelapps. Regularize a licença ou fale com o suporte para preservar o acesso.'], retention_60: ['Atenção: seu negócio está inativo há 60 dias', 'A licença ou o teste gratuito venceu há pelo menos 60 dias. Após 90 dias de inatividade, os dados poderão ser excluídos manualmente pela Raelapps. Regularize a licença ou fale com o suporte antes desse prazo.'] };
const slugOk = slug => typeof slug === 'string' && /^[a-z0-9][a-z0-9-]{1,47}$/.test(slug);
const insert = tx => tx.lock?.includes('FOR UPDATE') ? 'INSERT IGNORE' : 'INSERT OR IGNORE';

export async function insertNotification(tx, { recipientType, recipientId, eventKey, type, title, body, url, now, sessionHash }) {
  const at = typeof now === 'function' ? now() : now ?? Date.now();
  if (!['staff', 'customer'].includes(recipientType) || typeof recipientId !== 'string' || !recipientId || typeof eventKey !== 'string' || !eventKey || eventKey.length > 500 || !Number.isSafeInteger(at) || at < 0 || !url.startsWith('/') || url.startsWith('//') || title.length > 120 || body.length > 500 || url.length > 500) throw Error('Evento de notificação inválido.');
  const key = digest(`${type}:${eventKey}`), id = digest(`notification:${recipientType}:${recipientId}:${key}`);
  const result = await tx.query(`${insert(tx)} INTO notifications(id, recipient_type, recipient_id, title, body, url, event_key, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, recipientType, recipientId, title, body, url, key, at, null]);
  if (!Number(result.affectedRows ?? result.changes)) return id;
  const devices = await tx.query('SELECT id FROM notification_devices WHERE recipient_type = ? AND recipient_id = ? AND active = 1 AND (expiration_at IS NULL OR expiration_at > ?)' + (sessionHash ? ' AND session_hash = ?' : ''), sessionHash ? [recipientType, recipientId, at, sessionHash] : [recipientType, recipientId, at]);
  for (const device of devices) await tx.query(`${insert(tx)} INTO notification_outbox(id, notification_id, device_id, state, attempts, lease_until, next_check_at, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [digest(`${id}:${device.id}`), id, device.id, 'pending', 0, 0, at, '', at, at]);
  return id;
}
async function recipients(tx, professionalId, reception = true) {
  return tx.query(`SELECT id FROM users WHERE active = 1 AND (role ${reception ? "IN ('admin', 'reception')" : "= 'admin'"} OR (role = 'professional' AND professional_id = ?))`, [professionalId]);
}
export async function notifyAppointment(tx, { slug, appointmentId, eventKey, type, now }) {
  if (!slugOk(slug) || !bookingTypes[type]) throw Error('Evento de agendamento inválido.');
  const [appointment] = await tx.query('SELECT a.customer_id, a.professional_id, a.starts_at, a.snapshot_json, c.name AS customer_name FROM appointments a JOIN customers c ON c.id = a.customer_id WHERE a.id = ?', [appointmentId]); if (!appointment) return;
  const [title, body] = bookingTypes[type];
  const snapshot = JSON.parse(appointment.snapshot_json), service = snapshot.service?.name || 'Atendimento', zone = snapshot.business?.timeZone || 'America/Sao_Paulo', date = new Intl.DateTimeFormat('pt-BR', { timeZone: zone, dateStyle: 'short', timeStyle: 'short' }).format(Number(appointment.starts_at));
  const parts = new Intl.DateTimeFormat('en', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(Number(appointment.starts_at)), isoDate = ['year', 'month', 'day'].map(type => parts.find(part => part.type === type).value).join('-');
  for (const staff of await recipients(tx, appointment.professional_id)) await insertNotification(tx, { recipientType: 'staff', recipientId: staff.id, eventKey, type: `appointment.${type}`, title, body: `${appointment.customer_name} · ${service} · ${date}. ${body}`.slice(0, 500), url: `/sistema/${slug}?visao=agenda&data=${isoDate}`, now });
  await insertNotification(tx, { recipientType: 'customer', recipientId: appointment.customer_id, eventKey, type: `appointment.${type}`, title, body: `${service} · ${date}. ${body} Consulte seus agendamentos para ver os detalhes.`.slice(0, 500), url: `/negocio/${slug}?visao=agendamentos`, now });
}
export async function notifySubscription(tx, { slug, subscriptionId, eventKey, type, now }) {
  if (!slugOk(slug) || !subscriptionTypes[type]) throw Error('Evento de assinatura inválido.');
  const [subscription] = await tx.query('SELECT s.customer_id, s.professional_id, s.snapshot_json, c.name AS customer_name FROM subscriptions s JOIN customers c ON c.id = s.customer_id WHERE s.id = ?', [subscriptionId]); if (!subscription) return;
  const [title, body] = subscriptionTypes[type];
  const plan = JSON.parse(subscription.snapshot_json).name || 'Plano mensal';
  for (const staff of await recipients(tx, subscription.professional_id, false)) await insertNotification(tx, { recipientType: 'staff', recipientId: staff.id, eventKey, type: `subscription.${type}`, title, body: `${subscription.customer_name} · ${plan}. ${body}`.slice(0, 500), url: `/sistema/${slug}/assinaturas`, now });
  await insertNotification(tx, { recipientType: 'customer', recipientId: subscription.customer_id, eventKey, type: `subscription.${type}`, title, body: `${plan}. ${body}`.slice(0, 500), url: `/planos/${slug}`, now });
}
export async function notifyLicense(tx, { slug, eventKey, type, now }) {
  if (!slugOk(slug) || !licenseTypes[type]) throw Error('Evento de mensalidade inválido.');
  const [title, body] = licenseTypes[type];
  for (const staff of await tx.query("SELECT id FROM users WHERE active = 1 AND role = 'admin'")) await insertNotification(tx, { recipientType: 'staff', recipientId: staff.id, eventKey, type: `license.${type}`, title, body, url: `/sistema/${slug}/assinatura`, now });
}
