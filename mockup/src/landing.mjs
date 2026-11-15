const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => entities[character]);
const price = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

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

export function renderLanding(template, { slug, origin, data }) {
  const business = data?.published?.business;
  const title = business?.name || 'Acesso aos agendamentos';
  const accent = validLandingColor(business?.landingColor) ? business.landingColor : defaultLandingColor;
  const bookingPath = '/negocio/' + slug;
  const plansPath = '/planos/' + slug;
  const description = business?.description || '';
  const headline = business?.landingHeadline || title;
  const logo = /^[a-f0-9-]{10,64}$/i.test(data?.logoVersion || '')
    ? '<img class="brand-logo" src="/media/' + slug + '/logo/' + data.logoVersion + '.webp" width="60" height="60" alt="">'
    : '';
  const brand = '<a class="brand" href="/">' + logo + '<span>' + escape(title) + '</span></a>';
  const services = (data?.published.services ?? []).filter(service => service.online !== false && service.professionalIds?.length);
  const people = data?.published.professionals ?? [];
  const cards = services.map(service => {
    const fee = Number.isSafeInteger(service.priceCents) ? price.format(service.priceCents / 100) : '';
    return '<article class="service"><h3>' + escape(service.name) + '</h3>' +
      (service.description ? '<p>' + escape(service.description) + '</p>' : '') +
      '<div class="service-details"><span>' + escape(service.durationMinutes) + ' min</span>' +
      (fee ? '<strong>' + escape(fee) + '</strong>' : '') + '</div></article>';
  }).join('');
  const serviceSection = cards ? '<section class="catalog" id="servicos"><h2>Serviços</h2><div class="services-grid">' + cards + '</div></section>' : '';
  const teamSection = people.length ? '<section class="team"><h2>Quem atende</h2><ul>' +
    people.map(person => '<li>' + escape(person.name) + '</li>').join('') + '</ul></section>' : '';
  const address = business?.mode === 'online' ? 'Atendimento online' : business?.address || '';
  const availability = address ? '<p class="location">' + escape(address) + '</p>' : '';
  const hero = business ? '<section class="hero"><div><h1>' + escape(headline) + '</h1>' +
    (description ? '<p class="description">' + escape(description) + '</p>' : '') + availability +
    '<div class="actions"><a class="primary" href="' + bookingPath + '">Agendar horário</a>' +
    (cards ? '<a class="secondary" href="#servicos">Ver serviços</a>' : '') + '</div></div></section>' : '';
  const summary = escape((description || title).slice(0, 240));
  const metadata = business ? '<meta name="description" content="' + summary + '">' +
    '<meta property="og:title" content="' + escape(title) + '">' +
    '<meta property="og:description" content="' + summary + '">' +
    '<link rel="canonical" href="' + escape(origin + '/') + '">' : '';
  const links = business ? '<a href="' + plansPath + '">Planos</a>' : '';

  const fields = {
    '__LANDING_STYLE__': '--accent:' + accent + ';--on-accent:' + textColor(accent),
    '__TITLE__': escape(title),
    '__METADATA__': metadata,
    '__BRAND__': brand,
    '__HERO__': hero,
    '__CATALOG__': serviceSection + teamSection,
    '__LAYOUT__': business ? 'published' : 'unpublished',
    '__PLAN_LINK__': links,
    '__SLUG__': slug
  };
  return template.replace(/__(?:LANDING_STYLE|TITLE|METADATA|BRAND|HERO|CATALOG|LAYOUT|PLAN_LINK|SLUG)__/g, key => fields[key]);
}
