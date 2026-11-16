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
      select('#license-access').hidden = true;
      select('#license-panel').hidden = false;
      setInterval(() => {
        if (document.hidden || busy || !(recoveringUntil > Date.now() || snapshot?.orders.some(order => order.status === 'open'))) return;
        refresh().catch(error => { if (error.status === 401) access('Sua sessão terminou.'); });
      }, 6000);
    } catch (error) { access(error.status === 401 ? 'Entre como administrador para gerenciar a licença.' : error.message); }
  })();
})();
