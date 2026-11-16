import { createHash, randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { readMetadata } from './metadata.mjs';
import { failure } from './security.mjs';

const fields = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const hour = 60 * 60 * 1000;
const startOfHour = time => Math.floor(time / hour) * hour;
const dimensions = { source: 'utm_source', medium: 'utm_medium', campaign: 'utm_campaign' };
const localDate = (timestamp, zone) => Temporal.Instant.fromEpochMilliseconds(timestamp).toZonedDateTimeISO(zone).toPlainDate();
const stats = () => ({ visits: 0, bookings: 0 });
const cohort = () => ({ ...stats(), trackedVisits: 0, convertedVisits: 0 });
const withRate = row => ({ ...row, rate: row.trackedVisits ? row.convertedVisits / row.trackedVisits : null });
export const visitParam = 'ref_acesso';
export const attributionWindow = 2 * hour;
export const referenceKey = value => createHash('sha256').update(value).digest('hex');
export const validVisitRef = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

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

export function withUtms(path, utms, visitRef) {
  const url = new URL(path, 'https://internal.invalid');
  for (const [key, value] of Object.entries(basicUtms(utms))) url.searchParams.set(key, value);
  if (validVisitRef(visitRef)) url.searchParams.set(visitParam, visitRef);
  return url.pathname + url.search + url.hash;
}

export async function countLandingView(db, input, now, adChannels = []) {
  const reference = randomUUID();
  await db.query('INSERT INTO landing_visits(visit_key, created_at, utm_json) VALUES (?, ?, ?)',
    [referenceKey(reference), now, JSON.stringify({ ...basicUtms(input), ...(adChannels.length ? { rael_ad_channels: adChannels } : {}) })]);
  return reference;
}

export async function findLandingVisit(tx, reference, now) {
  if (!validVisitRef(reference)) return null;
  const visitKey = referenceKey(reference);
  const [row] = await tx.query('SELECT utm_json FROM landing_visits WHERE visit_key = ? AND created_at >= ? AND created_at <= ?',
    [visitKey, now - attributionWindow, now]);
  return row ? { visitKey, utms: basicUtms(readMetadata(row.utm_json)) } : null;
}

export function bookingMetadata(metadata, visit) {
  const { [visitParam]: ignored, ...fieldsFromBooking } = metadata;
  if (!visit) return fieldsFromBooking;
  for (const field of fields) delete fieldsFromBooking[field];
  return { ...fieldsFromBooking, ...visit.utms };
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
    const tracked = await tx.query(`SELECT v.created_at, v.utm_json,
      CASE WHEN EXISTS (SELECT 1 FROM landing_visit_bookings b WHERE b.visit_key = v.visit_key) THEN 1 ELSE 0 END AS converted
      FROM landing_visits v WHERE v.created_at >= ? AND v.created_at < ?`, [since, until]);
    const bookings = await tx.query('SELECT created_at, metadata_json FROM appointments WHERE created_at >= ? AND created_at < ?', [since, until]);
    const campaigns = new Map();
    const byCampaign = new Map();
    const totals = cohort();
    function include(json, bucket, count, date, trackedVisit = false, converted = false) {
      const day = daily.get(date);
      if (!day) return;
      const utms = basicUtms(readMetadata(json));
      for (const [facet, field] of Object.entries(dimensions)) options[facet].add(facetKey(utms[field]));
      if (Object.entries(dimensions).some(([facet, field]) => selected[facet] && selected[facet] !== facetKey(utms[field]))) return;
      const key = JSON.stringify(utms);
      if (!campaigns.has(key)) campaigns.set(key, { utms, ...stats() });
      campaigns.get(key)[bucket] += count;
      const name = utms.utm_campaign ?? null;
      if (!byCampaign.has(name)) byCampaign.set(name, { name, ...cohort() });
      const summary = byCampaign.get(name);
      summary[bucket] += count;
      day[bucket] += count;
      totals[bucket] += count;
      if (trackedVisit) {
        summary.trackedVisits++;
        totals.trackedVisits++;
        if (converted) {
          summary.convertedVisits++;
          totals.convertedVisits++;
        }
      }
    }
    const visitDates = new Map();
    for (const row of visits) {
      // Historical visits are stored in UTC hour buckets. Use the midpoint
      // to place a bucket when the business timezone has a partial-hour offset.
      const timestamp = Number(row.hour_at) + hour / 2;
      if (!visitDates.has(timestamp)) visitDates.set(timestamp, localDate(timestamp, zone).toString());
      include(row.utm_json, 'visits', Number(row.hits), visitDates.get(timestamp));
    }
    for (const row of tracked) include(row.utm_json, 'visits', 1, localDate(Number(row.created_at), zone).toString(), true, Number(row.converted) === 1);
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
