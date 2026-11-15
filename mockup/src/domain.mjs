import { validLandingColor } from './landing.mjs';
import { randomUUID } from 'node:crypto';
import { failure, isEmail, normalizeEmail } from './security.mjs';

export const segments = [
  { id: 'beleza', label: 'Beleza e cuidados pessoais', examples: ['Corte de cabelo', 'Manicure', 'Escova'] },
  { id: 'bem-estar', label: 'Bem-estar', examples: ['Sessão de relaxamento', 'Atendimento individual'] },
  { id: 'consultoria', label: 'Consultoria e mentoria', examples: ['Consultoria inicial', 'Sessão de acompanhamento'] },
  { id: 'aulas', label: 'Aulas individuais', examples: ['Aula particular', 'Aula de reforço'] },
  { id: 'fotografia', label: 'Fotografia', examples: ['Sessão de fotos', 'Ensaio individual'] },
  { id: 'outros', label: 'Outro serviço com horário marcado', examples: ['Atendimento', 'Sessão individual'] },
];
export const defaultWeek = () => Array.from({ length: 7 }, (_, day) => ({ day, enabled: day > 0 && day < 6, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' }));
export function initialDraft(name, ownerName, ownerEmail, professionalId) {
  return { step: 1, teamMode: 'solo', business: { name, segment: '', phone: '', email: '', timeZone: 'America/Sao_Paulo', mode: 'presencial', address: '', description: '', onlineInstructions: '' }, professionals: [{ id: professionalId, name: ownerName, email: ownerEmail, active: true, week: defaultWeek() }], services: [], rules: { noticeMinutes: 120, advanceDays: 30, cancelHours: 24 } };
}
const text = (value, max, label) => {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw failure(422, `Confira ${label}.`);
  return value.trim();
};
const integer = (value, min, max, label) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw failure(422, `Confira ${label}.`);
  return value;
};
const bool = value => { if (typeof value !== 'boolean') throw failure(422, 'Opção inválida.'); return value; };
const uuid = value => { if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) throw failure(422, 'Identificador inválido.'); return value; };
const only = (obj, allowed) => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || Object.keys(obj).some(key => !allowed.includes(key))) throw failure(422, 'Há campos inválidos na configuração. Recarregue a tela.');
};
const minute = value => { const [h, m] = value.split(':').map(Number); return h * 60 + m; };
export function sanitizeWeek(week) {
  if (!Array.isArray(week) || week.length !== 7) throw failure(422, 'Confira os sete dias do expediente.');
  const days = new Set();
  return week.map(entry => {
    only(entry, ['day', 'enabled', 'start', 'end', 'breakStart', 'breakEnd']);
    const day = integer(entry.day, 0, 6, 'o dia da semana');
    if (days.has(day)) throw failure(422, 'Há dias repetidos no expediente.');
    days.add(day);
    const result = { day, enabled: bool(entry.enabled) };
    for (const key of ['start', 'end', 'breakStart', 'breakEnd']) {
      if (typeof entry[key] !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(entry[key])) throw failure(422, 'Confira os horários no formato hora:minuto.');
      result[key] = entry[key];
    }
    return result;
  }).sort((a, b) => a.day - b.day);
}
export function weekIssues(week) {
  const issues = [];
  if (!week.some(day => day.enabled)) issues.push('Escolha ao menos um dia de atendimento.');
  for (const day of week.filter(day => day.enabled)) {
    if (minute(day.start) >= minute(day.end)) issues.push('O fim do expediente precisa ser depois do início.');
    // Equal break times mean no break. Otherwise it must be fully inside working hours.
    if (day.breakStart !== day.breakEnd && (minute(day.breakStart) < minute(day.start) || minute(day.breakEnd) > minute(day.end) || minute(day.breakStart) >= minute(day.breakEnd))) issues.push('A pausa precisa ficar dentro do expediente e terminar após começar.');
  }
  return [...new Set(issues)];
}
export function sanitizeDraft(input) {
  only(input, ['step', 'teamMode', 'business', 'professionals', 'services', 'rules']);
  only(input.business, ['name', 'segment', 'phone', 'email', 'timeZone', 'mode', 'address', 'description', 'onlineInstructions', 'landingHeadline', 'landingColor']);
  only(input.rules, ['noticeMinutes', 'advanceDays', 'cancelHours']);
  if (!['solo', 'team'].includes(input.teamMode)) throw failure(422, 'Escolha atendimento individual ou equipe.');
  const b = input.business;
  if (b.landingColor !== undefined && b.landingColor !== '' && !validLandingColor(b.landingColor)) throw failure(422, 'Escolha uma cor válida para a página inicial.');
  if (!['presencial', 'online'].includes(b.mode)) throw failure(422, 'Escolha atendimento presencial ou online.');
  try { new Intl.DateTimeFormat('pt-BR', { timeZone: b.timeZone }).format(); } catch { throw failure(422, 'Escolha um fuso horário válido.'); }
  if (!Array.isArray(input.professionals) || input.professionals.length > 30) throw failure(422, 'Confira a lista de profissionais.');
  const professionals = input.professionals.map(p => {
    only(p, ['id', 'name', 'email', 'active', 'week']);
    return { id: uuid(p.id), name: text(p.name, 120, 'o nome do profissional'), email: normalizeEmail(text(p.email, 254, 'o e-mail do profissional')), active: bool(p.active), week: sanitizeWeek(p.week) };
  });
  if (new Set(professionals.map(p => p.id)).size !== professionals.length) throw failure(422, 'Há profissionais repetidos.');
  if (input.teamMode === 'solo' && professionals.filter(p => p.active).length > 1) throw failure(422, 'No modo individual, mantenha apenas um profissional ativo.');
  if (!Array.isArray(input.services) || input.services.length > 100) throw failure(422, 'Confira o catálogo de serviços.');
  const services = input.services.map(service => {
    only(service, ['id', 'name', 'description', 'priceCents', 'durationMinutes', 'gapMinutes', 'professionalIds', 'online']);
    if (!Array.isArray(service.professionalIds) || service.professionalIds.length > professionals.length || new Set(service.professionalIds).size !== service.professionalIds.length) throw failure(422, 'Confira os profissionais habilitados.');
    const professionalIds = service.professionalIds.map(uuid);
    if (professionalIds.some(id => !professionals.some(p => p.id === id))) throw failure(422, 'Um serviço está ligado a um profissional inexistente.');
    return { id: uuid(service.id), name: text(service.name, 120, 'o nome do serviço'), description: text(service.description, 1000, 'a descrição do serviço'), priceCents: service.priceCents === null ? null : integer(service.priceCents, 0, 100000000, 'o preço'), durationMinutes: integer(service.durationMinutes, 0, 1440, 'a duração'), gapMinutes: integer(service.gapMinutes, 0, 240, 'o intervalo'), professionalIds, online: bool(service.online) };
  });
  if (new Set(services.map(s => s.id)).size !== services.length) throw failure(422, 'Há serviços repetidos.');
  return { step: integer(input.step, 1, 6, 'a etapa'), teamMode: input.teamMode, business: { name: text(b.name, 120, 'o nome do negócio'), segment: text(b.segment, 40, 'o segmento'), phone: text(b.phone, 25, 'o telefone'), email: normalizeEmail(text(b.email, 254, 'o e-mail')), timeZone: text(b.timeZone, 80, 'o fuso'), mode: b.mode, address: text(b.address, 300, 'o endereço'), description: text(b.description, 1000, 'a apresentação'), onlineInstructions: b.onlineInstructions === undefined ? '' : text(b.onlineInstructions, 1000, 'as orientações públicas do atendimento online'), landingHeadline: text(b.landingHeadline ?? '', 140, 'o título da página inicial'), landingColor: b.landingColor || '' }, professionals, services, rules: { noticeMinutes: integer(input.rules.noticeMinutes, 0, 10080, 'a antecedência'), advanceDays: integer(input.rules.advanceDays, 1, 365, 'a janela de agendamento'), cancelHours: integer(input.rules.cancelHours, 0, 168, 'o prazo de cancelamento') } };
}
export function validationReport(draft, preferences = []) {
  const steps = Array.from({ length: 6 }, (_, i) => ({ step: i + 1, issues: [] }));
  const issue = (step, message) => steps[step - 1].issues.push(message);
  const b = draft.business, active = draft.professionals.filter(p => p.active);
  if (b.name.length < 2) issue(1, 'Informe o nome público do negócio.');
  if (!segments.some(s => s.id === b.segment)) issue(1, 'Escolha o tipo de serviço que você oferece.');
  if (b.phone.replace(/\D/g, '').length < 10 || b.phone.replace(/\D/g, '').length > 15) issue(1, 'Informe um telefone de contato com DDD.');
  if (!isEmail(b.email)) issue(1, 'Informe um e-mail de contato válido.');
  if (b.mode === 'presencial' && b.address.length < 5) issue(1, 'Informe o endereço do atendimento presencial.');
  if (active.length < 1) issue(2, 'Ative ao menos um profissional.');
  const emails = new Set();
  for (const p of active) {
    if (p.name.length < 2) issue(2, 'Informe o nome de cada profissional ativo.');
    if (!isEmail(p.email)) issue(2, `Confira o e-mail de ${p.name || 'cada profissional'}.`);
    if (emails.has(p.email)) issue(2, 'Cada profissional precisa de um e-mail de acesso próprio.');
    emails.add(p.email);
    for (const message of weekIssues(p.week)) issue(4, `${p.name || 'Profissional'}: ${message}`);
  }
  const online = draft.services.filter(s => s.online);
  if (!online.length) issue(3, 'Cadastre ao menos um serviço disponível no catálogo.');
  for (const service of online) {
    if (service.name.length < 2 || service.durationMinutes < 5) issue(3, 'Dê um nome e uma duração de pelo menos 5 minutos para cada serviço.');
    if (service.priceCents === null) issue(3, `${service.name || 'Serviço'}: informe o preço. Para um serviço gratuito, digite 0 explicitamente.`);
    const eligible = active.filter(p => service.professionalIds.includes(p.id));
    if (!eligible.length) issue(3, `${service.name || 'Um serviço'} precisa de ao menos um profissional ativo.`);
    if (eligible.length && eligible.every(p => !p.week.some(day => {
      if (!day.enabled) return false;
      const length = service.durationMinutes + service.gapMinutes;
      if (day.breakStart === day.breakEnd) return minute(day.end) - minute(day.start) >= length;
      return Math.max(minute(day.breakStart) - minute(day.start), minute(day.end) - minute(day.breakEnd)) >= length;
    }))) issue(4, `${service.name}: a duração não cabe no expediente dos profissionais escolhidos.`);
  }
  for (const p of active) {
    const pref = preferences.find(row => row.professional_id === p.id);
    if (pref?.require_payment && pref.connection_status !== 'connected') issue(5, `${p.name}: conecte e valide a própria conta Mercado Pago para exigir pagamento.`);
  }
  for (const step of steps) step.issues = [...new Set(step.issues)];
  return { steps, ready: steps.every(s => !s.issues.length) };
}
export function publicSnapshot(draft, slug) {
  const active = draft.professionals.filter(p => p.active);
  return { slug, business: draft.business, professionals: active.map(({ id, name, week }) => ({ id, name, week })), services: draft.services.filter(s => s.online).map(service => ({ ...service, professionalIds: service.professionalIds.filter(id => active.some(p => p.id === id)) })), rules: draft.rules, bookingEnabled: false };
}
export function publicationState(draft, published, slug) {
  if (!published) return { hasChanges: false };
  const comparable = catalog => {
    const { logoUrl, ...business } = catalog.business;
    return {
      business: { ...business, onlineInstructions: business.onlineInstructions ?? '' },
      professionals: catalog.professionals.map(({ id, name, week }) => ({ id, name, week })),
      services: catalog.services.map(service => ({ ...service, professionalIds: [...service.professionalIds].sort() })),
      rules: catalog.rules,
    };
  };
  // Object storage order is immaterial; professional/service order remains public.
  // Image URLs and operational flags are applied live, outside catalog publication.
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return { hasChanges: JSON.stringify(canonical(comparable(publicSnapshot(draft, slug)))) !== JSON.stringify(canonical(comparable(published))) };
}
export const newId = () => randomUUID();
