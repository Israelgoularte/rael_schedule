import { randomUUID } from 'node:crypto';
import { readSettings } from './database.mjs';
import { initialDraft, sanitizeDraft, sanitizeWeek, validationReport, publicSnapshot, publicationState, weekIssues } from './domain.mjs';
import { passwordHash, checkPassword, passwordAttempt, digest, token, equal, normalizeEmail, isEmail, failure, rateLimit } from './security.mjs';
import { normalizeImage } from './images.mjs';
import { createBookings } from './bookings.mjs';
import { createPayments } from './payments.mjs';
import { createSubscriptions } from './subscriptions.mjs';
import { createCustomers } from './customers.mjs';
import { createFinance } from './finance.mjs';
import { createLicense } from './license.mjs';
import { createInstallationLicense } from './installation-license.mjs';
import { createNotifications } from './notifications.mjs';
import { trafficReport } from './traffic.mjs';

export async function audit(tx, actor, event, detail = {}) {
  await tx.query('INSERT INTO audit_events(id, actor_id, event_name, detail_json, created_at) VALUES (?, ?, ?, ?, ?)', [randomUUID(), actor, event, JSON.stringify(detail), Date.now()]);
}
export async function provisionTenant(db, { name, ownerName, ownerEmail, activationHash, expiresAt, trial = true }, now = () => Date.now()) {
  const email = normalizeEmail(ownerEmail);
  if (!isEmail(email) || !ownerName?.trim() || !name?.trim() || !/^[a-f0-9]{64}$/.test(activationHash) || !Number.isSafeInteger(expiresAt)) throw new Error('Provisionamento incompleto.');
  await db.transaction(async tx => {
    const [existing] = await tx.query('SELECT id FROM business_settings WHERE id = 1' + tx.lock);
    if (existing) return;
    const id = randomUUID(), professionalId = randomUUID(), trialStartedAt = now();
    const draft = initialDraft(name.trim(), ownerName.trim(), email, professionalId);
    await tx.query('INSERT INTO business_settings(id, revision, draft_json, published_json, published_at) VALUES (?, ?, ?, ?, ?)', [1, 0, JSON.stringify(draft), null, null]);
    if (trial) await tx.query('INSERT INTO license_trial(id, starts_at, ends_at) VALUES (?, ?, ?)', [1, trialStartedAt, trialStartedAt + 7 * 86400000]);
    await tx.query('INSERT INTO users(id, email, name, role, professional_id, password_hash, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, email, ownerName.trim(), 'admin', professionalId, null, 1, Date.now()]);
    await tx.query('INSERT INTO receiving_preferences(professional_id, require_payment, connection_status) VALUES (?, ?, ?)', [professionalId, 0, 'not_connected']);
    await tx.query('INSERT INTO account_tokens(token_hash, user_id, kind, expires_at, used_at) VALUES (?, ?, ?, ?, ?)', [activationHash, id, 'invite', expiresAt, null]);
    await audit(tx, null, 'business_provisioned');
  });
}

// Automatic provisioning never adopts an existing business or resets a password.
// The trial is initialized by createLicense only after registration is committed.
export async function provisionAutomaticTenant(db, { registrationId, slug, name, ownerName, ownerEmail, phone, encodedPassword }, now = () => Date.now()) {
  const email = normalizeEmail(ownerEmail);
  if (!/^[a-f0-9-]{36}$/.test(registrationId ?? '') || !/^[a-z0-9][a-z0-9-]{1,47}$/.test(slug ?? '') || !isEmail(email) || !ownerName?.trim() || !name?.trim() || !/^scrypt:32768:8:1:[a-f0-9]{32}:[a-f0-9]{128}$/.test(encodedPassword ?? '')) throw new Error('Provisionamento automático incompleto.');
  await db.transaction(async tx => {
    const [identity] = await tx.query('SELECT * FROM tenant_identity WHERE id = 1' + tx.lock);
    const [existing] = await tx.query('SELECT id FROM business_settings WHERE id = 1' + tx.lock);
    if (existing || identity) {
      const [owner] = await tx.query('SELECT id, role, active FROM users WHERE email = ?', [email]);
      if (!existing || identity?.registration_id !== registrationId || identity?.slug !== slug || owner?.role !== 'admin' || !Number(owner.active)) throw Object.assign(new Error('O banco não corresponde ao cadastro.'), { category: 'database_identity' });
      return;
    }
    // A fresh schema is allowed; imported contacts/access/history are never adopted.
    for (const table of ['users', 'customers', 'appointments', 'license_trial', 'managed_tenants', 'automatic_registrations', 'operation_requests']) {
      const [row] = await tx.query(`SELECT COUNT(*) AS count FROM ${table}`);
      if (Number(row.count)) throw Object.assign(new Error('O banco de destino não está vazio.'), { category: 'database_identity' });
    }
    const id = randomUUID(), professionalId = randomUUID(), at = now(), draft = initialDraft(name.trim(), ownerName.trim(), email, professionalId);
    if (typeof phone === 'string' && /^\d{10,15}$/.test(phone)) draft.business.phone = phone;
    await tx.query('INSERT INTO tenant_identity(id, registration_id, slug) VALUES (?, ?, ?)', [1, registrationId, slug]);
    await tx.query('INSERT INTO business_settings(id, revision, draft_json, published_json, published_at) VALUES (?, ?, ?, ?, ?)', [1, 0, JSON.stringify(draft), null, null]);
    await tx.query('INSERT INTO users(id, email, name, role, professional_id, password_hash, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, email, ownerName.trim(), 'admin', professionalId, encodedPassword, 1, at]);
    await tx.query('INSERT INTO receiving_preferences(professional_id, require_payment, connection_status) VALUES (?, ?, ?)', [professionalId, 0, 'not_connected']);
    await audit(tx, null, 'business_automatically_provisioned', { registrationId });
  });
}

export function createService(db, slug, config, dummyHash) {
  const cookieName = `${config.origin.startsWith('https://') ? '__Host-' : ''}rael_session_${slug}`;
  const license = createLicense(db, slug, config);
  const payments = createPayments(db, slug, config, { authorizeWrite: currentSession });
  const subscriptions = createSubscriptions(db, slug, config, payments, license);
  const installationLicense = createInstallationLicense(db, config.standalone && config.installationLicensing);
  const booking = createBookings(db, slug, config, dummyHash, payments, subscriptions, license, installationLicense);
  const customers = createCustomers(db, config);
  const finance = createFinance(db, config, payments);
  const notifications = createNotifications(db, slug, config, license);
  const accessLink = (kind, value) => `${config.origin}/sistema/${slug}#${kind === 'invite' ? 'ativar' : 'recuperar'}=${value}`;
  const userView = user => ({ id: user.id, name: user.name, email: user.email, role: user.role, professionalId: user.professional_id, ...(installationLicense && user.role === 'admin' ? { installationLicenseAvailable: true } : {}) });
  async function imageUrls() {
    const rows = await db.query('SELECT image_key, version FROM business_images');
    return Object.fromEntries(rows.map(row => [row.image_key, `/media/${slug}/${row.image_key}/${row.version}.webp`]));
  }
  function withImages(catalog, images) {
    return { ...catalog, business: { ...catalog.business, logoUrl: images.logo ?? null }, professionals: catalog.professionals.map(p => ({ ...p, photoUrl: images[p.id] ?? null })) };
  }
  async function preferences(tx = db) { const rows = await tx.query('SELECT professional_id, require_payment, connection_status FROM receiving_preferences'); for (const row of rows) if (row.require_payment || row.connection_status === 'connected') row.connection_status = (await payments.connectionFor(tx, row.professional_id)).ready ? 'connected' : 'not_connected'; return rows; }
  async function session(rawToken) {
    if (typeof rawToken !== 'string' || rawToken.length > 100) throw failure(401, 'Entre na sua conta para continuar.');
    const [row] = await db.query('SELECT s.csrf, s.expires_at, u.* FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token_hash = ?', [digest(rawToken)]);
    if (!row || !Number(row.active) || Number(row.expires_at) <= Date.now()) throw failure(401, 'Sua sessão terminou. Entre novamente.');
    if (row.role === 'professional') {
      const settings = await readSettings(db);
      if (!settings.draft.professionals.some(p => p.id === row.professional_id && p.active)) throw failure(403, 'Seu acesso profissional está inativo. Fale com o administrador.');
    }
    return row;
  }
  function requireAdmin(user) { if (user.role !== 'admin') throw failure(403, 'Somente o administrador pode alterar a configuração do negócio.'); }
  const eligibleStaff = (user, settings) => Boolean(user && Number(user.active) && ['admin', 'professional', 'reception'].includes(user.role) && (user.role !== 'professional' || settings.draft.professionals.some(p => p.id === user.professional_id && p.active)));
  const operationsConfig = () => typeof config.operationsConfig === 'function' ? config.operationsConfig() : config.operations;
  function requireOperator(actor) {
    const operations = operationsConfig();
    if (!config.enabled || !operations || actor.tenant !== operations.tenant || actor.role !== 'admin' || !operations.userIds.includes(actor.id)) throw failure(403, 'Acesso reservado à operação da plataforma.');
  }
  // Recheck the authenticated identity after expensive password work and while
  // holding the same settings lock used by login, team changes and password resets.
  async function currentSession(tx, actor, settings) {
    if (!actor || typeof actor.id !== 'string' || typeof actor.csrf !== 'string' || !actor.csrf || typeof actor.password_hash !== 'string') throw failure(401, 'Seu acesso mudou. Entre novamente para continuar.');
    const [current] = await tx.query('SELECT * FROM users WHERE id = ?' + tx.lock, [actor.id]);
    const [live] = await tx.query('SELECT csrf, expires_at FROM sessions WHERE user_id = ? AND csrf = ?' + tx.lock, [actor.id, actor.csrf]);
    if (!eligibleStaff(current, settings) || current.role !== actor.role || current.professional_id !== actor.professional_id || current.password_hash !== actor.password_hash || !live || live.csrf !== actor.csrf || Number(live.expires_at) <= Date.now()) throw failure(401, 'Seu acesso mudou. Entre novamente para continuar.');
    return current;
  }
  async function withCurrentSession(actor, work) {
    return db.transaction(async tx => {
      const settings = await readSettings(tx, true), current = await currentSession(tx, actor, settings);
      return work(tx, { ...current, csrf: actor.csrf, tenant: actor.tenant }, settings);
    });
  }
  async function snapshot(user) {
    const settings = await readSettings(db), prefs = await preferences(), images = await imageUrls();
    if (user.role === 'admin') {
      const users = await db.query('SELECT id, name, email, role, professional_id, active, password_hash FROM users');
      return { ...settings, images, user: userView(user), preferences: prefs.map(p => ({ ...p, require_payment: Boolean(p.require_payment) })), teamAccess: users.map(u => ({ ...userView(u), active: Boolean(u.active), accepted: Boolean(u.password_hash) })), report: validationReport(settings.draft, prefs), publication: publicationState(settings.draft, settings.published, slug), segments: (await import('./domain.mjs')).segments };
    }
    if (user.role === 'professional') {
      const professional = settings.draft.professionals.find(p => p.id === user.professional_id);
      return { revision: settings.revision, user: userView(user), businessName: settings.draft.business.name, professional: { ...professional, photoUrl: images[professional.id] ?? null }, services: settings.draft.services.filter(s => s.professionalIds.includes(professional.id)), receiving: prefs.find(p => p.professional_id === professional.id) ?? { require_payment: 0, connection_status: 'not_connected' } };
    }
    // Reception sees the public operational catalog, never draft staff emails or account preferences.
    return { user: userView(user), catalog: withImages(publicSnapshot(settings.draft, slug), images) };
  }
  async function login(emailInput, password) {
    const email = normalizeEmail(emailInput);
    await rateLimit(db, `login:${email}`, 6);
    await passwordAttempt(db);
    const [user] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    const valid = await checkPassword(password, user?.password_hash || dummyHash);
    if (!valid || !user || !Number(user.active)) throw failure(401, 'E-mail ou senha não conferem.');
    if (user.role === 'professional') {
      const settings = await readSettings(db);
      if (!settings.draft.professionals.some(p => p.id === user.professional_id && p.active)) throw failure(401, 'Seu acesso está inativo. Fale com o administrador.');
    }
    const value = token(), csrf = token(), expiresAt = Date.now() + 12 * 60 * 60 * 1000;
    await db.transaction(async tx => {
      const settings = await readSettings(tx, true);
      const [current] = await tx.query('SELECT password_hash, active FROM users WHERE id = ?', [user.id]);
      if (!current || !Number(current.active) || current.password_hash !== user.password_hash || (user.role === 'professional' && !settings.draft.professionals.some(p => p.id === user.professional_id && p.active))) throw failure(401, 'Seu acesso mudou. Entre novamente ou fale com o administrador.');
      await tx.query('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
      await tx.query('INSERT INTO sessions(token_hash, user_id, csrf, expires_at) VALUES (?, ?, ?, ?)', [digest(value), user.id, csrf, expiresAt]);
      await audit(tx, user.id, 'login');
    });
    return { value, csrf, user: userView(user) };
  }
  async function activate(value, password, expectedKind) {
    await rateLimit(db, 'activate', 30);
    if (typeof value !== 'string' || value.length > 100) throw failure(422, 'O link é inválido ou expirou. Solicite outro ao administrador.');
    await passwordAttempt(db);
    const encoded = await passwordHash(password);
    await db.transaction(async tx => {
      const settings = await readSettings(tx, true);
      const [preview] = await tx.query('SELECT user_id FROM account_tokens WHERE token_hash = ?', [digest(value)]);
      const [user] = preview ? await tx.query('SELECT * FROM users WHERE id = ?' + tx.lock, [preview.user_id]) : [];
      const [record] = await tx.query('SELECT * FROM account_tokens WHERE token_hash = ?' + tx.lock, [digest(value)]);
      if (!record || record.kind !== expectedKind || record.used_at !== null || Number(record.expires_at) <= Date.now()) throw failure(422, 'O link é inválido ou expirou. Solicite outro ao administrador.');
      if (!eligibleStaff(user, settings)) throw failure(422, 'Este acesso não está disponível. Fale com o administrador.');
      await tx.query('UPDATE users SET password_hash = ? WHERE id = ?', [encoded, user.id]);
      await tx.query('UPDATE account_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL', [Date.now(), user.id]);
      await tx.query('DELETE FROM sessions WHERE user_id = ?', [user.id]);
      await audit(tx, user.id, expectedKind === 'invite' ? 'invitation_accepted' : 'password_reset');
    });
  }
  async function changePassword(actor, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['currentPassword', 'newPassword'].includes(key))) throw failure(422, 'Informe somente sua senha atual e a nova senha.');
    if (typeof input.currentPassword !== 'string' || input.currentPassword.length > 128) throw failure(422, 'Informe sua senha atual.');
    if (typeof input.newPassword !== 'string' || input.newPassword.length < 8 || input.newPassword.length > 128) throw failure(422, 'Use uma senha com 8 a 128 caracteres.');
    await rateLimit(db, `password_change:${actor.id}`, 6);
    await passwordAttempt(db);
    if (!await checkPassword(input.currentPassword, actor.password_hash || dummyHash)) throw failure(422, 'A senha atual não confere.');
    await passwordAttempt(db);
    const encoded = await passwordHash(input.newPassword);
    await withCurrentSession(actor, async (tx, current) => {
      await tx.query('UPDATE users SET password_hash = ? WHERE id = ?', [encoded, current.id]);
      await tx.query('UPDATE account_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL', [Date.now(), current.id]);
      await tx.query('DELETE FROM sessions WHERE user_id = ?', [current.id]);
      await audit(tx, current.id, 'password_changed');
    });
    return { ok: true, requiresLogin: true };
  }
  async function issueRecovery(tx, actor, userId, settings, operator = false) {
    const [user] = await tx.query('SELECT * FROM users WHERE id = ?' + tx.lock, [userId]);
    if (!operator && user?.role === 'admin') throw failure(403, 'Para recuperar o acesso do administrador, use o procedimento assistido da plataforma.');
    if (!eligibleStaff(user, settings) || !user.password_hash || (operator && !['admin', 'professional'].includes(user.role))) throw failure(422, 'Este acesso não está disponível para recuperação. Confira se a pessoa está ativa e já aceitou o convite.');
    const operations = operationsConfig();
    if (operator && slug === operations.tenant && operations.userIds.includes(user.id)) throw failure(403, 'A recuperação dos operadores deve seguir o procedimento assistido da plataforma.');
    const value = token(), issuedAt = Date.now();
    await tx.query('UPDATE account_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL', [issuedAt, user.id]);
    await tx.query('INSERT INTO account_tokens(token_hash, user_id, kind, expires_at, used_at) VALUES (?, ?, ?, ?, ?)', [digest(value), user.id, 'reset', issuedAt + 30 * 60 * 1000, null]);
    await audit(tx, actor.id, operator ? 'operator_password_recovery_link_created' : 'password_recovery_link_created', { userId: user.id, ...(operator ? { operatorTenant: actor.tenant } : {}) });
    return { url: accessLink('reset', value), expiresInMinutes: 30 };
  }
  async function recovery(actor, userId) {
    requireAdmin(actor);
    if (typeof userId !== 'string' || userId.length !== 36) throw failure(422, 'Acesso inválido.');
    await rateLimit(db, 'recovery', 10, 60 * 60 * 1000);
    return withCurrentSession(actor, (tx, current, settings) => { requireAdmin(current); return issueRecovery(tx, current, userId, settings); });
  }
  async function operatorAccess(actor) {
    requireOperator(actor);
    const operations = operationsConfig();
    const settings = await readSettings(db), users = await db.query("SELECT * FROM users WHERE role IN ('admin', 'professional') ORDER BY role, name");
    return { slug, businessName: settings.draft.business.name, users: users.map(user => ({ ...userView(user), active: Boolean(user.active), accepted: Boolean(user.password_hash), recoveryAvailable: eligibleStaff(user, settings) && Boolean(user.password_hash) && !(slug === operations.tenant && operations.userIds.includes(user.id)) })) };
  }
  async function operatorRecovery(actor, userId, transaction, lockedSettings) {
    requireOperator(actor);
    if (typeof userId !== 'string' || userId.length !== 36) throw failure(422, 'Acesso inválido.');
    if (transaction) return issueRecovery(transaction, actor, userId, lockedSettings, true);
    return db.transaction(async tx => issueRecovery(tx, actor, userId, await readSettings(tx, true), true));
  }
  async function save(user, input) {
    requireAdmin(user);
    const draft = sanitizeDraft(input.draft);
    return db.transaction(async tx => {
      const settings = await readSettings(tx, true);
      if (settings.revision !== input.revision) throw failure(409, 'A configuração mudou em outra sessão. Recarregue antes de salvar para não perder alterações.');
      await installationLicense?.assertSeats(tx, settings, draft.professionals);
      const users = await tx.query('SELECT * FROM users');
      for (const bound of users.filter(u => u.professional_id)) {
        const p = draft.professionals.find(p => p.id === bound.professional_id);
        if (!p) throw failure(422, 'Inative o profissional para preservar seu acesso e histórico; não o exclua.');
        if (p.email && normalizeEmail(p.email) !== bound.email) throw failure(422, `O e-mail de acesso de ${bound.name} já está vinculado. Use o mesmo e-mail no cadastro profissional.`);
      }
      for (const professional of draft.professionals) {
        const [existing] = await tx.query('SELECT professional_id FROM receiving_preferences WHERE professional_id = ?', [professional.id]);
        if (!existing) await tx.query('INSERT INTO receiving_preferences(professional_id, require_payment, connection_status) VALUES (?, ?, ?)', [professional.id, 0, 'not_connected']);
      }
      await tx.query('UPDATE business_settings SET draft_json = ?, revision = revision + 1 WHERE id = 1', [JSON.stringify(draft)]);
      await audit(tx, user.id, 'setup_saved', { step: draft.step, revision: settings.revision + 1 });
      return { revision: settings.revision + 1, report: validationReport(draft, await preferences(tx)), publication: publicationState(draft, settings.published, slug) };
    });
  }
  async function publish(user, revision) {
    requireAdmin(user);
    return db.transaction(async tx => {
      const settings = await readSettings(tx, true);
      if (revision !== settings.revision) throw failure(409, 'A configuração mudou. Recarregue antes de publicar.');
      await installationLicense?.assertSeats(tx, settings, settings.draft.professionals, true);
      const report = validationReport(settings.draft, await preferences(tx));
      if (!report.ready) throw failure(422, report.steps.flatMap(step => step.issues).join(' '));
      const snapshot = publicSnapshot(settings.draft, slug), now = Date.now();
      await tx.query('UPDATE business_settings SET published_json = ?, published_at = ?, revision = revision + 1 WHERE id = 1', [JSON.stringify(snapshot), now]);
      await audit(tx, user.id, 'catalog_published', { revision: settings.revision + 1 });
      return { revision: settings.revision + 1, publishedAt: now, url: `${config.origin}/negocio/${slug}` };
    });
  }
  async function invite(user, input) {
    requireAdmin(user);
    if (!['professional', 'reception'].includes(input.role)) throw failure(422, 'Escolha acesso de profissional ou recepção.');
    const email = normalizeEmail(input.email);
    if (!isEmail(email)) throw failure(422, 'Informe um e-mail de acesso válido.');
    await rateLimit(db, 'invitations', 20, 60 * 60 * 1000);
    const value = token();
    const invited = await db.transaction(async tx => {
      const settings = await readSettings(tx, true);
      const professional = input.role === 'professional' ? settings.draft.professionals.find(p => p.id === input.professionalId && p.active) : null;
      if (input.role === 'professional' && (!professional || professional.email !== email)) throw failure(422, 'Salve um profissional ativo com esse e-mail antes de enviar o convite.');
      const name = professional?.name ?? String(input.name ?? '').trim();
      if (name.length < 2 || name.length > 120) throw failure(422, 'Informe o nome da pessoa convidada.');
      let [record] = await tx.query('SELECT * FROM users WHERE email = ?' + tx.lock, [email]);
      if (record && (record.role !== input.role || record.professional_id !== (professional?.id ?? null) || !Number(record.active))) throw failure(422, 'Este e-mail já está vinculado a outro acesso neste negócio.');
      if (record?.password_hash) throw failure(422, 'Essa pessoa já tem acesso. Ela pode usar a recuperação de senha.');
      if (!record) {
        if (!professional) {
          const rows = await tx.query("SELECT id FROM users WHERE role = 'reception' AND active = 1");
          if (rows.length >= 5) throw failure(422, 'O piloto permite até cinco acessos de recepção. Fale com o administrador da plataforma.');
        }
        record = { id: randomUUID(), name, email };
        await tx.query('INSERT INTO users(id, email, name, role, professional_id, password_hash, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [record.id, email, name, input.role, professional?.id ?? null, null, 1, Date.now()]);
      }
      await tx.query('UPDATE account_tokens SET used_at = ? WHERE user_id = ? AND kind = ? AND used_at IS NULL', [Date.now(), record.id, 'invite']);
      await tx.query('INSERT INTO account_tokens(token_hash, user_id, kind, expires_at, used_at) VALUES (?, ?, ?, ?, ?)', [digest(value), record.id, 'invite', Date.now() + 24 * 60 * 60 * 1000, null]);
      await audit(tx, user.id, 'team_invited', { invitedUserId: record.id, role: input.role });
      return record;
    });
    return { url: accessLink('invite', value), name: invited.name, expiresInHours: 24 };
  }
  async function ownReceiving(user, required, revision) {
    if (!['admin', 'professional'].includes(user.role) || !user.professional_id) throw failure(403, 'Somente o profissional pode escolher sua regra de recebimento.');
    if (typeof required !== 'boolean') throw failure(422, 'Escolha se deseja exigir pagamento.');
    return db.transaction(async tx => {
      const settings = await readSettings(tx, true);
      if (revision !== settings.revision) throw failure(409, 'A configuração mudou. Recarregue antes de salvar.');
      if (!settings.draft.professionals.some(p => p.id === user.professional_id && p.active)) throw failure(403, 'Seu cadastro profissional está inativo.');
      await tx.query('UPDATE receiving_preferences SET require_payment = ? WHERE professional_id = ?', [required ? 1 : 0, user.professional_id]);
      await tx.query('UPDATE business_settings SET revision = revision + 1 WHERE id = 1');
      await audit(tx, user.id, 'receiving_preference_changed', { professionalId: user.professional_id, required });
      return { revision: settings.revision + 1, report: validationReport(settings.draft, await preferences(tx)) };
    });
  }
  async function ownHours(user, week, revision) {
    if (user.role !== 'professional' || !user.professional_id) throw failure(403, 'Este recurso é do acesso profissional.');
    const sanitized = sanitizeWeek(week);
    const issues = weekIssues(sanitized);
    if (issues.length) throw failure(422, issues.join(' '));
    return db.transaction(async tx => {
      const settings = await readSettings(tx, true);
      if (settings.revision !== revision) throw failure(409, 'O expediente mudou. Recarregue antes de salvar.');
      const p = settings.draft.professionals.find(p => p.id === user.professional_id && p.active);
      if (!p) throw failure(403, 'Seu cadastro profissional está inativo.');
      p.week = sanitized;
      if (settings.published) { const live = settings.published.professionals.find(item => item.id === p.id); if (live) live.week = sanitized; }
      await tx.query('UPDATE business_settings SET draft_json = ?, published_json = ?, revision = revision + 1 WHERE id = 1', [JSON.stringify(settings.draft), settings.published ? JSON.stringify(settings.published) : null]);
      await audit(tx, user.id, 'own_hours_changed');
      return { revision: settings.revision + 1 };
    });
  }
  async function accessStatus(actor, userId, active) {
    requireAdmin(actor);
    if (typeof userId !== 'string' || userId.length !== 36 || typeof active !== 'boolean') throw failure(422, 'Confira o acesso escolhido.');
    await db.transaction(async tx => {
      await readSettings(tx, true);
      const [target] = await tx.query('SELECT * FROM users WHERE id = ?' + tx.lock, [userId]);
      if (!target || target.role === 'admin') throw failure(403, 'O acesso do administrador só pode ser gerenciado pela operação da plataforma.');
      await tx.query('UPDATE users SET active = ? WHERE id = ?', [active ? 1 : 0, userId]);
      await tx.query('DELETE FROM sessions WHERE user_id = ?', [userId]);
      await tx.query('UPDATE account_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL', [Date.now(), userId]);
      await audit(tx, actor.id, active ? 'team_access_enabled' : 'team_access_disabled', { userId });
    });
    return { ok: true };
  }
  async function saveImage(user, kind, input) {
    if (!['photo', 'logo', 'cover'].includes(kind) || !input || Object.keys(input).some(key => !['image', 'revision'].includes(key))) throw failure(422, 'Confira a imagem escolhida.');
    if (kind !== 'photo') requireAdmin(user);
    else if (!['admin', 'professional'].includes(user.role) || !user.professional_id) throw failure(403, 'Somente o profissional pode alterar a própria foto.');
    await rateLimit(db, `image:${user.id}`, 30, 60 * 60 * 1000);
    const encoded = input.image === null ? null : await normalizeImage(input.image, kind);
    return db.transaction(async tx => {
      const settings = await readSettings(tx, true);
      if (settings.revision !== input.revision) throw failure(409, 'A configuração mudou. Recarregue antes de salvar a imagem.');
      const key = kind === 'photo' ? user.professional_id : kind;
      if (kind === 'photo' && !settings.draft.professionals.some(p => p.id === key && p.active)) throw failure(403, 'Seu cadastro profissional está inativo.');
      await tx.query('DELETE FROM business_images WHERE image_key = ?', [key]);
      if (encoded) await tx.query('INSERT INTO business_images(image_key, image_base64, version, updated_at) VALUES (?, ?, ?, ?)', [key, encoded, randomUUID(), Date.now()]);
      await tx.query('UPDATE business_settings SET revision = revision + 1 WHERE id = 1');
      await audit(tx, user.id, kind === 'photo' ? 'profile_photo_changed' : `business_${kind}_changed`, { removed: encoded === null });
      return { revision: settings.revision + 1 };
    });
  }
  async function image(key, version, rawToken) {
    const settings = await readSettings(db);
    const published = ['logo', 'cover'].includes(key) ? Boolean(settings.published) : settings.published?.professionals.some(p => p.id === key);
    if (!published) {
      const user = await session(rawToken);
      if (!['admin', 'reception'].includes(user.role) && user.professional_id !== key) throw failure(403, 'Imagem não disponível neste acesso.');
    }
    const [row] = await db.query('SELECT image_base64 FROM business_images WHERE image_key = ? AND version = ?', [key, version]);
    if (!row) throw failure(404, 'Imagem não encontrada.');
    return Buffer.from(row.image_base64, 'base64');
  }
  return { cookieName, session, login, activate, changePassword, recovery, operatorAccess, operatorRecovery, withCurrentSession, assertCurrentSession: async (tx, actor, settings) => currentSession(tx, actor, settings ?? await readSettings(tx, true)), snapshot, save, publish, invite, ownReceiving, ownHours, accessStatus, saveImage, image, booking, payments, subscriptions, customers, finance, license, installationLicense, notifications,
    async traffic(user, query) {
      if (user.role !== 'admin') throw failure(403, 'Somente o gestor pode consultar o relatório de acessos.');
      const settings = await readSettings(db);
      return trafficReport(db, query, (config.now ?? Date.now)(), settings.published?.business.timeZone ?? settings.draft.business.timeZone);
    },
    async businessName() { return (await readSettings(db)).draft.business.name; },
    async logout(raw) { await db.query('DELETE FROM sessions WHERE token_hash = ?', [digest(raw ?? '')]); },
    async publicCatalog() { const settings = await readSettings(db); if (!settings.published) throw failure(404, 'Este negócio ainda está preparando seu catálogo.'); return booking.catalogInfo(settings, withImages(settings.published, await imageUrls())); },
    verifyCsrf(user, value) { if (!equal(user.csrf, value)) throw failure(403, 'Recarregue a página antes de continuar.'); },
    userView,
  };
}
