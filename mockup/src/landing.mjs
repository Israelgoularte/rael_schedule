import { withUtms } from './traffic.mjs';

const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => entities[character]);
const price = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

function initials(name) {
  const words = String(name ?? '').trim().split(/\s+/u).filter(Boolean);
  return (words.length > 1 ? [words[0], words.at(-1)] : words)
    .map(word => Array.from(word)[0]).join('').toLocaleUpperCase('pt-BR');
}

export const defaultLandingColor = '#205340';
export const validLandingColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

function textColor(color) {
  const rgb = color.slice(1).match(/../g).map(value => {
    const channel = parseInt(value, 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  const luminance = .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
  return luminance > .179 ? '#000000' : '#ffffff';
}

function businessIdentity(slug, data, fallbackName) {
  const business = data?.published?.business;
  const title = business?.name || fallbackName || 'Agendamento online';
  const accent = validLandingColor(business?.landingColor) ? business.landingColor : defaultLandingColor;
  const logoPath = /^[a-f0-9-]{10,64}$/i.test(data?.logoVersion || '')
    ? `/media/${slug}/logo/${data.logoVersion}.webp`
    : null;
  const logo = logoPath ? `<img class="brand-logo" src="${logoPath}" width="60" height="60" alt="">` : '';
  const brand = '<a class="brand" href="/">' + logo + '<span>' + escape(title) + '</span></a>';
  return { title, brand, logoPath, style: '--accent:' + accent + ';--on-accent:' + textColor(accent) };
}

function fillTemplate(template, fields) {
  return template.replace(/__[A-Z_]+__/g, key => Object.hasOwn(fields, key) ? fields[key] : key);
}

function accessLinks(slug, utms, visitRef) {
  return {
    '__LOGIN_LINK__': escape(withUtms(`/sistema/${slug}?acesso=cliente`, utms, visitRef)),
    '__REGISTER_LINK__': escape(withUtms(`/sistema/${slug}?acesso=cadastro`, utms, visitRef))
  };
}

export function renderLanding(template, { slug, origin, data, fallbackName, sourceUrl, utms, visitRef, advertisingConsent }) {
  const business = data?.published?.business;
  const { title, brand, logoPath, style } = businessIdentity(slug, data, fallbackName);
  const bookingPath = escape(withUtms('/negocio/' + slug, utms, visitRef));
  const plansPath = escape(withUtms('/planos/' + slug, utms, visitRef));
  const description = business?.description || '';
  const headline = business?.landingHeadline || title;
  const services = (data?.published?.services ?? []).filter(service => service.online !== false && service.professionalIds?.length);
  const people = data?.published?.professionals ?? [];
  const cards = services.map(service => {
    const fee = Number.isSafeInteger(service.priceCents) ? price.format(service.priceCents / 100) : '';
    return `<article class="service">
      <div class="service-copy">
        <h3>${escape(service.name)}</h3>
        ${service.description ? `<p>${escape(service.description)}</p>` : ''}
        <span class="service-duration">${escape(service.durationMinutes)} min</span>
      </div>
      ${fee ? `<strong class="service-price">${escape(fee)}</strong>` : ''}
    </article>`;
  }).join('');
  const serviceSection = cards ? `<section class="catalog" id="servicos"><h2>Serviços</h2><div class="services-grid">${cards}</div></section>` : '';
  const teamSection = people.length ? `<section class="team"><h2>Quem atende</h2><ul>${people.map(person => {
    const version = data?.photoVersions?.[person.id];
    const portrait = /^[a-f0-9-]{36}$/i.test(person.id) && /^[a-f0-9-]{36}$/i.test(version ?? '')
      ? `<img src="/media/${slug}/${person.id}/${version}.webp" width="48" height="48" loading="lazy" alt="">`
      : escape(initials(person.name));
    return `<li><span class="team-avatar" aria-hidden="true">${portrait}</span><strong>${escape(person.name)}</strong></li>`;
  }).join('')}</ul></section>` : '';
  const catalog = serviceSection || teamSection ? `<div class="landing-details">${serviceSection}${teamSection}</div>` : '';
  const address = business?.mode === 'online' ? 'Atendimento online' : business?.address || '';
  const heroMark = logoPath
    ? `<img src="${logoPath}" width="144" height="144" alt="">`
    : `<span>${escape(initials(title))}</span>`;
  const cover = /^[a-f0-9-]{36}$/i.test(data?.coverVersion ?? '')
    ? `<img class="hero-cover" src="/media/${slug}/cover/${data.coverVersion}.webp" alt="" fetchpriority="high">`
    : '';
  const hero = `<section class="hero${cover ? ' has-cover' : ''}">
    ${cover}
    <div class="hero-copy">
      <h1>${escape(headline)}</h1>
      ${description || !business ? `<p class="description">${escape(description || 'Os horários aparecerão aqui quando o negócio publicar a agenda.')}</p>` : ''}
      <div class="actions">
        <a class="primary hero-booking" href="${bookingPath}">Agendar horário</a>
        ${cards ? '<a class="secondary hero-services" href="#servicos">Ver serviços</a>' : ''}
      </div>
      ${address ? `<p class="location">${escape(address)}</p>` : ''}
    </div>
    ${cover ? '' : `<div class="hero-art" aria-hidden="true">
      <div class="hero-mark${logoPath ? ' hero-mark-logo' : ''}">${heroMark}</div>
    </div>`}
  </section>`;
  const summary = escape((description || title).slice(0, 240));
  const metadata = business ? '<meta name="description" content="' + summary + '">' +
    '<meta property="og:title" content="' + escape(title) + '">' +
    '<meta property="og:description" content="' + summary + '">' +
    '<link rel="canonical" href="' + escape(origin + '/') + '">' : '';
  const links = business ? '<a href="' + plansPath + '">Planos</a>' : '';

  return fillTemplate(template, {
    ...accessLinks(slug, utms, visitRef),
    '__LANDING_STYLE__': style,
    '__TITLE__': escape(title),
    '__METADATA__': metadata,
    '__BRAND__': brand,
    '__HERO__': hero,
    '__CATALOG__': catalog,
    '__ADVERTISING_CONSENT__': advertisingConsent ? `<aside class="advertising-consent" id="advertising-consent" data-ref="${escape(visitRef)}" aria-labelledby="advertising-title" hidden>
      <h2 id="advertising-title">Medição de anúncios</h2>
      <p>Se você permitir, o identificador do clique pode ser enviado à Meta ou ao Google quando seu agendamento for confirmado. Você pode agendar sem permitir. <a href="/privacidade">Privacidade</a></p>
      <div class="advertising-actions"><button type="button" data-choice="deny">Recusar</button><button type="button" data-choice="allow">Permitir medição</button></div>
      <p data-advertising-status role="status"></p>
    </aside><script src="/advertising-consent.js" defer></script>` : '',
    '__PLAN_LINK__': links,
    '__SOURCE_LINK__': sourceUrl ? '<a href="/codigo-fonte">Código-fonte</a>' : '',
    '__SLUG__': slug
  });
}

export function renderCustomerAccess(template, { slug, mode, data, fallbackName, utms, visitRef }) {
  const { title, brand, style } = businessIdentity(slug, data, fallbackName);
  const registering = mode === 'register';
  const bookings = escape(withUtms(`/negocio/${slug}?visao=agendamentos`, utms, visitRef));
  return fillTemplate(template, {
    ...accessLinks(slug, utms, visitRef),
    '__LANDING_STYLE__': style,
    '__TITLE__': escape(title),
    '__BRAND__': brand,
    '__SLUG__': slug,
    '__ACCESS_MODE__': mode,
    '__BOOKING_HISTORY__': bookings,
    '__ACCESS_TITLE__': registering ? 'Crie sua conta' : 'Acesse seus agendamentos',
    '__ACCESS_ACTION__': registering ? 'Criar conta' : 'Entrar',
    '__LOGIN_CURRENT__': registering ? '' : 'aria-current="page"',
    '__REGISTER_CURRENT__': registering ? 'aria-current="page"' : '',
    '__SIGNUP_STATE__': registering ? '' : 'hidden disabled',
    '__PASSWORD_AUTOCOMPLETE__': registering ? 'new-password' : 'current-password',
    '__PASSWORD_MINIMUM__': registering ? 'minlength="8"' : '',
    '__RECOVERY_LINK__': registering ? '' : `<a href="${bookings}">Esqueci a senha</a>`
  });
}
