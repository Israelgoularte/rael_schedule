'use strict';
(() => {
  const root = document.querySelector('#mp-root');
  const slug = location.pathname.split('/')[2];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let session = null;
  let csrf = '', settings = null, businessName = '', saving = false;
  let subscriptionReceiving = null, receivingBusy = false, receivingNotice = '', receivingError = false;
  async function request(path, data) {
    const response = await fetch(`/internal/${encodeURIComponent(slug)}/${path}`, {credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json',...(data ? {'X-CSRF-Token':csrf} : {})},...(data ? {method:'POST',body:JSON.stringify(data)} : {})});
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error || 'Não foi possível concluir. Tente novamente.'); error.status = response.status; if (error.status === 401) { session = null; csrf = ''; settings = null; subscriptionReceiving = null; receivingNotice = ''; businessName = ''; accessPage(error); } throw error; }
    return result;
  }
  const back = () => `/sistema/${encodeURIComponent(slug)}?etapa=5`;
  function header() { return window.RaelWorkspace.render({ slug, businessName: businessName || session?.businessName, user: session?.user, active: 'receiving', operationsAvailable: session?.operationsAvailable === true, logoutHtml: session?.user ? '<button type="button" class="button secondary small" data-mp-logout aria-label="Sair da minha conta">Sair</button>' : '' }); }
  function accessPage(error) {
    root.innerHTML = `${header()}<main id="main" class="auth-wrap"><section class="card"><div class="eyebrow">Recebimentos do negócio</div><h1>${error.status === 401 ? 'Entre no seu negócio' : 'Acesso à configuração'}</h1><p class="spaced">${esc(error.message)}</p><a class="button full spaced" href="${back()}">${error.status === 401 ? 'Ir para o acesso do negócio' : 'Voltar ao meu perfil'}</a></section></main>`; window.RaelTheme?.sync(); window.RaelWorkspace.sync();
  }
  function feedback(message, error = false) {
    const area = document.querySelector('#mp-feedback');
    if (!area) return;
    area.className = `note ${error ? 'error' : 'success'} mp-feedback spaced`;
    area.textContent = message; area.setAttribute('role', error ? 'alert' : 'status');
    area.focus();
  }
  const paymentsReleased = () => Boolean(settings && (settings.paymentsEnabled ?? settings.configured) === true && settings.releasePending !== true);
  function subscriptionReceivingContent() {
    if (!subscriptionReceiving) return '<h2 id="subscription-receiving-title">Recebimento das assinaturas</h2><p>Não foi possível carregar esta configuração.</p><button type="button" class="button secondary spaced" data-subscription-action="reload">Atualizar situação</button>';
    const business = subscriptionReceiving.mode === 'business', connected = subscriptionReceiving.connected === true;
    const enabled = paymentsReleased() && subscriptionReceiving.configured === true;
    const connectionStatus = connected ? 'Conta conectada' : subscriptionReceiving.status === 'reconnect' ? 'Reconexão necessária' : subscriptionReceiving.status === 'disconnected' ? 'Conta desconectada' : 'Conexão pendente';
    const disabled = receivingBusy ? 'disabled' : '', connectionDisabled = receivingBusy || !enabled ? 'disabled' : '';
    return `<h2 id="subscription-receiving-title">Recebimento das assinaturas</h2><p>Escolha onde receber as mensalidades dos consumidores. Os atendimentos avulsos mantêm a regra e a conta individual de cada profissional.</p>
      <form id="subscription-receiving-form"><fieldset class="mp-receiving-options" ${disabled}><legend>Onde receber novas assinaturas?</legend><label class="mp-receiving-choice"><input type="radio" name="mode" value="business" ${business ? 'checked' : ''}><span><strong>Na conta do negócio</strong><small>O gestor autoriza a conta que receberá as mensalidades do negócio.</small></span></label><label class="mp-receiving-choice"><input type="radio" name="mode" value="professional" ${!business ? 'checked' : ''}><span><strong>Na conta de cada profissional</strong><small>Cada profissional autoriza a própria conta recebedora.</small></span></label></fieldset><div class="mp-actions spaced"><button type="submit" class="button" ${disabled}>${receivingBusy ? 'Aguarde…' : 'Salvar recebimento das assinaturas'}</button></div></form>
      <p class="small muted">A mudança vale apenas para novas contratações. Assinaturas existentes mantêm a conta combinada. O sistema não divide o pagamento entre contas.</p><p class="small muted">A conta do negócio centraliza o recebimento das novas adesões, inclusive de planos individuais. Para permitir atendimentos com qualquer profissional habilitado, crie um <strong>Plano do negócio</strong> em <a href="/sistema/${encodeURIComponent(slug)}/assinaturas">Planos e Assinaturas</a>. Essa escolha não converte planos nem contratos existentes.</p>
      ${!enabled ? '<div class="note warning spaced">Você pode salvar sua escolha. A conexão das contas e os recebimentos online aguardam a preparação e a liberação da Raelapps.</div>' : ''}
      ${business ? `<div class="mp-business-connection spaced"><span class="badge ${connected ? 'good' : 'pending'}">${connectionStatus}</span><dl class="mp-receiving-account"><dt>Recebedor das assinaturas</dt><dd>${esc(subscriptionReceiving.receiver?.name || 'Ainda não conectado')}</dd></dl>${!connected ? '<p>Conecte a conta do negócio para liberar novas contratações. Enquanto a conexão estiver pendente, as assinaturas não serão cobradas nas contas individuais dos profissionais.</p>' : '<p>Novas assinaturas serão recebidas nessa conta. A conexão não confirma um pagamento.</p>'}<p class="small muted">Entre no Mercado Pago com a conta do negócio sob sua responsabilidade. Sua senha e eventuais códigos são informados somente no site oficial.</p><div class="mp-actions spaced">${connected ? `<button type="button" class="button secondary" data-subscription-action="check" ${connectionDisabled}>Conferir conexão do negócio</button><button type="button" class="button secondary" data-subscription-action="connect" ${connectionDisabled}>Renovar autorização do negócio</button><button type="button" class="button secondary" data-subscription-action="disconnect" ${connectionDisabled}>Desconectar conta do negócio</button>` : `<button type="button" class="button" data-subscription-action="connect" ${connectionDisabled}>${subscriptionReceiving.status === 'reconnect' ? 'Reconectar conta do negócio' : 'Conectar conta do negócio'}</button>`}</div>${connected ? '<p class="small muted">Se houver pagamentos ou assinaturas em acompanhamento, a desconexão poderá ser impedida. Procure o suporte antes de trocar uma conta com histórico.</p>' : ''}</div>` : `<p class="spaced">Cada profissional deve conectar sua própria conta na etapa Recebimento do seu acesso. ${subscriptionReceiving.receiver ? `A conta do negócio ${esc(subscriptionReceiving.receiver.name)} não será usada para novas assinaturas neste modo.` : ''}</p>`}
      <div id="subscription-receiving-feedback" class="${receivingNotice ? `note ${receivingError ? 'error' : 'success'} spaced` : 'mp-feedback'}" role="${receivingError ? 'alert' : 'status'}" tabindex="-1">${esc(receivingNotice)}</div>`;
  }
  function renderSubscriptionReceiving() {
    const section = document.querySelector('#recebimento-assinaturas');
    if (section && session?.user.role === 'admin') section.innerHTML = subscriptionReceivingContent();
  }
  async function receivingAction(action, input) {
    if (receivingBusy || saving || session?.user.role !== 'admin') return;
    if (action !== 'save' && action !== 'reload' && (!paymentsReleased() || subscriptionReceiving?.configured !== true)) return;
    receivingBusy = true; receivingNotice = ''; receivingError = false; renderSubscriptionReceiving();
    try {
      if (action === 'save') {
        if (!['business', 'professional'].includes(input.mode)) throw new Error('Escolha onde receber as assinaturas.');
        subscriptionReceiving = await request('subscription-receiving', { mode: input.mode, revision: subscriptionReceiving.revision });
        receivingNotice = subscriptionReceiving.mode === 'business' && !subscriptionReceiving.connected ? 'Escolha salva. A conta do negócio precisa estar conectada para novas contratações.' : 'Recebimento das assinaturas salvo. A mudança vale apenas para novas contratações.';
      } else if (action === 'connect') {
        const result = await request('subscription-receiving/connect', {}), url = new URL(result.url);
        if (url.protocol !== 'https:' || url.hostname !== 'auth.mercadopago.com' || url.username || url.password || url.port) throw new Error('Endereço de conexão inválido.');
        location.assign(url.href);
      } else {
        if (action !== 'reload') await request(`subscription-receiving/${action}`, {});
        subscriptionReceiving = await request('subscription-receiving');
        receivingNotice = action === 'check' ? 'Conexão do negócio conferida.' : action === 'disconnect' ? 'Conta do negócio desconectada. Novas contratações dependem de uma conta conectada.' : 'Situação do recebimento atualizada.';
      }
    } catch (error) {
      receivingNotice = error.status === 409 ? `${error.message} Atualize esta página para conferir a configuração antes de tentar novamente.` : error.message;
      receivingError = true;
    } finally {
      receivingBusy = false;
      if (session) { renderSubscriptionReceiving(); if (receivingNotice) document.querySelector('#subscription-receiving-feedback')?.focus(); }
    }
  }
  function subscriptionReturn() {
    const query = new URLSearchParams(location.search || ''), result = query.get('recebimento');
    if (result) {
      const connected = result === 'conectado' && subscriptionReceiving?.connected === true;
      receivingNotice = connected ? 'Conta do negócio conectada. Confira o recebedor das assinaturas abaixo.' : result === 'conectado' ? 'O retorno da autorização foi recebido. Confira a situação da conexão abaixo.' : result === 'cancelado' ? 'A conexão foi cancelada. Você pode tentar novamente.' : query.get('motivo') || 'Não foi possível concluir a conexão. Inicie novamente nesta página.';
      receivingError = result !== 'conectado'; renderSubscriptionReceiving();
    }
    if (result || query.get('assinaturas') === 'recebimento' || location.hash === '#recebimento-assinaturas') {
      document.querySelector('#recebimento-assinaturas')?.scrollIntoView?.({ block: 'start' });
      if (receivingNotice) document.querySelector('#subscription-receiving-feedback')?.focus();
    }
  }
  function render() {
    const ready = (settings.applicationConfigured ?? settings.configured) === true, releasePending = settings.releasePending === true;
    const paymentsEnabled = (settings.paymentsEnabled ?? settings.configured) === true && !releasePending, sandbox = settings.mode === 'sandbox';
    const status = paymentsEnabled ? 'Aplicação configurada' : ready ? (releasePending ? 'Aplicação salva · aguardando liberação' : 'Credenciais salvas') : 'Configuração pendente';
    root.innerHTML = `${header()}<main id="main" class="mp-wrap"><div class="mp-intro"><div class="eyebrow">Configuração guiada · Mercado Pago</div><h1>Prepare os recebimentos de ${esc(businessName)}</h1><p>Use uma aplicação criada na conta Mercado Pago do seu negócio. Após a preparação e a liberação dos recebimentos, escolha como receber as assinaturas. Nos atendimentos avulsos, cada profissional autoriza sua própria conta.</p></div>
      <div class="mp-layout"><div class="mp-guide">
      <section class="card" aria-labelledby="mp-step-1"><h2 id="mp-step-1"><span class="mp-number">1</span>Abra a conta certa</h2><p>Entre no painel oficial com a conta que pertence a este negócio.</p><ol><li>Abra <strong>Suas integrações</strong> e crie ou selecione uma aplicação exclusiva para este negócio.</li><li>Para mensalidades dos consumidores, selecione <strong>Assinaturas</strong>; para pagamentos avulsos, <strong>Checkout Pro</strong>. Se já criou uma aplicação de Assinaturas para este negócio, use-a.</li><li>${sandbox ? 'Este ambiente está em homologação. Use uma aplicação de uma <strong>conta de teste brasileira</strong> e as credenciais dessa conta fictícia.' : 'Use as credenciais da aplicação da sua conta brasileira. A liberação de cobranças reais depende da homologação da plataforma.'}</li></ol><a class="button secondary" href="https://www.mercadopago.com.br/developers/panel/app" target="_blank" rel="noopener noreferrer">Abrir painel do Mercado Pago ↗</a></section>
      <section class="card" aria-labelledby="mp-step-2"><h2 id="mp-step-2"><span class="mp-number">2</span>Cadastre os endereços</h2><p>Na sua aplicação, configure estes dois endereços. Eles identificam este negócio.</p><div class="field"><span>URL de retorno da autorização</span><small>Nas configurações de OAuth, cadastre como Redirect URI e habilite PKCE.</small><code class="mp-url">${esc(settings.callbackUrl)}</code><button type="button" class="button secondary small mp-copy" data-copy="callbackUrl">Copiar endereço de retorno</button></div><div class="field"><span>URL das notificações</span><small>Em Webhooks, selecione <strong>Planos e assinaturas</strong> e <strong>Pagamentos (legacy)</strong> (ou <strong>Pagamentos</strong>, conforme o nome no painel). Se Planos e assinaturas não aparecer, peça conferência à Raelapps antes de cobrar mensalidades. ${sandbox ? 'Se o painel mostrar abas de teste e produção, use este endereço na configuração da aplicação fictícia de homologação.' : 'Se o painel separar teste e produção, use este endereço na configuração de produção da aplicação real deste negócio.'}</small><code class="mp-url">${esc(settings.webhookUrl)}</code><button type="button" class="button secondary small mp-copy" data-copy="webhookUrl">Copiar endereço das notificações</button></div><p class="small muted">Guarde o segredo de assinatura gerado ao salvar as notificações. Ele será solicitado na próxima etapa.</p></section>
      <section class="card" aria-labelledby="mp-step-3"><h2 id="mp-step-3"><span class="mp-number">3</span>Valide sua aplicação</h2><p>Copie os dados do painel do Mercado Pago. A validação confere a conta titular antes de salvar.</p>${settings.message || !settings.editable ? `<div class="note warning spaced">${esc(settings.message || 'O armazenamento protegido está sendo preparado pela plataforma.')}</div>` : ''}<form id="mp-form" autocomplete="off"><fieldset ${!settings.editable ? 'disabled' : ''} style="border:0;padding:0;margin:0;min-width:0"><label class="field"><span>Client ID</span><input name="clientId" inputmode="numeric" pattern="[0-9]{4,32}" maxlength="32" value="${esc(settings.clientId)}" required><small>Disponível nas credenciais de produção da aplicação, inclusive em uma conta de teste. Ao trocar o Client ID, informe novamente as duas chaves.</small></label><label class="field"><span>Client Secret</span><input name="clientSecret" type="password" maxlength="4096" autocomplete="new-password" ${!settings.secretConfigured.clientSecret ? 'required' : ''}><small>${settings.secretConfigured.clientSecret ? 'Já protegido. Deixe em branco para manter o valor salvo.' : 'Cole a chave privada da aplicação. Ela será armazenada cifrada e não será exibida novamente.'}</small></label><label class="field"><span>Segredo das notificações</span><input name="webhookSecret" type="password" maxlength="4096" autocomplete="new-password" ${!settings.secretConfigured.webhookSecret ? 'required' : ''}><small>${settings.secretConfigured.webhookSecret ? 'Já protegido. Deixe em branco para manter o valor salvo.' : 'É o segredo gerado na seção Webhooks, diferente do Client Secret.'}</small></label><label class="check-line"><input name="confirmedOwnership" type="checkbox" required><span>Confirmo que esta aplicação pertence a este negócio e que conferi a conta aberta no Mercado Pago.</span></label><div class="mp-actions"><button class="button" type="submit">${ready ? 'Validar e salvar configuração' : 'Validar e salvar minha aplicação'}</button></div></fieldset></form><div id="mp-feedback" class="mp-feedback" tabindex="-1"></div><p class="mp-private">Não informe senha de login, dados de cartão ou Access Token. As chaves privadas permanecem no servidor.</p></section>
      <section class="card mp-subscription-receiving" id="recebimento-assinaturas" aria-labelledby="subscription-receiving-title">${subscriptionReceivingContent()}</section>
      <section class="card" aria-labelledby="mp-step-4"><h2 id="mp-step-4"><span class="mp-number">4</span>${paymentsEnabled ? 'Conecte quem vai receber' : 'Liberação dos recebimentos'}</h2>${paymentsEnabled ? `<p>A aplicação está preparada. Para os atendimentos avulsos e as assinaturas no modo individual, cada profissional deve entrar com seu próprio acesso, abrir a etapa Recebimento e autorizar sua conta no Mercado Pago. A regra de exigir pagamento nos atendimentos avulsos também é definida pelo próprio profissional.</p><a class="button spaced" href="${back()}">Ir para as contas dos profissionais</a>` : `<p>${releasePending ? 'Os recebimentos online permanecem desativados enquanto a plataforma conclui a homologação e a liberação.' : 'A conexão das contas profissionais ficará disponível após a preparação da aplicação e a liberação dos recebimentos.'}</p>`}</section>
      </div><aside class="card mp-side" aria-label="Situação dos recebimentos"><h2>Seu negócio, sua conta</h2><span class="badge ${paymentsEnabled ? 'good' : 'pending'}">${status}</span><dl><dt>Ambiente</dt><dd>${sandbox ? 'Homologação · sem cobrança real' : 'Produção'}</dd><dt>Conta titular</dt><dd>${esc(settings.owner?.name || (ready ? 'Configurada pela plataforma' : 'Aguardando validação'))}</dd><dt>Identificação da aplicação</dt><dd>${esc(settings.clientId || 'Ainda não informada')}</dd></dl><p>A mensalidade de R$ 60 da Raelapps é um contrato separado. Esta configuração cuida dos recebimentos do seu negócio.</p><p><a href="https://www.mercadopago.com.br/developers/pt/docs/security/oauth/creation" target="_blank" rel="noopener noreferrer">Ajuda oficial sobre autorização ↗</a></p></aside></div></main>`;
    window.RaelTheme?.sync(); window.RaelWorkspace.sync();
  }
  root.addEventListener('click', async event => {
    const logout = event.target.closest('[data-mp-logout]');
    if (logout?.dataset.mpLogout !== undefined) { try { await request('logout', {}); session = null; location.assign(`/sistema/${encodeURIComponent(slug)}`); } catch (error) { feedback(error.message, true); } return; }
    const receivingButton = event.target.closest('[data-subscription-action]');
    if (receivingButton) { if (!receivingButton.disabled && ['connect', 'check', 'disconnect', 'reload'].includes(receivingButton.dataset.subscriptionAction)) await receivingAction(receivingButton.dataset.subscriptionAction); return; }
    const button = event.target.closest('[data-copy]'); if (!button) return;
    try { await navigator.clipboard.writeText(settings[button.dataset.copy]); const label = button.textContent; button.textContent = 'Endereço copiado'; setTimeout(() => { if (button.isConnected) button.textContent = label; }, 2000); }
    catch { button.textContent = 'Selecione e copie o endereço acima'; }
  });
  root.addEventListener('submit', async event => {
    if (event.target.id === 'subscription-receiving-form') { event.preventDefault(); const data = new FormData(event.target); await receivingAction('save', { mode: data.get('mode') }); return; }
    if (event.target.id !== 'mp-form') return; event.preventDefault(); if (saving || receivingBusy) return;
    const form = event.target, button = form.querySelector('button[type=submit]'), data = new FormData(form);
    if (!form.reportValidity()) return;
    saving = true; button.disabled = true; button.textContent = 'Conferindo a conta…'; form.setAttribute('aria-busy','true');
    try {
      settings = await request('integration', {clientId:String(data.get('clientId')).trim(),clientSecret:String(data.get('clientSecret')).trim(),webhookSecret:String(data.get('webhookSecret')).trim(),revision:settings.revision,confirmedOwnership:data.get('confirmedOwnership') === 'on'});
      form.reset();
      try { subscriptionReceiving = await request('subscription-receiving'); } catch (error) { if (error.status === 401) throw error; subscriptionReceiving = null; }
      render();
      feedback(settings.releasePending ? 'Aplicação validada e credenciais salvas. Os recebimentos online aguardam a homologação e a liberação da plataforma.' : (settings.paymentsEnabled ?? settings.configured) ? 'Aplicação validada e credenciais salvas. Agora cada profissional pode conectar sua conta na etapa Recebimento.' : 'Aplicação validada e credenciais salvas. A conexão das contas profissionais aguarda a liberação dos recebimentos.');
    } catch (error) {
      // Discard private inputs after every submission; retain only the public ID.
      form.elements.clientSecret.value = ''; form.elements.webhookSecret.value = ''; form.elements.confirmedOwnership.checked = false;
      if (error.status === 409) feedback(`${error.message} Se outra sessão salvou, recarregue esta página antes de tentar novamente.`, true); else feedback(error.message, true);
    } finally { saving = false; if (button.isConnected) { button.disabled = false; button.textContent = 'Validar e salvar configuração'; form.removeAttribute('aria-busy'); } }
  });
  (async () => {
    try {
      session = await request('session'); csrf = session.csrf;
      if (session.user.role !== 'admin') throw Object.assign(new Error('Somente o administrador configura a aplicação do negócio. Entre no seu perfil para conectar sua própria conta.'),{status:403});
      [settings, businessName, subscriptionReceiving] = await Promise.all([request('integration'),request('setup').then(result => result.draft.business.name),request('subscription-receiving')]); render(); subscriptionReturn();
    } catch (error) {
      accessPage(error);
    }
  })();
})();
