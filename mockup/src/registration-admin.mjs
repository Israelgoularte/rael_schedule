import { createHmac, randomUUID } from 'node:crypto';
import { digest, equal, failure, normalizeEmail, rateLimit } from './security.mjs';
import { readMetadata } from './metadata.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const only = (value, keys) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw failure(422, 'Confira os dados do cadastro.'); };
const requestFields = ['id', 'slug', 'name', 'owner_name', 'owner_email', 'status', 'revision', 'created_at', 'created_by'];
const deletedName = 'Cadastro removido';

// Keep the receipt, address reservation and replay markers. Clearing a request
// never claims that a database or MySQL user was removed.
export async function scrubRegistrationRequest(tx, row, actor, at, key) {
  await tx.query('UPDATE operation_requests SET name = ?, owner_name = ?, owner_email = ?, notes = ?, metadata_json = ?, status = ?, archived_at = COALESCE(archived_at, ?), archived_by = COALESCE(archived_by, ?), deleted_at = ?, deleted_by = ?, deletion_key = ?, revision = revision + 1, updated_at = ? WHERE id = ?', [deletedName, '', '', '', '{}', 'cancelled', at, actor.id, at, actor.id, key, at, row.id]);
}

export function createRegistrationAdmin(config, { getService, database, lifecycle }) {
  const now = config.now ?? (() => Date.now());
  const previewKey = /^[a-f0-9]{64}$/i.test(config.integrationKey ?? '') ? Buffer.from(config.integrationKey, 'hex') : null;
  const allowed = user => Boolean(config.enabled && user?.tenant === config.operations?.tenant && user.role === 'admin' && config.operations?.userIds?.includes(user.id));
  const central = () => database(config.operations.tenant);
  async function operatorSession(user, work) {
    if (!allowed(user)) throw failure(403, 'Acesso reservado à operação da plataforma.');
    const service = await getService(config.operations.tenant);
    return service.withCurrentSession(user, async (tx, current) => {
      if (!allowed(current)) throw failure(403, 'Acesso reservado à operação da plataforma.');
      const result = await work(tx, current);
      if (!allowed(current)) throw failure(403, 'Acesso reservado à operação da plataforma.');
      return result;
    });
  }
  async function read(user, work) { await operatorSession(user, async () => {}); const result = await work(); return operatorSession(user, async () => result); }
  async function request(tx, id) {
    if (!uuid(id)) throw failure(422, 'Cadastro inválido.');
    const [row] = await tx.query('SELECT * FROM operation_requests WHERE id = ?', [id]);
    if (!row) throw failure(404, 'Cadastro não encontrado.');
    return row;
  }
  async function links(tx, row) {
    const [managed] = await tx.query('SELECT slug FROM managed_tenants WHERE slug = ? OR registration_id = ? LIMIT 1', [row.slug, row.id]);
    const [automatic] = await tx.query('SELECT id, state, category, lease_until FROM automatic_registrations WHERE id = ? OR slug = ? LIMIT 1', [row.id, row.slug]);
    const [tenant] = await tx.query('SELECT slug, state FROM tenant_lifecycle WHERE slug = ?', [row.slug]);
    return { managed, automatic, tenant, linked: Object.hasOwn(config.entries ?? {}, row.slug) || Boolean(managed || tenant) };
  }
  function orphanReason(row, link) {
    if (row.deleted_at != null) return 'Os dados desta solicitação já foram removidos.';
    if (row.slug === config.operations?.tenant) return 'A infraestrutura da gestão da Raelapps é protegida.';
    if (link.linked) return 'Use a gestão do negócio para arquivar ou analisar a exclusão dos dados e do banco.';
    if (row.created_by === 'automatic' || link.automatic) return 'A preparação automática pode possuir recursos na hospedagem. Preserve o cadastro e confira o provisionamento.';
    return '';
  }
  async function classification(row, link) {
    if (row.deleted_at != null || link.tenant?.state === 'deleted') return 'deleted';
    if (row.archived_at != null) return 'archived';
    if (row.status === 'cancelled' || ['cancelled', 'deleted'].includes(link.automatic?.state)) return 'cancelled';
    if (row.created_by === 'automatic' || link.automatic) return link.automatic?.state === 'ready' ? link.tenant?.state === 'archived' ? 'archived' : 'completed' : null;
    if (row.status !== 'ready' || !link.linked || !Object.hasOwn(config.entries ?? {}, row.slug)) return null;
    try {
      await getService(row.slug);
      const db = await database(row.slug), [owner] = await db.query('SELECT role, password_hash FROM users WHERE email = ? LIMIT 1', [normalizeEmail(row.owner_email)]);
      return owner?.role === 'admin' && Boolean(owner.password_hash) ? link.tenant?.state === 'archived' ? 'archived' : 'completed' : null;
    } catch { return null; }
  }
  function project(row, link, historyState) {
    return { ...Object.fromEntries(requestFields.map(key => [key, key === 'revision' || key === 'created_at' ? Number(row[key]) : row[key]])), automatic: row.created_by === 'automatic' || Boolean(link.automatic), ...(link.automatic ? { automaticState: link.automatic.state, preparationCategory: link.automatic.category } : {}), historyState, tenantLinked: link.linked, canDetail: true };
  }
  async function list(user, input = {}) {
    only(input, ['view', 'offset', 'q', 'status']);
    const view = input.view ?? 'pending', offset = Number(input.offset ?? 0), q = typeof (input.q ?? '') === 'string' ? (input.q ?? '').trim() : null, status = input.status ?? 'all';
    if (!['pending', 'history'].includes(view) || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000 || q === null || q.length > 100 || !['all', 'completed', 'cancelled', 'archived', 'deleted'].includes(status) || view === 'pending' && status !== 'all') throw failure(422, 'Confira os filtros do histórico de cadastros.');
    return read(user, async () => {
      const db = await central(), rows = await db.query(`SELECT ${requestFields.join(', ')}, archived_at, deleted_at FROM operation_requests ORDER BY created_at DESC, id LIMIT 10001`);
      if (rows.length > 10000) throw failure(422, 'Amplie a consulta antes de ultrapassar dez mil cadastros.');
      const [managed, automatic, tenants] = await Promise.all([db.query('SELECT slug, registration_id FROM managed_tenants'), db.query('SELECT id, slug, state, category FROM automatic_registrations'), db.query('SELECT slug, state FROM tenant_lifecycle')]);
      const managedBySlug = new Map(managed.map(row => [row.slug, row])), managedById = new Map(managed.map(row => [row.registration_id, row]));
      const automaticBySlug = new Map(automatic.map(row => [row.slug, row])), automaticById = new Map(automatic.map(row => [row.id, row])), tenantBySlug = new Map(tenants.map(row => [row.slug, row]));
      const found = [];
      for (const row of rows) {
        if (q && ![row.slug, row.name, row.owner_name, row.owner_email].some(value => String(value).toLowerCase().includes(q.toLowerCase()))) continue;
        const managed = managedBySlug.get(row.slug) ?? managedById.get(row.id), tenant = tenantBySlug.get(row.slug);
        const link = { managed, automatic: automaticById.get(row.id) ?? automaticBySlug.get(row.slug), tenant, linked: Object.hasOwn(config.entries ?? {}, row.slug) || Boolean(managed || tenant) }, historyState = await classification(row, link);
        if ((view === 'pending') === Boolean(historyState) || status !== 'all' && historyState !== status) continue;
        found.push(project(row, link, historyState));
      }
      return { requests: found.slice(offset, offset + 20), total: found.length, hasMore: found.length > offset + 20, offset, view, status, q };
    });
  }
  async function detail(user, input) {
    only(input, ['id']);
    return read(user, async () => {
      const db = await central(), row = await request(db, input.id), link = await links(db, row), historyState = await classification(row, link);
      let linkedBusiness = null;
      if (link.linked) {
        try { const item = await lifecycle.lookup(user, row.slug); linkedBusiness = { slug: item.slug, name: item.name, available: item.available, lifecycle: item.lifecycle }; }
        catch { linkedBusiness = { slug: row.slug, name: row.name, available: false, lifecycle: null }; }
      }
      const reason = orphanReason(row, link), archived = row.archived_at != null;
      return { request: { ...project(row, link, historyState), notes: row.notes, metadata: readMetadata(row.metadata_json), archivedAt: row.archived_at == null ? null : Number(row.archived_at), deletedAt: row.deleted_at == null ? null : Number(row.deleted_at) }, linkedBusiness, canArchiveRequest: !reason && !archived, canUnarchiveRequest: !reason && archived, canDeleteRequest: !reason && archived && Boolean(previewKey), blockedReason: reason || (!previewKey ? 'Configure a chave privada da plataforma antes de remover solicitações.' : '') };
    });
  }
  async function archive(user, input) {
    if (!allowed(user)) throw failure(403, 'Acesso reservado à operação da plataforma.');
    only(input, ['id', 'revision', 'archived']);
    if (!uuid(input.id) || !Number.isSafeInteger(input.revision) || input.revision < 1 || typeof input.archived !== 'boolean') throw failure(422, 'Confira a solicitação antes de arquivar.');
    const db = await central(); await rateLimit(db, `operator_request_archive:${user.id}`, 60, 60000);
    return operatorSession(user, async (tx, actor) => {
      const row = await request(tx, input.id), link = await links(tx, row), reason = orphanReason(row, link);
      if (reason) throw failure(409, reason);
      if (Number(row.revision) !== input.revision) throw failure(409, 'O cadastro mudou. Atualize o detalhe antes de continuar.');
      if (Object.hasOwn(config.entries ?? {}, row.slug)) throw failure(409, 'O negócio já foi provisionado. Use a gestão do cliente.');
      const archived = row.archived_at != null;
      if (archived === input.archived) return { ok: true, id: row.id, revision: Number(row.revision), archived };
      await tx.query('UPDATE operation_requests SET archived_at = ?, archived_by = ?, revision = revision + 1, updated_at = ? WHERE id = ?', [input.archived ? now() : null, input.archived ? actor.id : null, now(), row.id]);
      await audit(tx, actor, input.archived ? 'registration_request_archived' : 'registration_request_unarchived', row);
      return { ok: true, id: row.id, revision: Number(row.revision) + 1, archived: input.archived };
    });
  }
  const fingerprint = row => digest(JSON.stringify([row.id, row.slug, row.revision, row.status, row.created_by, row.archived_at, row.deleted_at, row.name, row.owner_name, row.owner_email, row.notes, row.metadata_json]));
  function preview(row, link, actor) {
    const blockedReasons = [orphanReason(row, link), row.archived_at == null ? 'Arquive esta solicitação antes de remover seus dados.' : '', !previewKey ? 'Configure a chave privada da plataforma antes de remover solicitações.' : ''].filter(Boolean);
    const expiresAt = now() + 300000, eligible = blockedReasons.length === 0, value = { v: 1, id: row.id, slug: row.slug, actor: actor.id, revision: Number(row.revision), fingerprint: fingerprint(row), expiresAt };
    const encoded = Buffer.from(JSON.stringify(value)).toString('base64url'), signature = previewKey ? createHmac('sha256', previewKey).update('registration-delete:' + encoded).digest('hex') : '';
    return { id: row.id, slug: row.slug, name: row.name, revision: Number(row.revision), eligible, blockedReasons, confirmation: 'EXCLUIR SOLICITAÇÃO ' + row.slug, previewToken: eligible ? encoded + '.' + signature : null, expiresAt, databaseReleasable: false };
  }
  async function deletionPreview(user, input) {
    only(input, ['id']);
    return operatorSession(user, async (tx, actor) => { const row = await request(tx, input.id); return preview(row, await links(tx, row), actor); });
  }
  function verifyPreview(value) {
    if (!previewKey || typeof value !== 'string' || value.length > 2048) throw failure(409, 'Atualize a prévia antes de remover a solicitação.');
    const parts = value.split('.');
    if (parts.length !== 2 || !equal(parts[1], createHmac('sha256', previewKey).update('registration-delete:' + parts[0]).digest('hex'))) throw failure(409, 'Atualize a prévia antes de remover a solicitação.');
    let decoded; try { decoded = JSON.parse(Buffer.from(parts[0], 'base64url')); } catch { throw failure(409, 'Prévia inválida.'); }
    return decoded;
  }
  async function deleteRequest(user, input) {
    if (!allowed(user)) throw failure(403, 'Acesso reservado à operação da plataforma.');
    only(input, ['id', 'revision', 'confirmation', 'previewToken', 'idempotencyKey', 'acknowledged']);
    if (!uuid(input.id) || !uuid(input.idempotencyKey) || !Number.isSafeInteger(input.revision) || input.revision < 1 || input.acknowledged !== true || typeof input.confirmation !== 'string') throw failure(422, 'Confirme explicitamente a remoção desta solicitação.');
    const db = await central(); await rateLimit(db, `operator_request_delete:${user.id}`, 20, 60000);
    return operatorSession(user, async (tx, actor) => {
      const row = await request(tx, input.id), key = digest('registration-delete:' + actor.id + ':' + input.idempotencyKey);
      const result = (revision, replayed = false) => ({ ok: true, id: row.id, revision, state: 'deleted', requestDeleted: true, databaseReleased: false, ...(replayed ? { replayed: true } : {}) });
      if (row.deleted_at != null) { if (row.deletion_key === key && input.revision === Number(row.revision) - 1 && input.confirmation === 'EXCLUIR SOLICITAÇÃO ' + row.slug) return result(Number(row.revision), true); throw failure(409, 'A solicitação já foi removida. Consulte o histórico.'); }
      const [used] = await tx.query('SELECT id FROM operation_requests WHERE deletion_key = ?', [key]);
      if (used) throw failure(409, 'Esta confirmação já foi usada com outra solicitação.');
      const link = await links(tx, row), current = preview(row, link, actor), token = verifyPreview(input.previewToken);
      if (!current.eligible || token.v !== 1 || token.id !== row.id || token.slug !== row.slug || token.actor !== actor.id || token.revision !== Number(row.revision) || token.fingerprint !== fingerprint(row) || !Number.isSafeInteger(token.expiresAt) || token.expiresAt <= now() || token.expiresAt > now() + 300000 || Number(row.revision) !== input.revision || input.confirmation !== current.confirmation || Object.hasOwn(config.entries ?? {}, row.slug)) throw failure(409, current.blockedReasons[0] || 'A solicitação ou sua prévia mudou. Confira novamente antes de remover.');
      await scrubRegistrationRequest(tx, row, actor, now(), key);
      await audit(tx, actor, 'registration_request_deleted', row);
      return result(Number(row.revision) + 1);
    });
  }
  async function audit(tx, actor, event, row) { await tx.query('INSERT INTO audit_events(id, actor_id, event_name, detail_json, created_at) VALUES (?, ?, ?, ?, ?)', [randomUUID(), actor.id, event, JSON.stringify({ id: row.id, slug: row.slug, databaseReleased: false }), now()]); }
  return { list, detail, archive, deletionPreview, deleteRequest };
}
