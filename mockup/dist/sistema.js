'use strict';
const root = document.querySelector('#system-root');
const dialog = document.querySelector('#system-dialog');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = value => value === null ? 'Preço a definir' : (Number(value) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const paths = location.pathname.split('/').filter(Boolean);
const slug = paths[1] ?? '';
const publicMode = paths[0] === 'negocio';
const returnToOperations = !publicMode && new URLSearchParams(location.search).get('retorno') === 'operacao';
const retainedReturn = returnToOperations ? '?retorno=operacao' : '';
let csrf = '', user = null, model = null, step = 1, workPro = '', teamOpen = false, agendaOpen = false, passwordOpen = false, testMode = false, mpStatus = null;
let dirty = false, saving = null, receivingSave = null, imageSaving = null, ownSaving = null, ownDirty = false, ownEdits = 0, timer, status = '', draftSaveError = '', conflict = false, validationVisible = false;
let activation = (() => { const hash = new URLSearchParams(location.hash.slice(1)); const value = hash.get('ativar') || hash.get('recuperar'); if (!value) return null; const result = { token: value, kind: hash.has('ativar') ? 'invite' : 'reset' }; history.replaceState(null, '', location.pathname + retainedReturn); return result; })();
const mpReturn = (() => { const q = new URLSearchParams(location.search); const state = q.get('recebimento'); if (!state) return null; const result = { state, message: (q.get('motivo') || '').slice(0, 400) }; history.replaceState(null, '', location.pathname + retainedReturn + location.hash); return result; })();
let operationsAvailable = false, recoveryEmail = false;
const setupDisclosureState = new Map();
function setupDisclosure(key, label, content, { required = false, optional = false } = {}) {
  const compact = window.matchMedia?.('(max-width: 720px)')?.matches === true;
  const open = required || (setupDisclosureState.has(key) ? setupDisclosureState.get(key) : !compact && !optional);
  return `<details class="setup-details setup-disclosure" data-setup-disclosure="${key}" ${open ? 'open' : ''}><summary>${esc(label)}</summary>${content}</details>`;
}
const requestedView = new URLSearchParams(location.search).get('visao');
agendaOpen = requestedView === 'agenda'; teamOpen = requestedView === 'equipe'; passwordOpen = requestedView === 'senha';
let requestedStep = mpReturn ? 5 : (() => { const value = Number(new URLSearchParams(location.search).get('etapa')); return Number.isInteger(value) && value >= 1 && value <= 6 ? value : 0; })();
let businessEditing = new URLSearchParams(location.search).get('editar') === '1' || requestedStep > 0 || Boolean(mpReturn);
const stepNames = ['Seu negócio', 'Quem atende', 'Seus serviços', 'Seus horários', 'Recebimento', 'Revise e publique'];
const dayNames = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const timeZones = { 'America/Sao_Paulo': 'Horário de Brasília', 'America/Manaus': 'Horário de Manaus', 'America/Cuiaba': 'Horário de Cuiabá', 'America/Rio_Branco': 'Horário de Rio Branco', 'America/Noronha': 'Horário de Fernando de Noronha' };
const zoneLabel = zone => timeZones[zone] || `Horário de ${zone.split('/').at(-1).replaceAll('_', ' ')}`;
const uid = () => crypto.randomUUID();
const week = () => Array.from({ length: 7 }, (_, day) => ({ day, enabled: day > 0 && day < 6, start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' }));
const button = (label, action, variant = '', extra = '') => `<button type="button" class="button ${variant}" data-action="${action}" ${extra}>${label}</button>`;
function toast(message) { const el = document.querySelector('#system-toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 5000); }
function modal(title, html, { preview = false } = {}) {
  dialog.className = preview ? 'catalog-preview-dialog' : '';
  const close = '<button type="button" class="dialog-close" data-action="close-dialog" aria-label="Fechar">×</button>';
  dialog.innerHTML = preview
    ? `<header class="catalog-preview-heading"><h2 id="dialog-title">${esc(title)}</h2>${close}</header><div class="catalog-preview-content">${html}<div class="row spaced">${button('Fechar prévia', 'close-dialog', 'secondary')}</div></div>`
    : `${close}<h2 id="dialog-title">${esc(title)}</h2>${html}`;
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
}
function header() { return `${testMode ? '<div class="test-banner">Ambiente de validação · use somente dados fictícios · nenhum e-mail ou pagamento é enviado</div>' : ''}${window.RaelWorkspace.render({ slug, businessName: model?.draft?.business.name ?? model?.businessName ?? model?.catalog?.business?.name, user, active: passwordOpen ? 'password' : agendaOpen ? 'agenda' : teamOpen && user?.role === 'admin' ? 'team' : 'profile', inPlace: true, operationsAvailable, logoutHtml: user ? button('Sair', 'logout', 'secondary small', 'aria-label="Sair da minha conta"') : '' })}${user ? '<aside id="license-banner" aria-label="Assinatura da plataforma"></aside>' : ''}`; }
function syncTheme() { window.RaelWorkspace.sync(); window.RaelLicenseNotice?.mount(slug, user?.role); window.RaelTheme?.sync(); }
function syncAgendaDate(value) {
  if (!agendaOpen || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
  const url = new URL(location.href || location.pathname + location.search, location.origin);
  url.searchParams.set("data", value);
  history.replaceState(history.state, "", url.pathname + url.search + url.hash);
}
function syncWorkspaceAddress(clearStep = false) {
  if (!user || publicMode) return;
  const query = new URLSearchParams(location.search);
  query.set('visao', passwordOpen ? 'senha' : agendaOpen ? 'agenda' : teamOpen && user.role === 'admin' ? 'equipe' : 'perfil');
  if (!agendaOpen) query.delete('data');
  if (clearStep) query.delete('etapa');
  const editingPublished = user.role === 'admin' && model?.published && businessEditing && !agendaOpen && !teamOpen && !passwordOpen;
  if (editingPublished) { query.set('editar', '1'); query.set('etapa', String(step)); }
  else { query.delete('editar'); if (model?.published || agendaOpen || teamOpen || passwordOpen) query.delete('etapa'); }
  const next = `${location.pathname}?${query.toString()}${location.hash}`;
  if (next !== location.pathname + location.search + location.hash) history.replaceState(history.state, '', next);
}
async function request(path, options = {}) {
  const response = await fetch(`/internal/${encodeURIComponent(slug)}/${path}`, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...options.headers } });
  let result;
  try { result = await response.json(); } catch { throw new Error('A conexão foi interrompida. Tente novamente.'); }
  if (!response.ok) throw Object.assign(new Error(result.error || 'Não foi possível concluir.'), { status: response.status });
  return result;
}
function field(label, path, value, { type = 'text', help = '', readonly = false, extra = '' } = {}) {
  return `<label class="field"><span>${esc(label)}</span><input data-path="${esc(path)}" type="${type}" value="${esc(value)}" ${readonly ? 'readonly' : ''} ${extra}>${help ? `<small>${esc(help)}</small>` : ''}</label>`;
}
function errorBox(message) { return `<div class="note error error-box" role="alert">${esc(message)}</div>`; }
function avatar(name, url, kind = 'photo') {
  const initials = name.split(' ').filter(Boolean).slice(0, 2).map(part => part[0]).join('');
  return `<span class="profile-image ${kind === 'logo' ? 'company-logo' : ''}"><span aria-hidden="true">${esc(initials || 'r.')}</span>${url ? `<img src="${esc(url)}" alt="${kind === 'logo' ? 'Logo de' : 'Foto de'} ${esc(name)}" width="96" height="96" decoding="async">` : ''}</span>`;
}
function imageEditor(kind, url, name, collapsible = false) {
  const editor = `<section class="image-editor"><div>${avatar(name, url, kind)}</div><div><h3>${kind === 'logo' ? 'Logo do negócio' : 'Sua foto de perfil'}</h3><p class="small muted">${kind === 'logo' ? 'Aparece no topo da página pública. Somente o gestor do negócio altera a logo.' : 'Ajuda o cliente a reconhecer quem vai atender. Cada profissional cuida da própria foto.'}</p><div class="row spaced"><label class="button secondary file-picker">${url ? 'Trocar imagem' : kind === 'logo' ? 'Escolher logo' : 'Escolher foto'}<input type="file" accept="image/jpeg,image/png,image/webp" data-image-kind="${kind}" aria-label="${kind === 'logo' ? 'Escolher logo do negócio' : 'Escolher foto de perfil'}"></label>${url ? button('Remover imagem', 'remove-image', 'secondary', `data-kind="${kind}"`) : ''}</div><p class="small muted spaced">JPG, PNG ou WebP, até 8 MB. ${kind === 'logo' ? 'A proporção da logo é preservada.' : 'A foto usa um recorte central quadrado.'} A imagem será pública quando o catálogo estiver publicado.</p></div></section>`;
  return collapsible ? `<div class="setup-image-options">${setupDisclosure(`image-${kind}`, kind === 'logo' ? 'Logo do negócio · adicionar ou trocar' : 'Foto de perfil · adicionar ou trocar', editor, { optional: true })}</div>` : editor;
}
function coverEditor(url) {
  return `<section class="card spaced cover-settings">
    <div>
      <h3>Foto de capa da página inicial</h3>
      <p class="small muted">A imagem aparece atrás do título da vitrine. Use uma foto horizontal, de preferência com o assunto principal à direita.</p>
    </div>
    ${url ? `<img class="cover-preview" src="${esc(url)}" alt="Foto de capa atual" decoding="async">` : ''}
    <div class="row">
      <label class="button secondary file-picker">${url ? 'Trocar foto de capa' : 'Escolher foto de capa'}<input type="file" accept="image/jpeg,image/png,image/webp" data-image-kind="cover" aria-label="Escolher foto de capa"></label>
      ${url ? button('Remover capa', 'remove-image', 'secondary', 'data-kind="cover"') : ''}
    </div>
    <small class="muted">JPG, PNG ou WebP, até 8 MB. A capa aparece assim que for salva, se o catálogo já estiver publicado.</small>
  </section>`;
}
async function prepareImage(file, kind) {
  if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) throw new Error('Escolha um arquivo JPG, PNG ou WebP de até 8 MB.');
  const url = URL.createObjectURL(file), image = new Image();
  try {
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('Não foi possível abrir essa imagem. Escolha outro arquivo.')); image.src = url; });
    const canvas = document.createElement('canvas');
    const scale = kind === 'cover'
      ? Math.min(1, 1600 / image.naturalWidth, 1000 / image.naturalHeight)
      : Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = kind === 'photo' ? 512 : Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = kind === 'photo' ? 512 : Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (kind === 'photo') { const side = Math.min(image.naturalWidth, image.naturalHeight); ctx.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 512, 512); }
    else ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/webp', kind === 'cover' ? 0.78 : 0.85);
  } finally { URL.revokeObjectURL(url); }
}
async function saveImage(kind, image) {
  if (imageSaving) return imageSaving;
  imageSaving = (async () => {
    if (receivingSave) await receivingSave;
    if (model.draft) await flush();
    while (ownDirty) await saveOwnHours();
    status = 'Salvando imagem…'; updateStatus();
    const path = { logo: 'business-logo', photo: 'profile-photo', cover: 'business-cover' }[kind];
    const result = await request(path, { method: 'PUT', body: JSON.stringify({ image, revision: model.revision }) });
    model.revision = result.revision; status = 'Imagem salva'; await load(); toast(image === null ? 'Imagem removida.' : kind === 'cover' ? 'Foto de capa salva.' : 'Imagem salva no perfil.');
  })().finally(() => { imageSaving = null; });
  return imageSaving;
}
function setValue(path, value) { const keys = path.split('.'); let target = model.draft; for (const key of keys.slice(0, -1)) target = target[key]; target[keys.at(-1)] = value; }
function draftSaveMessage() {
  if (conflict) return 'Salvamento pausado · confira a outra sessão antes de continuar.';
  if (draftSaveError) return `Rascunho não salvo: ${draftSaveError}`;
  if (saving) return dirty ? 'Salvando rascunho… novas alterações na fila.' : 'Salvando rascunho…';
  if (dirty) return 'Aguardando salvamento automático…';
  return status || 'Rascunho salvo · salvamento automático ativo';
}
function saveHelpContent() {
  return `<details class="setup-save-help" data-setup-disclosure="save-help" ${setupDisclosureState.get('save-help') ? 'open' : ''}><summary aria-label="Como funciona o salvamento automático">Como funciona</summary><p class="small muted">Ao parar de digitar, salvamos automaticamente o rascunho neste negócio. Aguarde a confirmação de salvo antes de fechar a página. Continuar também salva e permite tentar novamente se houver erro.</p><p class="small muted spaced">Salvar o rascunho não publica as mudanças. Na última etapa, revise e publique para mostrá-las aos clientes. “Dados preenchidos” indica campos completos; a conferência das informações é feita por você.</p></details>`;
}
function markDirty() { dirty = true; draftSaveError = ''; status = ''; updateStatus(); clearTimeout(timer); timer = setTimeout(() => (async () => { if (imageSaving) await imageSaving; await flush(); })().catch(showSaveError), 900); }
function updateStatus() { const el = document.querySelector('#save-status'); if (el) el.textContent = draftSaveMessage(); updatePublicationStatus(); }
function showSaveError(error) {
  if (error.status === 401) { auth(error.message); return; }
  if (error.status === 409) conflict = true;
  status = error.message; updateStatus();
  if (error.status === 409) { conflict = true; modal('Outra sessão salvou alterações', `<p>Outra sessão atualizou o cadastro. ${model?.draft ? 'Seus campos continuam nesta tela. Baixe o rascunho antes de recarregar para preservar suas anotações.' : 'Recarregue para consultar a versão mais recente antes de salvar novamente.'}</p><div class="row spaced">${model?.draft ? button('Baixar meu rascunho', 'download-draft', 'secondary') : ''}${button('Recarregar versão salva', 'reload')}</div>`); }
  else toast(error.message);
}
async function flush() {
  clearTimeout(timer);
  if (conflict) throw new Error('Recarregue a versão salva antes de continuar.');
  if (saving) { await saving; if (dirty) return flush(); return; }
  if (!dirty || !model?.draft) return;
  const draft = structuredClone(model.draft), revision = model.revision;
  dirty = false; draftSaveError = ''; status = '';
  saving = request('setup', { method: 'PUT', body: JSON.stringify({ revision, draft }) }).then(result => { model.revision = result.revision; model.report = result.report; model.publication = result.publication; status = `Rascunho salvo às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`; updateStatus(); }).catch(error => { dirty = true; draftSaveError = error.message; throw error; }).finally(() => { saving = null; updateStatus(); });
  updateStatus();
  await saving;
  if (dirty) return flush();
}
async function load(renderNow = true) { const fresh = await request('setup'); const pendingDraft = dirty && model?.draft ? structuredClone(model.draft) : null; const pendingWeek = ownDirty && user?.role === 'professional' && model?.professional ? structuredClone(model.professional.week) : null; const sameUser = user?.id === fresh.user.id, keepEditorStep = businessEditing && user?.role === 'admin' && model?.user?.id === fresh.user.id && model?.published && !requestedStep && !agendaOpen && !teamOpen, previousStep = step; model = fresh; user = model.user; mpStatus = user.professionalId ? await request('mp/status') : null; if (pendingDraft && sameUser) model.draft = pendingDraft; if (pendingWeek && sameUser && model.professional) model.professional.week = pendingWeek; if (user.role === 'admin') { step = requestedStep || (keepEditorStep ? previousStep : model.draft.step); requestedStep = 0; workPro ||= model.draft.professionals.find(p => p.active)?.id ?? ''; } if (renderNow) render(); }
function auth(message = '', success = false) {
  window.RaelAgenda?.unmount(); if (dialog.open) dialog.close(); dialog.innerHTML = ''; user = null; operationsAvailable = false; model = null; csrf = ''; dirty = false; ownDirty = false; status = ''; draftSaveError = ''; clearTimeout(timer);
  if (returnToOperations) document.title = 'Entrar na gestão da Raelapps · Rael Agendamentos';
  root.innerHTML = `${header()}<main id="main" class="auth-wrap"><div class="card"><div class="eyebrow">${returnToOperations ? 'Administração da plataforma' : 'Seu acesso individual'}</div><h1>${activation ? 'Escolha sua senha' : returnToOperations ? 'Gestão da Raelapps' : 'Bom ter você por aqui.'}</h1><p class="muted spaced">${activation ? 'Este link é pessoal. Defina uma senha que só você conheça e depois entre com seu e-mail.' : returnToOperations ? 'Entre com seu acesso de administrador da plataforma.' : 'Entre no seu negócio. Cada pessoa da equipe usa o próprio acesso.'}</p><div id="auth-error" class="spaced">${message ? success ? `<p class="note" role="status">${esc(message)}</p>` : errorBox(message) : ''}</div>${activation ? `<form id="activate-form"><label class="field"><span>Nova senha</span><input name="password" type="password" minlength="8" maxlength="128" autocomplete="new-password" required><small>Use uma frase ou senha com pelo menos 8 caracteres.</small></label><label class="field"><span>Repita a senha</span><input name="confirmation" type="password" minlength="8" maxlength="128" autocomplete="new-password" required></label><button class="button full" type="submit">Definir minha senha</button></form>` : `<form id="login-form"><label class="field"><span>Seu e-mail de acesso</span><input name="email" type="email" maxlength="254" autocomplete="username" required></label><label class="field"><span>Sua senha</span><input name="password" type="password" maxlength="128" autocomplete="current-password" required></label><button class="button full" type="submit">${returnToOperations ? 'Entrar na gestão' : 'Entrar no meu espaço'}</button></form><button class="text-button spaced" type="button" data-action="recovery-help">Esqueci minha senha</button>`}</div><p class="small muted spaced">${returnToOperations ? 'Este acesso é restrito aos administradores autorizados da Raelapps.' : `Entre com os dados do seu cadastro ou do convite recebido. Este endereço identifica o negócio: <strong>${esc(slug)}</strong>.`}</p></main>`;
  syncTheme();
}
function finishOperationReturn() {
  if (!returnToOperations) return false;
  if (operationsAvailable === true) location.assign('/operacao');
  else auth('Este acesso não tem permissão para a gestão da Raelapps. Entre com uma conta autorizada da plataforma.');
  return true;
}
function businessStep() {
  const b = model.draft.business;
  return `<div class="card spaced"><h2>Como seu cliente conhece você?</h2>${field('Nome público do negócio', 'business.name', b.name, { help: 'Pode ser o nome da empresa ou seu nome profissional.', extra: 'maxlength="120" autocomplete="organization"' })}<label class="field"><span>Que tipo de serviço você oferece?</span><select data-path="business.segment"><option value="">Escolha o segmento mais próximo</option>${model.segments.map(segment => `<option value="${segment.id}" ${segment.id === b.segment ? 'selected' : ''}>${esc(segment.label)}</option>`).join('')}</select><small>Isso ajuda com exemplos. Você pode personalizar seus serviços.</small></label><div class="grid2">${field('Telefone de contato', 'business.phone', b.phone, { type: 'tel', help: 'Com DDD. Será exibido no catálogo.', extra: 'maxlength="25" autocomplete="tel"' })}${field('E-mail de contato do negócio', 'business.email', b.email, { type: 'email', help: 'Dado de contato. Não enviamos mensagens automaticamente.', extra: 'maxlength="254"' })}</div><label class="field"><span>Como você atende?</span><select data-path="business.mode"><option value="presencial" ${b.mode === 'presencial' ? 'selected' : ''}>Em um endereço fixo</option><option value="online" ${b.mode === 'online' ? 'selected' : ''}>Online</option></select></label>${b.mode === 'presencial' ? field('Endereço do atendimento', 'business.address', b.address, { help: 'Confira o endereço que aparecerá para o cliente.', extra: 'maxlength="300"' }) : `<label class="field"><span>Como o cliente receberá o acesso ao atendimento online? (opcional)</span><textarea data-path="business.onlineInstructions" maxlength="1000" placeholder="Ex.: Entrarei em contato pelo telefone informado até 30 minutos antes para combinar o acesso.">${esc(b.onlineInstructions)}</textarea><small>Informe quem entra em contato, por qual canal e com que antecedência. Este texto é público: não inclua senhas nem links privados de reunião. O sistema não envia instruções automaticamente.</small></label>`}<label class="field"><span>Horário do seu negócio</span><select data-path="business.timeZone">${Object.entries(timeZones).map(([zone, label]) => `<option value="${zone}" ${b.timeZone === zone ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select><small>Define o horário da agenda, não a localização do negócio.</small></label><label class="field"><span>Apresente seu trabalho em poucas palavras</span><textarea data-path="business.description" maxlength="1000">${esc(b.description)}</textarea><small>Esse texto aparecerá no catálogo público e na página inicial.</small></label><div class="grid2">${field('Título da página inicial', 'business.landingHeadline', b.landingHeadline ?? '', { help: 'Se deixar em branco, será usado o nome do negócio.', extra: 'maxlength="140"' })}${field('Cor da página inicial', 'business.landingColor', b.landingColor || '#205340', { type: 'color' })}</div><p class="muted small">As alterações entram na página inicial quando o catálogo é publicado.</p></div>${imageEditor('logo', model.images?.logo, b.name, true)}${coverEditor(model.images?.cover)}`;
}
function peopleStep() {
  const active = model.draft.professionals.filter(p => p.active).length;
  return `${user.professionalId && model.draft.professionals.some(p => p.id === user.professionalId && p.active) ? imageEditor('photo', model.images?.[user.professionalId], user.name, true) : ''}<div class="choice-grid"><label class="choice"><input type="radio" name="teamMode" data-path="teamMode" value="solo" ${model.draft.teamMode === 'solo' ? 'checked' : ''}><span><strong>Atendo sozinho</strong><small>Seu próprio cadastro já conta como profissional.</small></span></label><label class="choice"><input type="radio" name="teamMode" data-path="teamMode" value="team" ${model.draft.teamMode === 'team' ? 'checked' : ''}><span><strong>Trabalho com uma equipe</strong><small>Até 3 profissionais ativos no mesmo negócio.</small></span></label></div><div class="row"><span class="badge good">${active} de 3 vagas usadas</span><span class="small muted">Cada profissional terá seu próprio login.</span></div>${model.draft.professionals.map((p, index) => { const bound = model.teamAccess.find(u => u.professionalId === p.id); return `<section class="professional-card"><div class="card-title"><div class="row">${avatar(p.name, model.images?.[p.id])}<h3>${esc(p.name || 'Novo profissional')}</h3></div><label class="check-line"><input type="checkbox" data-path="professionals.${index}.active" ${p.active ? 'checked' : ''}>Ativo</label></div><div class="grid2">${field('Nome público', `professionals.${index}.name`, p.name, { extra: 'maxlength="120"' })}${field('E-mail do acesso individual', `professionals.${index}.email`, p.email, { type: 'email', readonly: Boolean(bound), help: bound ? 'Já vinculado ao acesso desta pessoa.' : 'O convite será gerado por link; não enviaremos e-mail.', extra: 'maxlength="254"' })}</div><p class="small muted">${bound ? (bound.accepted ? 'Acesso individual já ativado.' : 'Acesso por convite aguardando ativação.') : 'Depois de salvar, gere o convite em “Acessos da equipe”.'} ${p.id === user.professionalId ? 'Este é seu cadastro profissional.' : ''}</p></section>`; }).join('')}${model.draft.teamMode === 'team' ? button('Adicionar profissional', 'add-professional', 'secondary', active >= 3 ? 'disabled title="Seu plano permite até 3 profissionais ativos"' : '') : ''}<div class="note spaced">Inativar libera uma vaga e impede novos acessos profissionais. O histórico e o cadastro ficam preservados.</div>`;
}
function compactEditor(key, className, summary, content, required = false, attributes = '') {
  const open = required || setupDisclosureState.get(key) === true;
  return `<details class="${className}" data-setup-disclosure="${key}" ${open ? 'open' : ''}><summary class="setup-editor-summary" ${attributes}>${summary}</summary><div class="setup-editor-body">${content}</div></details>`;
}
function editorHint() { return '<span class="setup-editor-hint"><span class="setup-editor-closed">Editar</span><span class="setup-editor-open">Recolher</span></span>'; }
function serviceEditorIssues(service) {
  const issues = [];
  if (service.name.trim().length < 2) issues.push('Informe o nome.');
  if (!Number.isInteger(service.priceCents) || service.priceCents < 0 || service.priceCents > 100000000) issues.push('Informe um preço válido; para gratuito, digite 0.');
  if (!Number.isInteger(service.durationMinutes) || service.durationMinutes < 5 || service.durationMinutes > 1440) issues.push('A duração deve ser de 5 a 1440 minutos.');
  if (!Number.isInteger(service.gapMinutes) || service.gapMinutes < 0 || service.gapMinutes > 240) issues.push('O intervalo deve ser de 0 a 240 minutos.');
  if (!model.draft.professionals.some(p => p.active && service.professionalIds.includes(p.id))) issues.push('Escolha ao menos um profissional ativo.');
  return issues;
}
function serviceEditorSummary(service) {
  const issues = serviceEditorIssues(service), professionals = model.draft.professionals.filter(p => p.active && service.professionalIds.includes(p.id));
  return `<span class="setup-editor-title">${esc(service.name || 'Novo serviço')}</span><span class="setup-editor-meta">${esc(money(service.priceCents))} · ${esc(service.durationMinutes)} min · ${esc(service.gapMinutes)} min de intervalo</span><span class="setup-editor-meta">Com ${esc(professionals.map(p => p.name || 'Profissional sem nome').join(', ') || 'nenhum profissional ativo')}</span><span class="setup-editor-state">${service.online ? 'Visível no catálogo ao publicar' : 'Fora do catálogo público'}${issues.length ? ` · ${esc(issues.join(' '))}` : ''}</span>${editorHint()}`;
}
function servicesStep() {
  const selected = model.segments.find(segment => segment.id === model.draft.business.segment);
  return `<div class="note">Cadastre preço e duração definidos. As sugestões de nome são editáveis; nenhum preço é aplicado automaticamente. Abra um serviço para editar seus dados.</div>${selected ? `<div class="row spaced">${selected.examples.map(name => button(esc(name), 'suggest-service', 'secondary small', `data-name="${esc(name)}"`)).join('')}</div>` : ''}${model.draft.services.map((service, index) => compactEditor(`service-${service.id}`, 'service-card setup-service-editor', serviceEditorSummary(service), `<div class="card-title"><h3>Dados do serviço</h3>${button('Remover', 'remove-service', 'secondary small', `data-index="${index}"`)}</div>${field('Nome do serviço', `services.${index}.name`, service.name, { extra: 'maxlength="120"' })}<div class="grid3">${field('Preço (R$)', `services.${index}.priceCents`, service.priceCents === null ? '' : (service.priceCents / 100).toFixed(2).replace('.', ','), { extra: 'inputmode="decimal" data-money="true" maxlength="12"', help: 'Exemplo: 60,00. Para oferecer grátis, digite 0.' })}${field('Duração em minutos', `services.${index}.durationMinutes`, service.durationMinutes, { type: 'number', extra: 'min="5" max="1440" data-number="true"', help: 'Tempo reservado para o atendimento.' })}${field('Intervalo após o serviço', `services.${index}.gapMinutes`, service.gapMinutes, { type: 'number', extra: 'min="0" max="240" data-number="true"', help: 'Minutos para preparar o próximo horário.' })}</div><p class="small"><strong>Quem pode realizar este serviço?</strong></p>${model.draft.professionals.filter(p => p.active).map(p => `<label class="check-line"><input type="checkbox" data-service="${index}" data-professional="${p.id}" ${service.professionalIds.includes(p.id) ? 'checked' : ''}>${esc(p.name || 'Profissional sem nome')}</label>`).join('') || '<p class="small muted">Cadastre um profissional ativo na etapa anterior.</p>'}<label class="check-line"><input type="checkbox" data-path="services.${index}.online" ${service.online ? 'checked' : ''}>Mostrar no catálogo público</label><label class="field"><span>Descrição e orientações públicas</span><textarea data-path="services.${index}.description" maxlength="1000">${esc(service.description)}</textarea></label>`, serviceEditorIssues(service).length > 0, `data-service-summary="${esc(service.id)}"`)).join('')}${button('Adicionar um serviço', 'add-service', 'secondary spaced')}`;
}
function dayEditorIssues(day) {
  const validTime = value => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value), issues = [];
  if (![day.start, day.end, day.breakStart, day.breakEnd].every(validTime)) return ['Confira os horários.'];
  if (!day.enabled) return [];
  if (day.start >= day.end) issues.push('O fim deve ser depois do início.');
  if (day.breakStart !== day.breakEnd && (day.breakStart < day.start || day.breakEnd > day.end || day.breakStart >= day.breakEnd)) issues.push('A pausa deve ficar dentro do expediente.');
  return issues;
}
function dayEditorSummary(day) {
  const issues = dayEditorIssues(day);
  return `<span class="setup-editor-title">${esc(dayNames[day.day])}</span><span class="setup-editor-meta">${day.enabled ? `${esc(day.start)}–${esc(day.end)} · ${day.breakStart === day.breakEnd ? 'sem pausa' : `pausa ${esc(day.breakStart)}–${esc(day.breakEnd)}`}` : 'Fechado'}</span>${issues.length ? `<span class="setup-editor-state">${esc(issues.join(' '))}</span>` : ''}${editorHint()}`;
}
function refreshCompactSummaries() {
  document.querySelectorAll('[data-service-summary]').forEach(summary => { const service = model?.draft?.services.find(service => service.id === summary.dataset.serviceSummary); if (service) summary.innerHTML = serviceEditorSummary(service); });
  document.querySelectorAll('[data-day-summary]').forEach(summary => { const professional = editableHours(summary.dataset.id, summary.dataset.own === 'true'), day = professional?.week[Number(summary.dataset.daySummary)]; if (day) summary.innerHTML = dayEditorSummary(day); });
}
function hoursFields(professional, index, own = false) {
  const noDays = !professional.week.some(day => day.enabled);
  const days = professional.week.map((day, i) => {
    const prefix = own ? `week.${i}` : `professionals.${index}.week.${i}`, pathAttribute = own ? 'data-own-path' : 'data-path', noBreak = day.breakStart === day.breakEnd;
    const dayLabel = [0, 6].includes(day.day) ? `no ${dayNames[day.day].toLowerCase()}` : `na ${dayNames[day.day].toLowerCase()}-feira`;
    const times = (keys, labels) => `<div class="schedule-times">${keys.map((key, position) => `<label class="field"><span>${labels[position]}</span><input type="time" ${pathAttribute}="${prefix}.${key}" value="${esc(day[key])}"></label>`).join('')}</div>`;
    const heading = `<div class="schedule-day-heading"><label class="check-line"><input type="checkbox" ${pathAttribute}="${prefix}.enabled" ${day.enabled ? 'checked' : ''}>Atender ${dayLabel}</label>${button('Copiar dia', 'copy-day', 'secondary small', `data-id="${esc(professional.id)}" data-day="${i}" data-own="${own}" aria-label="Copiar ${dayNames[day.day]} de ${esc(professional.name)} para outros dias"`)}</div>`;
    const fields = day.enabled ? `<div class="schedule-day-fields">${times(['start', 'end'], ['Início', 'Fim'])}<label class="check-line no-break-choice"><input type="checkbox" data-no-break="${i}" data-id="${esc(professional.id)}" data-own="${own}" ${noBreak ? 'checked' : ''}>Sem pausa</label>${noBreak ? '' : times(['breakStart', 'breakEnd'], ['Pausa começa', 'Pausa termina'])}</div>` : dayEditorIssues(day).length ? `<p class="note warning">Confira os horários guardados antes de continuar. Este dia continua fechado.</p><div class="schedule-day-fields">${times(['start', 'end'], ['Início', 'Fim'])}${times(['breakStart', 'breakEnd'], ['Pausa começa', 'Pausa termina'])}</div>` : '<p class="small muted">Dia fechado. Ative o atendimento neste dia para ajustar os horários.</p>';
    return compactEditor(`day-${own ? 'own' : 'admin'}-${professional.id}-${day.day}`, 'schedule-day setup-day-editor', dayEditorSummary(day), heading + fields, dayEditorIssues(day).length > 0 || noDays && day.day === 1, `data-day-summary="${i}" data-id="${esc(professional.id)}" data-own="${own}"`);
  }).join('');
  return `${noDays ? '<p class="note warning spaced">Ative ao menos um dia de atendimento.</p>' : ''}<div class="week">${days}</div>`;
}
function editableHours(id, own = false) {
  if (own && user.role === 'professional' && user.professionalId === id && model.professional?.id === id) return model.professional;
  if (!own && user.role === 'admin') return model.draft.professionals.find(p => p.id === id && p.active);
  return null;
}
function hoursChanged(own) { if (own) { ownDirty = true; ownEdits++; } else markDirty(); render(); }
function weekSummary(professional) {
  return professional.week.filter(d => d.enabled).map(d => `${dayNames[d.day]} ${d.start}–${d.end}${d.breakStart === d.breakEnd ? ' · sem pausa' : ` · pausa ${d.breakStart}–${d.breakEnd}`}`).join('; ') || 'Nenhum dia de atendimento';
}
function hoursStep() {
  const active = model.draft.professionals.filter(p => p.active);
  const chosen = active.find(p => p.id === workPro) ?? active[0];
  if (!chosen) return '<div class="note warning">Ative ao menos um profissional na etapa 2.</div>';
  workPro = chosen.id;
  const index = model.draft.professionals.findIndex(p => p.id === chosen.id);
  return `<div class="card"><label class="field"><span>Expediente de quem?</span><select id="work-professional">${active.map(p => `<option value="${p.id}" ${p.id === workPro ? 'selected' : ''}>${esc(p.name || 'Profissional')}</option>`).join('')}</select></label><p class="small muted">Ative os dias de atendimento e ajuste os horários. Marque “Sem pausa” para atender sem intervalo. “Copiar dia” aplica os horários somente aos dias que você selecionar.</p>${active.length > 1 ? `<div class="row spaced">${button('Copiar semana de outro profissional', 'copy-week', 'secondary', `data-id="${esc(chosen.id)}"`)}<span class="small muted">Destino: ${esc(chosen.name)}</span></div>` : ''}${hoursFields(chosen, index)}<div class="note spaced">${esc(zoneLabel(model.draft.business.timeZone))}. Use a Agenda para consultar atendimentos e bloquear datas específicas.</div></div><div class="card spaced"><h2>Regras de agendamento</h2><div class="grid3">${field('Antecedência mínima (min)', 'rules.noticeMinutes', model.draft.rules.noticeMinutes, { type: 'number', extra: 'min="0" max="10080" data-number="true"' })}${field('Agendar até quantos dias?', 'rules.advanceDays', model.draft.rules.advanceDays, { type: 'number', extra: 'min="1" max="365" data-number="true"' })}${field('Cancelar ou remarcar com antecedência de (horas)', 'rules.cancelHours', model.draft.rules.cancelHours, { type: 'number', help: 'O mesmo prazo vale para cancelar e remarcar online. Depois dele, o cliente precisa falar com o negócio.', extra: 'min="0" max="168" data-number="true"' })}</div><p class="small muted">Publique as alterações para aplicar essas regras às próximas reservas.</p></div>`;
}
function receivingCard(p, preference) {
  const self = p.id === user.professionalId, connected = self ? mpStatus?.connected : preference?.connection_status === 'connected';
  const required = Boolean(preference?.require_payment);
  const connection = `<div class="receiving-connection">${mpStatus?.receiver ? `<p class="small spaced">Recebedor: <strong>${esc(mpStatus.receiver.name)}</strong>${mpStatus.mode === 'sandbox' ? ' · ambiente de testes, sem cobrança real' : ''}</p>` : ''}<p class="small muted spaced">Conecte sua própria conta para receber pelos seus agendamentos. Você administra a conta e os reembolsos no Mercado Pago.</p><div class="row spaced">${button(connected ? 'Conferir conexão' : mpStatus?.status === 'reconnect' ? 'Reconectar minha conta' : 'Conectar minha conta Mercado Pago', connected ? 'mp-check' : 'mp-connect', 'secondary', mpStatus?.configured ? '' : 'disabled')}${connected ? button('Renovar autorização', 'mp-connect', 'secondary') + button('Desconectar', 'mp-disconnect', 'secondary') : ''}</div>${!mpStatus?.configured ? `<div class="note spaced">O gestor do negócio precisa configurar o Mercado Pago deste negócio antes da conexão individual.${user.role === 'admin' ? ' Use a configuração do negócio abaixo.' : ' Peça essa configuração ao gestor do negócio.'}</div>` : '<p class="small muted spaced">Sua senha é informada somente no site oficial do Mercado Pago. O nome do recebedor será mostrado ao cliente antes de pagar.</p>'}</div>`;
  return `<section class="professional-card"><div class="card-title"><h3>${esc(p.name)}</h3><span class="badge ${required && !connected ? 'pending' : 'good'}">${required ? connected ? 'Antecipado · conta conectada' : 'Antecipado · conexão pendente' : 'No atendimento'}</span></div>${self ? `<p class="muted small spaced">Como você quer receber pelos seus atendimentos?</p><div class="choice-grid spaced"><label class="choice"><input type="radio" name="receiving" data-receiving="false" ${!required ? 'checked' : ''}><span><strong>No atendimento</strong><small>O cliente confirma o horário e combina o pagamento com você. Mercado Pago é opcional.</small></span></label><label class="choice"><input type="radio" name="receiving" data-receiving="true" ${required ? 'checked' : ''}><span><strong>Antecipado</strong><small>O horário só é confirmado após o pagamento pelo Mercado Pago.</small></span></label></div>${required ? connection : `<details class="setup-details spaced"><summary>Gerenciar minha conexão Mercado Pago (opcional)</summary>${connection}</details>`}` : `<p class="small muted spaced">Regra atual: <strong>${required ? 'pagamento antecipado' : 'pagamento no atendimento'}</strong>. ${esc(p.name)} altera essa escolha e conecta a própria conta no acesso individual.</p>${button('Gerenciar acesso individual', 'team', 'secondary small spaced')}`}<div class="note ${required && !connected ? 'warning' : ''} spaced">${required ? connected ? 'O cliente terá uma reserva temporária e seguirá para o Mercado Pago. A confirmação depende da aprovação.' : 'A preferência de antecipação está salva. Novas reservas com pagamento obrigatório dependem da conexão e validação da conta.' : 'Agendamentos podem ser confirmados sem pagamento pela plataforma.'}</div></section>`;
}
function receivingStep() {
  const active = model.draft.professionals.filter(p => p.active), required = active.some(p => model.preferences.find(pref => pref.professional_id === p.id)?.require_payment);
  return `<p class="muted">Cada profissional escolhe sua regra no próprio acesso. Para receber no atendimento, você pode continuar sem configurar Mercado Pago.</p>${active.map(p => receivingCard(p, model.preferences.find(pref => pref.professional_id === p.id))).join('')}<details class="card setup-details spaced" ${required ? 'open' : ''}><summary>${required ? 'Configurar Mercado Pago para pagamentos antecipados' : 'Configurar Mercado Pago do negócio (opcional)'}</summary><p class="small muted spaced">Esta configuração só é necessária para cobrar pela plataforma. O negócio usa aplicação e credenciais próprias; depois, cada profissional conecta sua própria conta. ${mpStatus?.configured && mpStatus.mode === 'sandbox' ? 'Ambiente de testes, sem cobrança real.' : ''}</p><a class="button secondary spaced" href="/sistema/${slug}/recebimentos">Configurar Mercado Pago do negócio</a></details>`;
}
function reviewSummary(number) {
  const d = model.draft, active = d.professionals.filter(p => p.active);
  if (number === 1) return [d.business.name, d.business.description ? `Apresentação: ${d.business.description}` : 'Apresentação: não informada.', model.segments.find(s => s.id === d.business.segment)?.label, d.business.mode === 'online' ? 'Atendimento online' : d.business.address, d.business.phone, d.business.email, zoneLabel(d.business.timeZone), ...(d.business.mode === 'online' ? [d.business.onlineInstructions ? `Acesso online: ${d.business.onlineInstructions}` : 'Acesso online: orientações públicas não informadas'] : [])];
  if (number === 2) return [`${active.length} profissionais ativos`, ...active.map(p => p.name || 'Nome não informado')];
  if (number === 3) return d.services.map(s => `${s.name || 'Serviço sem nome'} · ${money(s.priceCents)} · ${s.durationMinutes} min de atendimento · ${s.gapMinutes} min de intervalo após · ${s.durationMinutes + s.gapMinutes} min reservados no total · ${active.filter(p => s.professionalIds.includes(p.id)).map(p => p.name).join(', ') || 'sem profissional vinculado'}${s.online ? '' : ' · oculto no catálogo'}`);
  if (number === 4) return [...active.map(p => `${p.name}: ${weekSummary(p)}`), `Antecedência mínima: ${d.rules.noticeMinutes} min · agendar até ${d.rules.advanceDays} dias · cancelar ou remarcar com ${d.rules.cancelHours} h de antecedência`];
  return active.map(p => { const pref = model.preferences.find(value => value.professional_id === p.id); return `${p.name}: ${pref?.require_payment ? `Antecipado · ${pref.connection_status === 'connected' ? 'conta conectada' : 'conexão pendente'}` : 'No atendimento'}`; });
}
function reviewOverview(number) {
  const d = model.draft, active = d.professionals.filter(p => p.active);
  if (number === 1) return `${d.business.name} · ${d.business.mode === 'online' ? 'Atendimento online' : 'Presencial'}`;
  if (number === 2) return `${active.length} de 3 profissionais · ${active.map(p => p.name || 'Nome não informado').join(', ')}`;
  if (number === 3) return d.services.slice(0, 2).map(s => `${s.name || 'Serviço sem nome'} · ${money(s.priceCents)} · ${s.durationMinutes} min`).join('; ') + (d.services.length > 2 ? ` · +${d.services.length - 2} serviço(s) nos detalhes` : '');
  if (number === 4) return `${active.map(p => `${p.name}: ${p.week.filter(day => day.enabled).length} dia(s)/semana`).join(' · ')}. Alterações até ${d.rules.cancelHours} h antes.`;
  return reviewSummary(number).join(' · ');
}
function reviewStep() {
  const ready = model.report.ready;
  const readyMessage = model.published ? publicationStateView().help : 'Os dados necessários estão preenchidos. Confira o resumo e revise o que será publicado.';
  const pendingMessage = model.published ? `${publicationStateView().help}${publicationStateView().kind === 'current' ? '' : ' Há pendências de configuração; confira as etapas indicadas abaixo.'}` : 'Seu rascunho está salvo. Corrija as pendências abaixo antes de publicar.';
  return `<div class="note ${ready ? 'success' : 'warning'}">${ready ? readyMessage : pendingMessage}</div><p class="small muted spaced">“Dados preenchidos” indica que os campos necessários estão completos. A conferência das informações é feita por você nesta revisão.</p><div class="review-list">${model.report.steps.slice(0, 5).map(item => `<section class="review-item setup-review-item"><div><h2>${esc(stepNames[item.step - 1])}</h2><small>${item.issues.length ? esc(item.issues.join(' ')) : 'Dados preenchidos'}</small><p class="setup-review-overview">${esc(reviewOverview(item.step))}</p>${item.step === 1 ? `<p class="setup-review-preview">${esc(model.draft.business.description ? `Apresentação: ${model.draft.business.description.slice(0, 120)}${model.draft.business.description.length > 120 ? '… (texto completo nos detalhes)' : ''}` : 'Apresentação: não informada.')}</p>` : ''}${setupDisclosure(`review-${item.step}`, `Ver detalhes de ${stepNames[item.step - 1]}`, `<ul class="setup-review-facts">${reviewSummary(item.step).filter(Boolean).map(value => `<li>${esc(value)}</li>`).join('') || '<li>Nenhum dado informado.</li>'}</ul>`, { required: item.issues.length > 0 })}</div>${button(item.issues.length ? 'Corrigir' : 'Editar', 'go-step', 'secondary small', `data-step="${item.step}"`)}</section>`).join('')}</div><div class="card"><h2>O que ficará público</h2><p class="muted small spaced">Nome, apresentação, local ou modalidade, orientações públicas de acesso online, contato, serviços, preços, profissionais e expedientes. E-mails individuais de acesso não serão exibidos.</p><div class="row spaced">${button('Conferir resumo público', 'preview', 'secondary')}${button(model.published ? 'Atualizar catálogo publicado' : 'Publicar meu catálogo', 'publish', '', ready && (!model.published || publicationStateView().kind === 'pending') ? '' : 'disabled')}</div><div class="note spaced">Ao publicar, o cliente poderá escolher e reservar horários disponíveis. O recebimento segue a escolha de cada profissional: combinar no atendimento ou continuar para o Mercado Pago antes de confirmar.</div>${model.publishedAt ? `<p class="small spaced">Publicado em ${new Date(model.publishedAt).toLocaleString('pt-BR')}.<br><a href="/negocio/${slug}" target="_blank" rel="noopener">Abrir catálogo publicado</a></p>` : ''}</div>`;
}
const stepHelp = ['Comece com as informações que seu cliente precisa para encontrar você.', 'Cada pessoa da equipe terá um acesso próprio. Quem atende conta no limite do plano.', 'Explique o que oferece, por quanto e quanto tempo o atendimento precisa.', 'Uma semana bem definida evita mostrar horários em que você não atende.', 'Escolha sua regra de confirmação e confira a conta que receberá os pagamentos.', 'Uma última revisão antes de compartilhar o endereço do seu negócio.'];
function publicationNotice() {
  if (!model.published) return '';
  const date = Number(model.publishedAt);
  return `<section class="catalog-publication" aria-label="Estado do catálogo"><div><strong>Catálogo publicado</strong><div id="publication-state" role="status" aria-live="polite">${publicationStatusContent()}</div></div>${publicLinkControls('catalog-public-link', date)}</section>`;
}
function publicationStateView() {
  if (dirty) return { kind: 'editing', title: 'Alterações ainda não salvas', help: 'Estas edições ainda não foram salvas. O catálogo atual continua disponível.' };
  if (saving) return { kind: 'editing', title: 'Salvando alterações…', help: 'O catálogo atual continua disponível enquanto o rascunho é salvo.' };
  if (model?.publication?.hasChanges === true) return { kind: 'pending', title: 'Há alterações pendentes de publicação', help: 'O rascunho tem mudanças em relação ao catálogo publicado. Revise e atualize a publicação para exibi-las aos clientes.' };
  if (model?.publication?.hasChanges === false) return { kind: 'current', title: 'Nenhuma alteração pendente de publicação', help: `Os dados públicos estão iguais ao catálogo publicado. Não é necessário atualizar a publicação.${model.report.ready ? '' : ' Há pendências de configuração; confira as etapas indicadas.'}` };
  return { kind: 'checking', title: 'Conferindo alterações do rascunho…', help: 'O catálogo publicado continua disponível. Recarregue a configuração se a conferência não terminar.' };
}
function publicationStatusContent({ completed = false } = {}) {
  let view = publicationStateView();
  if (completed && view.kind === 'pending') view = { ...view, help: 'Seu rascunho tem mudanças ainda não publicadas. Abra Editar para revisar e publicar. O catálogo atual continua disponível.' };
  if (completed && view.kind === 'current' && !model.report.ready) view = { ...view, title: 'Há pendências de configuração', help: 'O catálogo continua publicado. Abra Editar para conferir as pendências antes de atualizar.' };
  return `<div class="publication-draft-state ${view.kind}${!model.report.ready ? ' needs-attention' : ''}"><strong>${view.title}</strong><p class="publication-state-help">${view.help}</p>${view.kind === 'pending' && !completed ? button('Revisar alterações', 'review-publication', 'secondary small publication-review-link') : ''}</div>`;
}
function reviewPublicationHelp() {
  return model.published ? publicationStateView().help : stepHelp[5];
}
function updatePublicationStatus() {
  if (!model?.published || user?.role !== 'admin') return;
  const el = document.querySelector('#publication-state');
  if (el) el.innerHTML = publicationStatusContent({ completed: !businessEditing && !agendaOpen && !teamOpen });
  const publish = document.querySelector('[data-action="publish"]');
  if (publish) publish.disabled = !model.report.ready || publicationStateView().kind !== 'pending';
  const help = document.querySelector('#review-publication-help');
  if (help && step === 6) help.textContent = reviewPublicationHelp();
}
const publicBookingUrl = () => new URL(`/negocio/${encodeURIComponent(slug)}`, location.origin).href;
function publicLinkControls(id, publishedDate) {
  const address = `<label class="public-link-label" for="${id}">Link público de agendamento</label><input id="${id}" data-public-link type="url" value="${esc(publicBookingUrl())}" readonly aria-describedby="${id}-status">`;
  const copy = button('Copiar link público', 'copy-public-link', '', `data-public-input="${id}"`);
  const select = button('Selecionar link', 'select-public-link', 'secondary', `data-public-input="${id}"`);
  const open = `<a class="button secondary small" href="/negocio/${encodeURIComponent(slug)}" target="_blank" rel="noopener" aria-label="Abrir catálogo publicado">Abrir ↗</a>`;
  const feedback = `<p id="${id}-status" class="small muted public-copy-status" role="status"></p>`;
  if (id === 'catalog-public-link') {
    const details = `${Number.isFinite(publishedDate) && publishedDate > 0 ? `<p class="small muted">Última publicação em ${esc(new Date(publishedDate).toLocaleString('pt-BR'))}.</p>` : ''}${address}${select}`;
    return `<div class="public-link-controls"><div class="public-share-row">${copy}${open}</div>${setupDisclosure('catalog-share', 'Ver endereço e detalhes da publicação', details, { optional: true })}${feedback}</div>`;
  }
  return `<div class="public-link-controls">${address}<div class="public-share-row">${copy}${select}</div>${feedback}</div>`;
}
function publicLinkInput(target) { return document.getElementById(target?.dataset.publicInput || 'catalog-public-link'); }
function publicCopyFeedback(target, message) {
  const el = document.getElementById(`${target?.dataset.publicInput || 'catalog-public-link'}-status`);
  if (el) el.textContent = message;
  toast(message);
}
function selectPublicLink(target, announce = true) {
  if (user?.role !== 'admin' || !model?.published) return;
  const input = publicLinkInput(target);
  if (!input || !input.isConnected) return;
  const fallback = input.closest?.('[data-public-fallback]');
  if (fallback) fallback.hidden = false;
  const disclosure = input.closest?.('details');
  if (disclosure) { disclosure.open = true; setupDisclosureState.set(disclosure.dataset.setupDisclosure, true); }
  input.value = publicBookingUrl(); input.focus(); input.select();
  if (announce) publicCopyFeedback(target, 'Link selecionado. Use Ctrl+C ou ⌘C; no celular, mantenha pressionado e escolha Copiar.');
  return input;
}
function copyPublicLinkCompatible(target) {
  if (!selectPublicLink(target, false)) return false;
  try { return document.execCommand?.('copy') === true; } catch { return false; }
}
async function copyPublicLink(target) {
  if (user?.role !== 'admin' || !model?.published) return;
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(publicBookingUrl()); copied = true; }
    else copied = copyPublicLinkCompatible(target);
  } catch { if (user?.role === 'admin' && model?.published) copied = copyPublicLinkCompatible(target); }
  if (user?.role !== 'admin' || !model?.published) return;
  if (copied) {
    const fallback = publicLinkInput(target)?.closest?.('[data-public-fallback]'); if (fallback) fallback.hidden = true;
    if (target?.isConnected) target.focus();
    publicCopyFeedback(target, 'Link público copiado. Compartilhe com seus clientes.');
  } else {
    selectPublicLink(target, false);
    publicCopyFeedback(target, 'Não foi possível copiar automaticamente. Selecione e copie o endereço exibido.');
  }
}
function renderCompletedBusiness() {
  const business = model.published.business ?? model.draft.business, publishedAt = Number(model.publishedAt);
  root.innerHTML = `${header()}<main id="main" class="business-completed-wrap" tabindex="-1"><section id="published-business" class="business-completed card"><div class="business-completed-heading"><span class="business-completed-check" aria-hidden="true">✓</span><div><div class="eyebrow">Negócio · configuração inicial concluída</div><h1>Seu negócio está publicado</h1><p class="muted">Seu catálogo está disponível no link de agendamento.</p></div></div><div class="business-completed-identity">${avatar(business.name || 'Seu negócio', model.images?.logo, 'logo')}<div><strong>${esc(business.name || 'Seu negócio')}</strong>${Number.isFinite(publishedAt) && publishedAt > 0 ? `<p class="small muted">Última publicação em ${esc(new Date(publishedAt).toLocaleString('pt-BR'))}.</p>` : ''}</div></div><div id="publication-state" role="status" aria-live="polite">${publicationStatusContent({ completed: true })}</div><div class="business-completed-actions"><a class="button" href="${esc(publicBookingUrl())}" target="_blank" rel="noopener noreferrer">Conferir</a>${button('Copiar link', 'copy-public-link', 'secondary', 'data-public-input="published-public-link"')}${button('Editar', 'edit-business', 'secondary')}</div><div id="published-public-link-fallback" class="business-completed-fallback" data-public-fallback hidden><label class="public-link-label" for="published-public-link">Link público de agendamento</label><input id="published-public-link" data-public-link type="url" value="${esc(publicBookingUrl())}" readonly aria-describedby="published-public-link-status"></div><p id="published-public-link-status" class="small muted public-copy-status" role="status"></p></section></main>`;
}
function renderAdmin() {
  const content = [businessStep, peopleStep, servicesStep, hoursStep, receivingStep, reviewStep][step - 1]();
  const issues = model.report.steps[step - 1]?.issues ?? [];
  const complete = model.report.steps.slice(0, 5).filter(s => !s.issues.length).length;
  const names = stepNames.map((name, index) => index === 5 && model.published ? 'Revisar catálogo' : name);
  root.innerHTML = `${header()}${publicationNotice()}<div class="workspace"><aside class="setup-rail"><h2>${model.published ? 'Configuração do seu negócio' : 'Vamos preparar seu negócio'}</h2><p class="small muted">Etapa ${step} de 6</p><div class="progress-bar"><div style="width:${Math.round(complete / 5 * 100)}%"></div></div><ol class="steps">${names.map((name, i) => `<li><button class="step-button ${i < 5 && !model.report.steps[i].issues.length ? 'complete' : ''}" type="button" data-action="go-step" data-step="${i + 1}" ${step === i + 1 ? 'aria-current="step"' : ''} aria-label="Etapa ${i + 1}: ${esc(name)}${i < 5 && !model.report.steps[i].issues.length ? ' · dados preenchidos' : ''}"><span>${i + 1}</span><span>${esc(name)}</span></button></li>`).join('')}</ol><div class="plan-label"><strong>R$ 60,00/mês por negócio</strong><br>Até 3 profissionais ativos<br><span>Ambiente em desenvolvimento</span></div></aside><main id="main" class="setup-main" tabindex="-1"><div class="step-heading"><div><div class="eyebrow">Etapa ${step} · ${esc(names[step - 1])}</div><h1>${esc(names[step - 1])}</h1><p id="review-publication-help">${step === 6 ? reviewPublicationHelp() : stepHelp[step - 1]}</p></div></div><div class="setup-save-info"><div id="save-status" class="save-status" role="status">${esc(draftSaveMessage())}</div>${saveHelpContent()}</div>${validationVisible && issues.length ? `<div class="note error spaced" role="alert"><strong>Antes de continuar:</strong><ul>${issues.map(issue => `<li>${esc(issue)}</li>`).join('')}</ul></div>` : ''}<div class="spaced" id="step-content">${content}</div><footer class="setup-footer"><button type="button" class="text-button ${model.published ? 'published-edit-return' : ''}" data-action="save-later" title="${model.published ? 'Salva o rascunho e volta ao resumo; não publica as alterações' : 'Garante o salvamento do rascunho; você pode fechar após a confirmação'}">${model.published ? 'Voltar ao resumo' : 'Continuar depois'}</button><div class="row">${step > 1 ? button('Voltar', 'previous', 'secondary') : ''}${step < 6 ? button('Continuar', 'next') : button('Salvar agora', 'save', 'secondary')}</div></footer></main></div>`;
}
function teamPage() {
  const professionals = model.draft.professionals;
  return `${header()}<main id="main" class="team-wrap"><div class="eyebrow">Cada pessoa, seu próprio acesso</div><h1>Acessos da equipe</h1><p class="muted spaced">Gere um link pessoal e compartilhe manualmente com a pessoa certa. Nenhum e-mail será enviado. O link expira em 24 horas e só funciona uma vez.</p><div class="note spaced">Gestor do negócio configura o negócio e gerencia toda a agenda. Quando também atende, aparece como “Gestor do negócio e profissional”. Profissional acessa seu perfil e seus atendimentos; recepção organiza a agenda da equipe. Cada pessoa usa seu acesso individual.</div><h2 class="spaced">Profissionais</h2><div class="team-grid spaced">${professionals.map(p => { const account = model.teamAccess.find(u => u.professionalId === p.id); return `<div class="team-member"><div><strong>${esc(p.name || 'Profissional sem nome')}</strong><small>${esc(p.email)} · ${p.active ? 'Ativo' : 'Inativo'}</small><span class="badge">${account?.role === 'admin' ? esc(window.RaelWorkspace.roleLabel(account)) : account?.accepted ? 'Acesso ativado' : account ? 'Convite pendente' : 'Sem convite'}</span></div><div class="row">${account && account.role !== 'admin' ? button(account.active ? 'Bloquear acesso' : 'Liberar acesso', 'access-status', 'secondary small', `data-user="${account.id}" data-active="${!account.active}"`) : ''}${p.active && account?.role !== 'admin' && account?.active !== false ? account?.accepted ? button('Link de recuperação', 'reset-user', 'secondary small', `data-user="${account.id}"`) : button(account ? 'Gerar novo convite' : 'Gerar convite', 'invite-professional', 'secondary small', `data-id="${p.id}"`) : ''}</div></div>`; }).join('')}</div><h2 class="spaced">Recepção</h2><p class="small muted">Quem não realiza atendimentos não ocupa vaga de profissional.</p><div class="team-grid spaced">${model.teamAccess.filter(u => u.role === 'reception').map(u => `<div class="team-member"><div><strong>${esc(u.name)}</strong><small>${esc(u.email)} · ${u.accepted ? 'Acesso ativado' : 'Convite pendente'}</small></div>${button(u.active ? 'Bloquear acesso' : 'Liberar acesso', 'access-status', 'secondary small', `data-user="${u.id}" data-active="${!u.active}"`)}${u.active ? u.accepted ? button('Link de recuperação', 'reset-user', 'secondary small', `data-user="${u.id}"`) : button('Gerar novo convite', 'reinvite-reception', 'secondary small', `data-user="${u.id}"`) : ''}</div>`).join('')}</div><form id="reception-form" class="card spaced"><h3>Convidar uma pessoa da recepção</h3><div class="grid2"><label class="field"><span>Nome</span><input name="name" required minlength="2" maxlength="120"></label><label class="field"><span>E-mail usado no login</span><input name="email" type="email" required maxlength="254"><small>Apenas identifica o acesso. Não enviaremos e-mail.</small></label></div><button class="button" type="submit">Gerar link individual</button></form></main>`;
}
function ownPage() {
  if (user.role === 'reception') return `${header()}<main id="main" class="team-wrap"><div class="eyebrow">Seu acesso de recepção</div><h1>${esc(model.catalog.business.name)}</h1><div class="note spaced">Você pode consultar os serviços e profissionais. Abra a Agenda para criar e organizar os atendimentos da equipe. Configurações do negócio e recebimentos são restritos.</div>${catalogContent(model.catalog, true)}</main>`;
  const p = model.professional;
  return `${header()}<main id="main" class="team-wrap"><div class="eyebrow">Seu espaço profissional</div><h1>Olá, ${esc(user.name.split(' ')[0])}.</h1><p class="muted spaced">${esc(model.businessName)} · você acessa somente seu expediente, serviços e preferências.</p><div class="note spaced">Abra a Agenda para consultar e organizar seus atendimentos. Sua foto aparece na escolha do profissional pelo cliente.</div>${imageEditor('photo', p.photoUrl, p.name)}<section class="card spaced"><h2>Meus serviços</h2>${model.services.map(service => `<div class="review-item spaced"><strong>${esc(service.name)}</strong><span>${money(service.priceCents)} · ${service.durationMinutes} min</span></div>`).join('') || '<p class="small muted spaced">O gestor do negócio ainda não vinculou serviços ao seu cadastro.</p>'}</section><section class="card spaced"><h2>Meu expediente</h2><p class="small muted spaced">Edite apenas os seus horários. Marque “Sem pausa” para atender sem intervalo e use “Copiar dia” para repetir o expediente nos dias que escolher.</p>${hoursFields(p, 0, true)}${ownDirty ? '<p class="note warning spaced" role="status">Você alterou seu expediente. Salve para aplicar os horários.</p>' : ''}${button('Salvar meu expediente', 'save-own-hours', '', 'style="margin-top:20px"')}</section><section class="spaced" id="own-receiving"><h2>Minha regra de recebimento</h2>${receivingCard(p, model.receiving)}</section></main>`;
}
function catalogContent(catalog, embedded = false) {
  const b = catalog.business, professionals = catalog.professionals || [], titleTag = embedded ? 'h3' : 'h1';
  const description = b.description?.trim() || '', longIntroduction = description.length > 160;
  const receiving = p => p.requiresPayment === true ? 'Pagamento antecipado pelo Mercado Pago.' : p.requiresPayment === false ? 'Pagamento a combinar no atendimento, sem cobrança pela plataforma.' : 'Recebimento conforme a escolha deste profissional.';
  const information = `${longIntroduction ? `<p class="catalog-summary-text">${esc(description)}</p>` : ''}${b.mode === 'online' && b.onlineInstructions ? `<div class="catalog-access"><strong>Como acessar o atendimento online</strong><p class="catalog-summary-text">${esc(b.onlineInstructions)}</p></div>` : ''}<p class="catalog-summary-text">${b.phone ? `Contato: ${esc(b.phone)}` : 'Telefone não informado.'}${b.email ? `<br>${esc(b.email)}` : ''}</p>`;
  const introduction = `${description && !longIntroduction ? `<p class="catalog-summary-text">${esc(description)}</p>` : ''}${longIntroduction || b.onlineInstructions || b.phone || b.email ? `<details class="catalog-summary-details catalog-summary-about"><summary>${longIntroduction ? `Conheça ${esc(b.name || 'nosso trabalho')}` : b.mode === 'online' ? 'Acesso ao atendimento e contato' : 'Contato do negócio'}</summary>${information}</details>` : ''}`;
  const services = (catalog.services || []).map(service => {
    const text = service.description?.trim() || '', longDescription = text.length > 160;
    const duration = Number.isFinite(service.durationMinutes) ? `${service.durationMinutes} min` : 'Duração a definir';
    const names = professionals.filter(p => (service.professionalIds || []).includes(p.id)).map(p => p.name || 'Profissional sem nome').join(', ');
    return `<article class="catalog-summary-service"><div class="catalog-service-title"><h3>${esc(service.name || 'Serviço')}</h3><strong>${money(service.priceCents ?? null)}</strong></div>${text ? `<p class="catalog-summary-text">${esc(longDescription ? text.slice(0, 157).trimEnd() + '…' : text)}</p>` : ''}<p class="catalog-service-duration">${esc(duration)}${Number.isFinite(service.gapMinutes) ? ` · ${service.gapMinutes} min de intervalo após` : ''}</p><p class="catalog-service-professionals">Com ${esc(names || 'profissional a definir')}</p>${longDescription ? `<details class="catalog-summary-details"><summary>Descrição completa de ${esc(service.name || 'Serviço')}</summary><p class="catalog-summary-text">${esc(text)}</p></details>` : ''}</article>`;
  }).join('');
  return `<div class="catalog-summary ${embedded ? '' : 'catalog'}"><header class="catalog-summary-brand">${avatar(b.name || 'Seu negócio', b.logoUrl, 'logo')}<div><${titleTag}>${esc(b.name || 'Seu negócio')}</${titleTag}><p>${b.mode === 'online' ? 'Atendimento online' : esc(b.address || 'Local a combinar com o negócio')}</p></div></header>${introduction}<section class="catalog-summary-section" aria-labelledby="catalog-summary-services"><h2 id="catalog-summary-services">Serviços</h2><div class="catalog-summary-services">${services || '<div class="note">Os serviços ainda estão sendo preparados.</div>'}</div></section><section class="catalog-summary-section" aria-labelledby="catalog-summary-professionals"><h2 id="catalog-summary-professionals">Profissionais e expediente</h2><p class="catalog-summary-zone">${esc(zoneLabel(b.timeZone))}</p><div class="catalog-summary-professionals">${professionals.map(p => `<details class="catalog-summary-details catalog-summary-professional"><summary>${avatar(p.name || 'Profissional sem nome', p.photoUrl)}<span><strong>${esc(p.name || 'Profissional sem nome')}</strong><small>${(p.week || []).filter(day => day.enabled).length} dia(s) de atendimento por semana</small></span><span class="catalog-summary-expand" aria-hidden="true">Ver expediente</span></summary><dl class="catalog-summary-week">${(p.week || []).map(day => `<div><dt>${esc(dayNames[day.day])}</dt><dd>${day.enabled ? `${esc(day.start)} às ${esc(day.end)}${day.breakStart !== day.breakEnd ? `<small>Pausa: ${esc(day.breakStart)}–${esc(day.breakEnd)}</small>` : '<small>Sem pausa</small>'}` : 'Fechado'}</dd></div>`).join('')}</dl><p class="catalog-summary-text">${esc(receiving(p))}</p></details>`).join('') || '<p class="catalog-summary-text">Os profissionais ainda estão sendo preparados.</p>'}</div></section>${catalog.rules ? `<details class="catalog-summary-details catalog-summary-rules"><summary>Condições para agendar</summary><ul><li>Antecedência mínima: ${esc(catalog.rules.noticeMinutes)} minutos.</li><li>Agendamentos até ${esc(catalog.rules.advanceDays)} dias à frente.</li><li>Cancelar ou remarcar online até ${esc(catalog.rules.cancelHours)} horas antes do atendimento. Depois, fale com o negócio.</li><li>O recebimento segue a escolha de cada profissional. Confira os detalhes ao abrir o expediente acima.</li></ul></details>` : ''}<p class="catalog-summary-foot">${embedded ? 'Resumo para conferência. ' : ''}A reserva e as condições finais são confirmadas no link de agendamento.</p></div>`;
}
function passwordPage() {
  return `${header()}<main id="main" class="team-wrap account-security-wrap"><div class="eyebrow">Seu acesso individual</div><h1>Minha senha</h1><p class="muted spaced">Altere a senha do seu acesso: <strong>${esc(user.email || user.name)}</strong>.</p><section class="card spaced account-security-card"><h2>Escolher uma nova senha</h2><p class="small muted spaced">Use de 8 a 128 caracteres. Ao salvar, os acessos abertos com sua conta serão encerrados. Entre novamente com a nova senha.</p><form id="account-password-form"><label class="field"><span>Senha atual</span><input name="currentPassword" type="password" maxlength="128" autocomplete="current-password" required></label><label class="field"><span>Nova senha</span><input name="newPassword" type="password" minlength="8" maxlength="128" autocomplete="new-password" required></label><label class="field"><span>Repita a nova senha</span><input name="confirmation" type="password" minlength="8" maxlength="128" autocomplete="new-password" required></label><div id="account-password-error" role="alert"></div><button class="button spaced" type="submit">Salvar minha nova senha</button></form></section></main>`;
}
function render() { syncWorkspaceAddress(); window.RaelAgenda?.unmount(); if (passwordOpen) root.innerHTML = passwordPage(); else if (agendaOpen) { root.innerHTML = `${header()}<main id="main" class="team-wrap"></main>`; window.RaelAgenda.mount({ element: document.querySelector('#main'), request, user, initialDate: new URLSearchParams(location.search).get('data') || '', onDateChange: syncAgendaDate }); } else if (teamOpen && user.role === 'admin') root.innerHTML = teamPage(); else if (user.role === 'admin') { if (model.published && !businessEditing) renderCompletedBusiness(); else renderAdmin(); } else root.innerHTML = ownPage(); syncTheme(); }
async function navigate(next, check = false) {
  if (imageSaving) await imageSaving;
  if (receivingSave) await receivingSave;
  await flush();
  if (check && model.report.steps[step - 1].issues.length) { validationVisible = true; render(); document.querySelector('[role=alert]')?.scrollIntoView({ block: 'center' }); return; }
  if (model.published) businessEditing = true;
  step = Math.min(6, Math.max(1, next)); model.draft.step = step; dirty = true; validationVisible = false;
  await flush(); syncWorkspaceAddress(true); render(); window.scrollTo(0, 0);
}
function staffAccessUrl(value, reset = false) {
  const url = new URL(value, location.origin);
  if (url.origin !== location.origin || url.username || url.password || url.pathname !== `/sistema/${encodeURIComponent(slug)}` || url.search || !(reset ? /^#recuperar=[a-zA-Z0-9_-]+$/ : /^#ativar=[a-zA-Z0-9_-]+$/).test(url.hash)) throw new Error('O link recebido é inválido. Confira o acesso antes de tentar novamente.');
  return url.href;
}
function showLink(result, reset = false) {
  const url = staffAccessUrl(result.url, reset);
  modal(reset ? 'Link pessoal de recuperação' : 'Convite individual pronto', `<p class="small muted">Compartilhe diretamente com a pessoa conferida. ${reset ? 'Válido por 30 minutos.' : 'Válido por 24 horas.'} Só pode ser usado uma vez.</p><label class="field spaced"><span>${reset ? 'Link de recuperação' : 'Link de convite'}</span><input id="staff-access-url" type="text" readonly value="${esc(url)}" autocomplete="off" spellcheck="false"></label>${button('Copiar link pessoal', 'copy-link')}<p id="staff-access-copy-status" class="small muted spaced" role="status" aria-live="polite"></p><p class="small muted spaced">O link aparece apenas nesta janela. Nenhum e-mail foi enviado.</p>`);
}
dialog.addEventListener?.('close', () => { dialog.innerHTML = ''; });

document.addEventListener('toggle', event => {
  const key = event.target.dataset?.setupDisclosure;
  if (key) {
    setupDisclosureState.set(key, event.target.open);
    if (key.startsWith('service-') || key.startsWith('day-')) refreshCompactSummaries();
  }
}, true);

document.addEventListener('input', event => {
  const input = event.target;
  if (input.dataset.path && !['checkbox', 'radio'].includes(input.type)) {
    let value = input.value;
    if (input.dataset.money) { const raw = value.trim(); const parsed = /^\d{1,7}([,.]\d{0,2})?$/.test(raw) ? Number(raw.replace(',', '.')) : NaN; value = Number.isFinite(parsed) ? Math.round(parsed * 100) : null; }
    else if (input.dataset.number) value = Number(value);
    setValue(input.dataset.path, value); markDirty();
  }
  if (input.dataset.ownPath) { const keys = input.dataset.ownPath.split('.'); model.professional.week[Number(keys[1])][keys[2]] = input.type === 'checkbox' ? input.checked : input.value; ownDirty = true; ownEdits++; }
  if (input.dataset.path || input.dataset.ownPath) refreshCompactSummaries();
});
document.addEventListener('change', async event => {
  const input = event.target;
  try {
    if (input.dataset.imageKind) { const file = input.files?.[0]; if (file) await saveImage(input.dataset.imageKind, await prepareImage(file, input.dataset.imageKind)); return; }
    if (input.dataset.noBreak !== undefined) {
      const own = input.dataset.own === 'true', professional = editableHours(input.dataset.id, own), day = professional?.week[Number(input.dataset.noBreak)];
      if (!day?.enabled) return;
      if (input.checked) day.breakStart = day.breakEnd = day.start;
      else {
        const minutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3)), start = minutes(day.start), end = minutes(day.end);
        if (end - start < 2) { toast('Ajuste o início e o fim do expediente antes de incluir uma pausa.'); render(); return; }
        const clock = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`, length = Math.min(60, Math.floor((end - start) / 2)), middle = Math.floor((start + end - length) / 2);
        day.breakStart = clock(middle); day.breakEnd = clock(middle + length);
      }
      hoursChanged(own); return;
    }
    if (input.dataset.receiving !== undefined) {
      if (receivingSave) return;
      const required = input.dataset.receiving === 'true';
      document.querySelectorAll('[data-receiving]').forEach(el => { el.disabled = true; });
      receivingSave = (async () => {
        if (model.draft) await flush();
        while (ownDirty) await saveOwnHours();
        const result = await request('receiving', { method: 'PATCH', body: JSON.stringify({ required, revision: model.revision }) });
        model.revision = result.revision; await load(false); if (user.role === 'admin') document.querySelector('#step-content').innerHTML = receivingStep(); else document.querySelector('#own-receiving').innerHTML = '<h2>Minha regra de recebimento</h2>' + receivingCard(model.professional, model.receiving); updatePublicationStatus(); toast('Sua preferência de recebimento foi salva.');
      })();
      try { await receivingSave; }
      catch (error) { conflict = true; modal('Confira a preferência salva', '<p>Não foi possível conferir o resultado da alteração. Recarregue para confirmar a regra antes de continuar. Não vamos substituir sua escolha silenciosamente.</p>' + button('Recarregar configuração', 'reload', 'secondary spaced')); throw error; }
      finally { receivingSave = null; document.querySelectorAll('[data-receiving]').forEach(el => { el.disabled = false; }); }
      return;
    }
    if (input.id === 'work-professional') { await flush(); workPro = input.value; render(); return; }
    if (input.dataset.service !== undefined) {
      const service = model.draft.services[Number(input.dataset.service)], id = input.dataset.professional;
      service.professionalIds = input.checked ? [...service.professionalIds, id] : service.professionalIds.filter(value => value !== id); markDirty(); refreshCompactSummaries(); return;
    }
    if (input.dataset.path && (['checkbox', 'radio'].includes(input.type) || input.tagName === 'SELECT')) {
      const path = input.dataset.path;
      if (path === 'teamMode' && input.value === 'solo' && model.draft.professionals.filter(p => p.active).length > 1) { toast('Inative os outros profissionais antes de mudar para atendimento individual.'); render(); return; }
      setValue(path, input.type === 'checkbox' ? input.checked : input.value); markDirty();
      if (['business.mode', 'teamMode'].includes(path) || path.endsWith('.enabled') || path.endsWith('.active')) render();
      else refreshCompactSummaries();
    }
    if (input.dataset.ownPath && input.type === 'checkbox') render();
  } catch (error) { showSaveError(error); }
});
document.addEventListener('click', async event => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  const action = target.dataset.action;
  try {
    if (action === 'copy-public-link') { await copyPublicLink(target); return; }
    if (action === 'select-public-link') { selectPublicLink(target); return; }
    if (imageSaving && !['close-dialog', 'copy-link'].includes(action)) await imageSaving;
    if (receivingSave && !['close-dialog', 'copy-link'].includes(action)) await receivingSave;
    if (action === 'close-dialog') { dialog.close(); dialog.innerHTML = ''; return; }
    if (action === 'remove-image') { modal('Remover esta imagem?', `<p>${target.dataset.kind === 'cover' ? 'A vitrine voltará a destacar o logo do negócio.' : 'A imagem deixará de ser exibida no catálogo publicado.'}</p><div class="row spaced">${button('Manter imagem', 'close-dialog', 'secondary')}${button('Remover imagem', 'confirm-remove-image', '', `data-kind="${target.dataset.kind}"`)}</div>`); return; }
    if (action === 'confirm-remove-image') { target.disabled = true; await saveImage(target.dataset.kind, null); dialog.close(); return; }
    if (action === 'copy-link') { const input = dialog.querySelector('#staff-access-url'), feedback = dialog.querySelector('#staff-access-copy-status'); if (!input) return; try { await navigator.clipboard.writeText(input.value); feedback.textContent = 'Link copiado. Entregue apenas à pessoa conferida.'; } catch { input.focus(); input.select(); feedback.textContent = 'Selecione e copie o endereço acima.'; } return; }
    if (action === 'recovery-help') {
      if (recoveryEmail && window.RaelRecovery) { window.RaelRecovery.show({ dialog, email: root.querySelector('#login-form input[name="email"]')?.value || '', titleId: 'dialog-title', send: data => request('password-recovery', { method: 'POST', body: JSON.stringify(data) }) }); return; }
      modal('Recuperar seu acesso', '<p>A recuperação deste acesso está disponível com ajuda da Raelapps ou do gestor do negócio. Peça um link pessoal após a conferência da sua identidade.</p><p class="small muted spaced">Se você é o gestor ou administrador da Raelapps, fale com a operação da plataforma. Não envie sua senha.</p>'); return;
    }
    if (action === 'reload') { location.reload(); return; }
    if (action === 'download-draft') { const url = URL.createObjectURL(new Blob([JSON.stringify(model.draft, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'meu-rascunho-rael.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000); return; }
    if (action === 'mp-connect') { if (dirty) await flush(); if (ownDirty) await saveOwnHours(); const result = await request('mp/connect', { method: 'POST', body: '{}' }); const url = new URL(result.url); if (url.protocol !== 'https:' || url.hostname !== 'auth.mercadopago.com') throw new Error('Endereço de conexão inválido.'); location.assign(url.href); return; }
    if (action === 'mp-check') { mpStatus = await request('mp/check', { method: 'POST', body: '{}' }); modal('Sua conta de recebimento', `<p>Recebedor: <strong>${esc(mpStatus.receiver?.name)}</strong></p><p class="small muted spaced">${mpStatus.mode === 'sandbox' ? 'Ambiente de testes, sem cobrança real.' : 'Conexão de recebimento online.'} Sua conta e seus recebimentos são gerenciados no Mercado Pago.</p>`); return; }
    if (action === 'mp-disconnect') { modal('Desconectar sua conta?', `<p>Novas cobranças ficarão bloqueadas. Se houver pagamentos em acompanhamento, a conexão será mantida até a conferência. Para revogar a autorização no provedor, use também as configurações de aplicativos da sua conta Mercado Pago.</p><div class="row spaced">${button('Manter conexão', 'close-dialog', 'secondary')}${button('Desconectar', 'mp-disconnect-confirm')}</div>`); return; }
    if (action === 'mp-disconnect-confirm') { target.disabled = true; await request('mp/disconnect', { method: 'POST', body: '{}' }); dialog.close(); await load(); return; }
    if (action === 'logout') { if (dirty) await flush(); if (ownDirty) await saveOwnHours(); await request('logout', { method: 'POST', body: '{}' }); window.RaelAgenda?.unmount(); user = null; operationsAvailable = false; model = null; teamOpen = false; agendaOpen = false; passwordOpen = false; csrf = ''; auth(); return; }
    if (action === 'edit-business') {
      if (user?.role !== 'admin' || !model?.published) return;
      await flush(); businessEditing = true; requestedStep = 1; agendaOpen = false; teamOpen = false; await load(); window.scrollTo(0, 0); document.querySelector('#main')?.focus({ preventScroll: true }); return;
    }
    if (action === 'next') return await navigate(step + 1, true);
    if (action === 'previous') return await navigate(step - 1);
    if (action === 'review-publication') {
      if (user?.role !== 'admin' || !model?.published || publicationStateView().kind !== 'pending') return;
      if (step !== 6) await navigate(6);
      const review = document.querySelector('#main'); review?.focus({ preventScroll: true }); review?.scrollIntoView({ block: 'start' }); return;
    }
    if (action === 'go-step') return await navigate(Number(target.dataset.step));
    if (action === 'save' || action === 'save-later') { await flush(); if (action === 'save-later' && user?.role === 'admin' && model?.published) { businessEditing = false; requestedStep = 0; await load(); syncWorkspaceAddress(true); window.scrollTo(0, 0); document.querySelector('#main')?.focus({ preventScroll: true }); toast(model.publication?.hasChanges === true ? 'Rascunho salvo. As alterações só aparecem para os clientes depois de publicar.' : 'Configuração salva.'); } else toast('Rascunho salvo. Você pode fechar e continuar depois; a publicação é feita separadamente.'); return; }
    if (action === 'open-agenda' || action === 'open-profile' || action === 'open-password') { if (model.draft) await flush(); if (ownDirty) await saveOwnHours(); agendaOpen = action === 'open-agenda'; passwordOpen = action === 'open-password'; teamOpen = false; businessEditing = false; requestedStep = 0; await load(); syncWorkspaceAddress(true); window.scrollTo(0, 0); return; }
    if (action === 'team') { if (model.draft) await flush(); passwordOpen = false; agendaOpen = false; teamOpen = !teamOpen; businessEditing = false; requestedStep = 0; await load(); syncWorkspaceAddress(true); window.scrollTo(0, 0); return; }
    if (action === 'copy-day') {
      const own = target.dataset.own === 'true', professional = editableHours(target.dataset.id, own), index = Number(target.dataset.day), day = professional?.week[index];
      if (!day) return;
      modal(`Copiar ${dayNames[day.day]} de ${professional.name}`, `<p class="small muted spaced">${day.enabled ? `${day.start}–${day.end}${day.breakStart === day.breakEnd ? ' · sem pausa' : ` · pausa ${day.breakStart}–${day.breakEnd}`}` : 'Dia fechado'}. Escolha os dias que receberão esta configuração. Somente o expediente de <strong>${esc(professional.name)}</strong> será alterado.</p><form id="copy-day-form" data-id="${esc(professional.id)}" data-day="${index}" data-own="${own}"><fieldset class="copy-day-options spaced"><legend>Aplicar aos dias selecionados</legend>${professional.week.map((destination, i) => i === index ? '' : `<label class="check-line"><input name="targetDay" type="checkbox" value="${i}">${dayNames[destination.day]}</label>`).join('')}</fieldset><p class="small muted spaced">Isso substitui os horários, a pausa e a situação aberto/fechado apenas dos dias selecionados.</p><div class="row spaced">${button('Voltar sem copiar', 'close-dialog', 'secondary')}<button class="button" type="submit">Copiar para os dias selecionados</button></div></form>`); return;
    }
    if (action === 'copy-week') {
      const professional = editableHours(target.dataset.id), sources = user.role === 'admin' ? model.draft.professionals.filter(p => p.active && p.id !== target.dataset.id) : [];
      if (!professional || !sources.length) return;
      modal(`Copiar uma semana para ${professional.name}`, `<p class="small muted spaced">Escolha de quem copiar. Os sete dias de <strong>${esc(professional.name)}</strong> serão substituídos; os horários da pessoa de origem serão preservados.</p><form id="copy-week-form" data-id="${esc(professional.id)}"><label class="field spaced"><span>Copiar o expediente de</span><select name="sourceId" required><option value="">Escolha um profissional</option>${sources.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label><div class="row spaced">${button('Voltar sem copiar', 'close-dialog', 'secondary')}<button class="button" type="submit">Substituir a semana de ${esc(professional.name)}</button></div></form>`); return;
    }
    if (action === 'add-professional') {
      model.draft.professionals.push({ id: uid(), name: '', email: '', active: true, week: week() }); markDirty(); render(); return;
    }
    if (action === 'add-service' || action === 'suggest-service') { model.draft.services.push({ id: uid(), name: target.dataset.name ?? '', description: '', priceCents: null, durationMinutes: 30, gapMinutes: 0, professionalIds: model.draft.professionals.filter(p => p.active).map(p => p.id), online: true }); markDirty(); render(); return; }
    if (action === 'remove-service') { model.draft.services.splice(Number(target.dataset.index), 1); markDirty(); render(); return; }
    if (action === 'save-own-hours') { await saveOwnHours(); render(); toast('Seu expediente foi salvo.'); return; }
    if (action === 'preview') { await flush(); const d = model.draft; modal('Resumo público do negócio', catalogContent({ business: { ...d.business, logoUrl: model.images?.logo }, professionals: d.professionals.filter(p => p.active).map(p => ({ ...p, photoUrl: model.images?.[p.id], requiresPayment: Boolean(model.preferences.find(pref => pref.professional_id === p.id)?.require_payment) })), services: d.services.filter(s => s.online), rules: d.rules }, true), { preview: true }); return; }
    if (action === 'publish') {
      await flush();
      modal('Publicar o catálogo do negócio?', `<p>Nome, contato, local, serviços, profissionais e horários ficarão visíveis para quem tiver o link. Os clientes poderão reservar os horários disponíveis pelo link de agendamento. O recebimento segue a regra de cada profissional e a disponibilidade da conexão Mercado Pago.</p><div class="row spaced">${button('Voltar e revisar', 'close-dialog', 'secondary')}${button('Confirmar publicação', 'confirm-publish')}</div>`); return;
    }
    if (action === 'confirm-publish') { target.disabled = true; await request('publish', { method: 'POST', body: JSON.stringify({ revision: model.revision }) }); businessEditing = false; requestedStep = 0; dialog.close(); await load(); syncWorkspaceAddress(true); document.querySelector('#main')?.focus({ preventScroll: true }); window.scrollTo(0, 0); toast('Seu catálogo está publicado.'); return; }
    if (action === 'invite-professional') { const p = model.draft.professionals.find(p => p.id === target.dataset.id); target.disabled = true; const result = await request('team/invite', { method: 'POST', body: JSON.stringify({ role: 'professional', professionalId: p.id, email: p.email }) }); await load(); showLink(result); return; }
    if (action === 'reinvite-reception') { const u = model.teamAccess.find(u => u.id === target.dataset.user); const result = await request('team/invite', { method: 'POST', body: JSON.stringify({ role: 'reception', name: u.name, email: u.email }) }); showLink(result); return; }
    if (action === 'access-status') { await request('team/status', { method: 'POST', body: JSON.stringify({ userId: target.dataset.user, active: target.dataset.active === 'true' }) }); await load(); toast('Situação do acesso atualizada. O expediente não foi alterado.'); return; }
    if (action === 'reset-user') { const account = user?.role === 'admin' && model.teamAccess.find(u => u.id === target.dataset.user && u.role !== 'admin' && u.active && u.accepted); if (!account) throw new Error('Atualize a equipe e confira o acesso da pessoa.'); modal('Confirmar recuperação de acesso', `<p class="spaced"><strong>${esc(account.name)}</strong><br>${esc(account.email)}<br>${esc(model.draft.business.name)} · ${esc(slug)}</p><p class="small muted spaced">Confira a identidade da pessoa pelo canal combinado. Ela escolherá a própria senha usando um link pessoal, válido por 30 minutos e uma única vez.</p><form id="recovery-confirm-form" data-user="${esc(account.id)}"><label class="check-line spaced"><input name="identityConfirmed" type="checkbox" required>Conferi a identidade desta pessoa e o negócio acima.</label><div id="recovery-confirm-error" role="alert"></div><button class="button spaced" type="submit">Gerar link de recuperação</button></form>`); return; }
  } catch (error) { target.disabled = false; showSaveError(error); }
});
document.addEventListener('submit', async event => {
  event.preventDefault(); const form = event.target, formData = new FormData(form), data = Object.fromEntries(formData); const submit = form.querySelector('[type=submit]'); if (submit) submit.disabled = true;
  try {
    if (form.id === 'copy-day-form') {
      const own = form.dataset.own === 'true', professional = editableHours(form.dataset.id, own), sourceIndex = Number(form.dataset.day), source = professional?.week[sourceIndex], targets = [...new Set(formData.getAll('targetDay').map(Number))];
      if (!source || !targets.length || targets.some(i => !Number.isInteger(i) || i < 0 || i > 6 || i === sourceIndex)) throw new Error('Selecione os dias que receberão os horários.');
      for (const index of targets) professional.week[index] = { ...source, day: professional.week[index].day };
      dialog.close(); hoursChanged(own); toast(`Expediente de ${professional.name} copiado para ${targets.map(i => dayNames[professional.week[i].day]).join(', ')}.${own ? ' Salve seu expediente para aplicar.' : ''}`); return;
    }
    if (form.id === 'copy-week-form') {
      const destination = editableHours(form.dataset.id), source = user.role === 'admin' ? model.draft.professionals.find(p => p.active && p.id === data.sourceId && p.id !== form.dataset.id) : null;
      if (!destination || !source) throw new Error('Escolha um profissional de origem e confira o destino.');
      destination.week = structuredClone(source.week); dialog.close(); hoursChanged(false); toast(`Semana de ${source.name} copiada somente para ${destination.name}.`); return;
    }
    if (form.id === 'business-address-form') { const value = data.slug.trim().toLowerCase(); if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(value)) throw new Error('Confira o identificador escolhido no cadastro ou informado no convite.'); location.assign(`/sistema/${value}`); return; }
    if (form.id === 'account-password-form') {
      if (!data.currentPassword || data.currentPassword.length > 128) throw new Error('Informe sua senha atual.');
      if (typeof data.newPassword !== 'string' || data.newPassword.length < 8 || data.newPassword.length > 128) throw new Error('Use de 8 a 128 caracteres na nova senha.');
      if (data.newPassword !== data.confirmation) throw new Error('As novas senhas precisam ser iguais.');
      await request('account/password', { method: 'POST', body: JSON.stringify({ currentPassword: data.currentPassword, newPassword: data.newPassword }) });
      form.reset(); activation = null; auth('Sua senha foi alterada. Entre novamente com a nova senha.', true); return;
    }
    if (form.id === 'recovery-confirm-form') { if (data.identityConfirmed !== 'on') throw new Error('Confirme a identidade da pessoa antes de gerar o link.'); const requesterId = user?.id, requesterCsrf = csrf; const result = await request('team/recovery', { method: 'POST', body: JSON.stringify({ userId: form.dataset.user, identityConfirmed: true }) }); if (!requesterId || user?.id !== requesterId || csrf !== requesterCsrf || !dialog.open || form.isConnected === false) return; showLink(result, true); return; }
    if (form.id === 'login-form') { const result = await request('login', { method: 'POST', body: JSON.stringify(data) }); csrf = result.csrf; user = result.user; const session = await request('session'); operationsAvailable = session.operationsAvailable === true; if (finishOperationReturn()) return; if (user.role !== 'admin') teamOpen = false; await load(); return; }
    if (form.id === 'activate-form') { if (data.password !== data.confirmation) throw new Error('As senhas precisam ser iguais.'); await request('activate', { method: 'POST', body: JSON.stringify({ ...activation, password: data.password }) }); activation = null; auth('Senha definida. Entre com seu e-mail e a senha escolhida.'); return; }
    if (form.id === 'reception-form') { const result = await request('team/invite', { method: 'POST', body: JSON.stringify({ ...data, role: 'reception' }) }); await load(); showLink(result); return; }
  } catch (error) { if (error.status === 401) { auth(error.message); return; } const box = document.querySelector(form.id === 'account-password-form' ? '#account-password-error' : form.id === 'recovery-confirm-form' ? '#recovery-confirm-error' : '#auth-error'); if (box) box.innerHTML = errorBox(error.message); else toast(error.message); }
  finally { if (submit) submit.disabled = false; }
});
async function saveOwnHours() {
  if (ownSaving) { await ownSaving; if (ownDirty) return saveOwnHours(); return; }
  const edits = ownEdits;
  ownSaving = request('hours', { method: 'PATCH', body: JSON.stringify({ week: model.professional.week, revision: model.revision }) }).then(result => { model.revision = result.revision; ownDirty = edits !== ownEdits; }).finally(() => { ownSaving = null; });
  await ownSaving;
}
window.addEventListener('beforeunload', event => { if (dirty || saving || receivingSave || imageSaving || ownSaving || ownDirty) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('error', event => { if (event.target.matches?.('.profile-image img')) event.target.remove(); }, true);
async function boot() {
  if (!slug) { root.innerHTML = `${header()}<main id="main" class="auth-wrap"><div class="card"><div class="eyebrow">Acesso ao seu negócio</div><h1>Qual é seu endereço?</h1><p class="muted spaced">Use o identificador escolhido no cadastro ou informado no convite do gestor.</p><form id="business-address-form"><label class="field"><span>Identificador do negócio</span><input name="slug" required minlength="2" maxlength="48" placeholder="Ex.: meu-negocio" autocapitalize="none" autocomplete="off"></label><button class="button full" type="submit">Continuar</button></form></div></main>`; syncTheme(); return; }
  try {
    const meta = await request('meta'); testMode = meta.testMode; recoveryEmail = meta.recoveryEmail === true;
    if (publicMode) { const catalog = await request('catalog'); root.innerHTML = `${header()}<main id="main">${catalogContent(catalog)}</main>`; syncTheme(); return; }
    if (activation) { auth(); return; }
    try { const session = await request('session'); csrf = session.csrf; user = session.user; operationsAvailable = session.operationsAvailable === true; if (finishOperationReturn()) return; if (user.role !== 'admin') teamOpen = false; await load(); if (mpReturn) { if (user.role === 'admin') { businessEditing = true; agendaOpen = false; teamOpen = false; step = 5; render(); } toast(mpReturn.state === 'conectado' ? 'Conta Mercado Pago conectada.' : mpReturn.state === 'cancelado' ? 'A conexão foi cancelada. Você pode tentar novamente.' : mpReturn.message || 'Não foi possível concluir a conexão.'); }  }
    catch (error) { if (error.status === 401) auth(); else throw error; }
  } catch (error) { root.innerHTML = `${header()}<main id="main" class="auth-wrap"><div class="card"><h1>Vamos preparar este espaço.</h1><p class="muted spaced">${esc(error.message)}</p><a class="button secondary spaced" href="/">Voltar para a página inicial</a></div></main>`; syncTheme(); }
}
boot();
