'use strict';
(() => {
  const slug = location.pathname.split('/')[2];
  const system = '/sistema/' + encodeURIComponent(slug);
  const api = '/internal/' + encodeURIComponent(slug) + '/';
  const select = selector => document.querySelector(selector);
  const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const dates = Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'medium' });
  const reais = Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const planName = { community: 'Community', team: 'Equipe', pro: 'Pro', custom: 'Proposta comercial' };
  const states = { community: 'Gratuita', active: 'Ativa', grace: 'Em carência', expired: 'Vencida' };
  const checkoutLinks = new Map();
  let csrf, busy = false, refreshRequest, snapshot, plansMarkup = '', ordersMarkup = '', recoveringUntil = 0;

  async function request(path, data) {
    const response = await fetch(api + path, {
      credentials: 'same-origin', cache: 'no-store',
      ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(data) })
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || 'Não foi possível concluir.'), { status: response.status });
    return result;
  }

  function access(message) {
    select('#license-panel').hidden = true;
    const area = select('#license-access');
    area.hidden = false;
    area.innerHTML = html(message) + ' <a href="' + system + '">Ir para o painel</a>';
  }

  function feedback(message, error = false) {
    const area = select('#license-feedback');
    area.textContent = message;
    area.className = 'note ' + (error ? 'error' : 'success');
    if (message) area.focus();
  }

  function orderItem(order) {
    const url = checkoutLinks.get(order.id);
    const label = ({ open: order.emailVerified ? 'Aguardando pagamento' : 'Aguardando confirmação de e-mail', paid: 'Pagamento confirmado', cancelled: 'Cancelado', expired: 'Expirado' })[order.status] || order.status;
    const controls = order.status !== 'open' ? '' : '<div class="license-actions">' +
      (url ? '<a class="button" href="' + html(url) + '" target="_blank" rel="noopener noreferrer">Pagar no Mercado Pago de teste</a>' :
        order.emailVerified ? '<button type="button" class="button" data-action="checkout" data-order="' + html(order.id) + '">Preparar checkout de teste</button>' : '') +
      (order.emailVerified ? '' : '<button type="button" class="button secondary" data-action="cancel" data-order="' + html(order.id) + '">Cancelar pedido</button>') + '</div>';
    return '<li><strong>' + html(planName[order.plan] || order.plan) + ' · ' + html(reais.format(order.amount / 100)) + '</strong><br><span class="muted">' + html(label) + '</span>' + controls + '</li>';
  }

  function render(data) {
    const { license, online, professionals } = data;
    select('#license-current').innerHTML = '<div class="license-status"><strong>' + html(planName[license.plan]) + '</strong><span class="badge ' +
      (license.status === 'active' ? 'good' : 'pending') + '">' + html(states[license.status]) + '</span></div>' +
      '<p>' + professionals + ' de ' + license.seats + ' profissionais ativos</p>' +
      (license.expiresAt ? '<p>Válida até ' + dates.format(new Date(license.expiresAt)) + '</p>' : '') +
      (license.status === 'grace' ? '<p>Carência até ' + dates.format(new Date(license.graceUntil)) + '</p>' : '') +
      (!online ? '<p class="note warning">A central está temporariamente indisponível. Exibindo a licença local.</p>' : '') +
      (professionals > license.seats ? '<p class="note warning">A equipe supera o limite da licença. Escolha os profissionais que devem ficar ativos em Equipe.</p>' : '');
    select('[data-action="renewal"]').hidden = !data.canRenew;
    select('[data-action="renewal"]').disabled = !online;
    const planOptions = '<option value="">Selecione um plano</option>' + data.plans.map(plan =>
      '<option value="' + html(plan.code) + '">' + html(plan.title) + ' · até ' + html(plan.seats) + ' profissionais · ' + html(reais.format(plan.amount / 100)) + '/ano</option>'
    ).join('') + '<option value="custom">Tenho uma proposta comercial</option>';
    if (plansMarkup !== planOptions) {
      const input = select('#license-purchase [name="plan"]'), previous = input.value;
      input.innerHTML = planOptions;
      if ([...input.options].some(option => option.value === previous)) input.value = previous;
      input.dispatchEvent(new Event('change'));
      plansMarkup = planOptions;
    }
    select('#license-purchase button').disabled = !online;
    select('#license-recovery button').disabled = !online;
    const visible = [...data.orders.filter(order => order.status === 'open'), ...data.orders.filter(order => order.status !== 'open')].slice(0, 8);
    const activeStatuses = visible.map(orderItem).join('');
    if (ordersMarkup !== activeStatuses) {
      select('#license-orders').innerHTML = '<ul class="license-orders">' + activeStatuses + '</ul>';
      ordersMarkup = activeStatuses;
    }
    select('#license-order').hidden = !visible.length;
  }

  async function refresh() {
    if (!refreshRequest) refreshRequest = request('installation-license').then(data => {
      if (snapshot && data.license.status === 'active' && (data.license.expiresAt !== snapshot.license.expiresAt)) {
        feedback('Licença atualizada. A validade já aparece neste painel.');
        recoveringUntil = 0;
      }
      snapshot = data;
      render(data);
    }).finally(() => { refreshRequest = null; });
    return refreshRequest;
  }

  async function perform(action, data = {}) {
    if (busy) return;
    busy = true;
    feedback('');
    try {
      if (action !== 'refresh') {
        const result = await request('installation-license/' + action, data);
        if (action === 'checkout') checkoutLinks.set(data.orderId, result.url);
        const notices = {
          purchase: result.emailVerified ? 'Pedido pronto para o checkout.' : 'Confira o e-mail de confirmação. O pedido será atualizado automaticamente.',
          renewal: 'Pedido de renovação pronto. Prepare o checkout no quadro Pedidos.',
          recovery: 'Se o endereço tiver uma licença elegível, você receberá um link. Conclua a recuperação pelo e-mail.',
          checkout: 'Checkout de teste disponível no quadro Pedidos.',
          cancel: 'Pedido cancelado.'
        };
        if (action === 'recovery') recoveringUntil = Date.now() + 15 * 60_000;
        feedback(notices[action]);
      }
      if (refreshRequest) await refreshRequest;
      await refresh();
    } catch (error) {
      if (error.status === 401) access('Sua sessão terminou.');
      else feedback(error.message, true);
    } finally { busy = false; }
  }

  const proLabels = { meta: 'Meta', google: 'Google Ads', webhook: 'Webhook' };
  const proStatus = { simulated: 'Simulado localmente', received: 'Recebido pelo destino', validated: 'Validado pelo Google', accepted: 'Google aceitou para processamento', skipped: 'Envio cancelado pela preferência de medição', pending: 'Na fila', failed: 'Falhou' };
  let proRequest, proBusy = false, proActive = false;
  function proMessage(message) { select('#pro-access').textContent = message; }
  function renderPro(data) {
    const { features, keyActive, deliveries, destinations } = data;
    const enabled = features.length > 0;
    if (enabled && !proActive) proMessage('Licença PRO ativa.');
    proActive = enabled;
    select('#pro-controls').hidden = !enabled;
    if (!enabled) {
      clearApiKey();
      proMessage('Disponível com uma licença PRO ativa.');
      return;
    }
    const tracking = features.includes('advanced_tracking'), webhooks = features.includes('webhooks');
    select('#pro-api').hidden = !features.includes('api');
    select('#pro-test').hidden = !tracking && !webhooks;
    select('#pro-revoke').hidden = !keyActive;
    select('#pro-key').textContent = keyActive ? 'Substituir token' : 'Gerar token';
    if (!keyActive) clearApiKey();
    select('#pro-destinations').innerHTML = Object.entries(destinations).filter(([destination]) => destination === 'webhook' ? webhooks : tracking)
      .map(([destination, configured]) => '<li>' + proLabels[destination] + ' · ' + (configured ? (data.mode === 'live' ? 'Envio real habilitado' : 'Destino de teste configurado') : 'Simulação local') + '</li>').join('');
    select('#pro-deliveries').innerHTML = deliveries.map(row => '<li><strong>' + html(proLabels[row.destination]) + '</strong> · ' +
      html(proStatus[row.status]) + (row.detail ? ' · ' + html(row.detail) : '') + '<br><small class="muted">' +
      (row.mode === 'live' ? 'Real' : 'Teste') + ' · ' + html(new Date(row.at).toLocaleString('pt-BR')) + ' · Evento ' + html(row.eventId.slice(0, 12)) + '</small></li>').join('') ||
      '<li class="muted">Nenhuma entrega registrada.</li>';
  }

  function clearApiKey() {
    select('#pro-created-value').value = '';
    select('#pro-created-key').hidden = true;
  }
  function loadPro() {
    if (!proRequest) proRequest = request('pro').then(renderPro).finally(() => { proRequest = null; });
    return proRequest;
  }
  async function runPro(action) {
    if (proBusy) return;
    proBusy = true;
    try {
      if (action === 'refresh') {
        proMessage('');
        await loadPro();
      } else if (action === 'check') {
        const key = select('#pro-created-value').value;
        const response = await fetch('/api/v1/appointments?limit=1', {
          credentials: 'omit', headers: { Authorization: 'Bearer ' + key }, cache: 'no-store'
        });
        if (!response.ok) throw new Error('A consulta de teste não foi autorizada (HTTP ' + response.status + ').');
        const result = await response.json();
        proMessage('Consulta autenticada. ' + (result.appointments.length ? 'A API retornou dados de agenda.' : 'Nenhum agendamento nesta instalação.'));
      } else {
        const result = await request('pro/' + action, {});
        if (proRequest) await proRequest;
        await loadPro();
        if (action === 'key') {
          select('#pro-created-value').value = result.apiKey;
          select('#pro-created-key').hidden = false;
          proMessage('Token criado. Copie-o antes de sair desta página.');
        }
        if (action === 'key/revoke') {
          clearApiKey();
          proMessage('Token revogado.');
        }
        if (action === 'test-event') {
          proMessage('Evento de teste enfileirado. Consulte Entregas recentes.');
          setTimeout(() => { loadPro().catch(() => {}); }, 1200);
        }
      }
    } catch (error) { proMessage(error.message); }
    finally { proBusy = false; }
  }
  for (const [id, action] of Object.entries({ 'pro-test': 'test-event', 'pro-refresh': 'refresh', 'pro-key': 'key', 'pro-revoke': 'key/revoke', 'pro-check-api': 'check' })) {
    select('#' + id).addEventListener('click', () => runPro(action));
  }

  select('#license-purchase [name="plan"]').addEventListener('change', event => {
    const custom = event.target.value === 'custom';
    select('#license-proposal').hidden = !custom;
    select('#license-proposal input').required = custom;
  });
  for (const [selector, action] of [['#license-purchase', 'purchase'], ['#license-recovery', 'recovery']]) {
    select(selector).addEventListener('submit', event => {
      event.preventDefault();
      perform(action, Object.fromEntries(new FormData(event.currentTarget)));
    });
  }
  select('#license-panel').addEventListener('click', event => {
    const element = event.target.closest('button[data-action]');
    if (!element) return;
    if (element.dataset.action === 'cancel' && !confirm('Cancelar este pedido?')) return;
    perform(element.dataset.action, { orderId: element.dataset.order });
  });

  (async () => {
    try {
      const session = await request('session');
      if (!session.user.installationLicenseAvailable) return access('O gerenciamento de licença está disponível para o administrador do negócio.');
      csrf = session.csrf;
      select('#license-menu').innerHTML = window.RaelWorkspace.render({
        slug, businessName: session.businessName, user: session.user, csrf, active: 'license'
      });
      window.RaelWorkspace.sync();
      await refresh();
      if (session.user.proAvailable) {
        select('#license-pro').hidden = false;
        loadPro().catch(error => proMessage(error.message));
        setInterval(() => {
          if (!document.hidden && !proBusy) loadPro().catch(error => proMessage(error.message));
        }, 15000);
      }
      select('#license-access').hidden = true;
      select('#license-panel').hidden = false;
      setInterval(() => {
        if (document.hidden || busy || !(recoveringUntil > Date.now() || snapshot?.orders.some(order => order.status === 'open'))) return;
        refresh().catch(error => { if (error.status === 401) access('Sua sessão terminou.'); });
      }, 6000);
    } catch (error) { access(error.status === 401 ? 'Entre como administrador para gerenciar a licença.' : error.message); }
  })();
})();
