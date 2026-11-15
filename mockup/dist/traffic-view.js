const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const integer = new Intl.NumberFormat('pt-BR');
const percent = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 1 });
const n = value => integer.format(value);
const p = value => value === null ? '—' : percent.format(value);
const dateLabel = date => date.slice(8, 10) + '/' + date.slice(5, 7);
const keys = [['source', 'Origem', 'Todas as origens', 'Sem origem'], ['medium', 'Meio', 'Todos os meios', 'Sem meio'], ['campaign', 'Campanha', 'Todas as campanhas', 'Sem campanha']];
const columns = [['utm_source', 'Origem'], ['utm_medium', 'Meio'], ['utm_campaign', 'Campanha'], ['utm_content', 'Conteúdo'], ['utm_term', 'Termo']];

export function trafficQuery(search) {
  const query = new URLSearchParams(search);
  return new URLSearchParams([...query].filter(([key, value]) => value && ['days', 'from', 'to', ...keys.map(([name]) => name)].includes(key)));
}

function filters(model, resetUrl) {
  const custom = model.preset === 'custom';
  return `<form class="traffic-filters card" method="get" id="traffic-filters">
    <div class="traffic-filter-grid">
      <label class="field"><span>Período</span><select name="days">
        ${['7', '30', '90', 'custom'].map(value => `<option value="${value}" ${value === model.preset ? 'selected' : ''}>${value === 'custom' ? 'Personalizado' : 'Últimos ' + value + ' dias'}</option>`).join('')}
      </select></label>
      ${keys.map(([key, label, all, none]) => `<label class="field"><span>${label}</span><select name="${key}">
        <option value="">${all}</option>
        ${model.facets[key].map(value => `<option value="${escape(value)}" ${model.selected[key] === value ? 'selected' : ''}>${value === 'none' ? none : escape(value.slice(4))}</option>`).join('')}
      </select></label>`).join('')}
    </div>
    <fieldset class="traffic-dates" ${custom ? '' : 'hidden disabled'}>
      <legend>Intervalo personalizado</legend>
      <label class="field"><span>De</span><input type="date" name="from" value="${model.from}" max="${model.today}" required></label>
      <label class="field"><span>Até</span><input type="date" name="to" value="${model.to}" max="${model.today}" required></label>
    </fieldset>
    <div class="row">
      <button class="button" type="submit">Aplicar filtros</button>
      <a class="button secondary" href="${escape(resetUrl)}">Limpar filtros</a>
    </div>
  </form>`;
}

function chart(model) {
  const max = Math.max(1, ...model.daily.flatMap(row => [row.visits, row.bookings]));
  const step = Math.max(1, Math.ceil(model.daily.length / 9));
  const picked = model.daily.findLastIndex(row => row.visits || row.bookings);
  return `<section class="card traffic-chart">
    <div class="traffic-chart-heading">
      <h2>Movimento por dia</h2>
      <ul class="traffic-legend"><li>Acessos</li><li>Agendamentos</li></ul>
    </div>
    <p class="small muted" role="status" id="traffic-chart-detail">${picked < 0 ? 'Nenhum movimento no período.' : daySummary(model.daily[picked])}</p>
    <div class="traffic-chart-area">
      <div class="traffic-scale" aria-hidden="true"><span>${n(max)}</span><span>0</span></div>
      <div class="traffic-scroll" tabindex="0" role="region" aria-label="Gráfico diário de acessos e agendamentos">
        <div class="traffic-graph" style="--points:${model.daily.length}">
          ${model.daily.map((row, index) => `<button type="button" class="traffic-point" data-traffic-point="${index}" aria-label="${daySummary(row)}" aria-pressed="${index === picked}">
            <span class="traffic-bars" aria-hidden="true"><i style="--height:${100 * row.visits / max}%"></i><i style="--height:${100 * row.bookings / max}%"></i></span>
            <span class="traffic-tick" aria-hidden="true">${index % step === 0 || index === model.daily.length - 1 ? dateLabel(row.date) : ''}</span>
          </button>`).join('')}
        </div>
      </div>
    </div>
  </section>`;
}

