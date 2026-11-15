import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { readMetadata } from './metadata.mjs';
import { failure } from './security.mjs';

const fields = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const hour = 60 * 60 * 1000;
const startOfHour = time => Math.floor(time / hour) * hour;
const dimensions = { source: 'utm_source', medium: 'utm_medium', campaign: 'utm_campaign' };
const localDate = (timestamp, zone) => Temporal.Instant.fromEpochMilliseconds(timestamp).toZonedDateTimeISO(zone).toPlainDate();
const stats = () => ({ visits: 0, bookings: 0 });
const withRate = row => ({ ...row, rate: row.visits ? row.bookings / row.visits : null });

export function basicUtms(input = {}) {
  const result = {};
  for (const field of fields) {
    const raw = input instanceof URLSearchParams ? input.getAll(field) : input?.[field];
    const value = (Array.isArray(raw) ? raw.find(item => typeof item === 'string' && item.trim()) : raw);
    if (typeof value !== 'string') continue;
    const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (clean) result[field] = Array.from(clean).slice(0, 96).join('');
  }
  return result;
}

export function withUtms(path, utms) {
  const url = new URL(path, 'https://internal.invalid');
  for (const [key, value] of Object.entries(basicUtms(utms))) url.searchParams.set(key, value);
  return url.pathname + url.search + url.hash;
}

export async function countLandingView(db, input, now) {
  const payload = JSON.stringify(basicUtms(input));
  const key = createHash('sha256').update(payload).digest('hex');
  const upsert = db.driver === 'mysql'
    ? 'ON DUPLICATE KEY UPDATE hits = hits + 1'
    : 'ON CONFLICT (hour_at, campaign_key) DO UPDATE SET hits = hits + 1';
  await db.query('INSERT INTO landing_traffic(hour_at, campaign_key, utm_json, hits) VALUES (?, ?, ?, 1) ' + upsert,
    [startOfHour(now), key, payload]);
}

function reportPeriod(query, today) {
  const preset = query.days ?? '30';
  if (['7', '30', '90'].includes(preset)) return { preset, from: today.subtract({ days: Number(preset) - 1 }), to: today };
  if (preset === 'custom' && [query.from, query.to].every(value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? ''))) {
    let from, to;
    try { from = Temporal.PlainDate.from(query.from); to = Temporal.PlainDate.from(query.to); } catch {}
    if (from && to && Temporal.PlainDate.compare(from, to) <= 0 && Temporal.PlainDate.compare(to, today) <= 0 && from.until(to).days < 90) {
      return { preset, from, to };
    }
  }
  throw failure(422, 'Escolha um período de 7, 30 ou 90 dias, ou informe datas válidas para até 90 dias.');
}

const facetKey = value => value === undefined ? 'none' : 'utm:' + value;

export async function trafficReport(db, query, now, zone) {
  const today = localDate(now, zone);
  const { preset, from, to } = reportPeriod(query, today);
  const since = from.toZonedDateTime(zone).epochMilliseconds;
  const until = to.add({ days: 1 }).toZonedDateTime(zone).epochMilliseconds;
  const selected = Object.fromEntries(Object.keys(dimensions).map(key => {
    const value = query[key] ?? '';
    if (value && value !== 'none' && (!value.startsWith('utm:') || Array.from(value).length > 100)) {
      throw failure(422, 'Escolha filtros válidos de origem, meio e campanha.');
    }
    return [key, value];
  }));
  const options = Object.fromEntries(Object.keys(dimensions).map(key => [key, new Set()]));
  const daily = new Map();
  for (let date = from; Temporal.PlainDate.compare(date, to) <= 0; date = date.add({ days: 1 })) {
    daily.set(date.toString(), { date: date.toString(), ...stats() });
  }
  return db.transaction(async tx => {
    const visits = await tx.query('SELECT hour_at, utm_json, hits FROM landing_traffic WHERE hour_at >= ? AND hour_at < ?', [startOfHour(since), until]);
    const bookings = await tx.query('SELECT created_at, metadata_json FROM appointments WHERE created_at >= ? AND created_at < ?', [since, until]);
    const campaigns = new Map();
    const byCampaign = new Map();
    const totals = stats();
    function include(json, bucket, count, date) {
      const day = daily.get(date);
      if (!day) return;
      const utms = basicUtms(readMetadata(json));
      for (const [facet, field] of Object.entries(dimensions)) options[facet].add(facetKey(utms[field]));
      if (Object.entries(dimensions).some(([facet, field]) => selected[facet] && selected[facet] !== facetKey(utms[field]))) return;
      const key = JSON.stringify(utms);
      if (!campaigns.has(key)) campaigns.set(key, { utms, ...stats() });
      campaigns.get(key)[bucket] += count;
      const name = utms.utm_campaign ?? null;
      if (!byCampaign.has(name)) byCampaign.set(name, { name, ...stats() });
      byCampaign.get(name)[bucket] += count;
      day[bucket] += count;
      totals[bucket] += count;
    }
    const visitDates = new Map();
    for (const row of visits) {
      // Historical visits are stored in UTC hour buckets. Use the midpoint
      // to place a bucket when the business timezone has a partial-hour offset.
      const timestamp = Number(row.hour_at) + hour / 2;
      if (!visitDates.has(timestamp)) visitDates.set(timestamp, localDate(timestamp, zone).toString());
      include(row.utm_json, 'visits', Number(row.hits), visitDates.get(timestamp));
    }
    for (const row of bookings) include(row.metadata_json, 'bookings', 1, localDate(Number(row.created_at), zone).toString());
    const sort = (a, b) => b.visits - a.visits || b.bookings - a.bookings;
    const rows = [...campaigns.values()].sort(sort);
    const summaries = [...byCampaign.values()].sort(sort);
    const facets = Object.fromEntries(Object.entries(options).map(([key, values]) => {
      if (selected[key]) values.add(selected[key]);
      return [key, [...values].sort((a, b) => a.localeCompare(b, 'pt-BR'))];
    }));
    return {
      preset, from: from.toString(), to: to.toString(), today: today.toString(), timeZone: zone, selected, facets,
      totals: withRate(totals), daily: [...daily.values()], byCampaign: summaries.slice(0, 100).map(withRate), summaryCount: summaries.length,
      campaigns: rows.slice(0, 100), campaignCount: rows.length
    };
  });
}
