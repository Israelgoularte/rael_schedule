import { createHash } from 'node:crypto';
import { readMetadata } from './metadata.mjs';
import { failure } from './security.mjs';

const fields = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const hour = 60 * 60 * 1000;
const day = 24 * hour;
const startOfHour = time => Math.floor(time / hour) * hour;

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

export async function trafficReport(db, days, now) {
  if (![7, 30, 90].includes(days)) throw failure(422, 'Escolha um período de 7, 30 ou 90 dias.');
  const since = startOfHour(now - days * day);
  return db.transaction(async tx => {
    const visits = await tx.query('SELECT campaign_key, utm_json, SUM(hits) AS total FROM landing_traffic WHERE hour_at >= ? GROUP BY campaign_key, utm_json', [since]);
    const bookings = await tx.query('SELECT metadata_json FROM appointments WHERE created_at >= ?', [since]);
    const campaigns = new Map();
    const totals = { visits: 0, bookings: 0 };
    function include(json, bucket, count) {
      const utms = basicUtms(readMetadata(json));
      const key = JSON.stringify(utms);
      if (!campaigns.has(key)) campaigns.set(key, { utms, visits: 0, bookings: 0 });
      campaigns.get(key)[bucket] += count;
      totals[bucket] += count;
    }
    for (const row of visits) include(row.utm_json, 'visits', Number(row.total));
    for (const row of bookings) include(row.metadata_json, 'bookings', 1);
    const rows = [...campaigns.values()].sort((a, b) => b.visits - a.visits || b.bookings - a.bookings);
    return { days, totals, campaigns: rows.slice(0, 100), campaignCount: rows.length };
  });
}
