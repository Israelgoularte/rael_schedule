'use strict';
(() => {
  let controller;
  const timeZoneNames = { 'America/Sao_Paulo': 'Brasília', 'America/Manaus': 'Manaus', 'America/Cuiaba': 'Cuiabá', 'America/Campo_Grande': 'Campo Grande', 'America/Porto_Velho': 'Porto Velho', 'America/Rio_Branco': 'Rio Branco', 'America/Boa_Vista': 'Boa Vista', 'America/Belem': 'Belém', 'America/Fortaleza': 'Fortaleza', 'America/Recife': 'Recife', 'America/Maceio': 'Maceió', 'America/Bahia': 'Bahia', 'America/Araguaina': 'Araguaína', 'America/Noronha': 'Fernando de Noronha' };
  const timeZoneLabel = zone => `Horário de ${timeZoneNames[zone] ?? zone.split('/').at(-1).replaceAll('_', ' ')}`;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => (n / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const metadataDetails = value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length ? `<details class="metadata-details note spaced"><summary>Metadados</summary><pre tabindex="0">${esc(JSON.stringify(value, null, 2))}</pre></details>` : '';
  const labels = { awaiting_payment: 'Aguardando pagamento', expired: 'Reserva expirada', confirmed: 'Confirmado', in_progress: 'Em atendimento', completed: 'Concluído', cancelled: 'Cancelado', no_show: 'Não compareceu' };
  const appointmentKind = a => a.snapshot.subscription ? 'plan' : 'ordinary';
  const appointmentKindLabel = a => a.snapshot.subscription ? 'Plano mensal' : 'Avulso';
  const button = (text, action, extra = '') => `<button type="button" class="button secondary small" data-action="agenda-${action}" ${extra}>${text}</button>`;
  const blockPeriodLabels = {
    available: { kind: 'free', label: 'Livre' },
    occupied: { kind: 'occupied', label: 'Ocupado' },
    blocked: { kind: 'blocked', label: 'Bloqueado' },
    break: { kind: 'break', label: 'Pausa' },
    outside: { kind: 'unavailable', label: 'Fora do expediente' },
  };
  function blockChoices(periods) {
    const minutes = clock => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
    const format = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    return periods
      .filter((period, index) => period.status !== 'outside' || (index > 0 && index < periods.length - 1))
      .flatMap(period => {
        if (period.status !== 'available') return [period];
        const slots = [];
        const start = minutes(period.startTime), end = period.endDate === period.startDate ? minutes(period.endTime) : 1440;
        for (let at = start; at < end; at += 30) {
          const last = at + 30 >= end;
          slots.push({ ...period, startTime: format(at), endTime: last ? period.endTime : format(at + 30), endDate: last ? period.endDate : period.startDate });
        }
        return slots;
      });
  }
  window.RaelAgenda = {
    unmount() { controller?.abort(); },
    async mount({ element, request, user, initialDate = '', onDateChange }) {
      controller?.abort(); controller = new AbortController(); const signal = controller.signal;
      const dialog = document.querySelector('#system-dialog');
      let state = null, catalog = null, filterDate = /^\d{4}-\d{2}-\d{2}$/.test(initialDate) ? initialDate : '', days = 1, professionalId = '', sequence = 0, error = '', modalState = null, sending = false;
      const dt = at => new Intl.DateTimeFormat('pt-BR', { timeZone: state.timeZone, dateStyle: 'short', timeStyle: 'short' }).format(at);
      const time = at => new Intl.DateTimeFormat('pt-BR', { timeZone: state.timeZone, hour: '2-digit', minute: '2-digit' }).format(at);
      const field = (label, name, value, type = 'text', attrs = '') => `<label class="field"><span>${label}</span><input name="${name}" type="${type}" value="${esc(value)}" ${attrs}></label>`;
      const modal = (title, body) => { dialog.innerHTML = `<button type="button" class="dialog-close" data-action="agenda-close" aria-label="Fechar">×</button><h2 id="dialog-title">${esc(title)}</h2>${body}`; if (!dialog.open) dialog.showModal(); };
      const timingId = a => `agenda-timing-${a.id}`;
      function statusButton(a, next, label) {
        const availableAt = a.startAt - (next === 'in_progress' ? 15 * 60000 : 0);
        const disabled = Date.now() < availableAt;
        return button(label, 'status', `data-id="${a.id}" data-status="${next}"${disabled ? ` disabled aria-describedby="${timingId(a)}" title="Disponível a partir de ${esc(dt(availableAt))}"` : ''}`);
      }
      function timingHint(a) {
        if (!['confirmed', 'in_progress'].includes(a.status) || Date.now() >= a.startAt) return '';
        return `<p class="small muted spaced" id="${timingId(a)}">${a.status === 'confirmed' ? `Iniciar fica disponível em ${esc(dt(a.startAt - 15 * 60000))}. ` : ''}Concluir${a.status === 'confirmed' ? ' ou registrar falta' : ''} fica disponível no início previsto, ${esc(dt(a.startAt))}. Use Atualizar quando chegar o horário.</p>`;
      }
      function render() {
        if (!state) { element.innerHTML = `<div class="loading">${esc(error || 'Carregando sua agenda…')}</div>`; return; }
        element.innerHTML = `<div class="agenda-heading"><div><div class="eyebrow">Atendimentos do negócio</div><h1>Agenda</h1><p class="muted spaced">${esc(state.businessName)} · ${esc(timeZoneLabel(state.timeZone))}</p></div><div class="row">${button('Novo agendamento', 'new')}${button('Bloquear horário', 'block')}</div></div><div class="agenda-filters card spaced"><label class="field"><span>Data</span><input type="date" id="agenda-date" value="${filterDate}"></label><label class="field"><span>Período</span><select id="agenda-days"><option value="1" ${days === 1 ? 'selected' : ''}>Um dia</option><option value="7" ${days === 7 ? 'selected' : ''}>Sete dias</option></select></label>${user.role !== 'professional' ? `<label class="field"><span>Profissional</span><select id="agenda-professional"><option value="">Todos os profissionais</option>${state.professionals.map(p => `<option value="${p.id}" ${professionalId === p.id ? 'selected' : ''}>${esc(p.name)}${p.active ? '' : ' (inativo)'}</option>`).join('')}</select></label>` : ''}${button('Atualizar', 'refresh')}</div>${error ? `<div class="note error spaced" role="alert">${esc(error)}</div>` : ''}${state.truncated ? '<div class="note warning spaced">Há muitos registros nesse período. Filtre por profissional e por dia para consultar os demais.</div>' : ''}<div class="agenda-count spaced">${state.appointments.filter(a => !['cancelled', 'expired'].includes(a.status)).length} atendimento(s) · ${state.blocks.length} bloqueio(s)</div><div class="agenda-legend" aria-label="Tipo de agendamento"><span class="agenda-legend-item agenda-type-ordinary">Avulso</span><span class="agenda-legend-item agenda-type-plan">Plano mensal</span></div><div class="booking-list">${state.appointments.map(a => `<article class="appointment-card agenda-appointment agenda-type-${appointmentKind(a)}"><div class="agenda-card-top"><div><div class="agenda-card-labels"><span class="badge ${a.status === 'confirmed' ? 'good' : ''}">${esc(labels[a.status])}</span><span class="agenda-kind">${appointmentKindLabel(a)}</span></div><h3>${esc(a.customer.name)}</h3><strong>${esc(dt(a.startAt))} · ${esc(time(a.endAt))}</strong></div><strong>${a.snapshot.subscription ? "Incluído no plano" : money(a.snapshot.service.priceCents)}</strong></div><p class="appointment-meta">${esc(a.snapshot.service.name)} · ${esc(a.snapshot.professional.name)}</p><div class="row">${button('Ver detalhes', 'details', `data-id="${a.id}"`)}${a.snapshot.requirePayment ? button('Ver pagamento', 'payment', `data-id="${a.id}"`) : ''}${a.status === 'confirmed' ? button('Remarcar', 'move', `data-id="${a.id}"`) + statusButton(a, 'in_progress', 'Iniciar') : ''}${['confirmed', 'in_progress'].includes(a.status) ? statusButton(a, 'completed', 'Concluir') + button('Cancelar', 'status', `data-id="${a.id}" data-status="cancelled"`) : ''}${a.status === 'awaiting_payment' ? button('Cancelar reserva', 'status', `data-id="${a.id}" data-status="cancelled"`) : ''}${a.status === 'confirmed' ? statusButton(a, 'no_show', 'Registrar falta') : ''}</div>${timingHint(a)}</article>`).join('') || '<div class="note">Nenhum atendimento neste período. Você pode mudar a data ou consultar sete dias.</div>'}</div><h2 class="spaced">Bloqueios de expediente</h2><div class="booking-list">${state.blocks.map(b => `<article class="appointment-card"><h3>${esc(b.reason)}</h3><p class="appointment-meta">${esc(state.professionals.find(p => p.id === b.professionalId)?.name)}<br>${esc(dt(b.startAt))} a ${esc(dt(b.endAt))}</p>${button('Remover bloqueio', 'unblock', `data-id="${b.id}"`)}</article>`).join('') || '<p class="muted small">Nenhum bloqueio neste período.</p>'}</div>`;
      }
      async function load() {
        const seq = ++sequence;
        try { const result = await request('agenda?' + new URLSearchParams({ days, ...(filterDate ? { date: filterDate } : {}), ...(professionalId ? { professionalId } : {}) })); if (signal.aborted || seq !== sequence) return; state = result; filterDate = result.date; onDateChange?.(filterDate); render(); }
        catch (e) { if (signal.aborted || seq !== sequence) return; error = e.message; render(); }
      }
      async function reservationForm(appointment = null) {
        if (!catalog) throw new Error('Publique os serviços na configuração guiada antes de agendar.');
        modalState = { appointment, quote: null, key: crypto.randomUUID(), slotsSeq: 0 };
        const proOptions = catalog.professionals.filter(p => (p.bookingAllowed || appointment?.snapshot.requirePayment && p.id === appointment.professionalId) && (user.role !== 'professional' || p.id === user.professionalId) && (!appointment?.snapshot.requirePayment || p.id === appointment.professionalId));
        const serviceOptions = catalog.services.filter(s => proOptions.some(p => s.professionalIds.includes(p.id)));
        if (!serviceOptions.length) throw new Error('Não há serviço disponível para o seu acesso. Confira os vínculos e a regra de recebimento na configuração.');
        modal(appointment ? 'Remarcar atendimento' : 'Novo agendamento', `<form id="agenda-reservation"><label class="field"><span>Serviço</span><select name="serviceId" ${appointment ? 'disabled' : ''}>${serviceOptions.map(s => `<option value="${s.id}" ${appointment?.serviceId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label><label class="field"><span>Profissional</span><select name="professionalId">${proOptions.map(p => `<option value="${p.id}" ${appointment?.professionalId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>${field('Data', 'date', filterDate < catalog.bookingCalendar.today ? catalog.bookingCalendar.today : filterDate, 'date', `min="${catalog.bookingCalendar.today}" max="${catalog.bookingCalendar.lastDate}" required`)}<label class="field"><span>Horário disponível</span><select name="startAt" required><option value="">Consultando…</option></select></label><p id="agenda-quote" class="note"></p>${!appointment ? `${field('Nome do cliente', 'name', '', 'text', 'minlength="2" maxlength="120" autocomplete="name" required')}${field('WhatsApp com DDD', 'phone', '', 'tel', 'maxlength="25" autocomplete="tel" required')}${field('E-mail do cliente', 'email', '', 'email', 'maxlength="254" autocomplete="email" required')}<p class="small muted">O cadastro feito pela equipe não libera acesso automático ao cliente. O administrador pode gerar um link pessoal após conferir a identidade.</p>` : '<p class="small muted">Valor e duração originais serão mantidos. O horário anterior só será liberado se a remarcação for confirmada.</p>'}<p id="agenda-form-error" class="small note error spaced" role="alert" hidden></p><button class="button full spaced" type="submit" disabled>Confirmar ${appointment ? 'remarcação' : 'agendamento'}</button></form>`);
        await updateSlots();
      }
      async function updateSlots() {
        const form = dialog.querySelector('#agenda-reservation'); if (!form || !modalState) return;
        const reservation = modalState, seq = ++reservation.slotsSeq, serviceId = reservation.appointment?.serviceId ?? form.elements.serviceId.value, selectedProfessional = form.elements.professionalId.value;
        reservation.quote = null;
        const isCurrent = () => !signal.aborted && modalState === reservation && seq === reservation.slotsSeq && dialog.open && dialog.querySelector('#agenda-reservation') === form;
        const eligible = catalog.professionals.filter(p => (p.bookingAllowed || modalState.appointment?.snapshot.requirePayment && p.id === modalState.appointment.professionalId) && (user.role !== 'professional' || p.id === user.professionalId) && catalog.services.find(s => s.id === serviceId)?.professionalIds.includes(p.id) && (!modalState.appointment?.snapshot.requirePayment || p.id === modalState.appointment.professionalId));
        form.elements.professionalId.innerHTML = eligible.map(p => `<option value="${p.id}" ${p.id === selectedProfessional ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
        const data = Object.fromEntries(new FormData(form)), slotSelect = form.elements.startAt;
        const submit = form.querySelector('[type=submit]'); submit.disabled = true;
        try {
          const result = await request('agenda/availability?' + new URLSearchParams({ serviceId: modalState.appointment?.serviceId ?? data.serviceId, professionalId: data.professionalId ?? '', date: data.date, ...(modalState.appointment ? { appointmentId: modalState.appointment.id } : {}) }));
          if (!isCurrent()) return;
          reservation.quote = result.quote;
          slotSelect.innerHTML = result.slots.map(s => `<option value="${s.startAt}">${esc(s.time)}</option>`).join('') || '<option value="">Nenhum horário neste dia</option>';
          form.querySelector('#agenda-quote').textContent = `${money(result.quote.priceCents)} · ${result.quote.durationMinutes} minutos · ${timeZoneLabel(result.timeZone)}${result.quote.requiresPayment ? ' · pagamento pelo Mercado Pago, recebedor: ' + result.quote.receiver?.name : ' · pagamento no atendimento'}`;
          submit.disabled = !result.slots.length;
        } catch (e) { if (!isCurrent()) return; slotSelect.innerHTML = '<option value="">Escolha outro dia ou profissional</option>'; form.querySelector('#agenda-quote').textContent = e.message; }
      }
      async function updateBlockPreview(form) {
        const preview = modalState;
        if (!preview || preview.kind !== 'block') return;
        const seq = ++preview.previewSeq;
        const { professionalId, startDate } = form.elements;
        const timeline = form.querySelector('#agenda-block-timeline');
        const retry = form.querySelector('#agenda-block-retry');
        preview.date = startDate.value;
        preview.slots = [];
        clearBlockSelection(form);
        retry.hidden = true;
        timeline.setAttribute('aria-busy', 'false');
        if (!professionalId.value || !startDate.value || !startDate.validity.valid) {
          timeline.textContent = 'Escolha o profissional e a data inicial para ver os horários.';
          return;
        }
        timeline.setAttribute('aria-busy', 'true');
        timeline.textContent = 'Consultando horários…';
        const isCurrent = () => !signal.aborted && modalState === preview && seq === preview.previewSeq && dialog.open && form.isConnected;
        try {
          const result = await request('agenda/block-preview?' + new URLSearchParams({ professionalId: professionalId.value, date: startDate.value }));
          if (!isCurrent()) return;
          const clockChange = result.clockChange === true;
          const periods = result.periods;
          const slots = clockChange ? periods : blockChoices(periods);
          preview.slots = clockChange ? [] : slots;
          const items = slots.map((slot, index) => {
            const { kind, label } = blockPeriodLabels[slot.status];
            const end = slot.endDate !== slot.startDate && slot.endTime === '00:00' ? '24:00' : slot.endTime;
            const content = `<strong>${esc(slot.startTime)}–${esc(end)}</strong><span>${label}</span>`;
            return `<li>${slot.status === 'available' && !clockChange
              ? `<button type="button" class="agenda-block-slot" data-kind="${kind}" data-action="agenda-block-slot" data-index="${index}" aria-pressed="false">${content}</button>`
              : `<div class="agenda-block-slot" data-kind="${kind}">${content}</div>`}</li>`;
          });
          const note = clockChange ? '<p class="note">O relógio muda nesta data. Preencha o período manualmente nos campos abaixo.</p>' : '';
          timeline.innerHTML = note + (items.length ? `<ul class="agenda-block-slots">${items.join('')}</ul>` : '<p>Sem expediente neste dia.</p>');
        } catch {
          if (!isCurrent()) return;
          timeline.textContent = 'Não foi possível consultar os horários. Você pode tentar novamente ou preencher o período abaixo.';
          retry.hidden = false;
        } finally {
          if (isCurrent()) timeline.setAttribute('aria-busy', 'false');
        }
      }
      function clearBlockSelection(form) {
        modalState.anchor = null;
        for (const tile of form.querySelectorAll('[aria-pressed="true"]')) tile.setAttribute('aria-pressed', 'false');
        form.querySelector('#agenda-block-selection').textContent = '';
        form.querySelector('#agenda-block-clear').hidden = true;
      }
      function selectBlockSlot(form, index) {
        const preview = modalState;
        if (!preview || preview.kind !== 'block' || preview.slots[index]?.status !== 'available') return;
        const anchor = preview.anchor ?? index;
        let first = Math.min(anchor, index), last = Math.max(anchor, index);
        if (preview.slots.slice(first, last + 1).some(slot => slot.status !== 'available')) {
          first = index;
          last = index;
          preview.anchor = index;
        } else {
          preview.anchor = anchor;
        }
        const start = preview.slots[first], end = preview.slots[last];
        form.elements.startDate.value = start.startDate;
        form.elements.startTime.value = start.startTime;
        form.elements.endDate.value = end.endDate;
        form.elements.endTime.value = end.endTime;
        for (const tile of form.querySelectorAll('[data-action="agenda-block-slot"]')) {
          const tileIndex = Number(tile.dataset.index);
          tile.setAttribute('aria-pressed', String(tileIndex >= first && tileIndex <= last));
        }
        const endLabel = end.endDate !== start.startDate ? `${end.endTime} do dia seguinte` : end.endTime;
        form.querySelector('#agenda-block-selection').textContent = `Selecionado: ${start.startTime} a ${endLabel}.`;
        form.querySelector('#agenda-block-clear').hidden = false;
        form.querySelector('#agenda-form-error').hidden = true;
      }
      async function click(e) {
        const target = e.target.closest('[data-action^="agenda-"]'); if (!target || target.disabled || sending) return;
        e.stopPropagation(); const action = target.dataset.action.slice(7);
        try {
          error = '';
          if (action === 'close') { dialog.close(); modalState = null; return; }
          if (action === 'refresh') { await load(); return; }
          if (action === 'new') { await reservationForm(); return; }
          if (action === 'move') { await reservationForm(state.appointments.find(a => a.id === target.dataset.id)); return; }
          if (action === 'details') {
            const a = state.appointments.find(x => x.id === target.dataset.id);
            modal('Detalhes do atendimento', `<h3>${esc(a.snapshot.service.name)}</h3><p class="spaced">${esc(a.customer.name)}<br>${esc(a.customer.phone)}<br>${esc(a.customer.email)}</p><p class="spaced">${esc(dt(a.startAt))} · ${esc(a.snapshot.professional.name)}<br>${a.snapshot.subscription ? "Incluído no plano" : money(a.snapshot.service.priceCents)} · ${esc(labels[a.status])}</p><p class="spaced"><a href="${location.pathname}/financeiro?atendimento=${a.id}">Ver recebimentos e estimativa</a></p><p class="small muted spaced">${a.snapshot.subscription ? `Incluído no plano ${esc(a.snapshot.subscription.planName)}. Uma unidade foi reservada neste ciclo.` : a.snapshot.requirePayment ? 'Este agendamento possui recebimento pelo Mercado Pago. Consulte Ver pagamento para conferir.' : 'Pagamento a combinar no atendimento; nenhuma cobrança foi gerada.'}</p>${metadataDetails(a.metadata)}${user.role === 'admin' ? `<hr class="spaced"><h3 class="spaced">Acesso do cliente</h3><p class="small muted spaced">Gere uma recuperação somente após conferir a identidade diretamente com o cliente.</p><label class="check-line"><input type="checkbox" id="identity-checked">Conferi a identidade do cliente</label>${button('Gerar link pessoal', 'recover', `data-customer="${a.customerId}"`)}` : ''}`); return;
          }
          if (action === 'payment' || action === 'payment-refresh') { const id = target.dataset.id; const p = await request(action === 'payment' ? 'agenda/payment?appointmentId=' + encodeURIComponent(id) : 'agenda/payment-refresh', action === 'payment' ? {} : { method: 'POST', body: JSON.stringify({ appointmentId: id }) }); modal('Pagamento do atendimento', window.RaelPayment.panel(p, state.timeZone, 'agenda-', true)); return; }
          if (action === 'pay') { target.disabled = true; const p = await request('agenda/checkout', { method: 'POST', body: JSON.stringify({ appointmentId: target.dataset.id }) }); const url = window.RaelPayment.safeRedirect(p.url); modal('Link de pagamento do cliente', `<p>Compartilhe diretamente com o cliente deste atendimento. A reserva só será confirmada após a aprovação; nenhum e-mail foi enviado.</p><a class="share-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a><p class="small muted">Confira o recebedor antes de pagar.</p>`); return; }
          if (action === 'recover') {
            if (!dialog.querySelector('#identity-checked')?.checked) throw new Error('Confira a identidade e marque a confirmação antes de gerar o link.');
            const result = await request('agenda/customer-recovery', { method: 'POST', body: JSON.stringify({ customerId: target.dataset.customer, identityConfirmed: true }) });
            modal('Link pessoal do cliente', `<p>Compartilhe diretamente com o cliente identificado. Válido por 30 minutos e de uso único. Nenhum e-mail foi enviado.</p><a class="share-link" href="${esc(result.url)}" target="_blank" rel="noopener noreferrer">${esc(result.url)}</a>`); return;
          }
          if (action === 'status') {
            const a = state.appointments.find(x => x.id === target.dataset.id), status = target.dataset.status;
            modal(`Alterar para ${labels[status].toLowerCase()}?`, `<p>${esc(a.customer.name)} · ${esc(a.snapshot.service.name)}<br>${esc(dt(a.startAt))}</p>${status === 'cancelled' && a.snapshot.requirePayment ? '<p class="note warning spaced">Cancelar libera o horário, mas não reembolsa o pagamento automaticamente. Confira e resolva o valor na conta Mercado Pago do profissional.</p>' : ''}<div class="row spaced">${button('Voltar', 'close')}${button('Confirmar alteração', 'confirm-status', `data-id="${a.id}" data-status="${status}"`)}</div>`); return;
          }
          if (action === 'confirm-status') { const a = state.appointments.find(x => x.id === target.dataset.id); target.disabled = true; await request('agenda/status', { method: 'POST', body: JSON.stringify({ appointmentId: a.id, revision: a.revision, status: target.dataset.status }) }); dialog.close(); await load(); return; }
          if (action === 'block') {
            modalState = { kind: 'block', previewSeq: 0, slots: [], anchor: null };
            const professionals = state.professionals.filter(p => p.active);
            const preferred = professionalId || user.professionalId;
            const options = professionals.map(p => `<option value="${esc(p.id)}"${p.id === preferred ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
            const legend = Object.values(blockPeriodLabels).map(({kind, label}) => `<span data-kind="${kind}">${label}</span>`).join('');
            modal('Bloquear expediente', `<form id="agenda-block">
              <div class="grid2"><label class="field"><span>Profissional</span><select name="professionalId" required>${options || '<option value="">Nenhum profissional ativo</option>'}</select></label>
              ${field('Data inicial', 'startDate', filterDate, 'date', 'required')}</div>
              <section class="agenda-block-preview" aria-labelledby="agenda-block-preview-title">
                <div class="agenda-block-preview-heading"><h3 id="agenda-block-preview-title">Horários do dia</h3><p class="small muted">Selecione um horário livre. Para ampliar o período, escolha outro horário livre da mesma faixa.</p></div>
                <div class="agenda-block-legend" aria-label="Legenda dos horários">${legend}</div>
                <div id="agenda-block-timeline" class="small" aria-live="polite"></div>
                <button type="button" id="agenda-block-retry" class="text-button" data-action="agenda-block-retry" hidden>Tentar novamente</button>
                <div class="agenda-block-controls"><p class="agenda-block-selection small" id="agenda-block-selection" role="status"></p>
                <button type="button" id="agenda-block-clear" class="text-button" data-action="agenda-block-clear" hidden>Limpar seleção</button></div>
              </section>
              <div class="grid2">${field('Hora inicial', 'startTime', '09:00', 'time', 'required')}${field('Hora final', 'endTime', '18:00', 'time', 'required')}${field('Data final', 'endDate', filterDate, 'date', 'required')}</div>
              ${field('Motivo', 'reason', '', 'text', 'minlength="2" maxlength="200" placeholder="Folga, férias ou compromisso" required')}
              <p class="small muted">Você pode ajustar o período nos campos acima, inclusive para bloquear vários dias. Se houver um atendimento no período, remarque ou cancele antes de bloquear.</p>
              <p class="note error spaced" id="agenda-form-error" role="alert" hidden></p><button type="submit" class="button full spaced">Salvar bloqueio</button></form>`);
            await updateBlockPreview(dialog.querySelector('#agenda-block')); return;
          }
          if (action === 'block-slot') { selectBlockSlot(target.form, Number(target.dataset.index)); return; }
          if (action === 'block-clear') {
            const form = target.form;
            clearBlockSelection(form);
            form.elements.startTime.value = '';
            form.elements.endTime.value = '';
            form.querySelector('[data-action="agenda-block-slot"]')?.focus();
            return;
          }
          if (action === 'block-retry') { await updateBlockPreview(target.form); return; }
          if (action === 'unblock') { modal('Liberar esse expediente?', `<p>O período voltará a aceitar agendamentos conforme as demais regras do negócio.</p><div class="row spaced">${button('Voltar', 'close')}${button('Remover bloqueio', 'confirm-unblock', `data-id="${target.dataset.id}"`)}</div>`); return; }
          if (action === 'confirm-unblock') { target.disabled = true; await request('agenda/unblock', { method: 'POST', body: JSON.stringify({ id: target.dataset.id }) }); dialog.close(); await load(); return; }
        } catch (err) { error = err.message; if (dialog.open) { let el = dialog.querySelector('#agenda-action-error'); if (!el) { el = document.createElement('p'); el.id = 'agenda-action-error'; el.className = 'note error spaced'; el.setAttribute('role', 'alert'); dialog.append(el); } el.textContent = error; target.disabled = false; } else render(); }
      }
      element.addEventListener('click', click, { signal }); dialog.addEventListener('click', click, { signal });
      dialog.addEventListener('close', () => { if (!dialog.open) modalState = null; }, { signal });
      element.addEventListener('change', async e => { if (e.target.id === 'agenda-date') filterDate = e.target.value; else if (e.target.id === 'agenda-days') days = Number(e.target.value); else if (e.target.id === 'agenda-professional') professionalId = e.target.value; else return; error = ''; await load(); }, { signal });
      dialog.addEventListener('change', async e => {
        const { form, name } = e.target;
        if (form?.id === 'agenda-reservation' && ['serviceId', 'professionalId', 'date'].includes(name)) await updateSlots();
        if (form?.id !== 'agenda-block' || modalState?.kind !== 'block') return;
        if (['professionalId', 'startDate'].includes(name)) {
          if (name === 'startDate' && (form.elements.endDate.value === modalState.date || form.elements.endDate.value < e.target.value)) form.elements.endDate.value = e.target.value;
          await updateBlockPreview(form);
        } else if (['startTime', 'endTime', 'endDate'].includes(name)) {
          clearBlockSelection(form);
        }
      }, { signal });
      dialog.addEventListener('submit', async e => {
        if (!['agenda-reservation', 'agenda-block'].includes(e.target.id)) return;
        e.preventDefault(); e.stopPropagation(); if (sending) return;
        const data = Object.fromEntries(new FormData(e.target)), submit = e.target.querySelector('[type=submit]'); sending = true; submit.disabled = true;
        try {
          if (e.target.id === 'agenda-block') { await request('agenda/block', { method: 'POST', body: JSON.stringify(data) }); filterDate = data.startDate; if (professionalId) professionalId = data.professionalId; }
          else {
            if (!modalState?.quote || !e.target.elements.startAt.value) throw new Error('Escolha um horário disponível antes de confirmar.');
            const a = modalState.appointment;
            const payload = { professionalId: data.professionalId, startAt: Number(data.startAt), quote: modalState.quote.signature, idempotencyKey: modalState.key, ...(a ? { appointmentId: a.id, revision: a.revision } : { serviceId: data.serviceId, customer: { name: data.name, phone: data.phone, email: data.email } }) };
            const result = await request(a ? 'agenda/reschedule' : 'agenda/reserve', { method: 'POST', body: JSON.stringify(payload) });
            filterDate = data.date;
            if (professionalId) professionalId = result.appointment.professionalId ?? data.professionalId;
            if (result.appointment.status === 'awaiting_payment') { const p = await request('agenda/payment?appointmentId=' + result.appointment.id); modalState = null; await load(); modal('Reserva aguardando pagamento', window.RaelPayment.panel(p, state.timeZone, 'agenda-', true)); return; }
          }
          dialog.close(); modalState = null; await load();
        } catch (err) {
          const box = e.target.querySelector('#agenda-form-error'); box.hidden = false; box.textContent = err.message;
          if (err.status === 409 && e.target.id === 'agenda-block') await updateBlockPreview(e.target);
          else if (err.status === 409 && modalState) { modalState.key = crypto.randomUUID(); await updateSlots(); }
        }
        finally { sending = false; if (submit.isConnected) submit.disabled = e.target.id === 'agenda-reservation' && !e.target.elements.startAt.value; }
      }, { signal });
      catalog = await request('catalog').catch(() => null); await load();
    },
  };
})();
