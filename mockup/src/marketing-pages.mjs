// Only these product pages may be indexed. Tenant/account pages remain private
// to search engines even when the visitor opens a direct HTML alias.
export const marketingPages = new Map([
  ['/', '/index.html'],
  ['/agenda-para-barbearias', '/lp-agenda-para-barbearias.html'],
  ['/agenda-para-saloes-de-beleza', '/lp-agenda-para-saloes-de-beleza.html'],
  ['/agendamento-para-consultores', '/lp-agendamento-para-consultores.html'],
  ['/agenda-para-professores-particulares', '/lp-agenda-para-professores-particulares.html'],
  ['/precos', '/lp-precos.html'],
  ['/como-organizar-agendamentos', '/lp-como-organizar-agendamentos.html'],
]);
