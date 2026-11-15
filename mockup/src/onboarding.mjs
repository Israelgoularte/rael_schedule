import { randomUUID } from 'node:crypto';
import { validSlug } from './configuration.mjs';
import { readSettings } from './database.mjs';
import { digest, failure, isEmail, normalizeEmail, rateLimit } from './security.mjs';
import { requireLegalAcceptance } from './legal.mjs';
import { normalizeMetadata } from './metadata.mjs';

const confirmation = () => ({ ok: true, message: 'Recebemos sua solicitação. Nossa equipe vai conferir os dados e preparar o seu acesso.' });
const text = (value, max = 120) => typeof value === 'string' && value.trim().length >= 2 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

// All public requests share the operations database. A request never opens a
// tenant database, creates a user, starts a trial, or receives database secrets.
export function createOnboarding(config, getService, registryDatabase) {
  const now = config.now ?? (() => Date.now());
  async function request(input, { ip = 'unknown' } = {}) {
    if (!config.enabled || !config.operations || !Object.hasOwn(config.entries, config.operations.tenant)) throw failure(503, 'Novas solicitações estão temporariamente indisponíveis. Tente novamente mais tarde.');
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['name', 'slug', 'ownerName', 'ownerEmail', 'phone', 'requestKey', 'hp', 'legalAcceptance', 'metadata'].includes(key))) throw failure(422, 'Confira os dados da solicitação.');
    if (input.hp !== undefined && (typeof input.hp !== 'string' || input.hp.length > 200)) throw failure(422, 'Confira os dados da solicitação.');
    const source = typeof ip === 'string' && ip.length <= 128 ? ip : 'unknown';
    await getService(config.operations.tenant);
    const db = await registryDatabase(config.operations.tenant);
    await rateLimit(db, `onboarding:ip:burst:${source}`, 20);
    await rateLimit(db, `onboarding:ip:day:${source}`, 120, 86400000);
    if (input.hp?.trim()) return confirmation();
    const legalAcceptance = requireLegalAcceptance(input.legalAcceptance);

    const email = normalizeEmail(input.ownerEmail), phone = typeof input.phone === 'string' ? input.phone.replace(/[^0-9]/g, '') : '';
    if (!text(input.name) || !text(input.ownerName) || typeof input.ownerEmail !== 'string' || input.ownerEmail.length > 254 || !isEmail(email) || !validSlug(input.slug) || typeof input.phone !== 'string' || input.phone.length > 40 || !/^\+?[\d ().-]+$/.test(input.phone.trim()) || !/^\d{10,15}$/.test(phone) || typeof input.requestKey !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(input.requestKey)) throw failure(422, 'Informe o negócio, um endereço válido, o responsável, o e-mail e o telefone com DDD.');
    const name = input.name.trim(), ownerName = input.ownerName.trim();
    const metadata = normalizeMetadata(input.metadata), identity = { name, slug: input.slug, ownerName, email, phone };
    const requestKey = digest(`onboarding:${input.requestKey}`), signature = digest(JSON.stringify({ ...identity, metadata }));
    const legacySignature = Object.keys(metadata).length ? null : digest(JSON.stringify(identity));
    await db.transaction(async tx => {
      await readSettings(tx, true);
      const [submitted] = await tx.query('SELECT request_key, signature FROM onboarding_submissions WHERE request_key = ?', [requestKey]);
      // Reusing a key cannot amend a request, reveal a prior contact, or issue access.
      if (submitted) {
        if (submitted.signature !== signature && (legacySignature === null || submitted.signature !== legacySignature)) throw failure(409, 'Este envio corresponde a outra solicitação.');
        return;
      }
      const emailKey = digest(`onboarding:email:${email}`), at = now();
      const [attempt] = await tx.query('SELECT hits, window_start FROM auth_attempts WHERE attempt_key = ?', [emailKey]);
      if (attempt && at - Number(attempt.window_start) < 86400000) {
        if (Number(attempt.hits) >= 3) throw failure(429, 'Muitas solicitações. Aguarde e tente novamente mais tarde.');
        await tx.query('UPDATE auth_attempts SET hits = hits + 1 WHERE attempt_key = ?', [emailKey]);
      } else if (attempt) await tx.query('UPDATE auth_attempts SET hits = ?, window_start = ? WHERE attempt_key = ?', [1, at, emailKey]);
      else await tx.query('INSERT INTO auth_attempts(attempt_key, hits, window_start) VALUES (?, ?, ?)', [emailKey, 1, at]);

      const [existing] = await tx.query('SELECT id FROM operation_requests WHERE slug = ?', [input.slug]);
      const [retired] = await tx.query('SELECT slug FROM tenant_lifecycle WHERE slug = ?', [input.slug]);
      if (Object.hasOwn(config.entries, input.slug) || existing || retired) throw Object.assign(failure(409, 'Esse endereço já está em uso.'), { code: 'slug_unavailable', field: 'slug' });
      let id = null;
      if (!Object.hasOwn(config.entries, input.slug) && !existing) {
        id = randomUUID();
        await tx.query('INSERT INTO operation_requests(id, slug, name, owner_name, owner_email, status, notes, metadata_json, revision, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, input.slug, name, ownerName, email, 'received', `Telefone para contato: ${phone}. Solicitação pública; identidade ainda não conferida.`, JSON.stringify(metadata), 1, 'public', at, at]);
        await tx.query('INSERT INTO audit_events(id, actor_id, event_name, detail_json, created_at) VALUES (?, ?, ?, ?, ?)', [randomUUID(), null, 'business_public_request', JSON.stringify({ id, slug: input.slug }), at]);
        await tx.query('INSERT INTO audit_events(id, actor_id, event_name, detail_json, created_at) VALUES (?, ?, ?, ?, ?)', [randomUUID(), null, 'business_terms_accepted', JSON.stringify({ requestId: id, ...legalAcceptance }), at]);
      }
      await tx.query('INSERT INTO onboarding_submissions(request_key, signature, request_id, created_at) VALUES (?, ?, ?, ?)', [requestKey, signature, id, at]);
    });
    return confirmation();
  }
  return { request };
}
