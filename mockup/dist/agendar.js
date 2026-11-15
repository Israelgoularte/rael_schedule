'use strict';
(() => {
  const root = document.querySelector('#booking-root'), dialog = document.querySelector('#booking-dialog');
  const slug = location.pathname.split('/').filter(Boolean)[1], storageKey = `rael-booking-${slug}`;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => (n / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const addDays = (date, days) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
  const dateLabel = (date, options = {}) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', day: '2-digit', month: 'short', ...options }).format(new Date(`${date}T12:00:00Z`));
  let catalog, customer = null, csrf = '', testMode = false, recoveryEmail = false, busy = false, loading = false, error = '', page = 'wizard', authMode = 'register', success = null, rescheduling = null, slots = [], quote = null, serial = 0, list = [], hasMore = false, paymentData = null, paymentAppointmentId = '', paymentTimer = null, paymentPolls = 0;
  let memberships = [], selectedSubscription = '', pendingPlanSelection = false, renderedView = '', accountVersion = 0, planChoiceNotice = '';
  const landingSearch = location.search || '', openOwnAppointments = new URLSearchParams(location.search).get('visao') === 'agendamentos';
  let metadata = {}, metadataError = '';
  try { metadata = window.RaelMetadata.capture(landingSearch); } catch { metadataError = window.RaelMetadata?.errorMessage || 'Não foi possível ler este link. Peça um novo link para continuar.'; }
  const internalReturn = value => {
    const keys = Object.keys(value), id = item => typeof item === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(item);
    return keys.length === 1 && id(value.assinatura) || keys.length === 2 && value.pagamento === 'retorno' && id(value.reserva);
  };
  let booking = { step: 1, serviceId: '', professionalId: '', anyProfessional: false, date: '', startAt: null, idempotencyKey: crypto.randomUUID() };
  const prefill = (() => { const p = new URLSearchParams(location.search); let phone = (p.get('whatsapp') || p.get('phone') || p.get('telefone') || '').replace(/\D/g, ''); if ([10, 11].includes(phone.length)) phone = '55' + phone; const result = { name: (p.get('nome') || p.get('name') || '').slice(0, 120), phone: /^\d{12,15}$/.test(phone) ? phone : '', email: (p.get('email') || '').slice(0, 254) }; const token = new URLSearchParams(location.hash.slice(1)).get('recuperar-cliente'); if (location.search || token) history.replaceState(null, '', location.pathname + (metadataError ? location.search : '')); return { ...result, subscriptionId: /^[a-f0-9-]{36}$/.test(p.get('assinatura') || '') ? p.get('assinatura') : '', resetToken: token, returnAppointmentId: p.get('pagamento') === 'retorno' && /^[a-f0-9-]{36}$/.test(p.get('reserva') || '') ? p.get('reserva') : null }; })();
  selectedSubscription = prefill.subscriptionId; pendingPlanSelection = Boolean(prefill.subscriptionId);
  const fields = { name: prefill.name, phone: prefill.phone, email: prefill.email };
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey)), b = saved?.booking;
    const fresh = saved && Number.isFinite(saved.savedAt) && Date.now() - saved.savedAt >= 0 && Date.now() - saved.savedAt < 2 * 3600000;
    if (fresh && (!landingSearch || internalReturn(metadata))) {
      try { metadata = window.RaelMetadata.normalize(Object.fromEntries([...Object.entries(window.RaelMetadata.normalize(saved.metadata)), ...Object.entries(metadata)])); }
      catch { metadataError = window.RaelMetadata.errorMessage; }
    }
    if (fresh && b && Number.isInteger(b.step) && b.step >= 1 && b.step <= 4 && ['serviceId', 'professionalId'].every(k => typeof b[k] === 'string' && (b[k] === '' || /^[a-f0-9-]{36}$/.test(b[k]))) && /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') && Number.isFinite(Date.parse(b.date + 'T12:00:00Z')) && (b.startAt === null || Number.isSafeInteger(b.startAt))) {
      booking = { ...booking, serviceId: b.serviceId, professionalId: b.professionalId, anyProfessional: b.anyProfessional === true, date: b.date, dateBase: /^\d{4}-\d{2}-\d{2}$/.test(b.dateBase || '') ? b.dateBase : b.date, startAt: b.startAt, step: Math.min(3, b.step), subscriptionId: /^[a-f0-9-]{36}$/.test(b.subscriptionId || '') ? b.subscriptionId : '', idempotencyKey: /^[a-f0-9-]{36}$/.test(b.idempotencyKey || '') ? b.idempotencyKey : crypto.randomUUID() };
      if (landingSearch && JSON.stringify(metadata) !== JSON.stringify(window.RaelMetadata.normalize(saved.metadata))) booking.idempotencyKey = crypto.randomUUID();
    }
  } catch { if (!landingSearch) { metadata = {}; metadataError = 'Não foi possível recuperar a origem deste agendamento. Abra novamente o link que recebeu para continuar.'; } }
  selectedSubscription ||= booking.subscriptionId ?? "";
  function persist() { booking.subscriptionId = selectedSubscription; if (!rescheduling && !metadataError) try { sessionStorage.setItem(storageKey, JSON.stringify({ booking, metadata, savedAt: Date.now() })); } catch {} }
  if (landingSearch && !metadataError) persist();
  function resetChoice() { serial++; loading = false; booking.idempotencyKey = crypto.randomUUID(); booking.startAt = null; quote = null; slots = []; persist(); }
  function service() { return catalog.services.find(s => s.id === booking.serviceId); }
  function displayService() { return rescheduling?.snapshot.service ?? service(); }
  function professional() { return catalog.professionals.find(p => p.id === booking.professionalId); }
  const planServices = s => Array.isArray(s.services) ? s.services : s.serviceId ? [{ serviceId: s.serviceId, serviceName: s.serviceName, units: s.units }] : [];
  function serviceBalance(s, serviceId) {
    if (!planServices(s).some(item => item.serviceId === serviceId) || !s.cycle) return null;
    // A combined balance must never be reused as the quota of each service.
    const item = Array.isArray(s.cycle.services) ? s.cycle.services.find(item => item.serviceId === serviceId) : planServices(s).length === 1 ? s.cycle : null;
    return item && Number.isSafeInteger(item.remaining) && item.remaining >= 0 ? item : null;
  }
  function coversService(s, serviceId, professionalId = '', startAt = null) {
    return Boolean(customer && s.canUse && s.cycle && s.cycle.endAt > Date.now() && (!professionalId || s.scope === 'business' || s.professionalId === professionalId) && serviceBalance(s, serviceId) && (startAt === null || startAt >= s.cycle.startAt && startAt < s.cycle.endAt));
  }
  function servicePlans(serviceId, { professionalId = '', startAt = null, exhausted = false } = {}) {
    return memberships.filter(s => coversService(s, serviceId, professionalId, startAt) && (exhausted ? serviceBalance(s, serviceId).remaining === 0 : serviceBalance(s, serviceId).remaining > 0) && catalog.professionals.some(p => (!professionalId || p.id === professionalId) && (s.scope === 'business' || p.id === s.professionalId) && catalog.services.find(service => service.id === serviceId)?.professionalIds.includes(p.id) && (p.bookingAllowed || p.subscriptionBookingAllowed === true)));
  }
  function preferredServicePlan(serviceId) { const plans = servicePlans(serviceId); return plans.find(s => s.id === selectedSubscription) ?? plans[0]; }
  function selectedCoverage(p) { return memberships.find(s => s.id === selectedSubscription && coversService(s, booking.serviceId, p?.id ?? '') && serviceBalance(s, booking.serviceId).remaining > 0); }
  function displayCharge() { return rescheduling?.snapshot.subscription || selectedCoverage(professional()) ? 'Incluído no seu plano' : money(displayService()?.priceCents ?? 0); }
  function professionalAllowed(p) { return Boolean(p && (rescheduling ? p.id === rescheduling.professionalId : selectedSubscription ? selectedCoverage(p) && (p.bookingAllowed || p.subscriptionBookingAllowed === true) : p.bookingAllowed)); }
  function eligibleProfessionals() { return catalog.professionals.filter(p => professionalAllowed(p) && service()?.professionalIds.includes(p.id)).slice(0, 3); }
  function canChooseProfessional() { return booking.anyProfessional ? !rescheduling && !selectedSubscription && eligibleProfessionals().length > 0 : professionalAllowed(professional()) && service()?.professionalIds.includes(booking.professionalId); }
  function openOn(date) { const day = new Date(`${date}T12:00:00Z`).getUTCDay(); return (booking.anyProfessional ? eligibleProfessionals() : [professional()].filter(Boolean)).some(p => p.week.some(w => w.day === day && w.enabled)); }
  function businessFor(appointment) { return { ...catalog.business, ...appointment?.snapshot?.business }; }
  function rescheduleDate(appointment) {
    const parts = new Intl.DateTimeFormat('en', { timeZone: catalog.business.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(appointment.startAt);
    const date = ['year', 'month', 'day'].map(type => parts.find(part => part.type === type).value).join('-');
    return date < catalog.bookingCalendar.today ? catalog.bookingCalendar.today : date > catalog.bookingCalendar.lastDate ? catalog.bookingCalendar.lastDate : date;
  }
  function timeZoneLabel(zone = catalog.business.timeZone) { const names = { 'America/Sao_Paulo': 'Brasília', 'America/Manaus': 'Manaus', 'America/Cuiaba': 'Cuiabá', 'America/Campo_Grande': 'Campo Grande', 'America/Porto_Velho': 'Porto Velho', 'America/Rio_Branco': 'Rio Branco', 'America/Boa_Vista': 'Boa Vista', 'America/Belem': 'Belém', 'America/Fortaleza': 'Fortaleza', 'America/Recife': 'Recife', 'America/Maceio': 'Maceió', 'America/Bahia': 'Bahia', 'America/Araguaina': 'Araguaína', 'America/Noronha': 'Fernando de Noronha' }; const name = names[zone] ?? zone.split('/').at(-1).replaceAll('_', ' '); return `Horário de ${name}`; }
  function formatAt(at, business = catalog.business) { return new Intl.DateTimeFormat('pt-BR', { timeZone: business.timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(at); }
  function contacts(business = catalog.business) { const rawPhone = String(business.phone ?? '').trim(), digits = rawPhone.replace(/\D/g, ''), phone = /^[+\d\s().-]+$/.test(rawPhone) && /^\d{10,15}$/.test(digits) ? `<a href="tel:${digits.length > 11 || rawPhone.startsWith('+') ? '+' : ''}${digits}">Ligar: ${esc(rawPhone)}</a>` : ''; const email = String(business.email ?? '').trim(), mail = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(email) ? `<a href="mailto:${esc(encodeURIComponent(email).replace('%40', '@'))}">E-mail: ${esc(email)}</a>` : ''; return `<div class="booking-contacts">${[phone, mail].filter(Boolean).join('') || '<span>Solicite ao negócio um contato atualizado.</span>'}</div>`; }
  function accessInstructions(business, key) {
    const online = business.mode === 'online', instructions = online ? business.onlineInstructions?.trim() ?? '' : '', address = typeof business.address === 'string' ? business.address.trim() : '';
    const guidance = instructions ? `<details class="booking-details" data-booking-details="${esc(key)}"><summary>Orientações do atendimento online</summary><div class="booking-details-content"><p class="small booking-instructions">${esc(instructions)}</p></div></details>` : '';
    const location = online ? '' : address ? `<div class="booking-address spaced" data-booking-address><div class="booking-address-row"><p class="small muted booking-address-text">Local: ${esc(address)}</p>${button('<svg class="booking-address-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" focusable="false"><path d="M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg><span>Copiar</span>', 'copy-address', `data-address="${esc(address)}" aria-label="Copiar endereço" aria-describedby="booking-address-status-${esc(key)}"`, 'secondary small')}</div><div class="booking-address-fallback" data-address-fallback hidden><label class="field"><span>Endereço do atendimento</span><textarea data-address-input readonly rows="2" aria-describedby="booking-address-status-${esc(key)}">${esc(address)}</textarea></label></div><p id="booking-address-status-${esc(key)}" class="small muted booking-address-status" data-address-status role="status" aria-live="polite"></p></div>` : '<p class="small muted spaced">Local: Combine o local com o negócio.</p>';
    return `${location}${guidance}${contacts(business)}`;
  }
  async function copyAddress(target) {
    const section = target.closest('[data-booking-address]'), address = target.dataset.address;
    if (!section || typeof address !== 'string' || !address.trim()) return;
    const feedback = section.querySelector('[data-address-status]'), fallback = section.querySelector('[data-address-fallback]'), input = section.querySelector('[data-address-input]');
    if (!feedback || !fallback || !input) return;
    target.disabled = true; feedback.textContent = '';
    try {
      let copied = false;
      try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(address); copied = true; } } catch { /* Keep a visible manual-copy option when the browser refuses. */ }
      if (!section.isConnected) return;
      if (!copied) {
        fallback.hidden = false; input.focus({ preventScroll: true }); input.select();
        try { copied = document.execCommand?.('copy') === true; } catch { /* The address remains selected for manual copying. */ }
      }
      if (copied) {
        fallback.hidden = true;
        feedback.textContent = 'Endereço copiado.';
        if (target.isConnected) target.focus({ preventScroll: true });
      } else feedback.textContent = 'Não foi possível copiar automaticamente. O endereço está selecionado; copie o texto acima.';
    } finally { target.disabled = false; }
  }
  function cancellationInfo(at, hours, business, { warn = false, closed = false } = {}) { if (hours === 0) return ''; const deadline = at - hours * 3600000, inside = Date.now() >= deadline; return `<div class="booking-policy${warn && inside ? ' note warning' : ''} spaced"><p class="small">Cancelamento ou remarcação online até ${hours} horas antes: <strong>${esc(formatAt(deadline, business))}</strong>. <span class="muted">${esc(timeZoneLabel(business.timeZone, at))}.</span></p>${closed || inside ? `<p class="small spaced"><strong>O prazo de alteração online terminou.</strong> ${warn ? 'Depois de confirmar, combine qualquer alteração diretamente com o negócio.' : 'Fale diretamente com o negócio para combinar uma alteração.'}</p>` : '<p class="small spaced">Depois desse prazo, fale diretamente com o negócio.</p>'}</div>`; }
  const dt = at => new Intl.DateTimeFormat('pt-BR', { timeZone: catalog.business.timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(at);
  function button(text, action, extra = '', variant = '') { return `<button type="button" class="button ${variant}" data-action="${action}" ${extra}>${text}</button>`; }
  function portrait(name, url, logo = false) { return `<span class="profile-image ${logo ? 'company-logo' : ''}"><span aria-hidden="true">${esc(name.split(' ').slice(0, 2).map(w => w[0] ?? '').join(''))}</span>${url ? `<img src="${esc(url)}" alt="${logo ? 'Logo de' : 'Foto de'} ${esc(name)}" decoding="async" width="160" height="160">` : ''}</span>`; }
  async function api(path, { data, method = data ? 'POST' : 'GET' } = {}) {
    const version = accountVersion;
    let response; try { response = await fetch(`/internal/${encodeURIComponent(slug)}/${path}`, { method, credentials: 'same-origin', headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }); } catch { throw new Error('Não foi possível conectar. Confira sua internet e tente novamente; sua escolha continua salva.'); }
    let body; try { body = await response.json(); } catch { throw new Error('A conexão foi interrompida. Tente novamente; sua escolha continua salva.'); }
    if (!response.ok) { if (version === accountVersion && response.status === 401 && !['customer/login', 'customer/register', 'customer/session'].includes(path)) { customer = null; csrf = ''; authMode = 'login'; memberships = []; list = []; paymentData = null; } throw Object.assign(new Error(body.error || 'Não foi possível concluir.'), { status: response.status, staleAccount: version !== accountVersion }); } return body;
  }
  function showModal(title, html) { dialog.innerHTML = `<button class="dialog-close" type="button" data-action="close-dialog" aria-label="Fechar">×</button><h2 id="booking-dialog-title">${esc(title)}</h2>${html}`; dialog.showModal(); }
  function header() { return `${testMode ? '<div class="test-banner">Ambiente de testes · use dados fictícios · sem e-mails ou cobranças reais</div>' : ''}<header class="booking-header"><div class="business-brand">${portrait(catalog.business.name, catalog.business.logoUrl, true)}<div><strong>${esc(catalog.business.name)}</strong><small>${catalog.business.mode === 'online' ? 'Atendimento online' : esc(catalog.business.address)}</small></div></div><div class="booking-head-actions">${customer ? '<span data-rael-notifications></span>' : ''}<a class="button secondary small" href="/planos/${slug}">Planos</a>${button('Meus agendamentos', 'my-bookings', '', 'secondary small')}<button type="button" class="theme-toggle" data-theme-toggle aria-label="Alternar tema"></button></div></header>`; }
  function steps() { return `<ol class="booking-steps" aria-label="Etapas do agendamento">${['Serviço', 'Profissional', 'Dia e horário', 'Confirmação'].map((n, i) => `<li ${booking.step === i + 1 ? 'aria-current="step"' : ''} class="${booking.step > i + 1 ? 'done' : ''}"><span>${booking.step > i + 1 ? '✓' : i + 1}</span>${n}</li>`).join('')}</ol>`; }
  function chooseService() {
    const description = catalog.business.description?.trim() || '', longIntroduction = description.length > 160;
    const linkedPlan = selectedSubscription && memberships.find(s => s.id === selectedSubscription);
    return `<div class="booking-intro"><div class="eyebrow">Um horário que cabe na sua rotina</div><h1 tabindex="-1">Como podemos ajudar?</h1><p>Escolha o atendimento e encontre o melhor horário para você.</p>${linkedPlan && planServices(linkedPlan).length > 1 ? `<p class="small booking-plan-context">Seu plano: <strong>${esc(linkedPlan.name)}</strong>. Escolha um serviço incluído ou agende avulso.</p>` : ''}${description ? longIntroduction ? `<details class="booking-details booking-business-description" data-booking-details="business-introduction"><summary>Conheça ${esc(catalog.business.name)}</summary><p class="booking-instructions">${esc(description)}</p></details>` : `<p class="small booking-business-description">${esc(description)}</p>` : ''}</div><div class="service-options">${catalog.services.map(s => {
      const description = s.description?.trim() || `${s.durationMinutes} minutos de atendimento`, longDescription = description.length > 160;
      const covered = preferredServicePlan(s.id), exhausted = !covered && servicePlans(s.id, { exhausted: true }).length > 0;
      const price = covered ? `<strong class="service-plan-included">Incluído no seu plano</strong><span class="service-plan-balance">Disponível este mês: ${serviceBalance(covered, s.id).remaining}</span><span class="service-plan-name">${esc(covered.name)}</span>` : `${exhausted ? '<span class="service-plan-exhausted">Plano mensal esgotado</span>' : ''}<strong class="price">${money(s.priceCents)}</strong>${exhausted ? '<span class="service-plan-name">Valor para agendar avulso</span>' : ''}`;
      const choice = `<button type="button" class="select-card${covered ? ' service-covered' : ''}" data-action="service" data-id="${s.id}" aria-pressed="${s.id === booking.serviceId}"><span class="selection-mark" aria-hidden="true">${s.id === booking.serviceId ? '✓' : ''}</span><h3>${esc(s.name)}</h3><p>${esc(longDescription ? description.slice(0, 157).trimEnd() + '…' : description)}</p><p>${s.durationMinutes} min</p>${price}</button>`;
      return longDescription ? `<article class="service-with-details">${choice}<details class="booking-details" data-booking-details="service-${s.id}"><summary>Descrição completa de ${esc(s.name)}</summary><p class="small booking-instructions">${esc(description)}</p></details></article>` : choice;
    }).join('')}</div>`;
  }
  function chooseProfessional() { const pros = catalog.professionals.filter(p => service()?.professionalIds.includes(p.id) && (!rescheduling || p.id === rescheduling.professionalId)), eligible = eligibleProfessionals(); return `<div class="booking-heading"><div class="eyebrow">Etapa 2 de 4</div><h1 tabindex="-1">Quem vai atender você?</h1><p>Escolha o profissional para ${esc(displayService()?.name)} · ${displayService()?.durationMinutes} min · ${displayCharge()}.</p>${memberships.some(s => s.id === selectedSubscription && s.scope === 'business') ? '<p class="small spaced">Seu plano é do negócio: escolha qualquer profissional habilitado para este serviço. O saldo é compartilhado entre os profissionais.</p>' : ''}</div>${testMode ? '<p class="small muted spaced">Os retratos deste ambiente representam pessoas fictícias.</p>' : ''}<div class="pro-options spaced">${!rescheduling && !selectedSubscription && eligible.length > 1 ? `<button type="button" class="select-card pro-option any-professional" data-action="professional-any" aria-pressed="${booking.anyProfessional}"><span class="selection-mark" aria-hidden="true">${booking.anyProfessional ? '✓' : ''}</span><span class="any-professional-symbol" aria-hidden="true">◷</span><h3>Sem preferência</h3><p>Veja os horários dos profissionais disponíveis. Você confere quem vai atender antes de confirmar.</p></button>` : ''}${pros.map(p => `<button type="button" class="select-card pro-option" data-action="professional" data-id="${p.id}" aria-pressed="${!booking.anyProfessional && p.id === booking.professionalId}" ${!professionalAllowed(p) ? 'disabled' : ''}><span class="selection-mark" aria-hidden="true">${!booking.anyProfessional && p.id === booking.professionalId ? '✓' : ''}</span>${portrait(p.name, p.photoUrl)}<h3>${esc(p.name)}</h3><p>${esc(professionalAllowed(p) ? p.bookingAllowed ? 'Consultar horários' : 'Consultar horários com seu plano' : selectedSubscription && !selectedCoverage(p) ? 'Não incluído no plano selecionado' : p.unavailableReason)}</p></button>`).join('')}</div>${!eligible.length ? `<div class="note warning spaced">Nenhum profissional está liberado para este serviço no momento. Entre em contato com o negócio.${contacts()}</div>` : ''}`; }
  function dateControls() {
    const day = booking.date || catalog.bookingCalendar.today, base = booking.dateBase || day;
    const dates = Array.from({ length: 7 }, (_, i) => addDays(base, i)).filter(d => d <= catalog.bookingCalendar.lastDate);
    return `<div class="date-toolbar">${button('← Anteriores', 'previous-dates', base <= catalog.bookingCalendar.today ? 'disabled' : '', 'secondary small')}<strong class="small">${esc(dateLabel(base, { month: 'long', year: 'numeric', day: undefined }))}</strong>${button('Próximos →', 'next-dates', addDays(base, 7) > catalog.bookingCalendar.lastDate ? 'disabled' : '', 'secondary small')}</div><div class="date-options">${dates.map(date => `<button type="button" class="date-option" data-action="date" data-date="${date}" aria-pressed="${date === day}" ${!openOn(date) ? 'disabled' : ''}><span>${esc(dateLabel(date, { weekday: 'short', day: undefined, month: undefined }))}</span><strong>${date.slice(-2)}</strong><span>${esc(dateLabel(date, { month: 'short', day: undefined }))}</span></button>`).join('')}</div>`;
  }
  function chooseTime() { const groups = [['Manhã', 0, 12], ['Tarde', 12, 18], ['Noite', 18, 24]]; return `<div class="booking-heading"><div class="eyebrow">Etapa 3 de 4</div><h1 tabindex="-1">Qual é o melhor horário?</h1><p>${esc(booking.anyProfessional ? 'Sem preferência de profissional' : professional()?.name)} · ${esc(displayService()?.name)} · ${displayService()?.durationMinutes} min · ${displayCharge()}.</p><p class="small">${esc(timeZoneLabel())}. ${booking.anyProfessional ? 'O nome de quem vai atender aparece em cada horário.' : ''}</p></div>${dateControls()}<h2 class="spaced">${esc(dateLabel(booking.date, { weekday: 'long', year: 'numeric' }))}</h2>${loading ? '<div class="loading-slots" aria-busy="true" role="status">Consultando horários disponíveis…</div>' : slots.length ? groups.map(([name, begin, end]) => { const group = slots.filter(s => { const hour = Number(s.time.split(':')[0]); return hour >= begin && hour < end; }); return group.length ? `<section class="slot-period"><h3>${name}</h3><div class="slot-options${booking.anyProfessional ? ' combined-slots' : ''}">${group.map(s => `<button type="button" class="slot-option" data-action="slot" data-at="${s.startAt}" data-professional="${s.professionalId}" aria-pressed="${s.startAt === booking.startAt && s.professionalId === booking.professionalId}">${esc(s.time)}${booking.anyProfessional ? `<small>${esc(catalog.professionals.find(p => p.id === s.professionalId)?.name)}</small>` : ''}</button>`).join('')}</div></section>` : ''; }).join('') : '<div class="note spaced">Não há horários disponíveis neste dia. Escolha outra data acima.</div>'}<p class="booking-fineprint">O horário fica reservado após a confirmação final. ${rescheduling ? 'Ao remarcar, o horário anterior só será liberado quando o novo estiver confirmado.' : 'Até lá, outra pessoa pode escolher a mesma vaga.'}</p>`; }
  function summary(appointment = null) {
    const s = appointment?.snapshot.service ?? quote ?? displayService(), p = appointment?.snapshot.professional ?? professional(), at = appointment?.startAt ?? booking.startAt, business = businessFor(appointment ?? rescheduling);
    if (!appointment && rescheduling) business.timeZone = quote?.timeZone ?? catalog.business.timeZone;
    const included = appointment?.snapshot.subscription ?? rescheduling?.snapshot.subscription ?? eligibleMemberships().find(m => m.id === selectedSubscription);
    const paymentMessage = included ? `Este atendimento utiliza uma unidade de ${esc(included.planName ?? included.name)}. Sem cobrança avulsa adicional.` : (appointment?.snapshot.requirePayment ?? quote?.requiresPayment) ? appointment || rescheduling ? 'Pagamento gerenciado pelo Mercado Pago. Confira a situação nos detalhes do agendamento.' : `O pagamento será feito no Mercado Pago, na conta de ${esc(quote?.receiver?.name)}. O horário só será confirmado após a aprovação.` : '';
    return `<section class="booking-summary"><div class="row">${portrait(p.name, catalog.professionals.find(x => x.id === (appointment?.professionalId ?? p.id ?? booking.professionalId))?.photoUrl)}<div><h2>${esc(s.name ?? s.serviceName)}</h2><p class="small muted">Com ${esc(p.name)}</p></div></div><div class="summary-line spaced"><span>Data e horário</span><strong>${esc(formatAt(at, business))}</strong></div><div class="summary-line"><span>Duração e atendimento</span><strong>${s.durationMinutes} minutos · ${business.mode === 'online' ? 'Online' : 'Presencial'}</strong></div><div class="summary-line total"><span>${included ? 'Cobertura' : 'Valor'}</span><strong>${included ? 'Incluído no plano' : money(s.priceCents)}</strong></div>${paymentMessage ? `<p class="small muted spaced">${paymentMessage}</p>` : ''}${cancellationInfo(at, appointment?.snapshot.cancelHours ?? rescheduling?.snapshot.cancelHours ?? quote?.cancelHours ?? catalog.rules.cancelHours, business, { warn: !appointment })}${rescheduling ? '<div class="note spaced">Valor e duração do agendamento original serão mantidos.</div>' : ''}${accessInstructions(business, appointment?.id ?? 'review-access')}</section>`;
  }
  function authForm(loginOnly = false) { const register = !loginOnly && authMode === 'register'; return `<div class="booking-auth" id="booking-access" aria-labelledby="booking-access-title">${!loginOnly ? `<div class="auth-tabs">${['register', 'login'].map(mode => `<button type="button" data-action="auth-mode" data-mode="${mode}" aria-pressed="${mode === authMode}">${mode === 'register' ? 'Primeira vez aqui' : 'Já tenho cadastro'}</button>`).join('')}</div>` : ''}<h2 id="booking-access-title">${register ? 'Falta só conhecer você.' : 'Entre na sua conta'}</h2><p class="small muted spaced">${register ? 'Seu cadastro permite consultar e alterar seus próprios agendamentos.' : 'Use o e-mail e a senha que você cadastrou neste negócio.'}</p><form id="customer-auth">${register ? `<label class="field"><span>Seu nome</span><input name="name" value="${esc(fields.name)}" autocomplete="name" minlength="2" maxlength="120" required></label><label class="field"><span>WhatsApp com DDD</span><input name="phone" type="tel" inputmode="tel" value="${esc(fields.phone)}" autocomplete="tel" maxlength="25" required></label>` : ''}<label class="field"><span>Seu e-mail</span><input name="email" type="email" value="${esc(fields.email)}" autocomplete="username" maxlength="254" required></label><label class="field"><span>${register ? 'Crie uma senha' : 'Sua senha'}</span><input name="password" type="password" minlength="8" maxlength="128" autocomplete="${register ? 'new-password' : 'current-password'}" required><small>${register ? 'Pelo menos 8 caracteres.' : 'Use a senha cadastrada.'}</small></label>${register ? '<label class="field"><span>Repita sua senha</span><input name="confirmation" type="password" minlength="8" maxlength="128" autocomplete="new-password" required></label>' : ''}<p class="booking-fineprint">Seus dados serão usados pelo negócio para organizar o atendimento. Consulte os <a href="/termos" target="_blank" rel="noopener">Termos de Uso</a> e a <a href="/privacidade" target="_blank" rel="noopener">Política de Privacidade</a> (abrem em outra aba).</p><button class="button full spaced" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Aguarde…' : page === 'payment' ? 'Entrar e consultar pagamento' : page === 'mine' ? pendingPlanSelection ? 'Entrar e escolher horário' : 'Entrar e consultar' : quote?.requiresPayment && !rescheduling ? register ? 'Criar cadastro e reservar para pagar' : 'Entrar e continuar' : register ? 'Criar cadastro e confirmar' : rescheduling ? 'Entrar e confirmar' : 'Entrar e continuar'}</button></form>${!register ? '<button type="button" class="text-button spaced" data-action="recovery-help">Esqueci minha senha</button>' : ''}</div>`; }
  async function loadMemberships() { const version = accountVersion; if (!customer) { memberships = []; return; } const result = await api('customer/subscriptions'); if (version === accountVersion && customer) memberships = result.subscriptions; }
  function resumePlanSelection() {
    if (!pendingPlanSelection || !customer) return false;
    const selected = memberships.find(s => s.id === selectedSubscription);
    if (!selected) { error = 'Este plano não foi encontrado no seu acesso. Confira se entrou na conta usada na contratação.'; return false; }
    pendingPlanSelection = false; page = 'wizard';
    const services = planServices(selected), single = services.length === 1 && serviceBalance(selected, services[0].serviceId)?.remaining > 0 && selected.canUse;
    booking = { step: single ? selected.scope === 'business' ? 2 : 3 : 1, serviceId: single ? services[0].serviceId : '', professionalId: single && selected.scope !== 'business' ? selected.professionalId : '', anyProfessional: false, date: catalog.bookingCalendar.today, dateBase: catalog.bookingCalendar.today, startAt: null, idempotencyKey: crypto.randomUUID() };
    quote = null; slots = []; persist(); return single && selected.scope !== 'business';
  }
  function eligibleMemberships() { return servicePlans(booking.serviceId, { professionalId: booking.professionalId, startAt: booking.startAt }); }
  function membershipChoice() {
    const eligible = eligibleMemberships();
    if (rescheduling || !customer || !eligible.length && !selectedSubscription) return '';
    const selected = eligible.find(s => s.id === selectedSubscription), disabled = busy || loading ? 'disabled' : '';
    const date = at => new Intl.DateTimeFormat('pt-BR', { timeZone: catalog.business.timeZone, dateStyle: 'short' }).format(at);
    const ordinaryAllowed = professional()?.bookingAllowed === true;
    const plans = eligible.map(s => {
      const chosen = s.id === selectedSubscription, remaining = serviceBalance(s, booking.serviceId).remaining;
      return `<button type="button" class="select-card booking-payment-option" data-action="booking-plan" data-id="${esc(s.id)}" aria-pressed="${chosen}" ${disabled}><span class="selection-mark" aria-hidden="true">${chosen ? '✓' : ''}</span><span class="booking-payment-status">${chosen ? 'Selecionado' : 'Plano contratado'}</span><strong class="booking-payment-label">Usar meu plano</strong><span class="booking-payment-name">${esc(s.name)}</span><span class="booking-payment-detail">${remaining} atendimento${remaining > 1 ? 's' : ''} ${remaining > 1 ? 'disponíveis' : 'disponível'} · válido até ${esc(date(s.cycle.endAt))}</span><span class="booking-payment-detail">Sem cobrança avulsa adicional.</span></button>`;
    }).join('');
    return `<section class="booking-plan-choice spaced" aria-labelledby="booking-plan-choice-title"><h2 id="booking-plan-choice-title" tabindex="-1">${eligible.length ? 'Use seu plano neste atendimento' : 'Escolha como agendar'}</h2><p class="small muted">Escolha uma opção antes de confirmar.</p>${selectedSubscription && !selected ? '<p class="note warning spaced">O plano escolhido não cobre este horário. Escolha outro horário ou agende avulso.</p>' : ''}<div class="booking-plan-options" role="group" aria-label="Forma de agendamento">${plans}<button type="button" class="select-card booking-payment-option booking-payment-ordinary" data-action="booking-plan" data-id="" aria-pressed="${!selectedSubscription}" ${disabled || !ordinaryAllowed ? 'disabled' : ''}><span class="selection-mark" aria-hidden="true">${!selectedSubscription ? '✓' : ''}</span>${!selectedSubscription ? '<span class="booking-payment-status">Selecionado</span>' : ''}<strong class="booking-payment-label">Agendar avulso</strong><span class="booking-payment-price">${money(quote?.priceCents ?? displayService()?.priceCents ?? 0)}</span><span class="booking-payment-detail">${ordinaryAllowed ? 'Sem usar o saldo do seu plano.' : 'Avulso indisponível para este profissional no momento.'}</span></button></div>${loading ? '<p class="small spaced" role="status" aria-live="polite">Atualizando a opção de agendamento…</p>' : planChoiceNotice ? `<p class="small spaced" role="status" aria-live="polite">${esc(planChoiceNotice)}</p>` : selected ? '<p class="small spaced">Plano selecionado: 1 atendimento será usado ao confirmar. Nenhuma cobrança avulsa será criada.</p>' : ''}</section>`;
  }
  function review() { const choice = membershipChoice(); return `<div class="booking-heading"><div class="eyebrow">Etapa 4 de 4</div><h1 tabindex="-1">${rescheduling ? 'Vamos confirmar a mudança?' : 'Está tudo certo para você?'}</h1><p>Confira o serviço, o profissional e o horário antes de concluir.</p></div><div class="booking-review${choice ? ' has-plan-choice' : ''}">${choice}${summary()}<div class="booking-review-access">${customer ? `<div class="booking-auth"><h2>Seus dados</h2><p class="spaced"><strong>${esc(customer.name)}</strong></p><p class="small muted">${esc(customer.phone)}<br>${esc(customer.email)}</p><p class="small muted spaced">A reserva ficará vinculada à sua conta.</p>${button('Usar outro acesso', 'logout', '', 'secondary spaced')}</div>` : authForm()}</div></div>`; }
  function footer() { const included = rescheduling?.snapshot.subscription ?? selectedCoverage(professional()); const nextDisabled = busy || loading || (booking.step === 1 && !service()) || (booking.step === 2 && !canChooseProfessional()) || (booking.step === 3 && (!booking.startAt || !quote)); return `<footer class="booking-footer"><div class="summary-mini">${esc(displayService()?.name ?? 'Escolha seu atendimento')}${service() ? ` · ${displayService().durationMinutes} min · ${included ? 'Incluído no plano' : money(displayService().priceCents)}` : ''}${booking.anyProfessional && !booking.startAt ? ' · Sem preferência' : professional() ? ` · ${esc(professional().name)}` : ''}</div><div class="row">${button(booking.step > 1 ? '← Voltar' : 'Ver meus agendamentos', booking.step > 1 ? 'back' : 'my-bookings', busy ? 'disabled' : '', 'secondary')}${booking.step < 4 ? button('Continuar →', 'next', nextDisabled ? 'disabled' : '') : customer ? button(busy ? 'Confirmando…' : rescheduling ? 'Confirmar remarcação' : selectedSubscription ? 'Confirmar usando meu plano' : quote?.requiresPayment ? 'Reservar e continuar para pagamento' : 'Confirmar agendamento', 'confirm', busy || loading || (selectedSubscription && !rescheduling && !eligibleMemberships().some(s => s.id === selectedSubscription)) ? 'disabled' : '') : button('Entrar ou criar cadastro', 'focus-access', `${busy ? 'disabled' : ''} aria-controls="booking-access"`)}</div></footer>`; }
  function focusAccess() {
    if (page !== 'wizard' || booking.step !== 4 || customer) return;
    const panel = root.querySelector('#booking-access');
    if (!panel) return;
    const firstField = panel.querySelector(authMode === 'register' ? 'input[name="name"]' : 'input[name="email"]');
    panel.scrollIntoView({ block: 'start', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth' });
    firstField?.focus({ preventScroll: true });
  }
  function confirmation() { return `<main id="main" class="booking-shell"><div class="booking-success"><div class="success-symbol" aria-hidden="true">✓</div><div class="eyebrow">Tudo certo</div><h1 tabindex="-1">${rescheduling ? 'Seu horário foi remarcado.' : 'Seu agendamento está confirmado.'}</h1><p class="muted spaced">A reserva foi salva no sistema. Você pode consultá-la em Meus agendamentos.</p><p class="small muted spaced">Número: ${esc(success.id.slice(0, 8).toUpperCase())}</p><div class="spaced">${summary(success)}</div><div class="row spaced">${button('Meus agendamentos', 'my-bookings')}${button('Fazer outro agendamento', 'new', '', 'secondary')}</div></div></main>`; }
  const statuses = { awaiting_payment: 'Aguardando pagamento', expired: 'Reserva expirada', confirmed: 'Confirmado', in_progress: 'Em atendimento', completed: 'Concluído', cancelled: 'Cancelado', no_show: 'Não compareceu' };
  function appointmentCard(a) {
    const business = businessFor(a), states = { waiting: 'Aguardando pagamento', pending: 'Em processamento', in_process: 'Em análise', approved: 'Aprovado', rejected: 'Recusado', cancelled: 'Cancelado', refunded: 'Reembolsado', charged_back: 'Contestado' };
    const payment = a.snapshot.subscription ? `Incluído no plano ${a.snapshot.subscription.planName}` : a.snapshot.requirePayment ? `Mercado Pago · ${states[a.payment?.state] ?? 'Consulte a situação do pagamento'}` : 'A combinar no atendimento · sem cobrança pela plataforma';
    return `<article class="appointment-card"><div class="appointment-card-top"><span class="badge ${a.status === 'confirmed' ? 'good' : ''}">${esc(statuses[a.status] ?? a.status)}</span><span class="small muted">Código ${esc(a.id.slice(0, 8).toUpperCase())}</span></div><div class="appointment-person">${portrait(a.snapshot.professional.name, catalog.professionals.find(p => p.id === (a.professionalId ?? a.snapshot.professional.id))?.photoUrl)}<div><h3>${esc(a.snapshot.service.name)}</h3><p class="small muted">Com ${esc(a.snapshot.professional.name)} · ${a.snapshot.service.durationMinutes} minutos</p></div></div><strong>${esc(formatAt(a.startAt, business))}</strong><p class="appointment-meta">${esc(timeZoneLabel(business.timeZone, a.startAt))}<br>Valor do serviço: ${money(a.snapshot.service.priceCents)} · ${business.mode === 'online' ? 'Atendimento online' : 'Atendimento presencial'}</p><p class="small spaced"><strong>Pagamento:</strong> ${esc(payment)}</p>${a.payment?.resolution ? '<p class="note warning small spaced">Há uma orientação sobre o pagamento. Abra os detalhes antes de fazer nova tentativa.</p>' : ''}${cancellationInfo(a.startAt, a.snapshot.cancelHours ?? catalog.rules.cancelHours, business, { closed: a.status === 'confirmed' && !a.canCancel })}<div class="row appointment-actions spaced">${a.snapshot.requirePayment ? button('Ver pagamento', 'view-payment', `data-id="${a.id}"`, 'secondary small') : ''}${a.canReschedule ? button('Remarcar', 'reschedule', `data-id="${a.id}"`, 'secondary small') : ''}${a.canCancel ? button('Cancelar agendamento', 'cancel', `data-id="${a.id}"`, 'secondary small') : ''}</div>${accessInstructions(business, a.id)}</article>`;
  }
  function mine() { return `<main id="main" class="booking-shell"><div class="booking-heading spaced"><div class="eyebrow">Seu espaço</div><h1 tabindex="-1">Meus agendamentos</h1><p>${customer ? `Olá, ${esc(customer.name.split(' ')[0])}. Aqui aparecem somente os agendamentos da sua conta.` : 'Entre para consultar suas reservas neste negócio.'}</p></div><div class="row portal-back">${button('Novo agendamento', 'new', '', 'secondary')}${customer ? button('Sair da minha conta', 'logout', '', 'secondary') : ''}</div>${customer ? `<div class="booking-list">${list.map(appointmentCard).join('') || '<div class="note">Você ainda não tem agendamentos neste negócio.</div>'}</div>${hasMore ? button('Carregar agendamentos anteriores', 'more', '', 'secondary') : ''}` : `<div class="auth-wrap">${authForm(true)}</div>`}</main>`; }
  function render() {
    if (!catalog) return;
    const view = `${page}:${booking.step}`, visibleError = error || (!rescheduling ? metadataError : ''), openDetails = view === renderedView ? new Set([...root.querySelectorAll('details[data-booking-details][open]')].map(details => details.dataset.bookingDetails)) : new Set();
    const content = page === 'payment' ? paymentPage() : page === 'success' ? confirmation() : page === 'mine' ? mine() : `<main id="main" class="booking-shell">${steps()}${rescheduling ? '<div class="note spaced">Você está remarcando um agendamento existente.</div>' : ''}<div id="booking-error" class="note error booking-error" role="alert">${esc(visibleError)}</div>${[chooseService, chooseProfessional, chooseTime, review][booking.step - 1]()}${footer()}<p class="booking-brand-footer">Agendamento por Rael Agendamentos · ${esc(timeZoneLabel())}</p></main>`;
    root.innerHTML = header() + content;
    for (const details of root.querySelectorAll('details[data-booking-details]')) if (openDetails.has(details.dataset.bookingDetails)) details.open = true;
    if (page !== 'wizard' && visibleError) root.querySelector('main').insertAdjacentHTML('afterbegin', `<div class="note error spaced" role="alert">${esc(visibleError)}</div>`);
    window.RaelNotifications?.mount({ slug, audience: 'customer', user: customer, csrf });
    window.RaelTheme?.sync(); if (view !== renderedView) root.querySelector('main h1')?.focus({ preventScroll: true }); renderedView = view;
  }
  async function loadSlots() {
    if (!booking.date || !service() || !canChooseProfessional()) return;
    const seq = ++serial; loading = true; error = ''; render();
    try {
      const professionals = booking.anyProfessional ? eligibleProfessionals() : [professional()], previousAt = booking.startAt, previousProfessional = booking.professionalId;
      const results = await Promise.all(professionals.map(async p => { const result = await api('availability?' + new URLSearchParams({ serviceId: booking.serviceId, professionalId: p.id, date: booking.date, ...(rescheduling ? { appointmentId: rescheduling.id } : selectedSubscription ? { subscriptionId: selectedSubscription } : {}) })); return result.slots.map(s => ({ ...s, professionalId: p.id, quote: result.quote })); }));
      if (seq !== serial) return;
      const all = results.flat().sort((a, b) => a.startAt - b.startAt), retained = all.find(s => s.startAt === previousAt && s.professionalId === previousProfessional), byTime = new Map();
      for (const s of all) if (!byTime.has(s.startAt) || s === retained) byTime.set(s.startAt, s);
      slots = [...byTime.values()]; quote = retained?.quote ?? null;
      if (!retained) booking.startAt = null;
    } catch (e) { if (seq !== serial) return; error = e.message; slots = []; booking.startAt = null; quote = null; }
    finally { if (seq === serial) { loading = false; persist(); render(); } }
  }
  function paymentPage() { return `<main id="main" class="booking-shell"><div class="booking-heading spaced"><div class="eyebrow">Seu agendamento</div><h1 tabindex="-1">Pagamento</h1><p>Confira a situação antes de fazer qualquer nova tentativa.</p></div>${customer ? paymentData ? window.RaelPayment.panel(paymentData, catalog.business.timeZone) : '<div class="loading">Consultando pagamento…</div>' : authForm(true)}<div class="row spaced">${button('Meus agendamentos', 'my-bookings', '', 'secondary')}${button('Novo agendamento', 'new', '', 'secondary')}</div><p class="small muted spaced">Para ajuda, fale com ${esc(catalog.business.name)}.</p>${contacts()}</main>`; }
  async function loadPayment(id, refresh = false) {
    const version = accountVersion;
    if (id !== paymentAppointmentId) paymentData = null;
    const opening = page !== 'payment' || paymentAppointmentId !== id; if (paymentAppointmentId !== id) paymentPolls = 0; paymentAppointmentId = id; page = 'payment'; clearTimeout(paymentTimer);
    if (customer) {
      try { const result = await api(refresh ? 'customer/payment-refresh' : 'customer/payment?appointmentId=' + encodeURIComponent(id), refresh ? { data: { appointmentId: id } } : {}); if (version !== accountVersion || !customer || id !== paymentAppointmentId) return; paymentData = result; }
      catch (e) { if (version !== accountVersion || id !== paymentAppointmentId) return; if ([401, 403, 404].includes(e.status)) paymentData = null; if (e.status === 401) { customer = null; csrf = ''; authMode = 'login'; } error = e.message; render(); return; }
      if (paymentPolls++ < 40 && paymentData.appointmentStatus === 'awaiting_payment' && !paymentData.resolution && paymentData.expiresAt > Date.now()) paymentTimer = setTimeout(() => { if (page === 'payment' && customer) loadPayment(id).catch(e => { error = e.message; render(); }); }, 15000);
    }
    render(); if (opening) window.scrollTo(0, 0);
  }

  async function loadMine(append = false) { const version = accountVersion; clearTimeout(paymentTimer); page = 'mine'; error = ''; if (customer) { const result = await api(`customer/appointments?offset=${append ? list.length : 0}`); if (version !== accountVersion || !customer) return; list = append ? [...list, ...result.appointments] : result.appointments; hasMore = result.hasMore; } render(); window.scrollTo(0, 0); }
  async function confirm() {
    if (busy || loading || !customer || !quote || !booking.startAt || !professionalAllowed(professional()) || !service()?.professionalIds.includes(booking.professionalId)) return;
    if (metadataError && !rescheduling) { error = metadataError; render(); return; }
    if (selectedSubscription && !rescheduling && !eligibleMemberships().some(s => s.id === selectedSubscription)) { error = 'Seu plano não cobre este horário. Selecione um serviço e profissional incluídos dentro do ciclo pago, ou escolha serviço avulso.'; render(); return; }
    busy = true; error = ''; planChoiceNotice = ''; render();
    const data = { professionalId: booking.professionalId, startAt: booking.startAt, quote: quote.signature, idempotencyKey: booking.idempotencyKey, ...(rescheduling ? { appointmentId: rescheduling.id, revision: rescheduling.revision } : { serviceId: booking.serviceId, metadata, ...(selectedSubscription ? { subscriptionId: selectedSubscription } : {}) }) };
    try { const result = await api(rescheduling ? 'customer/reschedule' : 'customer/reserve', { data }); success = result.appointment; if (success.status === 'awaiting_payment') { await loadPayment(success.id); } else page = 'success'; try { sessionStorage.removeItem(storageKey); } catch {} }
    catch (e) { error = e.message; if (e.status === 401) { customer = null; csrf = ''; authMode = 'login'; } else if (e.status === 409) { catalog = await api('catalog'); booking.step = 3; booking.startAt = null; booking.idempotencyKey = crypto.randomUUID(); quote = null; } }
    finally { busy = false; render(); window.scrollTo(0, 0); }
    if (booking.step === 3 && page === 'wizard') { const message = error; await loadSlots(); error = message; render(); }
  }
  root.addEventListener('input', e => { if (e.target.form?.id === 'customer-auth' && ['name', 'phone', 'email'].includes(e.target.name)) fields[e.target.name] = e.target.value; });
  async function chooseBookingPlan(id) {
    if (busy || loading || rescheduling || !customer || page !== 'wizard' || booking.step !== 4 || typeof id !== 'string') return;
    if (id === selectedSubscription) { if (planChoiceNotice) { planChoiceNotice = ''; render(); const option = [...root.querySelectorAll('[data-action="booking-plan"]')].find(node => node.dataset.id === id); option?.focus({ preventScroll: true }); } return; }
    if (id ? !eligibleMemberships().some(s => s.id === id) : professional()?.bookingAllowed !== true) return;
    selectedSubscription = id; planChoiceNotice = '';
    if (id) booking.anyProfessional = false;
    booking.idempotencyKey = crypto.randomUUID(); persist();
    if (!canChooseProfessional()) {
      quote = null; slots = []; booking.startAt = null; booking.step = 2;
      error = 'O agendamento deste profissional está indisponível no momento. Confira as opções do seu plano.';
      render(); return;
    }
    await loadSlots();
    if (!booking.startAt) { booking.step = 3; render(); return; }
    if (page !== 'wizard' || booking.step !== 4) return;
    const option = [...root.querySelectorAll('[data-action="booking-plan"]')].find(node => node.dataset.id === id);
    option?.focus({ preventScroll: true });
  }
  document.addEventListener('error', e => { if (e.target.matches?.('.profile-image img')) e.target.remove(); }, true);
  document.addEventListener('click', async e => {
    const target = e.target.closest('[data-action]'); if (!target || target.disabled || busy) return;
    const action = target.dataset.action;
    try {
      if (action === 'copy-address') { await copyAddress(target); return; }
      if (action === 'focus-access') { focusAccess(); return; }
      if (action === 'booking-plan') { await chooseBookingPlan(target.dataset.id); return; }
      error = '';
      if (action === 'view-payment' || action === 'payment-refresh') { paymentPolls = 0; await loadPayment(target.dataset.id, action === 'payment-refresh'); return; }
      if (action === 'pay') { busy = true; target.disabled = true; try { const result = await api('customer/checkout', { data: { appointmentId: target.dataset.id } }); location.assign(window.RaelPayment.safeRedirect(result.url)); } finally { busy = false; target.disabled = false; } return; }
      if (action === 'close-dialog') { dialog.close(); return; }
      if (action === 'recovery-help') {
        if (recoveryEmail && window.RaelRecovery) { window.RaelRecovery.show({ dialog, email: root.querySelector('#customer-auth input[name="email"]')?.value || fields.email, businessName: catalog.business.name, titleId: 'booking-dialog-title', send: data => api('customer/password-recovery', { data }) }); return; }
        showModal('Recuperar seu acesso', `<p>Entre em contato com ${esc(catalog.business.name)} e solicite um link pessoal. O negócio precisa conferir sua identidade antes de liberar a recuperação.</p>${contacts()}`); return;
      }
      if (action === 'service') { if (rescheduling || !catalog.services.some(s => s.id === target.dataset.id)) return; booking.serviceId = target.dataset.id; const covered = preferredServicePlan(booking.serviceId); selectedSubscription = covered?.id ?? ''; booking.professionalId = covered?.professionalId ?? ''; booking.anyProfessional = false; const eligible = eligibleProfessionals(); if (!booking.professionalId && eligible.length === 1) booking.professionalId = eligible[0].id; resetChoice(); render(); return; }
      if (action === 'professional' || action === 'professional-any') { const any = action === 'professional-any'; if (any ? rescheduling || selectedSubscription || eligibleProfessionals().length < 2 : !eligibleProfessionals().some(p => p.id === target.dataset.id) || rescheduling && target.dataset.id !== rescheduling.professionalId) return; booking.anyProfessional = any; booking.professionalId = any ? '' : target.dataset.id; booking.date = catalog.bookingCalendar.today; booking.dateBase = booking.date; resetChoice(); render(); return; }
      if (action === 'slot') { if (loading || booking.step !== 3) return; const slot = slots.find(s => s.startAt === Number(target.dataset.at) && s.professionalId === (target.dataset.professional || booking.professionalId)); if (!slot || !eligibleProfessionals().some(p => p.id === slot.professionalId)) return; booking.startAt = slot.startAt; booking.professionalId = slot.professionalId; quote = slot.quote; booking.idempotencyKey = crypto.randomUUID(); persist(); render(); return; }
      if (action === 'date') { booking.date = target.dataset.date; resetChoice(); await loadSlots(); return; }
      if (action === 'next-dates' || action === 'previous-dates') { let base = addDays(booking.dateBase || booking.date, action === 'next-dates' ? 7 : -7); if (base < catalog.bookingCalendar.today) base = catalog.bookingCalendar.today; if (base > catalog.bookingCalendar.lastDate) return; booking.dateBase = base; booking.date = Array.from({ length: 7 }, (_, i) => addDays(base, i)).find(date => date <= catalog.bookingCalendar.lastDate && openOn(date)) || base; resetChoice(); await loadSlots(); return; }
      if (action === 'next') { if (booking.step === 1) { if (!service()) return; const eligible = eligibleProfessionals(); if (eligible.length === 1) { booking.anyProfessional = false; booking.professionalId = eligible[0].id; booking.date ||= catalog.bookingCalendar.today; booking.dateBase ||= booking.date; booking.step = 3; } else booking.step = 2; } else { if (booking.step === 2 && !canChooseProfessional() || booking.step === 3 && (!booking.startAt || !quote || !professionalAllowed(professional()))) return; if (booking.step === 3) await loadMemberships(); booking.step = Math.min(4, booking.step + 1); } persist(); if (page === 'wizard' && booking.step === 3) await loadSlots(); else render(); window.scrollTo(0, 0); return; }
      if (action === 'back') { if (rescheduling && booking.step === 2) { await loadMine(); rescheduling = null; return; } booking.step = Math.max(1, booking.step - 1); persist(); render(); window.scrollTo(0, 0); return; }
      if (action === 'auth-mode') { authMode = target.dataset.mode; render(); return; }
      if (action === 'confirm') { await confirm(); return; }
      if (action === 'my-bookings') { await loadMine(); return; }
      if (action === 'more') { await loadMine(true); return; }
      if (action === 'new') { planChoiceNotice = ''; metadata = window.RaelMetadata.campaign(metadata); metadataError = ''; serial++; loading = false; selectedSubscription = ''; pendingPlanSelection = false; rescheduling = null; success = null; paymentData = null; paymentAppointmentId = ''; paymentPolls = 0; clearTimeout(paymentTimer); page = 'wizard'; booking = { step: 1, serviceId: '', professionalId: '', anyProfessional: false, date: '', startAt: null, idempotencyKey: crypto.randomUUID() }; quote = null; slots = []; persist(); if (customer) { memberships = []; await loadMemberships(); } render(); window.scrollTo(0, 0); return; }
      if (action === 'logout') { window.RaelNotifications?.beforeLogout(); await api('customer/logout', { data: {} }); planChoiceNotice = ''; metadata = {}; metadataError = ''; accountVersion++; serial++; loading = false; customer = null; csrf = ''; fields.name = ''; fields.phone = ''; fields.email = ''; memberships = []; selectedSubscription = ''; pendingPlanSelection = false; list = []; hasMore = false; success = null; paymentData = null; paymentAppointmentId = ''; paymentPolls = 0; clearTimeout(paymentTimer); if (page !== 'wizard' || rescheduling) { page = 'mine'; rescheduling = null; quote = null; booking.step = 1; booking.startAt = null; } booking.subscriptionId = ''; authMode = 'login'; booking.idempotencyKey = crypto.randomUUID(); persist(); if (dialog.open) dialog.close(); dialog.innerHTML = ''; render(); return; }
      if (action === 'cancel') { const a = list.find(x => x.id === target.dataset.id); showModal('Cancelar seu agendamento?', `<p>${esc(a.snapshot.service.name)} · ${esc(dt(a.startAt))}. Essa vaga será liberada para outra pessoa.</p>${a.snapshot.requirePayment ? '<p class="note warning spaced">Cancelar o horário não reembolsa automaticamente um pagamento. Confira a situação e combine a resolução com o negócio.</p>' : ''}<div class="row spaced">${button('Manter agendamento', 'close-dialog', '', 'secondary')}${button('Confirmar cancelamento', 'confirm-cancel', `data-id="${a.id}"`)}</div>`); return; }
      if (action === 'confirm-cancel') { const a = list.find(x => x.id === target.dataset.id); busy = true; target.disabled = true; try { await api('customer/status', { data: { appointmentId: a.id, revision: a.revision, status: 'cancelled' } }); dialog.close(); await loadMine(); } finally { busy = false; target.disabled = false; } return; }
      if (action === 'reschedule') { const appointment = list.find(x => x.id === target.dataset.id); if (!appointment) return; const date = rescheduleDate(appointment); rescheduling = appointment; booking = { step: 3, serviceId: appointment.serviceId, professionalId: appointment.professionalId, anyProfessional: false, date, dateBase: date, startAt: null, idempotencyKey: crypto.randomUUID() }; if (!service() || !professional()) throw new Error('O serviço mudou. Entre em contato com o negócio para remarcar.'); selectedSubscription = ''; pendingPlanSelection = false; quote = null; slots = []; page = 'wizard'; await loadSlots(); window.scrollTo(0, 0); return; }
    } catch (errorResult) { if (errorResult.staleAccount) return; error = errorResult.message; if (dialog.open) dialog.close(); render(); }
  });
  document.addEventListener('submit', async e => {
    e.preventDefault(); if (busy) return;
    const data = Object.fromEntries(new FormData(e.target));
    if (e.target.id === 'customer-reset') {
      if (data.password !== data.confirmation) { dialog.querySelector('[role=alert]').textContent = 'As duas senhas precisam ser iguais.'; return; }
      busy = true; const submit = e.target.querySelector('button[type=submit]'); submit.disabled = true; try { await api('customer/reset', { data: { token: prefill.resetToken, password: data.password } }); prefill.resetToken = null; dialog.close(); page = 'mine'; authMode = 'login'; error = 'Senha definida. Entre com seu e-mail e sua nova senha.'; render(); } catch (err) { dialog.querySelector('[role=alert]').textContent = err.message; } finally { busy = false; submit.disabled = false; } return;
    }
    if (e.target.id !== 'customer-auth') return;
    const register = page === 'wizard' && authMode === 'register';
    if (register && data.password !== data.confirmation) { error = 'As duas senhas precisam ser iguais.'; render(); return; }
    busy = true; const submit = e.target.querySelector('button[type=submit]'); submit.disabled = true; submit.textContent = 'Aguarde…';
    try { const result = await api(register ? 'customer/register' : 'customer/login', { data: register ? { name: data.name, phone: data.phone, email: data.email, password: data.password } : { email: data.email, password: data.password } }); accountVersion++; customer = result.customer; csrf = result.csrf; busy = false; if (page === 'payment') await loadPayment(paymentAppointmentId, true); else if (page === 'mine') { if (pendingPlanSelection) { await loadMemberships(); if (resumePlanSelection()) await loadSlots(); else render(); } else await loadMine(); } else {
        await loadMemberships();
        if (!register && page === 'wizard' && !rescheduling) {
          await loadSlots();
          if (!booking.startAt) { booking.step = 3; render(); return; }
          if (!selectedSubscription && eligibleMemberships().length) {
            planChoiceNotice = 'Você tem um plano disponível. Escolha usar o plano ou agendar avulso antes de confirmar.';
            render();
            const heading = root.querySelector('#booking-plan-choice-title');
            heading?.focus(); heading?.scrollIntoView({ block: 'start' });
            return;
          }
        }
        await confirm();
      } }
    catch (err) { error = err.message; busy = false; render(); }
  });
  async function boot() {
    try {
      const meta = await api('meta'); testMode = meta.testMode; recoveryEmail = meta.recoveryEmail === true; catalog = await api('catalog');
      try { const session = await api('customer/session'); customer = session.customer; csrf = session.csrf; } catch (e) { if (e.status !== 401) throw e; }
      await loadMemberships();
      if (!customer && !pendingPlanSelection) selectedSubscription = '';
      if (pendingPlanSelection) { if (customer) resumePlanSelection(); else { page = 'mine'; authMode = 'login'; } }
      if (!service()) { booking.step = 1; booking.serviceId = ''; booking.professionalId = ''; booking.startAt = null; }
      if (booking.anyProfessional && (selectedSubscription || !eligibleProfessionals().length)) booking.anyProfessional = false;
      if (booking.step > 1 && !canChooseProfessional()) { booking.step = Math.min(2, booking.step); booking.startAt = null; }
      if (!booking.date || booking.date < catalog.bookingCalendar.today || booking.date > catalog.bookingCalendar.lastDate) { booking.date = catalog.bookingCalendar.today; booking.dateBase = booking.date; booking.startAt = null; }
      if (!booking.dateBase || booking.dateBase < catalog.bookingCalendar.today || booking.dateBase > catalog.bookingCalendar.lastDate) booking.dateBase = booking.date;
      if (prefill.returnAppointmentId) { authMode = 'login'; await loadPayment(prefill.returnAppointmentId, Boolean(customer)); } else if (openOwnAppointments) { authMode = 'login'; await loadMine(); } else { render(); if (page === 'wizard' && booking.step === 3) await loadSlots(); }
      if (prefill.resetToken) showModal('Defina sua nova senha', '<form id="customer-reset"><label class="field"><span>Nova senha</span><input type="password" name="password" minlength="8" maxlength="128" autocomplete="new-password" required></label><label class="field"><span>Repita sua senha</span><input type="password" name="confirmation" minlength="8" maxlength="128" autocomplete="new-password" required></label><p role="alert" class="small"></p><button class="button" type="submit">Definir senha</button></form>');
    } catch (e) { root.innerHTML = `<main id="main" class="auth-wrap"><div class="card"><h1 tabindex="-1">Vamos preparar este espaço.</h1><p class="muted spaced">${esc(e.message)}</p><a class="button secondary spaced" href="/">Voltar para o início</a></div></main>`; }
  }
  boot();
})();
