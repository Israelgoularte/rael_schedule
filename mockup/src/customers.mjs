import { randomUUID } from 'node:crypto';
import { readSettings } from './database.mjs';
import { normalizeEmail, isEmail, failure, digest, rateLimit } from './security.mjs';

const uuid = v => typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v);
const only = (v, keys) => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) throw failure(422, 'Confira os dados enviados.'); };
export function normalizeContact(input) {
  const name = typeof input.name === 'string' ? input.name.trim() : '', email = normalizeEmail(input.email);
  let phone = typeof input.phone === 'string' ? input.phone.replace(/\D/g, '') : '';
  if ([10, 11].includes(phone.length)) phone = '55' + phone;
  const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
  if (name.length < 2 || name.length > 120 || /[\x00-\x1f]/.test(name) || !isEmail(email) || !/^\d{12,15}$/.test(phone) || notes.length > 3000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(notes)) throw failure(422, 'Confira nome, WhatsApp com DDD e e-mail. As observações aceitam até 3.000 caracteres.');
  return { name, phone, email, notes };
}
const offsetOf = v => { const n = Number(v ?? 0); if (!Number.isSafeInteger(n) || n < 0 || n > 100000) throw failure(422, 'Página inválida.'); return n; };
export function createCustomers(db, config) {
  const now = config.now ?? (() => Date.now());
  const editAllowed = user => { if (!['admin', 'reception'].includes(user.role)) throw failure(403, 'A edição de clientes é feita pela administração ou recepção.'); };
  const admin = user => { if (user.role !== 'admin') throw failure(403, 'Somente o administrador pode importar ou exportar clientes.'); };
  const view = (r, user) => ({ id: r.id, name: r.name, phone: r.phone, email: r.email, revision: Number(r.profile_revision ?? 0), accessEnabled: Boolean(r.password_hash), createdAt: Number(r.created_at), ...(user.role !== 'professional' ? { notes: r.notes ?? '' } : {}) });
  const scope = user => user.role === 'professional' ? { sql: ' AND EXISTS (SELECT 1 FROM appointments a WHERE a.customer_id = c.id AND a.professional_id = ?)', params: [user.professional_id] } : { sql: '', params: [] };
  async function audit(tx, actor, event, detail) { await tx.query('INSERT INTO audit_events(id, actor_id, event_name, detail_json, created_at) VALUES (?, ?, ?, ?, ?)', [randomUUID(), actor, event, JSON.stringify(detail), now()]); }
  async function owned(tx, user, id) { if (!uuid(id)) throw failure(422, 'Cliente inválido.'); const s = scope(user), [r] = await tx.query('SELECT c.*, p.revision AS profile_revision, p.notes FROM customers c LEFT JOIN customer_profiles p ON p.customer_id = c.id WHERE c.id = ?' + s.sql, [id, ...s.params]); if (!r) throw failure(404, 'Cliente não encontrado no seu acesso.'); return r; }
  async function list(user, args = {}, exporting = false) {
    if (!['admin', 'reception', 'professional'].includes(user.role)) throw failure(403, 'Acesso não permitido.');
    if (exporting) { admin(user); await rateLimit(db, `customer_export:${user.id}`, 10, 60000); }
    const offset = offsetOf(args.offset), query = String(args.q ?? '').trim().toLowerCase(); if (query.length > 100) throw failure(422, 'Use uma busca de até 100 caracteres.');
    const s = scope(user), phoneQuery = /^[+\d\s().-]+$/.test(query) ? query.replace(/\D/g, '') || query : query;
    const where = ' WHERE (INSTR(LOWER(c.name), ?) > 0 OR INSTR(LOWER(c.email), ?) > 0 OR INSTR(c.phone, ?) > 0)' + s.sql, params = [query, query, phoneQuery, ...s.params];
    const limit = exporting ? 2001 : 26;
    const [count] = await db.query('SELECT COUNT(*) AS total FROM customers c' + where, params);
    if (exporting && Number(count.total) > 2000) throw failure(422, 'A exportação aceita até 2.000 clientes por vez. Refine a busca.');
    const rows = await db.query('SELECT c.*, p.revision AS profile_revision, p.notes FROM customers c LEFT JOIN customer_profiles p ON p.customer_id = c.id' + where + ` ORDER BY c.name, c.id LIMIT ${limit} OFFSET ${exporting ? 0 : offset}`, params);
    if (exporting) await db.transaction(tx => audit(tx, user.id, 'customers_exported', { total: rows.length }));
    const settings = await readSettings(db);
    return { customers: rows.slice(0, exporting ? 2000 : 25).map(r => view(r, user)), timeZone: settings.published?.business.timeZone ?? settings.draft.business.timeZone, total: Number(count.total), offset, hasMore: !exporting && rows.length > 25, canEdit: user.role !== 'professional', canTransfer: user.role === 'admin' };
  }
  async function detail(user, args) {
    const r = await owned(db, user, args.id), offset = offsetOf(args.offset);
    const filter = user.role === 'professional' ? ' AND professional_id = ?' : '';
    const rows = await db.query('SELECT * FROM appointments WHERE customer_id = ?' + filter + ` ORDER BY starts_at DESC, id LIMIT 26 OFFSET ${offset}`, [r.id, ...(filter ? [user.professional_id] : [])]);
    return { customer: view(r, user), history: rows.slice(0, 25).map(a => ({ id: a.id, startAt: Number(a.starts_at), endAt: Number(a.ends_at), status: a.status, snapshot: JSON.parse(a.snapshot_json) })), hasMore: rows.length > 25, offset, canEdit: user.role !== 'professional' };
  }
  async function duplicate(tx, data, except) { const [r] = await tx.query('SELECT id FROM customers WHERE email = ? AND id <> ?', [data.email, except ?? '']); if (r) throw failure(409, 'Já existe um cliente com este e-mail. Revise o cadastro existente; os históricos não serão unidos automaticamente.'); }
  async function save(user, input) {
    editAllowed(user); only(input, ['id', 'name', 'phone', 'email', 'notes', 'revision', 'identityConfirmed']); const data = normalizeContact(input);
    await rateLimit(db, `customer_save:${user.id}`, 100, 60000);
    return db.transaction(async tx => {
      await readSettings(tx, true); const previous = input.id ? await owned(tx, user, input.id) : null;
      if (previous && Number(previous.profile_revision ?? 0) !== input.revision) throw failure(409, 'O cadastro foi alterado em outro acesso. Atualize antes de salvar.');
      await duplicate(tx, data, previous?.id);
      const emailChanged = previous && previous.email !== data.email;
      if (emailChanged && previous.password_hash && (user.role !== 'admin' || input.identityConfirmed !== true)) throw failure(422, 'Para trocar o e-mail de um cliente com acesso, o administrador precisa confirmar a identidade. O acesso atual será revogado e uma nova recuperação será necessária.');
      const id = previous?.id ?? randomUUID(), revision = Number(previous?.profile_revision ?? 0) + 1;
      if (previous) await tx.query('UPDATE customers SET name = ?, phone = ?, email = ? WHERE id = ?', [data.name, data.phone, data.email, id]);
      else await tx.query('INSERT INTO customers(id, name, phone, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, data.name, data.phone, data.email, null, now()]);
      if (previous?.profile_revision !== null && previous?.profile_revision !== undefined) await tx.query('UPDATE customer_profiles SET revision = ?, notes = ?, updated_at = ? WHERE customer_id = ?', [revision, data.notes, now(), id]);
      else await tx.query('INSERT INTO customer_profiles(customer_id, revision, notes, updated_at) VALUES (?, ?, ?, ?)', [id, revision, data.notes, now()]);
      if (emailChanged) { await tx.query('UPDATE customers SET password_hash = NULL WHERE id = ?', [id]); await tx.query('DELETE FROM customer_sessions WHERE customer_id = ?', [id]); await tx.query('UPDATE customer_tokens SET used_at = ? WHERE customer_id = ? AND used_at IS NULL', [now(), id]); }
      await audit(tx, user.id, previous ? 'customer_updated' : 'customer_created', { customerId: id, emailChanged: Boolean(emailChanged), revision });
      return { id, revision, recoveryRequired: Boolean(emailChanged || !previous?.password_hash) };
    });
  }
  async function analyze(tx, rows) {
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 200) throw failure(422, 'Importe de 1 a 200 linhas por vez.');
    const seen = new Set(), phones = new Set(), result = [];
    for (let i = 0; i < rows.length; i++) {
      let data; try { only(rows[i], ['name', 'phone', 'email', 'notes']); data = normalizeContact(rows[i]); } catch (e) { result.push({ line: i + 2, valid: false, error: e.message }); continue; }
      let error = ''; if (seen.has(data.email) || phones.has(data.phone)) error = 'E-mail ou telefone repetido no arquivo.'; seen.add(data.email); phones.add(data.phone);
      const existing = await tx.query('SELECT id, email, phone FROM customers WHERE email = ? OR phone = ? LIMIT 2', [data.email, data.phone]);
      if (existing.length) error = 'E-mail ou telefone já cadastrado. Revise o cliente existente.';
      result.push({ line: i + 2, ...data, valid: !error, error });
    }
    return { rows: result, validCount: result.filter(r => r.valid).length, skippedCount: result.filter(r => !r.valid).length };
  }
  async function preview(user, input) { admin(user); only(input, ['rows']); await rateLimit(db, `customer_import_preview:${user.id}`, 15, 60000); const result = await analyze(db, input.rows); return { ...result, checksum: digest(JSON.stringify(result)) }; }
  async function importRows(user, input) {
    admin(user); only(input, ['rows', 'checksum', 'idempotencyKey']); if (!uuid(input.idempotencyKey) || typeof input.checksum !== 'string') throw failure(422, 'Confira a prévia antes de importar.');
    const key = digest(`${user.id}:${input.idempotencyKey}`), signature = digest(JSON.stringify({ rows: input.rows, checksum: input.checksum }));
    return db.transaction(async tx => {
      await readSettings(tx, true); const [prior] = await tx.query('SELECT * FROM customer_imports WHERE request_key = ?', [key]); if (prior) { if (prior.signature !== signature) throw failure(409, 'Essa confirmação já foi usada com outro arquivo.'); return JSON.parse(prior.result_json); }
      const result = await analyze(tx, input.rows); if (digest(JSON.stringify(result)) !== input.checksum) throw failure(409, 'Os cadastros mudaram desde a prévia. Confira novamente antes de importar.');
      if (!result.validCount) throw failure(422, 'Não há linhas válidas para importar. Corrija o arquivo e gere outra prévia.');
      for (const r of result.rows.filter(r => r.valid)) { const id = randomUUID(); await tx.query('INSERT INTO customers(id, name, phone, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, r.name, r.phone, r.email, null, now()]); await tx.query('INSERT INTO customer_profiles(customer_id, revision, notes, updated_at) VALUES (?, ?, ?, ?)', [id, 1, r.notes, now()]); }
      const response = { imported: result.validCount, skipped: result.skippedCount }; await tx.query('INSERT INTO customer_imports(request_key, signature, result_json, actor_id, created_at) VALUES (?, ?, ?, ?, ?)', [key, signature, JSON.stringify(response), user.id, now()]); await audit(tx, user.id, 'customers_imported', response); return response;
    });
  }
  return { list, detail, save, preview, importRows };
}
