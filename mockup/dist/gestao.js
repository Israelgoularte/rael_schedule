import { parseClientsCsv, clientsCsv } from './gestao-csv.js?v=092';

const root = document.querySelector('#management-root'), dialog = document.querySelector('#management-dialog');
const [, slug, section] = location.pathname.split('/').filter(Boolean);
const view = ['clientes', 'financeiro', 'painel', 'acessos'].includes(section) ? section : 'painel';
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = v => (Number(v ?? 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const labels = { confirmed: 'Confirmado', awaiting_payment: 'Aguardando pagamento', expired: 'Expirado', in_progress: 'Em atendimento', completed: 'Concluído', cancelled: 'Cancelado', no_show: 'Falta' };
const methods = { cash: 'Dinheiro', pix: 'Pix recebido fora da plataforma', card: 'Cartão na maquininha', transfer: 'Transferência', other: 'Outro', external: 'Link externo', mercadopago: 'Mercado Pago' };
const sources = { manual: 'Registro manual', mercadopago: 'Mercado Pago · avulso', subscription: 'Assinatura' };
const sourceLabel = e => e.source === 'subscription' ? (e.method === 'mercadopago' ? 'Mercado Pago · assinatura' : 'Recebimento manual · assinatura') : (sources[e.source] ?? e.source);
const titles = { clientes: 'Clientes', financeiro: 'Financeiro', painel: 'Visão geral', acessos: 'Acessos' };
const descriptions = { acessos: 'Veja de onde vieram os acessos à vitrine e as reservas.', clientes: 'Encontre seus clientes, mantenha os dados em dia e consulte o histórico de atendimentos.', financeiro: 'Acompanhe o que foi registrado e o que ainda é estimado. Cada recebimento conserva sua origem.', painel: 'Sua agenda e seus recebimentos em um só lugar, com números calculados a partir dos registros do negócio.' };
let operationsAvailable = false;
let user, csrf = '', setup, testMode = false, model, busy = false, error = '', q = '', offset = 0, appointmentOffset = 0, historyOffset = 0, detailCustomer = null, financeDetail = null, manualKey, manualStorageKey, importRows, importPreview, importKey, importRevision = 0;
let filters = { from: '', to: '', professionalId: '' };
const requestedTrafficDays = new URLSearchParams(location.search).get('days');
const trafficDays = ['7', '30', '90'].includes(requestedTrafficDays) ? requestedTrafficDays : '30';
const button = (label, action, extra = '', secondary = true) => `<button type="button" class="button ${secondary ? 'secondary' : ''}" data-manage="${action}" ${extra}>${label}</button>`;
const field = (label, name, value = '', extra = '', type = 'text') => `<label class="field"><span>${esc(label)}</span><input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
const formatDate = at => new Intl.DateTimeFormat('pt-BR', { timeZone: model?.timeZone ?? setup?.draft?.business.timeZone ?? 'America/Sao_Paulo', dateStyle: 'short' }).format(at);
const formatTime = at => new Intl.DateTimeFormat('pt-BR', { timeZone: model?.timeZone ?? setup?.draft?.business.timeZone ?? 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(at);
async function api(path, data) {
  const r = await fetch(`/internal/${encodeURIComponent(slug)}/${path}`, { credentials: 'same-origin', ...(data ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(data) } : {}) });
  let result; try { result = await r.json(); } catch { throw new Error('A conexão foi interrompida. Tente novamente; um registro já enviado não será duplicado.'); }
  if (!r.ok) { if (r.status === 401) { user = null; operationsAvailable = false; csrf = ''; setup = null; model = null; detailCustomer = null; financeDetail = null; if (dialog.open) dialog.close(); } throw Object.assign(new Error(result.error || 'Não foi possível concluir.'), { status: r.status }); } return result;
}
function header() {
  return `${testMode ? '<div class="test-banner">Ambiente de validação · somente dados fictícios · nenhum e-mail ou pagamento real é enviado</div>' : ''}${window.RaelWorkspace.render({ slug, businessName: setup?.draft?.business.name ?? setup?.businessName ?? setup?.catalog?.business?.name, user, active: view, operationsAvailable, logoutHtml: user ? button('Sair', 'logout', 'aria-label="Sair da minha conta"') : '' })}<aside id="license-banner" aria-label="Assinatura da plataforma"></aside>`;
}
const empty = text => `<div class="management-empty">${text}</div>`;
const metric = (label, value, help, estimate = false) => `<article class="metric ${estimate ? 'estimated' : ''}"><span>${label}</span><strong>${value}</strong><small>${help}</small></article>`;
function periodForm() { return `<form id="period-filter" class="management-filters card">${field('De', 'from', filters.from, 'required', 'date')}${field('Até', 'to', filters.to, 'required', 'date')}${user.role !== 'professional' ? `<label class="field"><span>Profissional</span><select name="professionalId"><option value="">Todos os profissionais</option>${model.professionals.map(p => `<option value="${p.id}" ${filters.professionalId === p.id ? 'selected' : ''}>${esc(p.name)}${p.active ? '' : ' (inativo)'}</option>`).join('')}</select></label>` : ''}<button class="button" type="submit">Aplicar filtros</button></form>`; }
function pager(pageOffset, hasMore, action, total) { return `<div class="management-pager"><p class="small muted">${total === undefined ? `Página ${pageOffset / 25 + 1}` : `${total} registro(s) · página ${pageOffset / 25 + 1}`}</p><div class="row">${button('← Anterior', action, `data-offset="${Math.max(0, pageOffset - 25)}" ${pageOffset ? '' : 'disabled'}`)}${button('Próxima →', action, `data-offset="${pageOffset + 25}" ${hasMore ? '' : 'disabled'}`)}</div></div>`; }
function customerList() { return `<form id="customer-filter" class="management-filters"><label class="field search"><span>Buscar cliente</span><input name="q" value="${esc(q)}" maxlength="100" placeholder="Nome, WhatsApp ou e-mail"></label><button class="button" type="submit">Buscar</button></form><div class="management-list">${model.customers.map(c => `<article class="management-item"><div><h3>${esc(c.name)}</h3><p>${esc(c.phone)}<br>${esc(c.email)}</p><p>${c.accessEnabled ? 'Acesso do cliente ativo' : 'Sem acesso ativado · recuperação assistida pelo administrador'}</p></div>${button('Ver cadastro e histórico', 'customer-detail', `data-id="${c.id}"`)}</article>`).join('') || empty('Nenhum cliente encontrado. Você pode mudar a busca ou cadastrar o primeiro cliente.')}</div>${pager(offset, model.hasMore, 'customers-page', model.total)}`; }
function receiptCards() { const t = model.totals; return `<div class="management-kpis">${metric('Recebimento registrado', money(t.netCents), 'Recebimentos menos devoluções no período. Tarifas não deduzidas.')}${metric('Recebimento estimado fora da plataforma', money(t.estimatedCents), 'Saldo dos serviços agendados sem pagamento online ou baixa manual. Não comprova recebimento.', true)}${metric('Registrado manualmente', money(t.manualNetCents), 'Dinheiro, Pix externo, maquininha e outros, menos devoluções.')}${metric('Devoluções e ajustes registrados', money(t.refundsCents), 'Histórico preservado. Nenhum valor é transferido por esta tela.')}</div>`; }
function financeList() {
  return `${periodForm()}${receiptCards()}<div class="note finance-disclaimer">A estimativa usa a <strong>data do atendimento</strong> e exclui cancelamentos, faltas e serviços cobertos por plano. Uma baixa manual reduz a estimativa. Os valores registrados usam a <strong>data do recebimento/devolução</strong> e podem pertencer a outros atendimentos. Não some as duas colunas como se fossem um único saldo. De atendimentos já concluídos, ${money(model.totals.completedEstimatedCents)} ainda estão sem baixa.</div><section class="management-section"><h2>Atendimentos e saldo</h2><div class="management-list">${model.appointments.map(a => `<article class="management-item"><div><span class="badge">${labels[a.status] ?? esc(a.status)}</span><h3>${esc(a.customerName)}</h3><p>${esc(a.serviceName)} · ${esc(a.professionalName)}<br>${formatTime(a.startAt)}</p><p>${a.coveredByPlan ? 'Incluído no plano · não gera receita novamente' : `${money(a.priceCents)} em serviços · ${money(a.receivedCents)} registrados · ${money(a.pendingCents)} sem baixa`}</p>${a.estimatedCents ? `<p>Estimado fora da plataforma: <strong>${money(a.estimatedCents)}</strong></p>` : ''}${a.needsReview ? '<p class="note warning">Há recebimento em atendimento cancelado, expirado ou com falta. Confira a resolução.</p>' : ''}</div><div class="row">${button(a.canRecord ? 'Registrar recebimento' : 'Ver lançamentos', 'finance-detail', `data-id="${a.appointmentId}"`)}</div></article>`).join('') || empty('Nenhum atendimento neste período.')}</div>${pager(appointmentOffset, model.appointmentHasMore, 'appointments-page', model.appointmentTotal)}</section><section class="management-section"><h2>Histórico de recebimentos e devoluções</h2><p class="small muted">Online avulso: ${money(model.totals.onlineNetCents)} · Assinaturas: ${money(model.totals.subscriptionNetCents)}. Valores líquidos de devoluções, antes de tarifas.</p><div class="management-list">${model.entries.map(e => `<article class="management-item"><div><span class="badge">${esc(sourceLabel(e))}</span><h3>${esc(e.customerName)}</h3><p>${formatDate(e.occurredAt)} · ${esc(e.professionalName)} · ${esc(methods[e.method] ?? e.method)}<br>${esc(e.note)}${e.actorName ? `<br>Registrado por ${esc(e.actorName)}` : ''}</p>${e.dateSource === 'manual_confirmed' ? '<p>Data da confirmação de recebimento pela equipe.</p>' : e.dateSource === 'recorded' ? '<p>Data do registro no Rael; data original não informada pelo provedor.</p>' : ''}</div><div class="amount">${e.kind === 'refund' ? '−' : '+'} ${money(e.amountCents)}</div></article>`).join('') || empty('Nenhum recebimento registrado neste período. Estimativas não aparecem neste histórico.')}</div>${pager(offset, model.hasMore, 'entries-page')}</section>`;
}
function dashboard() {
  const s = model.statuses, total = Object.values(s).reduce((a, b) => a + b, 0), max = Math.max(1, ...model.daily.map(d => Math.abs(d.netCents)));
  return `${periodForm()}${receiptCards()}<div class="management-kpis">${metric('Agendamentos no período', String(total), `${s.confirmed ?? 0} confirmados · ${s.in_progress ?? 0} em atendimento`)}${metric('Atendimentos concluídos', String(s.completed ?? 0), `${s.no_show ?? 0} falta(s) · ${s.cancelled ?? 0} cancelamento(s)`)}${metric('Novos clientes', String(model.newCustomers), 'Cadastros criados no período, respeitando seu acesso.')}${metric('Ocupação do expediente', model.occupancy.percent === null ? 'Sem expediente' : `${model.occupancy.percent.toLocaleString('pt-BR')}%`, `${model.occupancy.occupiedMinutes} min reservados / ${model.occupancy.availableMinutes} min disponíveis`)}</div><div class="note">A estimativa não confirma pagamento e diminui quando houver baixa manual. ${money(model.totals.completedEstimatedCents)} da estimativa são de atendimentos já concluídos. Assinaturas são contadas pelo recebimento da mensalidade, sem repetir receita em cada atendimento.</div><div class="management-grid"><section class="card"><h2>Movimento registrado por dia</h2><p class="small muted spaced">Recebimentos menos devoluções, antes de tarifas.</p><div class="trend-list">${model.daily.map(d => `<div class="trend-row ${d.netCents < 0 ? 'negative' : ''}"><span>${d.date.slice(8)}/${d.date.slice(5, 7)}</span><div class="trend-bar"><span style="--bar-width:${Math.max(1, Math.abs(d.netCents) / max * 100)}%"></span></div><strong>${money(d.netCents)}</strong></div>`).join('') || '<p class="muted small">Sem recebimentos registrados no período.</p>'}</div></section><section class="card"><h2>Atendimentos por profissional</h2><div class="management-list">${model.byProfessional.map(p => `<div><strong>${esc(p.name)}</strong><p class="small muted">${p.appointments} agendamento(s) · ${p.completed} concluído(s)<br>${money(p.estimatedCents)} estimados fora da plataforma</p></div>`).join('') || '<p class="small muted">Nenhum profissional cadastrado.</p>'}</div><p class="small muted">${esc(model.occupancy.basis)}</p></section></div>`;
}
function traffic() {
  const fmt = value => Number(value).toLocaleString('pt-BR');
  const columns = [['utm_source', 'Origem'], ['utm_medium', 'Meio'], ['utm_campaign', 'Campanha'], ['utm_content', 'Conteúdo'], ['utm_term', 'Termo']];
  const rows = model.campaigns.map(({ utms, visits, bookings }) => `<tr>${columns.map(([key], index) => `<td>${esc(utms[key] ?? (index === 0 && !Object.keys(utms).length ? 'Sem UTM' : '—'))}</td>`).join('')}<td class="traffic-number">${fmt(visits)}</td><td class="traffic-number">${fmt(bookings)}</td></tr>`).join('');
  return `<form method="get" class="management-filters card">
      <label class="field"><span>Período</span><select name="days">${[7, 30, 90].map(days => `<option value="${days}" ${days === model.days ? 'selected' : ''}>Últimos ${days} dias</option>`).join('')}</select></label>
      <button class="button" type="submit">Aplicar filtro</button>
    </form>
    <div class="management-kpis">
      ${metric('Acessos à página inicial', fmt(model.totals.visits), 'Aberturas da página, incluindo visitas sem UTM.')}
      ${metric('Agendamentos criados', fmt(model.totals.bookings), 'Reservas pela data em que foram feitas.')}
    </div>
    <section class="management-section">
      <h2>Resultado por UTM</h2>
      ${rows ? `<div class="traffic-table" tabindex="0" role="region" aria-label="Resultados por UTM"><table><thead><tr>${columns.map(([, label]) => `<th scope="col">${label}</th>`).join('')}<th scope="col">Acessos</th><th scope="col">Agendamentos</th></tr></thead><tbody>${rows}</tbody></table></div>` : empty('Nenhum acesso ou agendamento no período.')}
      ${model.campaignCount > model.campaigns.length ? '<p class="small muted">A tabela mostra até 100 combinações. Os totais incluem todas elas.</p>' : ''}
    </section>`;
}
function render() {
  document.title = `${titles[view]} · Rael Agendamentos`;
  root.innerHTML = header() + `<main id="main" class="management-shell"><div class="management-heading"><div><div class="eyebrow">${user?.role === 'professional' ? 'Seu espaço individual' : 'Gestão do negócio'}</div><h1>${titles[view]}</h1><p>${descriptions[view]}</p></div>${view === 'clientes' && model?.canEdit ? `<div class="row">${button('Novo cliente', 'new-customer', '', false)}${model.canTransfer ? button('Importar CSV', 'import') + button('Exportar CSV', 'export') : ''}</div>` : ''}</div><div class="note error management-error" role="alert">${esc(error)}</div>${!model ? empty('Não foi possível carregar os registros. Atualize a página para tentar novamente.') : view === 'clientes' ? customerList() : view === 'financeiro' ? financeList() : view === 'acessos' ? traffic() : dashboard()}</main>`; window.RaelTheme?.sync(); window.RaelWorkspace.sync(); window.RaelLicenseNotice?.mount(slug, user?.role);
}
async function load() {
  if (view === 'acessos') {
    model = await api('traffic?' + new URLSearchParams({ days: trafficDays }));
    render();
    return;
  }
  const params = new URLSearchParams(view === 'clientes' ? { q, offset: String(offset) } : { ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), offset: String(offset), appointmentOffset: String(appointmentOffset) });
  model = await api((view === 'clientes' ? 'customers' : view === 'financeiro' ? 'finance' : 'dashboard') + '?' + params);
  if (view !== 'clientes') filters = { from: model.from, to: model.to, professionalId: model.professionalId };
  render();
}
function modal(title, html) { dialog.innerHTML = `<button type="button" class="dialog-close" data-manage="close" aria-label="Fechar">×</button><h2 id="management-dialog-title">${esc(title)}</h2><div class="management-detail">${html}<div class="note error management-error spaced" role="alert"></div></div>`; if (!dialog.open) dialog.showModal(); }
function customerForm(c) {
  const allowed = user.role !== 'professional';
  return `${allowed ? `<form id="customer-edit">${field('Nome', 'name', c?.name, 'minlength="2" maxlength="120" required')}${field('WhatsApp com DDD', 'phone', c?.phone, 'maxlength="25" required', 'tel')}${field('E-mail', 'email', c?.email, 'maxlength="254" autocomplete="off" required', 'email')}<label class="field"><span>Observações internas</span><textarea name="notes" maxlength="3000">${esc(c?.notes)}</textarea><small>Use apenas informações necessárias ao atendimento. Não ficam visíveis ao cliente.</small></label>${c?.accessEnabled ? `<div class="note warning">Trocar o e-mail de um cliente com acesso revoga a senha e as sessões atuais. O administrador deverá conferir a identidade e gerar uma recuperação manual.</div>${user.role === 'admin' ? '<label class="check-line"><input type="checkbox" name="identityConfirmed">Conferi a identidade para uma eventual troca de e-mail.</label>' : ''}` : '<p class="small muted">Cadastrar o contato não cria senha nem envia convite automaticamente.</p>'}<button class="button form-actions" type="submit">Salvar cadastro</button></form>` : `<p>${esc(c.name)}<br>${esc(c.phone)}<br>${esc(c.email)}</p>`}`;
}
async function openCustomer(id, pageOffset = 0) {
  const result = await api('customers/detail?' + new URLSearchParams({ id, offset: String(pageOffset) })); detailCustomer = result.customer; historyOffset = pageOffset;
  modal('Cadastro e histórico', `${customerForm(result.customer)}${user.role === 'admin' ? '<h3>Acesso do cliente</h3><label class="check-line"><input type="checkbox" id="recovery-identity">Conferi a identidade do cliente para liberar a recuperação.</label>' + button('Gerar link pessoal', 'customer-recovery') : ''}<h3>Histórico de atendimentos</h3><div class="management-list">${result.history.map(a => `<article class="management-item"><div><span class="badge">${labels[a.status] ?? esc(a.status)}</span><h3>${esc(a.snapshot.service.name)}</h3><p>${formatTime(a.startAt)} · ${esc(a.snapshot.professional.name)}<br>${a.snapshot.subscription ? 'Incluído no plano ' + esc(a.snapshot.subscription.planName) : money(a.snapshot.service.priceCents)}</p></div>${button('Ver financeiro', 'finance-detail', `data-id="${a.id}"`)}</article>`).join('') || empty('Nenhum atendimento neste acesso.')}</div>${pager(historyOffset, result.hasMore, 'history-page')}`);
}
function manualForm(refund) {
  const amount = refund ? refund.refundableCents : financeDetail.pendingCents;
  return `<form id="manual-entry"><div class="note ${refund ? 'warning' : ''}">${refund ? 'Este registro documenta uma devolução ou corrige uma baixa manual. Não transfere dinheiro nem reembolsa pelo Mercado Pago.' : 'Registre somente um valor efetivamente recebido. A baixa não altera a situação do atendimento nem simula aprovação do Mercado Pago.'}</div>${field('Valor (R$)', 'amount', (amount / 100).toFixed(2), `min="0.01" max="${amount / 100}" step="0.01" inputmode="decimal" required`, 'number')}<label class="field"><span>Forma de ${refund ? 'devolução' : 'recebimento'}</span><select name="method">${Object.entries(methods).filter(([key]) => !['mercadopago', 'external'].includes(key)).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select></label>${field('Data informada', 'date', financeDetail.today ?? model.today, 'required', 'date')}${field(refund ? 'Motivo da devolução ou correção' : 'Observação (opcional)', 'note', '', `maxlength="250" ${refund ? 'minlength="3" required' : ''}`)}<button class="button form-actions" type="submit">${refund ? 'Registrar devolução/correção' : 'Confirmar recebimento manual'}</button></form>`;
}
function pendingManualKey(id, refund = '') {
  manualStorageKey = `rael-manual-${slug}-${id}-${refund || 'receipt'}`;
  try { const key = sessionStorage.getItem(manualStorageKey); if (key) return key; const created = crypto.randomUUID(); sessionStorage.setItem(manualStorageKey, created); return created; } catch { return crypto.randomUUID(); }
}
async function openFinance(id) {
  financeDetail = await api('finance/appointment?id=' + encodeURIComponent(id)); manualKey = pendingManualKey(id);
  modal('Recebimentos do atendimento', `<h3>${esc(financeDetail.customerName)}</h3><p class="small muted">${esc(financeDetail.serviceName)} · ${esc(financeDetail.professionalName)}<br>${formatTime(financeDetail.startAt)} · ${labels[financeDetail.status]}</p><p class="spaced"><strong>${money(financeDetail.receivedCents)} registrados</strong> · ${money(financeDetail.pendingCents)} sem baixa</p>${financeDetail.coveredByPlan ? '<div class="note">Atendimento incluído em plano. Não registrar a mensalidade novamente nesta reserva.</div>' : financeDetail.requireOnline ? '<div class="note">Cobrança online: acompanhada pelo Mercado Pago, sem baixa manual nesta tela.</div>' : ''}${financeDetail.canRecord ? '<h3>Registrar valor recebido</h3>' + manualForm() : ''}<h3>Lançamentos</h3><div class="management-list">${financeDetail.entries.map(e => `<article class="management-item"><div><strong>${e.kind === 'refund' ? 'Devolução/ajuste' : 'Recebimento'} · ${money(e.amountCents)}</strong><p>${formatDate(e.occurredAt)} · ${esc(sourceLabel(e))}<br>${esc(methods[e.method])}<br>${esc(e.note)}${e.actorName ? '<br>Por ' + esc(e.actorName) : ''}</p>${e.canRefund && e.refundableCents > 0 ? button('Registrar devolução/correção', 'refund', `data-id="${e.id}"`) : ''}</div></article>`).join('') || empty('Nenhum recebimento registrado para este atendimento.')}</div>`);
}
let refundOf;
function download(name, csv) { const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function importModal() { importRevision++; importPreview = null; importRows = null; importKey = crypto.randomUUID(); modal('Importar clientes', `<p class="small muted">CSV com até 200 clientes e 200 KB. E-mails ou telefones já cadastrados não serão sobrescritos. Confira a prévia antes de importar as linhas válidas.</p>${button('Baixar modelo CSV', 'csv-template')}<form id="import-preview"><label class="field"><span>Escolher arquivo CSV</span><input name="file" type="file" accept=".csv,text/csv"></label><label class="field"><span>Ou cole o conteúdo do CSV</span><textarea name="csv" maxlength="200000" placeholder="nome;whatsapp;email;observacoes"></textarea></label><button class="button" type="submit">Conferir prévia</button></form><div id="import-result"></div>`); }
function invalidateImportPreview(event) {
  if (event.target.form?.id !== 'import-preview' || !['csv', 'file'].includes(event.target.name)) return;
  importRevision++; importRows = null; importPreview = null;
  const result = dialog.querySelector('#import-result');
  if (result) result.innerHTML = '<p class="note spaced">O conteúdo mudou. Confira uma nova prévia antes de importar.</p>';
}
document.addEventListener('input', invalidateImportPreview);
document.addEventListener('change', invalidateImportPreview);
function moneyInput(value) { if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error('Informe o valor com até duas casas decimais.'); return Math.round(Number(value) * 100); }
document.addEventListener('click', async e => {
  const target = e.target.closest('[data-manage]'); if (!target || target.disabled || busy) return; const action = target.dataset.manage;
  error = '';
  try {
    if (action === 'logout') { await api('logout', {}); user = null; operationsAvailable = false; location.assign(`/sistema/${encodeURIComponent(slug)}`); return; }
    if (action === 'close') { dialog.close(); return; }
    if (action === 'new-customer') { detailCustomer = null; modal('Novo cliente', customerForm()); return; }
    if (action === 'import') { importModal(); return; }
    if (action === 'csv-template') { download('modelo-clientes.csv', clientsCsv([{ name: 'Cliente Exemplo', phone: '5511000000000', email: 'cliente@example.com', notes: 'Preferência de atendimento' }])); return; }
    busy = true; target.disabled = true;
    if (action === 'customers-page' || action === 'entries-page') { offset = Number(target.dataset.offset); await load(); }
    if (action === 'appointments-page') { appointmentOffset = Number(target.dataset.offset); await load(); }
    if (action === 'customer-detail') await openCustomer(target.dataset.id);
    if (action === 'history-page') await openCustomer(detailCustomer.id, Number(target.dataset.offset));
    if (action === 'finance-detail') { refundOf = null; await openFinance(target.dataset.id); }
    if (action === 'refund') { const original = financeDetail.entries.find(e => e.id === target.dataset.id); refundOf = original.id; manualKey = pendingManualKey(financeDetail.appointmentId, refundOf); modal('Registrar devolução ou correção', `<h3>${esc(financeDetail.customerName)}</h3><p class="small muted">Até ${money(original.refundableCents)} deste recebimento.</p>${manualForm(original)}`); }
    if (action === 'export') { const result = await api('customers/export', { q }); download('clientes-rael.csv', clientsCsv(result.customers)); }
    if (action === 'customer-recovery') { if (!dialog.querySelector('#recovery-identity')?.checked) throw new Error('Confira a identidade e marque a confirmação antes de gerar o link.'); const r = await api('agenda/customer-recovery', { customerId: detailCustomer.id, identityConfirmed: true }); modal('Link pessoal do cliente', `<p>Compartilhe diretamente com o cliente identificado. Válido por 30 minutos, de uso único. Nenhum e-mail foi enviado.</p><a class="share-link" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.url)}</a>`); }
    if (action === 'import-confirm') { if (!importRows || !importPreview) throw new Error('Confira uma nova prévia antes de importar.'); const result = await api('customers/import', { rows: importRows, checksum: importPreview.checksum, idempotencyKey: importKey }); dialog.close(); q = ''; offset = 0; await load(); toast(`${result.imported} cliente(s) importado(s); ${result.skipped} linha(s) ignorada(s).`); }
  } catch (err) { if (dialog.open) dialog.querySelector('[role=alert]').textContent = err.message; else { error = err.message; render(); } } finally { busy = false; if (target.isConnected) target.disabled = false; }
});
function toast(text) { const el = document.querySelector('#system-toast'); el.textContent = text; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 4500); }
document.addEventListener('submit', async e => {
  if (!['customer-filter', 'period-filter', 'customer-edit', 'manual-entry', 'import-preview'].includes(e.target.id)) return;
  e.preventDefault(); if (busy) return; busy = true; const form = e.target, submit = form.querySelector('button[type=submit]'), data = Object.fromEntries(new FormData(form)); if (submit) submit.disabled = true;
  error = ''; const alert = dialog.open ? dialog.querySelector('[role=alert]') : null; if (alert) alert.textContent = '';
  try {
    if (form.id === 'customer-filter') { q = data.q.trim(); offset = 0; await load(); }
    if (form.id === 'period-filter') { filters = { from: data.from, to: data.to, professionalId: data.professionalId ?? '' }; offset = 0; appointmentOffset = 0; await load(); }
    if (form.id === 'customer-edit') { const result = await api('customers/save', { name: data.name, phone: data.phone, email: data.email, notes: data.notes, ...(detailCustomer ? { id: detailCustomer.id, revision: detailCustomer.revision } : {}), ...(data.identityConfirmed ? { identityConfirmed: true } : {}) }); await load(); await openCustomer(result.id); toast('Cadastro salvo.'); }
    if (form.id === 'manual-entry') { await api('finance/manual', { appointmentId: financeDetail.appointmentId, amountCents: moneyInput(data.amount), method: data.method, date: data.date, note: data.note, idempotencyKey: manualKey, ...(refundOf ? { refundOf } : {}) }); try { sessionStorage.removeItem(manualStorageKey); } catch {} await load(); refundOf = null; await openFinance(financeDetail.appointmentId); toast('Lançamento registrado no histórico.'); }
    if (form.id === 'import-preview') {
      const revision = importRevision;
      const file = form.querySelector('[name=file]').files[0]; if (file && file.size > 200000) throw new Error('Escolha um CSV de até 200 KB.');
      const text = data.csv.trim() ? data.csv : file ? await file.text() : '', rows = parseClientsCsv(text);
      const preview = await api('customers/import-preview', { rows });
      if (revision !== importRevision || !form.isConnected || !dialog.open) return;
      importRows = rows; importPreview = preview; importKey = crypto.randomUUID();
      dialog.querySelector('#import-result').innerHTML = `<div class="note spaced">${importPreview.validCount} linha(s) válida(s) · ${importPreview.skippedCount} ignorada(s). Nenhum cadastro existente será alterado.</div><div class="import-preview"><table><thead><tr><th>Linha</th><th>Cliente</th><th>Situação</th></tr></thead><tbody>${importPreview.rows.map(r => `<tr><td>${r.line}</td><td>${esc(r.name ?? 'Dados inválidos')}<br>${esc(r.email)}</td><td>${r.valid ? 'Pronto para importar' : esc(r.error)}</td></tr>`).join('')}</tbody></table></div>${button(`Importar ${importPreview.validCount} cliente(s) válido(s)`, 'import-confirm', importPreview.validCount ? '' : 'disabled', false)}`;
    }
  } catch (err) { if (dialog.open) dialog.querySelector('[role=alert]').textContent = err.message; else { error = err.message; render(); } } finally { busy = false; if (submit?.isConnected) submit.disabled = false; }
});
(async () => {
  try { const session = await api('session'); user = session.user; operationsAvailable = session.operationsAvailable === true; csrf = session.csrf; testMode = session.testMode; setup = await api('setup'); await load(); const appointment = new URLSearchParams(location.search).get('atendimento'); if (appointment && view === 'financeiro') { await openFinance(appointment); history.replaceState(null, '', location.pathname); } }
  catch (err) { if (err.status === 401) { root.innerHTML = `<main class="auth-wrap"><section class="card"><h1>Entre no seu negócio</h1><p class="muted spaced">Use seu acesso individual para consultar esta área.</p><a class="button spaced" href="/sistema/${slug}">Entrar no meu espaço</a></section></main>`; } else { error = err.message; render(); } }
})();
