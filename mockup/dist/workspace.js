'use strict';
(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const roles = { admin: 'Gestor do negócio', professional: 'Profissional', reception: 'Recepção' };
  const roleLabel = user => user?.role === 'admin' && user.professionalId ? 'Gestor do negócio e profissional' : roles[user?.role] ?? 'Acesso individual';
  const compact = () => window.matchMedia?.('(max-width: 1023px)')?.matches ?? false;
  const preferences = new Map();
  let drawer = null, notificationContext;
  const paths = {
    painel: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    agenda: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18M8 15h3"/>',
    clientes: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5"/>',
    financeiro: '<path d="M3 20h18M6 16v-5M12 16V4M18 16V8"/>',
    plans: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    memberships: '<path d="M4 7h16M4 17h16M7 4 4 7l3 3M17 14l3 3-3 3"/><circle cx="12" cy="12" r="2"/>',
    profile: '<path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6M9 8h.01M15 8h.01M9 11h.01M15 11h.01"/>',
    team: '<circle cx="8" cy="8" r="3"/><circle cx="18" cy="9" r="2"/><path d="M2 21v-3a6 6 0 0 1 12 0v3M16 15a4 4 0 0 1 6 4v2"/>',
    receiving: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h3M13 15h2"/>',
    password: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 15v2"/>',
    license: '<path d="M12 3 3 7v6c0 4 9 8 9 8s9-4 9-8V7l-9-4Z"/><path d="m8 12 3 3 5-6"/>',
    public: '<path d="M14 3h7v7M21 3l-9 9M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',
    operations: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 9v12"/>',
    businesses: '<path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6"/>',
    finance: '<path d="M3 20h18M6 16v-5M12 16V4M18 16V8"/>',
    registrations: '<path d="M3 11a9 9 0 1 1 2.7 7M3 4v7h7M12 7v5l3 2"/>',
    back: '<path d="m10 5-7 7 7 7M3 12h18"/>', menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>', collapse: '<path d="m14 6-6 6 6 6"/>',
  };
  const icon = key => `<svg class="workspace-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[key] ?? paths.painel}</svg>`;
  function businessItems({ slug, user, active, inPlace = false, operationsAvailable = false }) {
    const base = `/sistema/${encodeURIComponent(slug)}`;
    const local = (key, label, action, query, group) => ({ key, label, group, ...(inPlace ? { action, attribute: 'data-action' } : { href: `${base}?visao=${query}` }) });
    return [
      { key: 'painel', label: 'Visão geral', group: 'Dia a dia', href: `${base}/painel` }, local('agenda', 'Agenda', 'open-agenda', 'agenda', 'Dia a dia'),
      { key: 'clientes', label: 'Clientes', group: 'Dia a dia', href: `${base}/clientes` }, { key: 'financeiro', label: 'Financeiro', group: 'Dia a dia', href: `${base}/financeiro` },
      ...(['admin', 'professional'].includes(user.role) ? [{ key: 'memberships', label: 'Planos e Assinaturas', group: 'Serviços e planos', href: `${base}/assinaturas` }] : []),
      local('profile', user.role === 'admin' ? 'Negócio' : user.role === 'professional' ? 'Meu perfil' : 'Meu acesso', 'open-profile', 'perfil', 'Configurações'),
      ...(user.role === 'admin' ? [local('team', 'Equipe', 'team', 'equipe', 'Configurações'), { key: 'receiving', label: 'Mercado Pago', group: 'Configurações', href: `${base}/recebimentos` }] : []),
      local('password', 'Minha senha', 'open-password', 'senha', 'Minha conta'),
      { key: 'public', label: 'Abrir agendamento ↗', href: `/negocio/${encodeURIComponent(slug)}`, external: true },
    ].map(item => ({ ...item, current: item.key === (active === 'plans' ? 'memberships' : active) }));
  }
  function itemHtml(item) {
    const common = `class="workspace-item${item.current ? ' current' : ''}${item.platform ? ' workspace-platform-link' : ''}" aria-label="${esc(item.label)}" title="${esc(item.label)}"${item.current ? ' aria-current="page"' : ''}`;
    const label = `${icon(item.key)}<span class="workspace-item-label">${esc(item.label)}</span>`;
    return item.href ? `<a ${common} href="${esc(item.href)}"${item.external ? ' target="_blank" rel="noopener"' : ''}>${label}</a>` : `<button type="button" ${common} ${item.attribute}="${esc(item.action)}">${label}</button>`;
  }
  function readCollapsed(key) {
    if (preferences.has(key)) return preferences.get(key);
    let value = false; try { value = window.localStorage?.getItem(key) === 'true'; } catch { /* Navigation works without browser storage. */ }
    preferences.set(key, value); return value;
  }
  function rootFor(nav) { return nav.parentElement ?? nav.closest?.('.workspace-app'); }
  function toggleFor(nav) { return rootFor(nav)?.querySelector?.('[data-workspace-toggle]') ?? nav.querySelector?.('[data-workspace-toggle]'); }
  function releaseDrawer(returnFocus = false) {
    if (!drawer) return;
    const previous = drawer; drawer = null;
    for (const [element, inert] of previous.background) element.inert = inert;
    document.body?.classList?.remove('workspace-drawer-open');
    previous.nav.dataset.workspaceOpen = 'false'; previous.nav.hidden = compact();
    if (previous.backdrop) previous.backdrop.hidden = true;
    previous.toggle?.setAttribute('aria-expanded', 'false');
    previous.panel?.removeAttribute?.('role'); previous.panel?.removeAttribute?.('aria-modal'); previous.panel?.removeAttribute?.('aria-label');
    if (returnFocus) previous.toggle?.focus();
  }
  function render({ slug = '', businessName = '', user = null, active = '', inPlace = false, operationsAvailable = false, operation = false, logoutHtml = '', csrf = '' } = {}) {
    // In-place navigation replaces its root: release old modal side effects first.
    releaseDrawer();
    notificationContext = { slug, audience: 'staff', user, csrf, operation };
    const signedIn = Boolean(user), central = operation && signedIn;
    const name = central ? 'Gestão da Raelapps' : signedIn ? businessName || 'Seu negócio' : 'Rael Agendamentos';
    const scope = central ? 'PLATAFORMA' : signedIn ? 'GESTÃO DO NEGÓCIO' : 'ACESSO INDIVIDUAL';
    const role = central ? 'Acesso à gestão da Raelapps' : roleLabel(user), title = central ? 'Menu da Raelapps' : 'Menu do negócio';
    const items = !signedIn ? [] : central ? [
      { key: 'businesses', label: 'Clientes da plataforma', group: 'Plataforma', action: 'view-businesses', attribute: 'data-platform', current: active === 'businesses' },
      { key: 'registrations', label: 'Histórico de cadastros', group: 'Plataforma', action: 'view-registrations', attribute: 'data-platform', current: active === 'registrations' },
      { key: 'finance', label: 'Financeiro da Raelapps', group: 'Plataforma', action: 'view-finance', attribute: 'data-platform', current: active === 'finance' },
      ...(slug ? [{ key: 'password', label: 'Minha senha', group: 'Minha conta', href: `/sistema/${encodeURIComponent(slug)}?visao=senha` }, { key: 'back', label: 'Voltar ao meu negócio', href: `/sistema/${encodeURIComponent(slug)}` }] : []),
    ] : businessItems({ slug, user, active, inPlace, operationsAvailable });
    const groups = [...new Set(items.map(item => item.group).filter(Boolean))], key = `rael-workspace-collapsed:${central ? 'platform' : slug}`;
    return `<header class="system-header workspace-header">${items.length ? `<button type="button" class="workspace-menu-toggle" data-workspace-toggle aria-controls="workspace-menu-panel" aria-expanded="false" aria-label="Abrir ${title.toLowerCase()}" hidden>${icon('menu')}<span class="workspace-menu-toggle-label">Menu</span></button>` : ''}<a class="brand workspace-brand" href="${central ? '/operacao' : signedIn && slug ? `/sistema/${encodeURIComponent(slug)}` : '/'}"><span class="app-brand-mark" aria-hidden="true"><img class="app-brand-image" src="/app-logo-v4.png" width="40" height="40" alt=""></span><span><small>${scope}</small><strong title="${esc(name)}">${esc(name)}</strong></span></a>${signedIn ? `<div class="workspace-person"><strong>${esc(user.name)}</strong><span>${esc(role)}</span></div>` : ''}<div class="header-actions workspace-header-actions">${signedIn && slug ? '<span data-rael-notifications></span>' : ''}<button type="button" class="theme-toggle" data-theme-toggle aria-label="Alternar tema"></button>${logoutHtml}</div></header>${items.length ? `<button type="button" class="workspace-backdrop" data-workspace-close aria-label="Fechar menu" tabindex="-1" hidden></button><nav class="workspace-nav-shell" data-workspace-nav data-workspace-key="${esc(key)}" aria-label="${central ? 'Áreas da Raelapps' : 'Áreas do negócio'}"><div id="workspace-menu-panel" class="workspace-menu-panel"><div class="workspace-sidebar-head"><strong class="workspace-sidebar-title">${title}</strong><button type="button" class="workspace-close" data-workspace-close aria-label="Fechar menu" hidden>${icon('close')}</button><button type="button" class="workspace-collapse" data-workspace-collapse aria-label="Recolher menu lateral" title="Recolher menu lateral" aria-expanded="true">${icon('collapse')}</button></div>${groups.map(group => `<section class="workspace-group"><h2 class="workspace-group-title">${esc(group)}</h2><div class="workspace-group-items">${items.filter(item => item.group === group).map(itemHtml).join('')}</div></section>`).join('')}<div class="workspace-sidebar-footer">${items.filter(item => !item.group).map(itemHtml).join('')}</div></div></nav>` : ''}`;
  }
  function setCollapsed(nav, value, persist = false) {
    const app = rootFor(nav), collapse = nav.querySelector?.('[data-workspace-collapse]');
    if (!app) return;
    app.dataset.workspaceCollapsed = String(value); collapse?.setAttribute('aria-expanded', String(!value));
    const label = value ? 'Expandir menu lateral' : 'Recolher menu lateral';
    collapse?.setAttribute('aria-label', label); collapse?.setAttribute('title', label);
    if (persist) { preferences.set(nav.dataset.workspaceKey, value); try { window.localStorage?.setItem(nav.dataset.workspaceKey, String(value)); } catch { /* Nonessential preference. */ } }
  }
  function setOpen(nav, open, returnFocus = false) {
    const app = rootFor(nav), toggle = toggleFor(nav), panel = nav.querySelector?.('.workspace-menu-panel');
    if (!app || !panel) return;
    const mobile = compact(), backdrop = app.querySelector?.('.workspace-backdrop');
    if (!mobile) { releaseDrawer(); nav.hidden = false; nav.dataset.workspaceOpen = 'true'; if (backdrop) backdrop.hidden = true; return; }
    if (!open) { if (drawer?.nav === nav) releaseDrawer(returnFocus); else { nav.hidden = true; nav.dataset.workspaceOpen = 'false'; toggle?.setAttribute('aria-expanded', 'false'); if (backdrop) backdrop.hidden = true; if (returnFocus) toggle?.focus(); } return; }
    if (drawer?.nav === nav) return;
    releaseDrawer(); nav.hidden = false; nav.dataset.workspaceOpen = 'true'; if (backdrop) backdrop.hidden = false;
    toggle?.setAttribute('aria-expanded', 'true');
    panel.setAttribute?.('role', 'dialog'); panel.setAttribute?.('aria-modal', 'true'); panel.setAttribute?.('aria-label', nav.getAttribute?.('aria-label') ?? 'Menu do negócio');
    const background = new Map();
    const remember = element => { if (!element || element === nav || element === backdrop || background.has(element)) return; background.set(element, Boolean(element.inert)); element.inert = true; };
    for (const child of app.children ?? []) remember(child);
    for (const child of document.body?.children ?? []) if (child !== app && !child.contains?.(app)) remember(child);
    drawer = { nav, app, panel, toggle, backdrop, background };
    document.body?.classList?.add('workspace-drawer-open'); nav.querySelector?.('.workspace-close')?.focus();
  }
  function sync() {
    if (notificationContext !== undefined) window.RaelNotifications?.mount(notificationContext);
    if (drawer?.nav?.isConnected === false) releaseDrawer();
    const navs = document.querySelectorAll?.('[data-workspace-nav]') ?? [];
    for (const app of document.querySelectorAll?.('.workspace-app') ?? []) if (!app.querySelector?.('[data-workspace-nav]')) { app.classList?.remove('workspace-app'); delete app.dataset.workspaceCollapsed; }
    for (const nav of navs) {
      const app = rootFor(nav), toggle = toggleFor(nav), close = nav.querySelector?.('.workspace-close'), collapse = nav.querySelector?.('[data-workspace-collapse]');
      if (!app || !toggle) continue;
      app.classList?.add('workspace-app');
      const mobile = compact(), changed = nav.dataset.workspaceCompact !== String(mobile), focusedInPanel = changed && nav.contains?.(document.activeElement);
      nav.dataset.workspaceCompact = String(mobile); toggle.hidden = !mobile; if (close) close.hidden = !mobile; if (collapse) collapse.hidden = mobile;
      setCollapsed(nav, readCollapsed(nav.dataset.workspaceKey));
      if (changed && drawer?.nav === nav) releaseDrawer();
      setOpen(nav, mobile ? !changed && nav.dataset.workspaceOpen === 'true' : true, Boolean(mobile && focusedInPanel));
      if (changed && !mobile && focusedInPanel && document.activeElement?.hidden) collapse?.focus();
    }
  }
  document.addEventListener?.('click', event => {
    const trigger = event.target.closest?.('[data-workspace-toggle]');
    if (trigger) { const app = trigger.closest?.('.workspace-app'), nav = app?.querySelector?.('[data-workspace-nav]'); if (nav) setOpen(nav, nav.dataset.workspaceOpen !== 'true'); return; }
    const collapse = event.target.closest?.('[data-workspace-collapse]');
    if (collapse) { const nav = collapse.closest?.('[data-workspace-nav]'); if (nav && !compact()) setCollapsed(nav, rootFor(nav)?.dataset.workspaceCollapsed !== 'true', true); return; }
    const close = event.target.closest?.('[data-workspace-close]');
    if (close) { const nav = close.closest?.('[data-workspace-nav]') ?? close.closest?.('.workspace-app')?.querySelector?.('[data-workspace-nav]'); if (nav) setOpen(nav, false, true); return; }
    const item = event.target.closest?.('.workspace-item');
    if (item && compact()) { const nav = item.closest?.('[data-workspace-nav]'); if (nav) setOpen(nav, false); return; }
    if (drawer && !drawer.nav.contains?.(event.target)) setOpen(drawer.nav, false, true);
  });
  document.addEventListener?.('keydown', event => {
    if (!drawer || !compact()) return;
    if (event.key === 'Escape') { event.preventDefault(); setOpen(drawer.nav, false, true); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...(drawer.nav.querySelectorAll?.('a[href],button:not([disabled]),[tabindex="0"]') ?? [])].filter(element => !element.hidden && !element.closest?.('[hidden]') && (typeof element.getClientRects !== 'function' || element.getClientRects().length));
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === first || !drawer.nav.contains?.(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !drawer.nav.contains?.(document.activeElement))) { event.preventDefault(); first.focus(); }
  });
  window.addEventListener?.('resize', sync);
  window.RaelWorkspace = { render, sync, roleLabel };
})();
