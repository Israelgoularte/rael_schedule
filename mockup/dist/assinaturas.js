'use strict';
(() => {
  const root = document.querySelector('#subscriptions-root'), dialog = document.querySelector('#subscription-dialog');
  const parts = location.pathname.split('/').filter(Boolean), staffMode = parts[0] === 'sistema', slug = parts[1], managementView = staffMode;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = v => (v / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const button = (text, action, extra = '', secondary = false) => `<button type="button" class="button ${secondary ? 'secondary' : ''}" data-sub-action="${action}" ${extra}>${text}</button>`;
  let operationsAvailable = false, sessionBusinessName = '', recoveryEmail = false;
  let catalog, plans = [], memberships = [], user = null, csrf = '', testMode = false, error = '', notice = '', busy = false, selected = '', acceptedOffer = '', authRegister = true, setup, requestKey = crypto.randomUUID(), receiptDraft = null;
  const authFields = { name: '', phone: '', email: '' }, planFields = { name: '', price: '', billingMethod: 'mercadopago', paymentInstructions: '', externalPaymentUrl: '', scope: 'professional' };
  let planRows = [{ serviceId: '', units: '1' }], creationOpen = false, editingPlan = null, managementCanCreate = false, managementCanCreateBusiness = false, receivingMode = 'professional';
  let withdrawalDraft = null;
  let payerChoice = { mode: 'account', email: '' };
  const payerAttempts = new Map();
  const payerEmailError = 'Informe um e-mail válido para o pagamento, com até 254 caracteres.';
  const normalizedPayerEmail = value => String(value ?? '').trim().toLowerCase();
  const validPayerEmail = value => typeof value === 'string' && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value) && normalizedPayerEmail(value).length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedPayerEmail(value));
  function resetPayerChoice() { payerChoice = { mode: 'account', email: '' }; payerAttempts.clear(); acceptedOffer = ''; requestKey = crypto.randomUUID(); }
  const businessPlan = p => p?.scope === 'business';
  const planResponsibility = p => businessPlan(p) ? 'Plano do negócio · qualquer profissional habilitado' : p.professionalName;
  const canCreateAnyPlan = () => managementCanCreate || managementCanCreateBusiness;
  function editorServices() {
    if (planFields.scope !== 'business') return (setup?.draft?.services ?? setup?.services ?? []).filter(s => s.online && s.professionalIds?.includes(user?.professionalId));
    const published = setup?.published, active = new Set((setup?.draft?.professionals ?? []).filter(p => p.active).map(p => p.id));
    const enabled = new Set((published?.professionals ?? []).filter(p => active.has(p.id)).map(p => p.id));
    return (published?.services ?? []).filter(s => s.online && s.professionalIds?.some(id => enabled.has(id)));
  }
  function billingHelp(isManual, business = planFields.scope === 'business') {
    return isManual ? 'Você confirma o recebimento e a validade de cada período. Não exige conexão com o Mercado Pago.' : business || receivingMode === 'business' ? 'As mensalidades são recebidas na conta do negócio configurada pelo gestor. A aceitação do valor depende do Mercado Pago.' : 'Cada plano pertence ao seu perfil e à sua conta recebedora. A aceitação do valor depende do Mercado Pago.';
  }
  const servicesOf = p => Array.isArray(p.services) && p.services.length ? p.services : [{ serviceId: p.serviceId, serviceName: p.serviceName, units: p.units }];
  const totalUnits = p => servicesOf(p).reduce((sum, item) => sum + Number(item.units || 0), 0);
  const composition = p => `<ul class="plan-composition">${servicesOf(p).map(item => `<li><strong>${item.units}×</strong> ${esc(item.serviceName)} por mês</li>`).join('')}</ul>`;
  function serviceBalances(s) {
    const balances = s.cycle?.services ?? servicesOf(s).map(item => ({ ...item, used: s.cycle?.used ?? 0, remaining: s.cycle?.remaining ?? 0 }));
    return `<ul class="plan-service-balances">${balances.map(item => `<li><strong>${esc(item.serviceName)}</strong><span>Disponível este mês: <strong>${item.remaining}</strong> de ${item.units}</span><small>${item.used} utilizado(s) ou reservado(s)${item.remaining === 0 ? ' · Plano mensal esgotado' : ''}</small></li>`).join('')}</ul>`;
  }
  let managementPlanId = '', managementMemberId = '', managementOverview = null, managementMembers = null, managementSequence = 0, managementLoading = false, managementProfessionals = [];
  const overviewDefaults = { search: '', professionalId: '', billingMethod: '', visibility: '', sort: 'active_desc', page: 1, pageSize: 12 };
  const membersDefaults = { search: '', status: '', sort: 'name_asc', page: 1, pageSize: 20 };
  const overviewFilters = { ...overviewDefaults }, memberFilters = { ...membersDefaults }, overviewDraft = { ...overviewDefaults }, memberDraft = { ...membersDefaults };
  const managementStates = { active: 'Ativa', pending: 'Pagamento pendente', expired: 'Período vencido', suspended: 'Suspensa', ended: 'Encerrada', review: 'Precisa de conferência' };
  const selectOptions = (options, value) => options.map(([key, label]) => `<option value="${esc(key)}" ${String(value) === String(key) ? 'selected' : ''}>${esc(label)}</option>`).join('');
  const compositionBrief = p => { const items = servicesOf(p), brief = items.slice(0, 3).map(item => `${item.units}× ${item.serviceName}`).join(' · '); return esc(brief + (items.length > 3 ? ` · +${items.length - 3} serviço(s)` : '')); };
  const activeCustomerLabel = p => `${Number(p.activeCustomers ?? 0)} ${Number(p.activeCustomers) === 1 ? 'cliente ativo' : 'clientes ativos'}`;
  const totalCustomerLabel = p => `${Number(p.totalCustomers ?? 0)} ${Number(p.totalCustomers) === 1 ? 'cliente ao todo' : 'clientes ao todo'}`;
  function managementFilterPanel(form, filters, defaults) {
    const applied = Object.keys(defaults).some(key => !['page', 'pageSize'].includes(key) && String(filters[key]) !== String(defaults[key]));
    return `<details class="management-filter-panel" ${window.matchMedia?.('(max-width:720px)')?.matches ? '' : 'open'}><summary>Filtros e ordenação${applied ? '<span class="badge">Seleção aplicada</span>' : ''}</summary>${form}</details>`;
  }
  function managementPager(result, level) {
    const page = Number(result.page ?? 1), pageSize = Number(result.pageSize ?? (level === 'plan' ? 12 : 20)), total = Number(result.total ?? 0);
    if (!total) return '';
    return `<nav class="management-pagination" aria-label="Paginação de ${level === 'plan' ? 'planos' : 'clientes'}"><span>${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} de ${total}</span><div class="row">${button('Anterior', `management-${level}-page`, `data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}`, true)}<span>Página ${page}</span>${button('Próxima', `management-${level}-page`, `data-page="${page + 1}" ${result.hasMore ? '' : 'disabled'}`, true)}</div></nav>`;
  }
  function managementPlanFilters() {
    return `<form id="management-plan-filters" class="management-filters card"><label class="field management-search"><span>Buscar plano</span><input name="search" type="search" maxlength="100" placeholder="Nome do plano ou serviço" value="${esc(overviewDraft.search)}"></label>${user.role === 'admin' ? `<label class="field"><span>Profissional</span><select name="professionalId">${selectOptions([['', 'Todos os profissionais'], ...managementProfessionals.map(p => [p.id, p.name])], overviewDraft.professionalId)}</select></label>` : ''}<label class="field"><span>Recebimento</span><select name="billingMethod">${selectOptions([['', 'Todos'], ['manual', 'Manual'], ['mercadopago', 'Mercado Pago']], overviewDraft.billingMethod)}</select></label><label class="field"><span>Visibilidade</span><select name="visibility">${selectOptions([['', 'Todos'], ['visible', 'Visível'], ['hidden', 'Oculto']], overviewDraft.visibility)}</select></label><label class="field"><span>Ordenar por</span><select name="sort">${selectOptions([['active_desc', 'Mais clientes ativos'], ['name_asc', 'Nome: A a Z'], ['name_desc', 'Nome: Z a A'], ['price_asc', 'Menor mensalidade'], ['price_desc', 'Maior mensalidade'], ['newest', 'Mais recentes']], overviewDraft.sort)}</select></label><div class="management-filter-actions"><button type="submit" class="button" ${busy ? 'disabled' : ''}>Filtrar</button>${button('Limpar filtros', 'reset-plan-filters', '', true)}</div></form>`;
  }
  function managementMemberFilters() {
    return `<form id="management-member-filters" class="management-filters management-member-filters card"><label class="field management-search"><span>Buscar cliente</span><input name="search" type="search" maxlength="100" placeholder="Nome ou e-mail do cliente" value="${esc(memberDraft.search)}"></label><label class="field"><span>Situação</span><select name="status">${selectOptions([['', 'Todas as situações'], ...Object.entries(managementStates)], memberDraft.status)}</select></label><label class="field"><span>Ordenar por</span><select name="sort">${selectOptions([['name_asc', 'Nome: A a Z'], ['name_desc', 'Nome: Z a A'], ['expires_asc', 'Vencimento mais próximo'], ['newest', 'Mais recentes'], ['status', 'Situação']], memberDraft.sort)}</select></label><div class="management-filter-actions"><button type="submit" class="button" ${busy ? 'disabled' : ''}>Filtrar</button>${button('Limpar filtros', 'reset-member-filters', '', true)}</div></form>`;
  }
  const editablePlan = id => plans.find(p => p.id === id) ?? (managementMembers?.plan?.id === id ? managementMembers.plan : null);
  function planActions(p) { return `<div class="management-plan-edit-actions">${p.canEdit === true ? button('Editar plano', 'edit-plan', `data-id="${esc(p.id)}"`, true) : ''}${p.canToggle === true ? button(p.active ? 'Inativar plano' : 'Ativar plano', 'plan-status', `data-id="${esc(p.id)}"`, true) : ''}</div>`; }
  function resetPlanEditor() { editingPlan = null; creationOpen = false; planRows = [{ serviceId: '', units: '1' }]; Object.assign(planFields, { name: '', price: '', billingMethod: 'mercadopago', paymentInstructions: '', externalPaymentUrl: '', scope: 'professional' }); }
  function fillPlanEditor(p) { editingPlan = { id: p.id, revision: p.revision, active: Boolean(p.active), scope: p.scope ?? 'professional' }; creationOpen = true; planRows = servicesOf(p).map(item => ({ serviceId: item.serviceId, units: String(item.units) })); Object.assign(planFields, { name: p.name, price: (p.priceCents / 100).toFixed(2), billingMethod: p.billingMethod ?? 'mercadopago', paymentInstructions: p.paymentInstructions ?? '', externalPaymentUrl: p.externalPaymentUrl ?? '', scope: p.scope ?? 'professional' }); }
  function managementPlanRow(p) {
    return `<article class="management-plan-row"><div class="management-plan-summary"><h2>${esc(p.name)}</h2><p class="management-composition">${compositionBrief(p)}</p><p class="small muted">${esc(planResponsibility(p))} · ${manual(p) ? 'Recebimento manual' : 'Mercado Pago'}</p><span class="badge">${p.active ? 'Visível para novas adesões' : 'Oculto para novas adesões'}</span></div><div class="management-plan-count"><strong>${activeCustomerLabel(p)}</strong><span>${totalCustomerLabel(p)}</span><small>${Number(p.totalSubscriptions ?? 0)} assinatura(s)</small></div><div class="management-plan-price"><strong>${money(p.priceCents)}</strong><span>/mês</span></div><div class="management-plan-actions">${button('Ver clientes', 'manage-plan', `data-id="${esc(p.id)}"`, true)}${planActions(p)}</div></article>`;
  }
  function managementMemberRow(s) {
    const status = s.managementStatus ?? (s.resolution ? 'review' : s.state === 'suspended' ? 'suspended' : s.canUse && s.cycle ? 'active' : s.state === 'cancelled' ? 'ended' : s.latestCycleEndAt ? 'expired' : 'pending');
    const validity = s.cycle ? `Até ${date(s.cycle.endAt)}` : s.latestCycleEndAt ? `Venceu em ${date(s.latestCycleEndAt)}` : 'Período não iniciado';
    return `<tr><td data-label="Cliente"><strong>${esc(s.customerName)}</strong>${s.customerEmail ? `<small>${esc(s.customerEmail)}</small>` : ''}</td><td data-label="Situação"><span class="badge ${status === 'active' ? 'good' : ''}">${esc(managementStates[status] ?? 'Em conferência')}</span></td><td data-label="Validade">${esc(validity)}</td><td data-label="Saldo">${s.cycle ? `${Number(s.cycle.remaining ?? 0)} de ${totalUnits(s)} atendimento(s)` : 'Sem saldo liberado'}</td><td class="management-member-action">${button('Ver assinatura', 'manage-member', `data-id="${esc(s.id)}"`, true)}</td></tr>`;
  }
  function managementContent() {
    if (!managementPlanId) {
      return `<section id="my-plans" class="plan-management" tabindex="-1" aria-label="Planos e clientes">${managementFilterPanel(managementPlanFilters(), overviewFilters, overviewDefaults)}<div class="management-list-heading"><h2>Planos do negócio</h2><span class="small muted">${Number(managementOverview?.total ?? 0)} plano(s) encontrado(s)</span></div><div class="management-plan-list">${(managementOverview?.plans ?? []).map(managementPlanRow).join('') || `<div class="note">${managementLoading ? 'Consultando planos…' : managementOverview ? 'Nenhum plano corresponde aos filtros. Ajuste a busca ou use Criar plano para preparar sua primeira oferta.' : 'Não foi possível carregar os planos.'}</div>`}</div>${managementOverview ? managementPager(managementOverview, 'plan') : managementLoading ? '' : button('Tentar novamente', 'management-reload', '', true)}</section>`;
    }
    const p = managementMembers?.plan;
    if (!p) return `<section id="my-plans" class="plan-management" tabindex="-1">${button('← Voltar aos planos', 'back-plan-list', '', true)}<div class="note spaced">${managementLoading ? 'Consultando clientes deste plano…' : 'Não foi possível carregar os clientes deste plano.'}</div>${managementLoading ? '' : button('Tentar novamente', 'management-reload', '', true)}</section>`;
    const selectedMember = memberships.find(s => s.id === managementMemberId);
    return `<section id="my-plans" class="plan-management" tabindex="-1"><div class="management-plan-heading">${button('← Voltar aos planos', 'back-plan-list', '', true)}<div><h2>${esc(p.name)}</h2><p class="small muted">${money(p.priceCents)}/mês · ${esc(planResponsibility(p))} · ${manual(p) ? 'Recebimento manual' : 'Mercado Pago'}</p></div><div class="management-plan-count"><strong>${activeCustomerLabel(p)}</strong><span>${totalCustomerLabel(p)}</span></div></div>${!selectedMember ? planActions(p) : ''}${selectedMember ? `<div class="management-member-detail">${button('← Voltar aos clientes', 'back-members', '', true)}${membershipCard(selectedMember)}</div>` : `<details class="management-plan-composition"><summary>Ver serviços incluídos no plano</summary>${composition(p)}</details>${managementFilterPanel(managementMemberFilters(), memberFilters, membersDefaults)}<div class="management-list-heading"><h2>Clientes deste plano</h2><span class="small muted">${Number(managementMembers.total ?? 0)} assinatura(s) encontrada(s)</span></div><div class="management-table-wrap"><table class="management-member-table"><thead><tr><th scope="col">Cliente</th><th scope="col">Situação</th><th scope="col">Validade</th><th scope="col">Saldo total</th><th scope="col"><span class="sr-only">Ações</span></th></tr></thead><tbody>${memberships.map(managementMemberRow).join('')}</tbody></table></div>${!memberships.length ? '<div class="note">Nenhum cliente corresponde aos filtros deste plano.</div>' : ''}${managementPager(managementMembers, 'member')}`}</section>`;
  }
  const states = { pending: 'Aguardando autorização', authorized: 'Renovação autorizada', paused: 'Renovação pausada', cancelled: 'Renovação cancelada' };
  const manualStates = { pending: 'Aguardando confirmação do recebimento', authorized: 'Período ativo', suspended: 'Uso suspenso pelo prestador', cancelled: 'Assinatura encerrada' };
  const manual = p => p.billingMethod === 'manual' || p.mode === 'manual';
  const managesManual = s => staffMode && (s.canManageManual ?? (businessPlan(s) ? false : user?.role === 'admin' || user?.professionalId === s.professionalId));
  const centralReceiving = s => businessPlan(s) || s.receivingMode === 'business';
  const canRefresh = s => s.canRefresh ?? (!staffMode || !centralReceiving(s));
  const managesAutomatic = s => staffMode && (s.canManageAutomatic ?? (!centralReceiving(s) && user?.professionalId === s.professionalId));
  const offerConsentKey = p => p ? JSON.stringify([p.id, p.checkoutRevision ?? p.revision, p.name, p.priceCents, p.billingMethod, p.scope, p.professionalId, p.receivingMode, p.receiver?.id, servicesOf(p)]) : '';
  const withdrawnCreation = s => s?.creation?.withdrawn === true;
  const currentPayerMembership = planId => memberships.find(s => s.planId === planId && !manual(s) && !withdrawnCreation(s) && s.state !== 'cancelled');
  const recordedPayerEmail = s => s?.payerEmailRecorded !== false && typeof s?.payerEmail === 'string' && Boolean(s.payerEmail);
  const membershipPayerEmail = s => recordedPayerEmail(s) ? s.payerEmail : null;
  function payerEmailFor(p, readInput = false) {
    const existing = currentPayerMembership(p.id), attempt = payerAttempts.get(p.id);
    const value = existing ? membershipPayerEmail(existing) : attempt ? attempt.payload.payerEmail : payerChoice.mode === 'other' ? readInput ? root.querySelector('#plan-payer-email')?.value ?? payerChoice.email : payerChoice.email : user?.email;
    if (!validPayerEmail(value)) throw new Error(payerEmailError);
    return normalizedPayerEmail(value);
  }
  function payerEmailSummary(s) {
    if (staffMode || manual(s) || !user || !recordedPayerEmail(s)) return '';
    return `<p class="small muted plan-payer-summary">E-mail para pagamento no Mercado Pago: <strong>${esc(s.payerEmail)}</strong>. Este e-mail pertence a esta solicitação e não altera seu acesso ao Rael.</p>`;
  }
  function payerEmailFields(p) {
    if (staffMode || !user || manual(p)) return '';
    const existing = currentPayerMembership(p.id), attempt = payerAttempts.get(p.id);
    if (existing && !recordedPayerEmail(existing) || !existing && attempt && !Object.hasOwn(attempt.payload, 'payerEmail')) return '';
    if (existing || attempt) {
      const email = existing ? membershipPayerEmail(existing) : attempt.payload.payerEmail;
      return `<section class="plan-payer-email"><h3>E-mail para pagamento no Mercado Pago</h3><p class="spaced"><strong>${esc(email || 'E-mail não confirmado')}</strong></p><p class="small muted spaced">Este e-mail foi definido para a solicitação enviada e não pode ser alterado nesta tentativa. Consulte Meus planos para acompanhar. Seu acesso ao Rael não muda.</p></section>`;
    }
    let summary; try { summary = 'O pagamento será preparado para ' + payerEmailFor(p) + '.'; } catch { summary = 'Informe o e-mail que será usado para pagar.'; }
    return `<fieldset class="plan-payer-email"><legend>E-mail para pagamento no Mercado Pago</legend><label class="plan-payer-option"><input type="radio" name="payerEmailMode" value="account" ${payerChoice.mode === 'account' ? 'checked' : ''}><span>Usar e-mail do cadastro<br><strong>${esc(user.email)}</strong></span></label><label class="plan-payer-option"><input type="radio" name="payerEmailMode" value="other" ${payerChoice.mode === 'other' ? 'checked' : ''}><span>Usar outro e-mail</span></label>${payerChoice.mode === 'other' ? `<label class="field"><span>E-mail para pagamento</span><input id="plan-payer-email" name="payerEmail" type="email" autocomplete="email" inputmode="email" maxlength="254" required value="${esc(payerChoice.email)}" aria-describedby="plan-payer-email-help plan-payer-email-summary"></label>` : ''}<p id="plan-payer-email-help" class="small muted spaced">Se estiver conectado ao Mercado Pago ou Mercado Livre, use o e-mail dessa conta. Esta escolha não altera seu acesso ao Rael.</p><p id="plan-payer-email-summary" class="small spaced" role="status" aria-live="polite">${esc(summary)}</p></fieldset>`;
  }
  function syncPayerAttempts() {
    for (const [planId, attempt] of payerAttempts) {
      const current = attempt.subscriptionId ? memberships.find(s => s.id === attempt.subscriptionId) : memberships.find(s => s.planId === planId && !withdrawnCreation(s) && s.state !== 'cancelled' && normalizedPayerEmail(s.payerEmail) === attempt.payload.payerEmail);
      if (current && (withdrawnCreation(current) || current.state === 'cancelled')) payerAttempts.delete(planId);
      else if (current) attempt.subscriptionId = current.id;
    }
  }
  function subscriptionPayload(s, offered) {
    const planId = s?.planId ?? offered.id;
    const base = { planId, idempotencyKey: requestKey, accepted: true, ...((offered?.checkoutRevision ?? offered?.revision) ? { planRevision: offered.checkoutRevision ?? offered.revision } : s?.offerRevision ? { planRevision: s.offerRevision } : {}) };
    if (manual(s ?? offered)) return base;
    const prior = payerAttempts.get(planId);
    const existing = s ?? currentPayerMembership(planId);
    if (existing && !recordedPayerEmail(existing)) {
      if (prior?.subscriptionId === existing.id && !Object.hasOwn(prior.payload, 'payerEmail')) return prior.payload;
      const payload = Object.freeze({ ...base, ...(s ? { idempotencyKey: crypto.randomUUID() } : {}) });
      payerAttempts.set(planId, { payload, offerKey: offered ? offerConsentKey(offered) : null, subscriptionId: existing.id }); return payload;
    }
    if (s) {
      const value = membershipPayerEmail(s);
      if (!validPayerEmail(value)) throw new Error('O e-mail desta solicitação precisa de conferência antes de continuar.');
      const payerEmail = normalizedPayerEmail(value);
      if (prior?.subscriptionId === s.id && prior.payload.payerEmail === payerEmail) return prior.payload;
      const payload = Object.freeze({ ...base, idempotencyKey: crypto.randomUUID(), payerEmail });
      payerAttempts.set(planId, { payload, offerKey: null, subscriptionId: s.id }); return payload;
    }
    if (prior) {
      if (prior.offerKey !== offerConsentKey(offered)) throw new Error('As condições mudaram após o envio. Confira a solicitação em Meus planos antes de continuar.');
      return prior.payload;
    }
    const payload = Object.freeze({ ...base, payerEmail: payerEmailFor(offered, true) });
    payerAttempts.set(planId, { payload, offerKey: offerConsentKey(offered), subscriptionId: null }); return payload;
  }
  function retainPayerField(target) {
    if (!['payerEmailMode', 'payerEmail'].includes(target.name)) return false;
    const p = plans.find(p => p.id === selected);
    if (!p || staffMode || !user || manual(p) || currentPayerMembership(p.id) || payerAttempts.has(p.id) || busy) return true;
    if (target.name === 'payerEmailMode') {
      if (!['account', 'other'].includes(target.value) || payerChoice.mode === target.value) return true;
      payerChoice.mode = target.value; acceptedOffer = ''; clearPayerEmailError(p); render();
    } else {
      payerChoice.email = target.value; acceptedOffer = '';
      const consent = root.querySelector('#plan-consent'); if (consent) consent.checked = false;
      const summary = root.querySelector('#plan-payer-email-summary');
      if (summary) { try { summary.textContent = 'O pagamento será preparado para ' + payerEmailFor(p) + '.'; } catch { summary.textContent = 'Informe o e-mail que será usado para pagar.'; } }
      clearPayerEmailError(p);
    }
    return true;
  }
  function clearPayerEmailError(p) {
    if (error !== payerEmailError) return;
    try { payerEmailFor(p); error = ''; const alert = root.querySelector('#plan-error'); if (alert) alert.textContent = ''; } catch { /* Keep validation guidance until this field is valid. */ }
  }
  function creationStatus(s) {
    if (withdrawnCreation(s)) return 'withdrawn';
    if (manual(s) || s.state !== 'pending') return null;
    if (!s.creation && s.canUse && s.cycle) return null;
    return ['ready', 'preparing', 'unconfirmed'].includes(s.creation?.status) ? s.creation.status : s.canCheckout ? 'ready' : 'unconfirmed';
  }
  const canCheckCreation = s => s.canCheckCreation ?? canRefresh(s);
  function creationMessage(s) {
    const status = creationStatus(s);
    if (status === 'preparing') return '<div class="note spaced"><strong>Preparando o link no Mercado Pago.</strong><p>A solicitação ainda está em preparação. Aguarde e atualize esta página para conferir a situação antes de tentar contratar novamente.</p></div>';
    if (status !== 'unconfirmed') return '';
    const issues = { not_found: 'A consulta ainda não confirmou o link desta solicitação. Peça conferência ao negócio antes de qualquer nova contratação.', ambiguous: 'O retorno precisa de conferência pelo negócio antes de continuar.', mismatch: 'Os dados retornados precisam ser conferidos pelo negócio antes de continuar.', unavailable: 'Não foi possível concluir a consulta. Tente conferir novamente ou fale com o negócio.' };
    const guidance = canWithdrawCreation(s) ? 'Você pode encerrar esta solicitação no sistema. Uma nova contratação exige conferir e aceitar novamente as condições do plano.' : issues[s.creation?.issue] || 'Confira a solicitação antes de tentar contratar novamente. Esta situação não confirma cobrança nem pagamento.';
    return `<div class="note warning spaced"><strong>O link de pagamento ainda não pôde ser confirmado.</strong><p>${guidance}</p>${s.creation?.supportCode ? `<p class="small">Código para suporte: <strong>${esc(s.creation.supportCode)}</strong>. Informe esse código ao negócio.</p>` : ''}</div>`;
  }
  const canWithdrawCreation = s => Boolean(user && !staffMode && s && !manual(s) && creationStatus(s) === 'unconfirmed' && s.canWithdrawCreation === true && typeof s.withdrawalRevision === 'string' && /^[a-f0-9]{64}$/i.test(s.withdrawalRevision));
  const withdrawButton = s => canWithdrawCreation(s) ? button('Encerrar solicitação e tentar novamente', 'withdraw', `data-id="${esc(s.id)}"`, true) : '';
  function refreshButton(s) {
    const status = creationStatus(s);
    if (status === 'withdrawn') return '';
    if (status === 'preparing') return canRefresh(s) ? button('Preparando link…', 'refresh', `data-id="${s.id}" disabled`, true) : '';
    if (status === 'unconfirmed') return `${canRefresh(s) && canCheckCreation(s) ? button('Conferir link no Mercado Pago', 'refresh', `data-id="${s.id}"`, true) : ''}${withdrawButton(s)}`;
    return canRefresh(s) ? button('Atualizar situação', 'refresh', `data-id="${s.id}"`, true) : '';
  }
  function withdrawalDialog(s) {
    withdrawalDraft = { id: s.id, revision: s.withdrawalRevision };
    dialog.innerHTML = `<h2 id="subscription-dialog-title">Encerrar esta solicitação?</h2><p class="spaced">${esc(s.name)} · ${money(s.priceCents)}/mês</p><p class="muted spaced">O encerramento vale apenas para este pedido no sistema. O histórico será preservado e a situação no Mercado Pago continuará em conferência. Esta ação não confirma cancelamento no Mercado Pago nem solicita reembolso.</p><p class="spaced">Nenhuma nova assinatura será criada agora. Para tentar novamente, escolha Conhecer este plano e aceite as condições outra vez.</p><div class="row spaced">${button('Manter solicitação', 'close', '', true)}${button('Confirmar encerramento', 'confirm-withdraw', `data-id="${esc(s.id)}" data-revision="${esc(s.withdrawalRevision)}"`)}</div><div role="alert" tabindex="-1" class="note error spaced"></div>`;
    dialog.showModal();
  }
  function focusPlanError() {
    const alert = root.querySelector('#plan-error');
    alert?.focus?.({ preventScroll: true }); alert?.scrollIntoView?.({ block: 'start' });
  }
  function externalUrl(value) { try { const url = new URL(value), host = url.hostname.toLowerCase(); return url.protocol === 'https:' && !url.username && !url.password && !url.port && host.includes('.') && !host.endsWith('.localhost') && !host.endsWith('.local') && !/^(?:\d|\[)/.test(host) ? url.href : ''; } catch { return ''; } }
  const renewalBlocked = row => row?.renewalBlocked === true || row?.renewalAllowed === false;
  const planRenewalPending = p => p?.providerPending === true || memberships.some(s => s.planId === p?.id && s.providerPending === true);
  const planRenewalBlocked = p => renewalBlocked(p) || memberships.some(s => s.planId === p.id && renewalBlocked(s));
  function renewalContact() { return `<p class="small muted">Fale com o negócio para solicitar a liberação deste plano.</p>${catalog?.business.phone ? `<a class="plan-renewal-contact" href="tel:${esc(String(catalog.business.phone).replace(/[^+0-9]/g, ''))}">Ligar para o negócio: ${esc(catalog.business.phone)}</a>` : ''}`; }
  function renewalSection(s) {
    const blocked = renewalBlocked(s), pending = s.providerPending === true;
    if (!staffMode && !blocked && !pending && !s.renewalNeedsNewConsent) return '';
    if (staffMode && typeof s.renewalAllowed !== 'boolean' && !blocked && !pending && s.canManageRenewal !== true) return '';
    return `<section class="plan-renewal-section" aria-label="Renovação da assinatura"><h3>Renovação</h3><strong>${blocked ? 'Renovação bloqueada pelo negócio' : pending ? 'Liberação aguardando o Mercado Pago' : 'Novas renovações permitidas'}</strong><p class="small muted">${blocked ? 'O bloqueio impede novas adesões e renovações deste plano pelo sistema. O período já pago, o saldo e os agendamentos são preservados.' : 'A liberação permite uma nova contratação ou renovação autorizada. O período atual, o saldo e os agendamentos não mudam.'}</p>${pending ? `<div class="note warning small">${s.providerError === true ? 'Não foi possível confirmar o cancelamento no Mercado Pago. A solicitação continua pendente.' : 'O cancelamento das próximas cobranças do contrato anterior ainda não foi confirmado pelo Mercado Pago.'} Atualize a situação e confira a conta recebedora antes de considerar a cobrança encerrada. Uma nova contratação fica indisponível até essa confirmação.</div>` : ''}${s.renewalNeedsNewConsent ? '<p class="small muted">O contrato automático anterior não será reativado. Para voltar a cobrar pelo Mercado Pago, o consumidor precisa contratar e autorizar novamente.</p>' : ''}${staffMode ? s.canManageRenewal === true ? button(blocked ? 'Permitir renovação' : 'Bloquear renovação', 'renewal-policy', `data-id="${esc(s.id)}" data-allowed="${blocked}"`, true) : '<p class="small muted">Somente o responsável com permissão pode alterar esta liberação.</p>' : blocked ? renewalContact() : ''}</section>`;
  }
  function renewalDialog(s, allowed) {
    dialog.innerHTML = `<h2 id="subscription-dialog-title">${allowed ? 'Permitir renovação?' : 'Bloquear renovação?'}</h2><p class="spaced">${esc(s.customerName)} · ${esc(s.name)}</p><p class="muted spaced">${allowed ? 'O cliente poderá voltar a contratar ou renovar este plano, mediante pagamento e autorização. Esta ação não libera saldo nem registra recebimento.' : 'Este cliente não poderá contratar novamente este plano nem iniciar novos períodos enquanto o bloqueio estiver ativo.'}</p><p class="spaced">O período já pago, o saldo disponível e os agendamentos existentes serão preservados.</p>${!manual(s) ? `<div class="note spaced">${allowed ? 'Permitir renovação não reativa o contrato antigo do Mercado Pago. Se a cobrança foi cancelada ou seu cancelamento já foi solicitado, uma nova contratação exige novo consentimento do consumidor.' : 'Também solicitaremos ao Mercado Pago o cancelamento das próximas cobranças deste contrato. A confirmação pode ficar pendente; acompanhe a situação até o Mercado Pago confirmar.'}</div>` : ''}<div class="row spaced">${button('Voltar', 'close', '', true)}${button(allowed ? 'Confirmar liberação' : 'Confirmar bloqueio', 'confirm-renewal-policy', `data-id="${esc(s.id)}" data-allowed="${allowed}"`)}</div><div role="alert" class="note error spaced"></div>`;
    dialog.showModal();
  }
  function paymentGuidance(p) {
    const url = externalUrl(p.externalPaymentUrl);
    const guidance = `${p.paymentInstructions ? `<p class="plan-instructions small muted">${esc(p.paymentInstructions)}</p>` : ''}${url ? `<a class="button secondary plan-external-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Pagar pelo link do prestador ↗</a><p class="small muted">Link externo de ${esc(new URL(url).hostname)}. Abrir ou pagar por esse link não confirma o recebimento neste sistema; aguarde a confirmação do prestador.</p>` : ''}`;
    if (!p.cycle && !p.nextCycle) return guidance;
    const confirmation = p.nextCycle ? `${p.cycle ? 'Este período já está confirmado. A próxima renovação também já está confirmada.' : 'O próximo período já está confirmado.'} Não é necessário pagar novamente por esses períodos.` : 'Este período já está confirmado. Combine a próxima renovação com o prestador.';
    return `<p class="small muted">${confirmation}</p>${guidance ? `<details><summary>${p.nextCycle ? 'Orientações para renovações futuras' : 'Orientações para a próxima renovação'}</summary>${guidance}</details>` : ''}`;
  }
  async function api(path, data) { let r; try { r = await fetch(`/internal/${encodeURIComponent(slug)}/${path}`, { credentials: 'same-origin', ...(data ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(data) } : {}) }); } catch { throw new Error('Não foi possível conectar. Confira sua internet e tente novamente; os dados preenchidos continuam nesta tela.'); } let result; try { result = await r.json(); } catch { throw new Error('A conexão foi interrompida. Atualize a situação antes de tentar novamente.'); } if (!r.ok) { if (r.status === 401 && !['customer/login', 'customer/register', 'session', 'customer/session'].includes(path)) { user = null; csrf = ''; memberships = []; resetPayerChoice(); if (staffMode) { setup = null; plans = []; managementOverview = null; managementMembers = null; managementPlanId = ''; managementMemberId = ''; managementCanCreate = false; managementCanCreateBusiness = false; receivingMode = 'professional'; resetPlanEditor(); managementSequence++; operationsAvailable = false; sessionBusinessName = ''; } } throw Object.assign(new Error(result.error || 'Não foi possível concluir.'), { status: r.status }); } return result; }
  const date = at => new Intl.DateTimeFormat('pt-BR', { timeZone: catalog?.business.timeZone ?? 'America/Sao_Paulo', dateStyle: 'short' }).format(at);
  function header() { if (staffMode) return `${testMode ? '<div class="test-banner">Ambiente de validação · recebimentos reais desativados</div>' : ''}${window.RaelWorkspace.render({ slug, user, businessName: setup?.draft?.business.name ?? setup?.businessName ?? sessionBusinessName, active: 'memberships', operationsAvailable, csrf, logoutHtml: user ? button('Sair', 'staff-logout', 'aria-label="Sair da minha conta"', true) : '' })}`; const b = catalog?.business; return `${testMode ? '<div class="test-banner">Ambiente de validação · recebimentos reais desativados</div>' : ''}<header class="booking-header public-plans-header"><div class="business-brand">${b?.logoUrl ? `<img class="plan-head-logo" src="${esc(b.logoUrl)}" alt="Logo de ${esc(b.name)}">` : ''}<div><strong>${esc(b?.name ?? 'Rael Agendamentos')}</strong><small>Planos e assinaturas</small></div></div><div class="booking-head-actions">${user ? '<span data-rael-notifications></span>' : ''}<a class="button secondary small" href="/${staffMode ? 'sistema' : 'negocio'}/${slug}">${staffMode ? 'Meu espaço' : 'Agendar horário'}</a>${staffMode ? `<a class="button secondary small" href="/sistema/${slug}/financeiro">Financeiro</a>` : ""}<button class="theme-toggle" type="button" data-theme-toggle aria-label="Alternar tema"></button></div></header>`; }
  function planCard(p) {
    const isManual = manual(p), blocked = !staffMode && planRenewalBlocked(p), awaitingProvider = !staffMode && planRenewalPending(p);
    return `<article class="plan-card"><div class="eyebrow">${esc(planResponsibility(p))}</div><h2>${esc(p.name)}</h2><span class="badge">${isManual ? 'Recebimento manual' : 'Cobrança pelo Mercado Pago'}</span><div class="plan-price">${money(p.priceCents)} <small>/mês</small></div>${composition(p)}<ul><li>${businessPlan(p) ? 'Atendimento com qualquer profissional habilitado para o serviço' : `Atendimento com ${esc(p.professionalName)}`}</li><li>Saldo não acumula para o mês seguinte</li><li>${isManual ? 'Pague como combinado com o prestador; ele confirma cada período' : 'Renovação mensal automática até cancelar'}</li></ul>${staffMode ? `<span class="badge">${p.active ? 'Visível para clientes' : 'Oculto para novas adesões'}</span>${button(p.active ? 'Ocultar plano' : 'Exibir plano', 'plan-status', `data-id="${p.id}"`, true)}` : button(blocked ? 'Renovação bloqueada' : awaitingProvider ? 'Aguardando Mercado Pago' : p.available ? 'Conhecer este plano' : 'Plano indisponível no momento', 'select', `data-id="${p.id}" ${!blocked && !awaitingProvider && p.available ? '' : 'disabled'}`)}${blocked ? `<div class="plan-renewal-public-note">${renewalContact()}</div>` : awaitingProvider ? '<p class="small muted">Aguarde a confirmação do cancelamento anterior pelo Mercado Pago para contratar novamente.</p>' : ''}${!p.available && staffMode ? `<p class="small muted">${isManual ? 'Confira se o serviço e o profissional estão publicados e se a assinatura do negócio está regular.' : 'Publique o serviço e conecte sua conta de recebimento para liberar adesões.'}</p>` : ''}</article>`;
  }
  function membershipCard(s) {
    const isManual = manual(s), canManage = isManual && managesManual(s), ended = s.state === 'cancelled';
    const creation = creationStatus(s);
    if (creation === 'withdrawn') return `<article class="plan-card"><span class="badge">Solicitação anterior encerrada</span><h2>${esc(s.name)}</h2>${staffMode ? `<strong>${esc(s.customerName)}</strong>` : ''}<p class="small muted">${money(s.priceCents)}/mês · ${esc(planResponsibility(s))}</p>${composition(s)}${payerEmailSummary(s)}<div class="note spaced">Este pedido foi encerrado apenas no sistema. O histórico foi preservado e a situação no Mercado Pago continua em conferência. Isso não confirma cancelamento no Mercado Pago nem reembolso.</div>${s.creation?.supportCode ? `<p class="small muted">Código para suporte: <strong>${esc(s.creation.supportCode)}</strong></p>` : ''}</article>`;
    const state = creation === 'preparing' ? 'Preparando link de pagamento' : creation === 'unconfirmed' ? 'Link de pagamento em conferência' : isManual && s.state === 'authorized' && !s.cycle ? 'Período vencido · aguardando renovação' : (isManual ? manualStates : states)[s.state] ?? 'Em conferência';
    const pending = isManual ? ended ? 'Assinatura encerrada. Novos usos estão bloqueados.' : 'O saldo será liberado quando o prestador confirmar o recebimento e o período pago.' : 'Aguardando uma cobrança aprovada. Autorizar a renovação não libera saldo por si só.';
    const manualActions = canManage && !ended ? `${!s.nextCycle && !renewalBlocked(s) ? button(s.cycle ? 'Registrar renovação' : 'Confirmar recebimento e ativar', 'manual-receipt', `data-id="${s.id}"`) : ''}${s.state === 'authorized' && s.cycle ? button('Suspender uso', 'manual-status', `data-id="${s.id}" data-active="false"`, true) : s.state === 'suspended' && s.cycle ? button('Reativar uso', 'manual-status', `data-id="${s.id}" data-active="true"`, true) : ''}` : '';
    return `<article class="plan-card"><span class="badge">${esc(state)}</span><h2>${esc(s.name)}</h2>${staffMode ? `<strong>${esc(s.customerName)}</strong>` : ''}<p class="small muted">${money(s.priceCents)}/mês · ${esc(planResponsibility(s))}<br>Quantidades renovadas a cada ciclo pago<br>${isManual ? 'Recebimento manual · sem cobrança automática' : 'Cobrança recorrente pelo Mercado Pago'}</p>${!isManual && (s.receiver?.name || s.receiverName) ? `<p class="small muted">Recebedor: <strong>${esc(s.receiver?.name || s.receiverName)}</strong></p>` : ''}${composition(s)}${payerEmailSummary(s)}${s.resolution ? '<div class="note error">Esta assinatura precisa de conferência com o profissional. Novos usos estão bloqueados.</div>' : ''}${creation === 'preparing' || creation === 'unconfirmed' ? creationMessage(s) : s.cycle ? `<div class="plan-meter"><strong>${s.cycle.remaining} de ${totalUnits(s)} atendimentos ${isManual && !s.canUse ? 'no período pago · uso bloqueado' : 'disponíveis'}</strong><br>Ciclo de ${date(s.cycle.startAt)} até ${date(s.cycle.endAt)}<br>${s.cycle.used} utilizado(s) ou reservado(s)${serviceBalances(s)}</div>` : `<div class="note">${pending}</div>`}${s.nextCycle ? `<div class="note">Próximo período já confirmado: ${date(s.nextCycle.startAt)} até ${date(s.nextCycle.endAt)}. ${isManual && ended ? 'A assinatura foi encerrada; novos usos permanecem bloqueados.' : isManual && s.state === 'suspended' ? 'O uso permanecerá suspenso até a reativação pelo prestador.' : 'O novo saldo será liberado no início desse período.'}</div>` : ''}${isManual && !ended && !staffMode && !renewalBlocked(s) ? paymentGuidance(s) : ''}${renewalSection(s)}<div class="row">${!isManual && s.canCheckout && !staffMode && !renewalBlocked(s) && !s.providerPending ? button('Continuar no Mercado Pago', 'resume', `data-id="${s.id}"`) : ''}${!staffMode && s.canUse && s.cycle?.remaining ? `<a class="button" href="/negocio/${slug}?assinatura=${s.id}">Agendar usando o plano</a>` : ''}${manualActions}${refreshButton(s)}${isManual ? !ended && (!staffMode || canManage) ? button('Encerrar assinatura', 'cancel', `data-id="${s.id}"`, true) : '' : s.canCancel && (!staffMode || s.canManageAutomatic === true) && !s.providerPending ? button('Cancelar renovação', 'cancel', `data-id="${s.id}"`, true) : ''}</div>${isManual ? s.state === 'suspended' ? '<p class="small muted">A suspensão impede novos usos, preserva os agendamentos existentes e não reinicia o saldo. A validade do período continua correndo.</p>' : ended ? '<p class="small muted">Novos usos estão bloqueados. Agendamentos e recebimentos anteriores são preservados; não há devolução automática.</p>' : '<p class="small muted">Cada renovação depende da confirmação do recebimento pelo gestor ou profissional responsável.</p>' : s.state === 'cancelled' ? '<p class="small muted">Sem novas renovações. Saldo já pago pode ser usado até o fim do ciclo. Agendamentos existentes são preservados.</p>' : ''}</article>`;
  }
  function auth() { return `<section class="card plan-login"><h2>${authRegister ? 'Crie seu acesso' : 'Entre na sua conta'}</h2><p class="muted spaced">${authRegister ? 'Seu cadastro fica vinculado a este negócio.' : 'Use o acesso que você já utiliza para agendar.'}</p><div class="plan-auth-options">${button(authRegister ? 'Já tenho cadastro' : 'Quero criar meu cadastro', 'auth-toggle', '', true)}</div><form id="plan-auth">${authRegister ? `<label class="field"><span>Seu nome</span><input name="name" value="${esc(authFields.name)}" autocomplete="name" minlength="2" maxlength="120" required></label><label class="field"><span>WhatsApp com DDD</span><input name="phone" type="tel" inputmode="tel" value="${esc(authFields.phone)}" autocomplete="tel" maxlength="25" required></label>` : ''}<label class="field"><span>E-mail</span><input name="email" type="email" value="${esc(authFields.email)}" autocomplete="username" maxlength="254" required></label><label class="field"><span>Senha</span><input name="password" type="password" minlength="8" maxlength="128" autocomplete="${authRegister ? 'new-password' : 'current-password'}" required></label>${authRegister ? '<label class="field"><span>Repita a senha</span><input name="confirmation" type="password" minlength="8" maxlength="128" autocomplete="new-password" required></label>' : ''}<button class="button full spaced" ${busy ? 'disabled' : ''}>${busy ? 'Aguarde…' : authRegister ? 'Criar cadastro e continuar' : 'Entrar'}</button></form>${!authRegister ? button('Esqueci minha senha', 'recovery-help', '', true) : ''}</section>`; }
  function detail(p) {
    const isManual = manual(p);
    const unfinished = user && memberships.find(s => s.planId === p.id && ['preparing', 'unconfirmed'].includes(creationStatus(s)));
    if (unfinished) return `<section class="card plan-detail"><div class="eyebrow">${esc(p.name)}</div><h2>Confira sua solicitação em andamento</h2>${payerEmailSummary(unfinished)}${creationMessage(unfinished)}${refreshButton(unfinished)}<p class="small muted spaced">A conferência usa a solicitação existente e não inicia outra assinatura.</p><a class="button secondary spaced" href="#my-plans">Ver meus planos</a></section>`;
    const sentAttempt = payerAttempts.get(p.id);
    if (sentAttempt && sentAttempt.offerKey !== offerConsentKey(p)) return `<section class="card plan-detail"><h2>Confira a solicitação enviada</h2>${payerEmailFields(p)}<p class="note spaced">As condições mudaram após o envio. Confira a solicitação em Meus planos antes de continuar.</p><a class="button secondary spaced" href="#my-plans">Ver meus planos</a></section>`;
    if (user && (planRenewalBlocked(p) || planRenewalPending(p))) return `<section class="card plan-detail"><div class="eyebrow">${esc(p.name)}</div><h2>${planRenewalBlocked(p) ? 'Renovação bloqueada pelo negócio' : 'Aguardando confirmação do Mercado Pago'}</h2><p class="muted spaced">${planRenewalBlocked(p) ? 'Novas contratações e renovações deste plano precisam de liberação.' : 'Aguarde a confirmação do cancelamento anterior pelo Mercado Pago para contratar novamente.'} O período já pago e os agendamentos existentes são preservados.</p>${planRenewalBlocked(p) ? renewalContact() : ''}</section>`;
    return `<section class="card plan-detail"><div class="eyebrow">Confira antes de continuar</div><h2>${esc(p.name)}</h2><p class="spaced"><strong>${money(p.priceCents)} por mês</strong>, ${isManual ? 'com recebimento combinado com o prestador e confirmação de cada período.' : 'com renovação automática até o cancelamento.'}</p><p class="muted spaced">${businessPlan(p) ? 'Escolha qualquer profissional habilitado para cada serviço.' : `Atendimentos com ${esc(p.professionalName)}.`} Cada serviço tem seu próprio saldo mensal: </p>${composition(p)}<p class="muted spaced">O atendimento deve acontecer dentro do ciclo. Saldo não acumula e não pode ser trocado entre serviços. Ao esgotar um serviço, você pode contratá-lo avulso.</p>${isManual ? '<div class="note spaced">Pagamento presencial, Pix ou outra forma combinada com o prestador. Não há cobrança automática neste sistema. O saldo só será liberado após a confirmação do recebimento pelo gestor ou profissional responsável.</div>' : `<p class="muted spaced">Recebedor: <strong>${esc(p.receiver?.name)}</strong>. O cartão será informado somente no ambiente do Mercado Pago. Você pode cancelar a renovação em Meus planos.</p>`}<p class="small muted spaced">Cancelamento do atendimento dentro do prazo do negócio devolve a unidade ao mesmo ciclo. Cancelamento tardio ou falta consome a unidade. ${isManual ? 'Encerrar a assinatura bloqueia novos usos e preserva os horários já agendados. Combine eventuais devoluções diretamente com o prestador.' : 'Cancelar o plano não cancela os horários já agendados nem solicita reembolso.'}</p>${user ? `${!isManual ? payerEmailFields(p) : ''}<label class="plan-consent"><input id="plan-consent" type="checkbox" ${acceptedOffer === offerConsentKey(p) ? 'checked' : ''} ${busy ? 'disabled' : ''}><span>${isManual ? `Li as condições do plano de <strong>${money(p.priceCents)} por mês</strong>. Vou combinar o pagamento com o prestador e aguardar a confirmação para usar o saldo. Não haverá cobrança automática.` : `Li as condições e quero autorizar uma assinatura de <strong>${money(p.priceCents)} por mês</strong>, com renovação automática até cancelar.`}</span></label>${button(isManual ? 'Aderir e combinar pagamento' : 'Continuar para o Mercado Pago', 'subscribe', `data-id="${p.id}" ${busy ? 'disabled' : ''}`)}<p class="small muted spaced">${isManual ? 'A adesão não confirma pagamento nem libera atendimentos. As instruções de recebimento aparecerão em Meus planos.' : 'A confirmação e a autorização de cobrança serão concluídas no Mercado Pago.'}</p>` : '<p class="muted spaced">Entre ou crie seu acesso para continuar com este plano.</p><a class="button secondary" href="#plan-auth">Entrar ou criar meu acesso</a>'}</section>`;
  }
  function createForm() {
    if (!user || !creationOpen || !editingPlan && !canCreateAnyPlan()) return '';
    const own = editorServices(), isManual = planFields.billingMethod === 'manual', business = planFields.scope === 'business';
    const rows = planRows.map((item, index) => `<div class="plan-service-row"><label class="field"><span>Serviço ${index + 1}</span><select name="serviceId_${index}" required><option value="">Selecione um serviço</option>${own.map(s => `<option value="${esc(s.id)}" ${s.id === item.serviceId ? 'selected' : ''} ${planRows.some((other, i) => i !== index && other.serviceId === s.id) ? 'disabled' : ''}>${esc(s.name)}</option>`).join('')}</select></label><label class="field plan-service-units"><span>Quantidade por mês</span><input name="units_${index}" type="number" min="1" max="100" step="1" inputmode="numeric" value="${esc(item.units)}" required></label>${planRows.length > 1 ? button('Remover', 'remove-service', `data-index="${index}" aria-label="Remover serviço ${index + 1}"`, true) : ''}</div>`).join('');
    const scopeChoice = editingPlan ? `<p class="small muted wide">${business ? 'Plano do negócio · qualquer profissional habilitado' : 'Plano do meu perfil'}. O tipo do plano será mantido.</p>` : managementCanCreateBusiness ? `<label class="field wide"><span>Tipo de plano</span><select name="scope">${managementCanCreate ? `<option value="professional" ${!business ? 'selected' : ''}>Plano do meu perfil</option>` : ''}<option value="business" ${business ? 'selected' : ''}>Plano do negócio · qualquer profissional habilitado</option></select><small>O plano do negócio permite usar os serviços com qualquer profissional habilitado para atendê-los.</small></label>` : '';
    return user.professionalId || business && user.role === 'admin' ? `<details id="plan-editor" class="card plan-editor" open><summary><strong>${editingPlan ? 'Editar plano' : 'Criar plano mensal'}</strong></summary>${editingPlan ? '<div class="note spaced">As alterações valem para novas adesões. Assinaturas atuais mantêm o nome, o preço, os serviços, as quantidades e a forma de recebimento combinados, inclusive nas renovações.</div>' : '<p class="muted spaced">Inclua os serviços publicados e escolha a quantidade de cada um por mês. Cada cliente tem seu próprio saldo por serviço.</p>'}<form id="plan-create" class="plan-form spaced">${scopeChoice}<label class="field wide"><span>Nome do plano</span><input name="name" value="${esc(planFields.name)}" minlength="3" maxlength="100" placeholder="Ex.: Cuidado mensal" required></label><fieldset class="plan-services wide"><legend>Serviços incluídos no plano</legend><p class="small muted">${business ? 'Inclua serviços publicados com ao menos um profissional ativo habilitado. O cliente escolhe quem atende a cada agendamento.' : 'Exemplo: 1 corte, 2 barbas e 1 sobrancelha. O saldo de cada serviço é separado.'}</p>${rows}${button('Adicionar outro serviço', 'add-service', planRows.length >= own.length || planRows.length >= 100 ? 'disabled' : '', true)}</fieldset><label class="field wide"><span>Mensalidade do plano completo (R$)</span><input name="price" type="number" min="0.01" max="1000000" step="0.01" inputmode="decimal" value="${esc(planFields.price)}" placeholder="Ex.: 60,00" required></label><label class="field wide"><span>Como você quer receber este plano?</span><select name="billingMethod" aria-describedby="plan-billing-help"><option value="mercadopago" ${!isManual ? 'selected' : ''}>Mercado Pago · cobrança recorrente automática</option><option value="manual" ${isManual ? 'selected' : ''}>Recebimento manual · presencial, Pix ou link externo</option></select><small id="plan-billing-help">${billingHelp(isManual, business)}</small></label>${business ? `<p class="small muted wide"><a href="/sistema/${encodeURIComponent(slug)}/recebimentos?assinaturas=recebimento">Configurar recebimento das assinaturas</a></p>` : ''}<div id="plan-manual-fields" class="wide plan-manual-fields" ${isManual ? '' : 'hidden'}><label class="field"><span>Instruções de pagamento (opcional)</span><textarea name="paymentInstructions" maxlength="500" ${isManual ? '' : 'disabled'} placeholder="Ex.: Pague na recepção ou combine o Pix comigo.">${esc(planFields.paymentInstructions)}</textarea></label><label class="field"><span>Link externo de pagamento (opcional)</span><input name="externalPaymentUrl" type="url" maxlength="2048" value="${esc(planFields.externalPaymentUrl)}" placeholder="https://…" ${isManual ? '' : 'disabled'}><small>Use um endereço público com HTTPS. Abrir o link não confirma o pagamento: você registra o recebimento na assinatura do cliente.</small></label></div><div class="wide plan-editor-actions">${button('Cancelar', 'cancel-plan-edit', '', true)}<button type="submit" class="button" ${busy ? 'disabled' : ''}>${editingPlan ? 'Salvar alterações' : 'Criar plano mensal'}</button></div></form></details>` : '<div class="note">Para vender planos do seu perfil, ative seu próprio cadastro como profissional na configuração.</div>';
  }
  function receiptDialog(s) {
    const previous = receiptDraft;
    if (!previous || previous.subscriptionId !== s.id || previous.expectedCycleEndAt !== (s.latestCycleEndAt ?? null)) receiptDraft = { subscriptionId: s.id, idempotencyKey: crypto.randomUUID(), expectedCycleEndAt: s.latestCycleEndAt ?? null, method: 'cash', note: '', receivedConfirmed: false };
    const d = receiptDraft;
    dialog.innerHTML = `<h2 id="subscription-dialog-title">${s.cycle ? 'Registrar renovação' : 'Confirmar recebimento e ativar'}</h2><p><strong>${esc(s.customerName)}</strong> · ${esc(s.name)}</p><div class="note spaced">Registre somente se você já recebeu <strong>${money(s.priceCents)}</strong>. Isto registra a entrada no financeiro e libera os serviços abaixo por um mês; não realiza cobrança nem transferência.</div>${composition(s)}<p class="small muted spaced">${s.cycle ? `O novo período começa quando o período já pago terminar em ${date(s.latestCycleEndAt ?? s.cycle.endAt)}.` : 'O período de um mês começa agora, após sua confirmação.'} ${s.state === 'suspended' ? 'Confirmar um novo recebimento também reativa o uso da assinatura.' : ''}</p><form id="plan-manual-receipt" class="spaced"><label class="field"><span>Como você recebeu?</span><select name="method" required>${[['cash', 'Dinheiro / presencial'], ['pix', 'Pix'], ['card', 'Cartão fora da plataforma'], ['transfer', 'Transferência'], ['external', 'Link externo'], ['other', 'Outra forma']].map(([value, label]) => `<option value="${value}" ${value === d.method ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="field"><span>Observação (opcional)</span><textarea name="note" maxlength="250" placeholder="Ex.: Pix recebido no atendimento">${esc(d.note)}</textarea></label><label class="plan-consent"><input name="receivedConfirmed" type="checkbox" ${d.receivedConfirmed ? 'checked' : ''} required><span>Confirmo que já recebi <strong>${money(s.priceCents)}</strong> deste cliente e quero registrar esse recebimento.</span></label><div class="row spaced">${button('Voltar', 'close', '', true)}<button type="submit" class="button">Registrar recebimento</button></div><div role="alert" class="note error spaced"></div></form>`;
    dialog.showModal();
  }
  function statusDialog(s, active) {
    dialog.innerHTML = `<h2 id="subscription-dialog-title">${active ? 'Reativar o uso?' : 'Suspender o uso?'}</h2><p>${esc(s.customerName)} · ${esc(s.name)}</p><p class="muted spaced">${active ? 'O cliente poderá usar o saldo restante do período já pago. Esta ação não renova a validade nem reinicia a quantidade de atendimentos.' : 'O cliente ficará impedido de fazer novos agendamentos com este plano. O período pago continua correndo, e os agendamentos e recebimentos anteriores são preservados.'}</p><p class="small muted spaced">Esta ação não registra recebimento nem realiza cobrança ou devolução.</p><div class="row spaced">${button('Voltar', 'close', '', true)}${button(active ? 'Confirmar reativação' : 'Confirmar suspensão', 'confirm-manual-status', `data-id="${s.id}" data-active="${active}"`)}</div><div role="alert" class="note error spaced"></div>`;
    dialog.showModal();
  }
  function render() {
    const title = staffMode ? 'Planos e Assinaturas' : 'Seu atendimento, todo mês.';
    document.title = staffMode ? title + ' · Rael Agendamentos' : catalog?.business?.name ? 'Planos e assinaturas · ' + catalog.business.name : 'Planos e assinaturas';
    const intro = staffMode ? 'Crie e organize os planos do negócio. Escolha um plano para acompanhar clientes, recebimentos, saldo e renovações.' : 'Escolha seu plano, confira o que está incluído e organize seus próximos atendimentos.';
    const heading = `<section class="plans-hero${staffMode ? ' management-unified-hero' : ''}"><div><div class="eyebrow">${staffMode ? 'Seu negócio · planos e clientes' : 'Mais continuidade no seu cuidado'}</div><h1>${title}</h1><p>${intro}</p></div>${staffMode && user && canCreateAnyPlan() ? button('Criar plano', 'create-plan') : ''}</section>`;
    const alerts = `<div id="plan-error" class="note error spaced" role="alert" tabindex="-1">${esc(error)}</div><div id="plan-notice" class="note success spaced" role="status">${esc(notice)}</div>`;
    let content;
    if (staffMode) {
      content = !user ? `<section class="card plan-login"><h2>Entre no seu negócio</h2><p class="muted spaced">Use seu acesso individual para gerenciar planos e assinaturas dos clientes.</p><a class="button" href="/sistema/${slug}">Entre no seu espaço para continuar</a></section>` : createForm() + managementContent();
    } else {
      const chosen = plans.find(p => p.id === selected);
      const offers = `<section class="public-plan-offers" aria-label="Planos disponíveis"><div class="plans-grid">${plans.map(planCard).join('') || '<div class="note">Nenhum plano disponível por enquanto.</div>'}</div>${chosen ? detail(chosen) : ''}</section>`;
      const account = user ? `<aside class="public-plan-account card" aria-labelledby="plan-account-title"><h2 id="plan-account-title">Sua conta</h2><div class="plan-account"><p>Conectado como <strong>${esc(user.name)}</strong><br><span class="small muted">${esc(user.email)}</span></p></div><a class="button secondary" href="#my-plans">Ver meus planos</a>${button('Sair da minha conta', 'logout', '', true)}</aside>` : `<aside class="public-plan-account" aria-label="Seu acesso"><section id="my-plans" tabindex="-1">${auth()}</section></aside>`;
      content = `<div class="public-plans-layout">${offers}${account}</div>${user ? `<section id="my-plans" class="public-plan-memberships" tabindex="-1"><h2 class="plan-section">Meus planos</h2><div class="plans-grid">${memberships.map(membershipCard).join('') || '<div class="note">Ainda não há assinaturas neste acesso.</div>'}</div></section>` : ''}`;
    }
    root.innerHTML = header() + `<main id="main" class="plans-shell${staffMode ? managementView ? ' management-plans-shell' : '' : ' public-plans-shell'}">${heading}${alerts}${content}<p class="small muted spaced">O recebimento dos planos é gerenciado pelo prestador. A mensalidade do sistema Rael é um contrato separado.</p></main>`;
    window.RaelTheme?.sync(); window.RaelWorkspace?.sync(); if (!staffMode) window.RaelNotifications?.mount({ slug, audience: 'customer', user, csrf });
  }
  function retainField(event) { const target = event.target; if (retainPayerField(target)) return; if (target.id === 'plan-consent') { acceptedOffer = target.checked ? offerConsentKey(plans.find(p => p.id === selected)) : ''; return; } if (target.form?.id === 'plan-create' && target.name === 'scope') { if (editingPlan || target.value === 'business' && !managementCanCreateBusiness || target.value === 'professional' && !managementCanCreate) return; planFields.scope = target.value; const allowed = new Set(editorServices().map(s => s.id)); planRows = planRows.map(row => allowed.has(row.serviceId) ? row : { serviceId: '', units: row.units }); render(); return; } if (target.form?.id === 'management-plan-filters' && Object.hasOwn(overviewDraft, target.name)) overviewDraft[target.name] = target.value; if (target.form?.id === 'management-member-filters' && Object.hasOwn(memberDraft, target.name)) memberDraft[target.name] = target.value; if (target.form?.id === 'plan-auth' && Object.hasOwn(authFields, target.name)) authFields[target.name] = target.value; if (target.form?.id === 'plan-create' && /^(serviceId|units)_\d+$/.test(target.name)) { const [field, index] = target.name.split('_'); if (planRows[Number(index)]) planRows[Number(index)][field] = target.value; } if (target.form?.id === 'plan-create' && Object.hasOwn(planFields, target.name)) planFields[target.name] = target.value; if (target.form?.id === 'plan-create' && target.name === 'billingMethod') { const isManual = target.value === 'manual', fields = root.querySelector('#plan-manual-fields'); fields.hidden = !isManual; for (const field of fields.querySelectorAll('input,textarea')) field.disabled = !isManual; root.querySelector('#plan-billing-help').textContent = billingHelp(isManual); } }
  root.addEventListener('input', retainField); root.addEventListener('change', retainField);
  async function loadManagement() {
    const seq = ++managementSequence, selectedPlan = managementPlanId;
    managementLoading = true;
    if (selectedPlan) { managementMembers = null; memberships = []; } else { managementOverview = null; plans = []; memberships = []; }
    let result;
    try { result = await api(selectedPlan ? 'subscriptions/plan-members?' + new URLSearchParams({ planId: selectedPlan, ...memberFilters }) : 'subscriptions/overview?' + new URLSearchParams(overviewFilters)); }
    catch (err) { if (!user) { managementLoading = false; throw err; } if (seq !== managementSequence || selectedPlan !== managementPlanId) return false; managementLoading = false; throw err; }
    if (seq !== managementSequence || selectedPlan !== managementPlanId || !user) return false;
    managementLoading = false;
    if (selectedPlan) { managementMembers = result; memberships = result.subscriptions; plans = [result.plan]; memberFilters.page = Number(result.page ?? memberFilters.page); if (managementMemberId && !memberships.some(s => s.id === managementMemberId)) { managementMemberId = ''; notice = `${notice ? notice + ' ' : ''}A assinatura saiu desta página após a atualização. Os filtros foram mantidos.`; } }
    else { managementOverview = result; managementProfessionals = result.professionals ?? []; managementCanCreate = result.canCreate === true; managementCanCreateBusiness = user?.role === 'admin' && result.canCreateBusiness === true; receivingMode = result.receivingMode ?? (result.businessMode ? 'business' : 'professional'); plans = result.plans; memberships = []; overviewFilters.page = Number(result.page ?? overviewFilters.page); }
    return true;
  }
  async function reload() {
    if (staffMode) {
      if (user) { if (!await loadManagement()) return; }
      else { plans = []; memberships = []; setup = null; }
    } else { plans = (await api('subscription-plans')).plans; memberships = user ? (await api('customer/subscriptions')).subscriptions : []; syncPayerAttempts(); }
    render();
  }
  root.addEventListener('click', async e => {
    const target = e.target.closest('[data-sub-action]'); if (!target || target.disabled || busy) return;
    const action = target.dataset.subAction, id = target.dataset.id;
    if (managementView && managementLoading && !['manage-plan', 'back-plan-list', 'management-plan-page', 'management-member-page', 'reset-plan-filters', 'reset-member-filters', 'management-reload', 'staff-logout'].includes(action)) return;
    error = ''; notice = ''; let focusMemberships = false, controlsBusy = false;
    try {
      if (managementView && ['create-plan', 'edit-plan', 'cancel-plan-edit'].includes(action)) {
        if (action === 'cancel-plan-edit') { resetPlanEditor(); render(); return; }
        const p = action === 'edit-plan' ? editablePlan(id) : null;
        if (action === 'edit-plan' ? p?.canEdit !== true : !canCreateAnyPlan()) return;
        busy = true; controlsBusy = true; target.disabled = true;
        const preparedSetup = await api('setup'); setup = preparedSetup;
        if (p) fillPlanEditor(p); else { resetPlanEditor(); creationOpen = true; if (managementCanCreateBusiness && (receivingMode === 'business' || !managementCanCreate)) planFields.scope = 'business'; }
        return;
      }
      if (managementView && action === 'plan-status') {
        const p = editablePlan(id); if (p?.canToggle !== true) return;
        dialog.innerHTML = `<h2 id="subscription-dialog-title">${p.active ? 'Inativar plano?' : 'Ativar plano?'}</h2><p class="spaced">${esc(p.name)}</p><p class="muted spaced">${p.active ? 'O plano ficará indisponível para novas adesões. As assinaturas já contratadas continuam com seus termos e saldo; esta ação não cancela contratos nem cobranças.' : 'O plano voltará a aceitar novas adesões quando os serviços, o profissional e a forma de recebimento estiverem disponíveis. Os contratos existentes não serão alterados.'}</p><div class="row spaced">${button('Voltar', 'close', '', true)}${button(p.active ? 'Confirmar inativação' : 'Confirmar ativação', 'confirm-plan-status', `data-id="${esc(p.id)}" data-active="${!p.active}"`)}</div><div role="alert" class="note error spaced"></div>`; dialog.showModal(); return;
      }
      if (managementView && ['manage-plan', 'manage-member', 'back-plan-list', 'back-members', 'management-plan-page', 'management-member-page', 'reset-plan-filters', 'reset-member-filters', 'management-reload'].includes(action)) {
        if (action === 'manage-member') { if (!memberships.some(s => s.id === id)) return; managementMemberId = id; render(); root.querySelector('#my-plans')?.focus({ preventScroll: true }); root.querySelector('#my-plans')?.scrollIntoView({ block: 'start' }); return; }
        if (action === 'back-members') { managementMemberId = ''; render(); root.querySelector('#my-plans')?.focus({ preventScroll: true }); root.querySelector('#my-plans')?.scrollIntoView({ block: 'start' }); return; }
        if (action === 'manage-plan') { managementPlanId = id; managementMemberId = ''; managementMembers = null; Object.assign(memberFilters, membersDefaults); Object.assign(memberDraft, membersDefaults); }
        if (action === 'back-plan-list') { managementPlanId = ''; managementMemberId = ''; managementMembers = null; }
        if (action === 'management-plan-page' || action === 'management-member-page') { const page = Number(target.dataset.page); if (!Number.isInteger(page) || page < 1) return; (action === 'management-plan-page' ? overviewFilters : memberFilters).page = page; managementMemberId = ''; }
        if (action === 'reset-plan-filters') { Object.assign(overviewFilters, overviewDefaults); Object.assign(overviewDraft, overviewDefaults); }
        if (action === 'reset-member-filters') { Object.assign(memberFilters, membersDefaults); Object.assign(memberDraft, membersDefaults); managementMemberId = ''; }
        target.disabled = true; await reload(); const section = root.querySelector('#my-plans'); section?.focus({ preventScroll: true }); section?.scrollIntoView({ block: 'start' }); return;
      }
      if (action === 'add-service') { creationOpen = true; const own = editorServices(); if (planRows.length < Math.min(own.length, 100)) planRows.push({ serviceId: '', units: '1' }); render(); root.querySelector(`[name="serviceId_${planRows.length - 1}"]`)?.focus(); return; }
      if (action === 'remove-service') { creationOpen = true; const index = Number(target.dataset.index); if (Number.isInteger(index) && index >= 0 && index < planRows.length && planRows.length > 1) planRows.splice(index, 1); render(); return; }
      if (action === 'select') { selected = id; acceptedOffer = ''; payerChoice = { mode: 'account', email: '' }; requestKey = payerAttempts.get(id)?.payload.idempotencyKey ?? crypto.randomUUID(); render(); root.querySelector('.plan-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
      if (action === 'auth-toggle') { authRegister = !authRegister; render(); return; }
      if (action === 'recovery-help') {
        if (recoveryEmail && window.RaelRecovery) { window.RaelRecovery.show({ dialog, email: root.querySelector('#plan-auth input[name="email"]')?.value || authFields.email, businessName: catalog?.business.name || '', titleId: 'subscription-dialog-title', send: data => api('customer/password-recovery', data) }); return; }
        dialog.innerHTML = `<h2 id="subscription-dialog-title">Recuperar seu acesso</h2><p>Entre em contato com ${esc(catalog?.business.name || 'o negócio')} pelo contato ${esc(catalog?.business.phone || 'informado na página de agendamento')} e solicite um link pessoal após a conferência da sua identidade.</p><div class="row spaced">${button('Fechar', 'close', '', true)}</div>`; dialog.showModal(); return;
      }
      if (action === 'withdraw') { const s = memberships.find(s => s.id === id); if (!canWithdrawCreation(s)) return; withdrawalDialog(s); return; }
      if (['refresh', 'resume', 'cancel', 'manual-receipt', 'manual-status', 'renewal-policy'].includes(action) && withdrawnCreation(memberships.find(s => s.id === id))) return;
      if (action === 'renewal-policy') { const s = memberships.find(s => s.id === id); if (!staffMode || s?.canManageRenewal !== true) return; renewalDialog(s, target.dataset.allowed === 'true'); return; }
      if (action === 'manual-receipt') { const s = memberships.find(s => s.id === id); if (!s || !manual(s) || !managesManual(s) || renewalBlocked(s)) return; receiptDialog(s); return; }
      if (action === 'manual-status') { const s = memberships.find(s => s.id === id); if (!s || !manual(s) || !managesManual(s)) return; statusDialog(s, target.dataset.active === 'true'); return; }
      if (action === 'refresh') { const s = memberships.find(s => s.id === id); if (!s || !canRefresh(s) || creationStatus(s) === 'preparing' || creationStatus(s) === 'unconfirmed' && !canCheckCreation(s)) return; }
      if (action === 'cancel') { const s = memberships.find(s => s.id === id); if (!s || manual(s) && staffMode && !managesManual(s) || !manual(s) && staffMode && !managesAutomatic(s) || s.canCancel === false) return; const isManual = manual(s); dialog.innerHTML = `<h2 id="subscription-dialog-title">${isManual ? 'Encerrar a assinatura?' : 'Cancelar a renovação?'}</h2><p class="spaced">${esc(s.name)} · ${money(s.priceCents)}/mês</p><p class="muted spaced">${isManual ? 'O encerramento impede novos usos do plano imediatamente, inclusive de saldo ainda disponível. Os agendamentos e recebimentos anteriores são preservados. Combine eventuais devoluções diretamente com o prestador.' : 'O Mercado Pago deixará de gerar novas renovações após confirmar o cancelamento. O ciclo já pago e os agendamentos existentes são preservados. Não solicita reembolso automático.'}</p><div class="row spaced">${button('Manter assinatura', 'close', '', true)}${button(isManual ? 'Confirmar encerramento' : 'Confirmar cancelamento', 'confirm-cancel', `data-id="${id}"`)}</div><div role="alert" class="note error spaced"></div>`; dialog.showModal(); return; }
      if (action === 'resume') { const existing = memberships.find(s => s.id === id); if (!existing?.canCheckout || creationStatus(existing) !== 'ready') return; }
      if (action === 'subscribe' || action === 'resume') { const existing = memberships.find(s => s.id === id), offeredPlan = plans.find(p => p.id === (existing?.planId ?? id)); if (renewalBlocked(existing) || offeredPlan && planRenewalBlocked(offeredPlan)) throw new Error('Este plano está com renovação bloqueada. Fale com o negócio para solicitar a liberação.'); if (existing?.providerPending || offeredPlan && planRenewalPending(offeredPlan)) throw new Error('Aguarde o Mercado Pago confirmar o cancelamento anterior antes de contratar novamente.'); }
      if (action === 'subscribe') { const offer = plans.find(p => p.id === id); if (memberships.some(s => s.planId === id && ['preparing', 'unconfirmed'].includes(creationStatus(s)))) throw new Error('Confira a solicitação em andamento antes de contratar novamente.'); if (!offer || !root.querySelector('#plan-consent')?.checked) throw new Error('Leia e aceite as condições deste plano antes de continuar.'); const existing = currentPayerMembership(id); if (!manual(offer) && (!existing || recordedPayerEmail(existing))) payerEmailFor(offer, true); acceptedOffer = offerConsentKey(offer); }
      busy = true; controlsBusy = true; target.disabled = true;
      if (action === 'staff-logout' && staffMode) { await api('logout', {}); user = null; operationsAvailable = false; location.assign(`/sistema/${encodeURIComponent(slug)}`); return; }
      if (action === 'logout') { window.RaelNotifications?.beforeLogout(); await api('customer/logout', {}); user = null; csrf = ''; memberships = []; resetPayerChoice(); authRegister = false; }
      if (action === 'refresh') { await api(`${staffMode ? '' : 'customer/'}subscriptions/refresh`, { subscriptionId: id }); const wasCreationCheck = memberships.some(s => s.id === id && creationStatus(s) === 'unconfirmed'); if (wasCreationCheck) notice = 'Solicitação conferida. Veja abaixo a situação do link de pagamento.'; }
      if (action === 'subscribe' || action === 'resume') {
        const s = memberships.find(s => s.id === id), offered = !s ? plans.find(p => p.id === id) : null, payload = subscriptionPayload(s, offered);
        if (!manual(s ?? offered)) render();
        const result = await api('customer/subscriptions/start', payload), attempt = payerAttempts.get(payload.planId);
        if (attempt && typeof result.id === 'string') attempt.subscriptionId = result.id;
        if (manual(result)) { selected = ''; notice = 'Adesão registrada. Combine o pagamento com o prestador e aguarde a confirmação do recebimento para usar seu saldo.'; focusMemberships = true; }
        else { const url = new URL(result.url); if (url.protocol !== 'https:' || !['www.mercadopago.com.br', 'mercadopago.com.br', 'sandbox.mercadopago.com.br'].includes(url.hostname) || url.username || url.password || url.port) throw new Error('Link de assinatura inválido.'); location.assign(url.href); return; }
      }
      await reload();
    } catch (err) { error = err.message; if (action === 'subscribe' && controlsBusy && user && !staffMode) { try { memberships = (await api('customer/subscriptions')).subscriptions; syncPayerAttempts(); } catch { /* Preserve the original creation error. */ } } } finally { if (controlsBusy) busy = false; if (!['select', 'cancel', 'manual-receipt', 'manual-status', 'recovery-help', 'add-service', 'remove-service', 'plan-status', 'renewal-policy'].includes(action)) render(); if (['create-plan', 'edit-plan'].includes(action) && creationOpen && !error) { root.querySelector('#plan-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); root.querySelector('#plan-editor input[name="name"]')?.focus({ preventScroll: true }); } if (error) focusPlanError(); if (focusMemberships) { const section = root.querySelector('#my-plans'); section?.focus({ preventScroll: true }); section?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }
  });
  dialog.addEventListener('click', async e => {
    const t = e.target.closest('[data-sub-action]'); if (!t || busy) return;
    if (t.dataset.subAction === 'close') { withdrawalDraft = null; dialog.close(); return; }
    if (t.dataset.subAction === 'confirm-withdraw') {
      const current = memberships.find(s => s.id === t.dataset.id);
      if (!dialog.open || !withdrawalDraft || withdrawalDraft.id !== current?.id || withdrawalDraft.revision !== t.dataset.revision || !canWithdrawCreation(current) || current.withdrawalRevision !== t.dataset.revision) return;
      busy = true; t.disabled = true; let completed = false, showError = false;
      try {
        const result = await api('customer/subscriptions/withdraw', { subscriptionId: current.id, expectedRevision: t.dataset.revision, confirmed: true });
        if (result?.id === current.id && withdrawnCreation(result)) memberships = memberships.map(s => s.id === current.id ? result : s);
        payerAttempts.delete(current.planId); payerChoice = { mode: 'account', email: '' }; selected = ''; acceptedOffer = ''; requestKey = crypto.randomUUID();
        notice = 'Solicitação anterior encerrada neste sistema e mantida em conferência. Para contratar novamente, escolha Conhecer este plano e aceite as condições outra vez.';
        completed = true; withdrawalDraft = null; dialog.close(); await reload();
      } catch (err) {
        let reloaded = false;
        if (!completed && err.status !== 401) { try { await reload(); reloaded = true; } catch { /* Preserve the withdrawal error; API session expiry still clears the access. */ } }
        const latest = memberships.find(s => s.id === current.id), changed = reloaded && (!canWithdrawCreation(latest) || latest.withdrawalRevision !== t.dataset.revision);
        if (completed || err.status === 401 || !user || changed) { withdrawalDraft = null; dialog.close(); error = err.message; showError = true; }
        else { const alert = dialog.querySelector('[role=alert]'); alert.textContent = err.message; alert.focus?.(); }
      } finally {
        busy = false; t.disabled = false;
        if (completed || showError) { render(); if (showError) focusPlanError(); else { root.querySelector('#my-plans')?.focus({ preventScroll: true }); root.querySelector('#my-plans')?.scrollIntoView({ block: 'start' }); } }
      }
      return;
    }
    if (t.dataset.subAction === 'confirm-renewal-policy') {
      const s = memberships.find(s => s.id === t.dataset.id); if (!staffMode || s?.canManageRenewal !== true || withdrawnCreation(s)) return;
      busy = true; t.disabled = true;
      try { const allowed = t.dataset.allowed === 'true', result = await api('subscriptions/renewal-policy', { subscriptionId: s.id, allowed, expectedRevision: s.renewalRevision }); notice = allowed ? manual(s) ? 'Renovação permitida. Novos períodos podem ser confirmados após o recebimento, sem alterar o saldo atual.' : result.providerPending ? 'Permissão salva. Aguarde o Mercado Pago confirmar o cancelamento do contrato anterior; nenhuma cobrança automática foi reativada.' : 'Renovação permitida. Uma nova cobrança automática exige a contratação e o consentimento do consumidor; o contrato anterior não foi reativado.' : result.providerPending ? 'Bloqueio salvo. O Mercado Pago ainda precisa confirmar o cancelamento das próximas cobranças. O período já pago e os agendamentos foram preservados.' : 'Renovação bloqueada. O período já pago, o saldo e os agendamentos foram preservados.'; await reload(); dialog.close(); }
      catch (err) { if (err.status === 401) { dialog.close(); error = err.message; render(); } else dialog.querySelector('[role=alert]').textContent = err.message; }
      finally { busy = false; t.disabled = false; render(); }
      return;
    }
    if (t.dataset.subAction === 'confirm-plan-status') {
      const p = editablePlan(t.dataset.id); if (p?.canToggle !== true) return;
      busy = true; t.disabled = true;
      try { await api('subscriptions/plan-status', { planId: p.id, active: t.dataset.active === 'true', expectedRevision: p.revision }); notice = t.dataset.active === 'true' ? 'Plano ativado para novas adesões. Os contratos existentes foram preservados.' : 'Plano inativado para novas adesões. As assinaturas existentes continuam preservadas.'; if (editingPlan?.id === p.id) resetPlanEditor(); await reload(); dialog.close(); }
      catch (err) { if (err.status === 401) { dialog.close(); error = err.message; render(); } else dialog.querySelector('[role=alert]').textContent = err.message; }
      finally { busy = false; t.disabled = false; render(); }
      return;
    }
    if (!['confirm-cancel', 'confirm-manual-status'].includes(t.dataset.subAction)) return;
    const current = memberships.find(s => s.id === t.dataset.id);
    if (!current || withdrawnCreation(current) || staffMode && (manual(current) ? !managesManual(current) : !managesAutomatic(current)) || t.dataset.subAction === 'confirm-cancel' && current.canCancel === false) return;
    busy = true; t.disabled = true; let completed = false;
    try { const status = t.dataset.subAction === 'confirm-manual-status'; await api(status ? 'subscriptions/manual-status' : `${staffMode ? '' : 'customer/'}subscriptions/cancel`, { subscriptionId: t.dataset.id, ...(status ? { active: t.dataset.active === 'true' } : {}) }); if (!status && !manual(current)) { payerAttempts.delete(current.planId); payerChoice = { mode: 'account', email: '' }; } notice = status ? t.dataset.active === 'true' ? 'Uso reativado com o saldo e a validade anteriores.' : 'Uso suspenso. Os agendamentos existentes foram preservados.' : manual(memberships.find(s => s.id === t.dataset.id) ?? {}) ? 'Assinatura encerrada. Agendamentos e recebimentos anteriores foram preservados.' : 'Cancelamento confirmado.'; await reload(); dialog.close(); completed = true; }
    catch (err) { if (staffMode && err.status === 401) { dialog.close(); error = err.message; render(); } else dialog.querySelector('[role=alert]').textContent = err.message; }
    finally { busy = false; t.disabled = false; if (completed) render(); }
  });
  function retainReceipt(event) { const t = event.target; if (t.form?.id !== 'plan-manual-receipt' || !receiptDraft) return; if (t.name === 'method' || t.name === 'note') receiptDraft[t.name] = t.value; if (t.name === 'receivedConfirmed') receiptDraft.receivedConfirmed = t.checked; }
  dialog.addEventListener('input', retainReceipt); dialog.addEventListener('change', retainReceipt);
  dialog.addEventListener('submit', async e => {
    if (e.target.id !== 'plan-manual-receipt') return; e.preventDefault(); if (busy || !receiptDraft || withdrawnCreation(memberships.find(s => s.id === receiptDraft.subscriptionId))) return;
    const form = e.target, data = Object.fromEntries(new FormData(form)), alert = dialog.querySelector('[role=alert]');
    if (data.receivedConfirmed !== 'on') { alert.textContent = 'Confirme que você já recebeu o valor antes de registrar.'; return; }
    busy = true; const submit = form.querySelector('[type=submit]'); submit.disabled = true; alert.textContent = '';
    const payload = { subscriptionId: receiptDraft.subscriptionId, idempotencyKey: receiptDraft.idempotencyKey, expectedCycleEndAt: receiptDraft.expectedCycleEndAt, method: data.method, note: data.note, receivedConfirmed: true };
    let completed = false;
    try { await api('subscriptions/manual-receipt', payload); notice = 'Recebimento registrado no financeiro e período de um mês confirmado.'; await reload(); receiptDraft = null; dialog.close(); completed = true; }
    catch (err) { if (err.status === 401) { dialog.close(); error = err.message; render(); } else alert.textContent = err.message; }
    finally { busy = false; submit.disabled = false; if (completed) render(); }
  });
  root.addEventListener('submit', async e => {
    if (managementView && ['management-plan-filters', 'management-member-filters'].includes(e.target.id)) {
      e.preventDefault(); if (busy) return;
      const values = Object.fromEntries(new FormData(e.target)), isOverview = e.target.id === 'management-plan-filters', filters = isOverview ? overviewFilters : memberFilters, draft = isOverview ? overviewDraft : memberDraft;
      for (const key of Object.keys(isOverview ? overviewDefaults : membersDefaults)) if (!['page', 'pageSize'].includes(key)) filters[key] = draft[key] = String(values[key] ?? (key === 'sort' ? isOverview ? 'active_desc' : 'name_asc' : ''));
      filters.page = 1; managementMemberId = ''; error = ''; notice = '';
      try { await reload(); } catch (err) { error = err.message; } finally { render(); }
      return;
    }
    if (!['plan-auth', 'plan-create'].includes(e.target.id)) return; e.preventDefault(); if (busy) return;
    const data = Object.fromEntries(new FormData(e.target));
    if (e.target.id === 'plan-create') { for (const key of Object.keys(planFields)) if (Object.hasOwn(data, key)) planFields[key] = data[key]; planRows = Object.keys(data).filter(key => /^serviceId_\d+$/.test(key)).sort((a, b) => Number(a.split('_')[1]) - Number(b.split('_')[1])).map(key => ({ serviceId: data[key], units: data['units_' + key.split('_')[1]] ?? '' })); }
    busy = true; e.target.querySelector('button[type=submit],button:not([type])').disabled = true; error = '';
    try {
      if (e.target.id === 'plan-auth') { if (authRegister && data.password !== data.confirmation) throw new Error('As senhas precisam ser iguais.'); const r = await api(authRegister ? 'customer/register' : 'customer/login', authRegister ? { name: data.name, phone: data.phone, email: data.email, password: data.password } : { email: data.email, password: data.password }); user = r.customer; csrf = r.csrf; resetPayerChoice(); }
      else { const scope = editingPlan?.scope ?? data.scope ?? planFields.scope; if (scope === 'business' && (user?.role !== 'admin' || !editingPlan && !managementCanCreateBusiness)) throw new Error('Somente o gestor pode criar planos do negócio com recebimento centralizado.'); if (!editingPlan && scope !== 'business' && !managementCanCreate) throw new Error('Seu acesso não permite criar este plano.'); if (!/^\d+(?:\.\d{1,2})?$/.test(data.price)) throw new Error('Informe o valor com até duas casas decimais.'); if (data.billingMethod === 'manual' && data.externalPaymentUrl?.trim() && !externalUrl(data.externalPaymentUrl.trim())) throw new Error('Use um link de pagamento público com HTTPS, sem usuário ou senha no endereço.'); const services = Object.keys(data).filter(key => /^serviceId_\d+$/.test(key)).sort((a, b) => Number(a.split('_')[1]) - Number(b.split('_')[1])).map(key => ({ serviceId: data[key], units: Number(data['units_' + key.split('_')[1]]) })); if (!services.length || services.some(item => !item.serviceId || !Number.isInteger(item.units) || item.units < 1 || item.units > 100)) throw new Error('Escolha os serviços e informe de 1 a 100 atendimentos por mês para cada um.'); if (new Set(services.map(item => item.serviceId)).size !== services.length) throw new Error('Cada serviço deve aparecer uma única vez. Ajuste a quantidade na mesma linha.'); const wasEditing = Boolean(editingPlan); await api(wasEditing ? 'subscriptions/plan-update' : 'subscriptions/plan', { ...(wasEditing ? { planId: editingPlan.id, expectedRevision: editingPlan.revision } : {}), ...(scope === 'business' ? { scope: 'business' } : {}), name: data.name, services, priceCents: Math.round(Number(data.price) * 100), active: wasEditing ? editingPlan.active : true, billingMethod: data.billingMethod, ...(data.billingMethod === 'manual' ? { paymentInstructions: data.paymentInstructions?.trim() ?? '', externalPaymentUrl: data.externalPaymentUrl?.trim() ?? '' } : {}) }); resetPlanEditor(); notice = wasEditing ? 'Plano atualizado para novas adesões. Os contratos já assinados mantêm as condições originais.' : 'Plano criado. A forma de recebimento aparece nas condições para o cliente.'; }
      await reload();
    } catch (err) { error = err.message; } finally { busy = false; render(); }
  });
  (async () => { try { if (staffMode && parts[2] === 'planos') history.replaceState(null, '', `/sistema/${encodeURIComponent(slug)}/assinaturas${location.search}${location.hash}`); const meta = await api('meta'); testMode = meta.testMode; recoveryEmail = meta.recoveryEmail === true; try { const session = await api(staffMode ? 'session' : 'customer/session'); user = staffMode ? session.user : session.customer; operationsAvailable = staffMode && session.operationsAvailable === true; sessionBusinessName = staffMode ? session.businessName ?? '' : ''; csrf = session.csrf; } catch (err) { if (err.status !== 401) throw err; } catalog = await api('catalog').catch(() => null); await reload(); if (!staffMode && location.search) { history.replaceState(null, '', location.pathname); document.querySelector('#my-plans')?.scrollIntoView(); } else if (location.hash === '#my-plans') document.querySelector('#my-plans')?.scrollIntoView(); } catch (err) { error = err.message; render(); } })();
})();