function daySummary({ date, visits, bookings }) {
  return `${dateLabel(date)} · ${n(visits)} ${visits === 1 ? 'acesso' : 'acessos'} · ${n(bookings)} ${bookings === 1 ? 'agendamento' : 'agendamentos'}`;
}

function table(headers, rows, label) {
  if (!rows) return '<div class="management-empty">Nenhum resultado com estes filtros.</div>';
  return `<div class="traffic-table" tabindex="0" role="region" aria-label="${label}"><table>
    <thead><tr>${headers.map(text => `<th scope="col">${text}</th>`).join('')}</tr></thead><tbody>${rows}</tbody>
  </table></div>`;
}

export function renderTraffic(model, resetUrl, metric) {
  const summaryRows = model.byCampaign.map(({ name, visits, bookings, trackedVisits, convertedVisits, rate }) => `<tr><th scope="row">${escape(name ?? 'Sem campanha')}</th><td class="traffic-number">${n(visits)}</td><td class="traffic-number">${n(trackedVisits)}</td><td class="traffic-number">${n(convertedVisits)}</td><td class="traffic-number">${n(bookings)}</td><td class="traffic-number">${p(rate)}</td></tr>`).join('');
  const detailRows = model.campaigns.map(({ utms, visits, bookings }) => `<tr>${columns.map(([key], index) => `<td>${escape(utms[key] ?? (index === 0 && !Object.keys(utms).length ? 'Sem UTM' : '—'))}</td>`).join('')}<td class="traffic-number">${n(visits)}</td><td class="traffic-number">${n(bookings)}</td></tr>`).join('');
  return `${filters(model, resetUrl)}
    <div class="management-kpis traffic-kpis">
      ${metric('Acessos à página inicial', n(model.totals.visits), 'Aberturas no período, incluindo visitas sem UTM.')}
      ${metric('Agendamentos criados', n(model.totals.bookings), 'Reservas pela data em que foram feitas.')}
      ${metric('Taxa de conversão', p(model.totals.rate), `${n(model.totals.convertedVisits)} de ${n(model.totals.trackedVisits)} acessos rastreados geraram uma reserva.`)}
    </div>
    ${chart(model)}
    <section class="management-section">
      <h2>Conversão por campanha</h2>
      <p class="small muted">A taxa usa a data do acesso à vitrine. Cada acesso rastreado que gera pelo menos um agendamento em até 2 horas conta uma vez. Acessos antigos sem vínculo aparecem no total, e campanhas sem acessos rastreados exibem “—”.</p>
      ${table(['Campanha', 'Acessos', 'Rastreados', 'Convertidos', 'Agendamentos', 'Conversão'], summaryRows, 'Conversão por campanha')}
      ${model.summaryCount > model.byCampaign.length ? '<p class="small muted">A tabela mostra as 100 campanhas com mais movimento.</p>' : ''}
    </section>
    ${detailRows ? `<details class="management-section traffic-detail"><summary>Detalhes por UTM</summary>
      ${table([...columns.map(([, label]) => label), 'Acessos', 'Agendamentos'], detailRows, 'Detalhes por UTM')}
      ${model.campaignCount > model.campaigns.length ? '<p class="small muted">A tabela mostra até 100 combinações. Os totais incluem todas elas.</p>' : ''}
    </details>` : ''}`;
}

export function connectTraffic(root, model) {
  const form = root.querySelector('#traffic-filters');
  const period = form.elements.days, dates = form.querySelector('fieldset');
  const from = form.elements.from, to = form.elements.to;
  const syncDates = () => {
    dates.hidden = dates.disabled = period.value !== 'custom';
    to.setCustomValidity('');
    if (!dates.disabled && from.value && to.value) {
      const distance = (Date.parse(to.value) - Date.parse(from.value)) / 86400000;
      if (distance < 0 || distance >= 90) to.setCustomValidity('Selecione um intervalo de até 90 dias, com início antes do fim.');
    }
  };
  form.addEventListener('change', syncDates);
  syncDates();
  const points = [...root.querySelectorAll('[data-traffic-point]')];
  for (const point of points) point.addEventListener('click', () => {
    for (const other of points) other.setAttribute('aria-pressed', String(other === point));
    root.querySelector('#traffic-chart-detail').textContent = daySummary(model.daily[Number(point.dataset.trafficPoint)]);
  });
}
