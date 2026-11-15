import { randomUUID } from 'node:crypto';
import { readSettings } from './database.mjs';
import { digest, failure, isEmail, normalizeEmail, token } from './security.mjs';
import { secretBox } from './mercadopago-client.mjs';

export const recoveryMessage = 'Se houver um acesso disponível para este e-mail, enviaremos um link de recuperação. Confira também a caixa de spam.';
const minute = 60000, hour = 60 * minute, leaseMs = minute;
const terminal = ['sent', 'expired', 'failed', 'skipped'];
const response = () => ({ message: recoveryMessage });

// The public request never waits for SMTP. Only the registered recipient is
// encrypted in this short-lived queue; URLs and tokens never enter API results,
// audit events or a restored backup. A retry always uses the original token.
export function createPasswordRecovery(db, slug, config, { mailer, consumeGlobalBudget = async () => {} } = {}) {
  const now = config.now ?? (() => Date.now());
  const box = id => secretBox(config.integrationKey, `rael:password-recovery:v1:${slug}:${id}`);
  const enabled = () => Boolean(config.enabled && !config.testMode && mailer?.enabled && /^[a-f0-9]{64}$/i.test(config.integrationKey ?? '') && slug !== (typeof config.operationsConfig === 'function' ? config.operationsConfig() : config.operations)?.tenant);
  const eligible = (person, kind, settings) => Boolean(person?.password_hash && (kind === 'customer' || Number(person.active) && ['admin', 'professional', 'reception'].includes(person.role) && (person.role !== 'professional' || settings.draft.professionals.some(p => p.id === person.professional_id && p.active))));

  async function budget(tx, scope, limit, window, at) {
    const key = digest(scope);
    const [row] = await tx.query('SELECT hits, window_start FROM auth_attempts WHERE attempt_key = ?' + tx.lock, [key]);
    if (!row) { await tx.query('INSERT INTO auth_attempts(attempt_key, hits, window_start) VALUES (?, ?, ?)', [key, 1, at]); return true; }
    if (at - Number(row.window_start) >= window) { await tx.query('UPDATE auth_attempts SET hits = ?, window_start = ? WHERE attempt_key = ?', [1, at, key]); return true; }
    if (Number(row.hits) >= limit) return false;
    await tx.query('UPDATE auth_attempts SET hits = hits + 1 WHERE attempt_key = ?', [key]); return true;
  }

  async function request(input, kind = 'staff') {
    if (!enabled()) throw failure(503, 'A recuperação por e-mail está sendo preparada. Solicite ajuda para recuperar seu acesso.');
    if (!['staff', 'customer'].includes(kind) || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || typeof input.email !== 'string' || input.email.length > 254 || /[\x00-\x1f\x7f]/.test(input.email)) throw failure(422, 'Informe somente o e-mail do seu cadastro.');
    const email = normalizeEmail(input.email);
    if (!isEmail(email)) throw failure(422, 'Informe um e-mail válido.');
    const at = now(), emailHash = digest(email);
    const accepted = await db.transaction(async tx => {
      const settings = await readSettings(tx, true);
      const tenantAllowed = await budget(tx, 'password_recovery:tenant_hour', 30, hour, at);
      if (!tenantAllowed) return false;
      // These scopes deliberately omit the profile: one address cannot evade
      // its cooldown by switching between professional and consumer login.
      const cooled = await budget(tx, `password_recovery:address_minute:${emailHash}`, 1, minute, at);
      const addressAllowed = await budget(tx, `password_recovery:address_hour:${emailHash}`, 3, hour, at);
      await tx.query('DELETE FROM auth_attempts WHERE window_start < ?', [at - 48 * hour]);
      if (!cooled || !addressAllowed) return true;
      const [person] = await tx.query(`SELECT * FROM ${kind === 'customer' ? 'customers' : 'users'} WHERE email = ?` + tx.lock, [email]);
      if (!eligible(person, kind, settings)) return true;
      const id = randomUUID(), value = token();
      const payload = { id: person.id, email: person.email, name: person.name, credential: digest(person.password_hash), token: value, businessName: settings.draft.business.name };
      await tx.query('INSERT INTO password_recovery_jobs(id, recipient_type, recipient_id, email_hash, payload_cipher, token_hash, state, attempts, lease_until, next_check_at, expires_at, created_at, updated_at, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, kind, person.id, emailHash, box(id).seal(payload), null, 'queued', 0, 0, at, at + 30 * minute, at, at, '']);
      return true;
    });
    if (!accepted) throw failure(429, 'Muitas solicitações neste negócio. Aguarde alguns minutos e tente novamente.');
    return response();
  }

  async function finish(tx, row, state, at, issue = '') {
    await tx.query('UPDATE password_recovery_jobs SET state = ?, payload_cipher = NULL, lease_until = 0, next_check_at = 0, last_error = ?, updated_at = ? WHERE id = ?', [state, issue, at, row.id]);
  }
  async function claim() {
    return db.transaction(async tx => {
      const settings = await readSettings(tx, true), at = now();
      // Terminal records retain only hashes/identifiers briefly for audit and
      // retry fencing. Their encrypted delivery payload is already destroyed.
      await tx.query('DELETE FROM password_recovery_jobs WHERE updated_at < ? AND state IN (?, ?, ?, ?)', [at - 48 * hour, ...terminal]);
      const rows = await tx.query('SELECT * FROM password_recovery_jobs WHERE state IN (?, ?, ?) AND next_check_at <= ? AND lease_until <= ? ORDER BY created_at, id LIMIT 10', ['queued', 'retry', 'sending', at, at]);
      for (const row of rows) {
        if (Number(row.expires_at) <= at) { await finish(tx, row, 'expired', at); continue; }
        if (Number(row.attempts) >= 3) { await finish(tx, row, 'failed', at, 'attempt_limit'); continue; }
        let payload;
        try { payload = box(row.id).open(row.payload_cipher); }
        catch { await finish(tx, row, 'failed', at, 'invalid_payload'); continue; }
        const kind = row.recipient_type;
        if (!['staff', 'customer'].includes(kind) || payload?.id !== row.recipient_id || typeof payload.email !== 'string' || !isEmail(payload.email) || digest(payload.email) !== row.email_hash || typeof payload.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(payload.token) || typeof payload.credential !== 'string') { await finish(tx, row, 'failed', at, 'invalid_payload'); continue; }
        const [person] = await tx.query(`SELECT * FROM ${kind === 'customer' ? 'customers' : 'users'} WHERE id = ?` + tx.lock, [row.recipient_id]);
        const [newer] = await tx.query('SELECT id FROM password_recovery_jobs WHERE recipient_type = ? AND recipient_id = ? AND created_at > ? LIMIT 1', [kind, row.recipient_id, Number(row.created_at)]);
        if (newer || !eligible(person, kind, settings) || person.email !== payload.email || digest(person.password_hash) !== payload.credential) { await finish(tx, row, 'skipped', at, 'access_changed'); continue; }
        const table = kind === 'customer' ? 'customer_tokens' : 'account_tokens', principal = kind === 'customer' ? 'customer_id' : 'user_id', hash = digest(payload.token);
        if (row.token_hash) {
          const [live] = await tx.query(`SELECT * FROM ${table} WHERE token_hash = ?` + tx.lock, [row.token_hash]);
          if (row.token_hash !== hash || !live || live[principal] !== row.recipient_id || live.used_at !== null || Number(live.expires_at) <= at || kind === 'staff' && live.kind !== 'reset') { await finish(tx, row, 'skipped', at, 'link_invalidated'); continue; }
        } else {
          const [latest] = await tx.query(`SELECT expires_at FROM ${table} WHERE ${principal} = ? AND used_at IS NULL ORDER BY expires_at DESC LIMIT 1`, [row.recipient_id]);
          // An assisted recovery created after this public request takes
          // precedence. An old queued request must never revoke its new link.
          if (latest && Number(latest.expires_at) > Number(row.expires_at)) { await finish(tx, row, 'skipped', at, 'newer_link'); continue; }
          await tx.query(`UPDATE ${table} SET used_at = ? WHERE ${principal} = ? AND used_at IS NULL`, [at, row.recipient_id]);
          if (kind === 'customer') await tx.query('INSERT INTO customer_tokens(token_hash, customer_id, expires_at, used_at) VALUES (?, ?, ?, ?)', [hash, row.recipient_id, Number(row.expires_at), null]);
          else await tx.query('INSERT INTO account_tokens(token_hash, user_id, kind, expires_at, used_at) VALUES (?, ?, ?, ?, ?)', [hash, row.recipient_id, 'reset', Number(row.expires_at), null]);
        }
        const attempt = Number(row.attempts) + 1;
        await tx.query('UPDATE password_recovery_jobs SET state = ?, token_hash = ?, attempts = ?, lease_until = ?, updated_at = ? WHERE id = ?', ['sending', hash, attempt, at + leaseMs, at, row.id]);
        return { row: { ...row, token_hash: hash, attempts: attempt, lease_until: at + leaseMs }, payload };
      }
      return null;
    });
  }
  async function settle(row, state, issue = '', retryDelay = 0) {
    await db.transaction(async tx => {
      await readSettings(tx, true);
      const [current] = await tx.query('SELECT * FROM password_recovery_jobs WHERE id = ?' + tx.lock, [row.id]);
      // A delayed SMTP completion may not overwrite a newer worker's claim.
      if (!current || current.state !== 'sending' || Number(current.attempts) !== row.attempts || Number(current.lease_until) !== row.lease_until) return;
      const at = now();
      if (retryDelay && Number(current.expires_at) > at + retryDelay && Number(current.attempts) < 3) await tx.query('UPDATE password_recovery_jobs SET state = ?, lease_until = 0, next_check_at = ?, last_error = ?, updated_at = ? WHERE id = ?', ['retry', at + retryDelay, issue, at, row.id]);
      else await finish(tx, current, state, at, issue);
    });
  }
  async function sweep() {
    await db.transaction(async tx => {
      await readSettings(tx, true);
      const at = now();
      await tx.query('UPDATE password_recovery_jobs SET state = ?, payload_cipher = NULL, lease_until = 0, next_check_at = 0, last_error = ?, updated_at = ? WHERE expires_at <= ? AND state IN (?, ?, ?)', ['expired', '', at, at, 'queued', 'retry', 'sending']);
      await tx.query('DELETE FROM password_recovery_jobs WHERE updated_at < ? AND state IN (?, ?, ?, ?)', [at - 48 * hour, ...terminal]);
    });
    if (!enabled()) {
      const [row] = await db.query('SELECT MIN(expires_at) AS next_at FROM password_recovery_jobs WHERE state IN (?, ?, ?)', ['queued', 'retry', 'sending']);
      return { sent: 0, attempted: 0, nextAt: row?.next_at == null ? null : Math.max(now(), Number(row.next_at)) };
    }
    let sent = 0, attempted = 0;
    for (let n = 0; n < 2; n++) {
      const claimed = await claim();
      if (!claimed) break;
      const { row, payload } = claimed;
      try { await consumeGlobalBudget(); }
      catch {
        // A shared sender outage/limit must not leak the identity to a public
        // request. The queue keeps the same token and retries within its TTL.
        await settle(row, 'failed', 'sender_unavailable', row.attempts === 1 ? 30000 : 120000); continue;
      }
      if (now() >= Number(row.expires_at)) { await settle(row, 'expired'); continue; }
      attempted++;
      try {
        const customer = row.recipient_type === 'customer';
        await mailer.send({ to: payload.email, name: payload.name, businessName: payload.businessName, url: `${config.origin}/${customer ? 'negocio' : 'sistema'}/${slug}#${customer ? 'recuperar-cliente' : 'recuperar'}=${payload.token}`, expiresInMinutes: Math.max(1, Math.ceil((Number(row.expires_at) - now()) / minute)), kind: row.recipient_type });
        await settle(row, 'sent'); sent++;
      } catch (error) {
        // Never retain a provider's arbitrary message, response, address or
        // command. These fixed operational categories are enough to separate
        // SMTP setup failures without exposing a recovery credential.
        const category = ['auth', 'connection', 'tls', 'rejected', 'delivery_failed'].includes(error?.category) ? error.category : 'delivery_failed';
        const code = error?.smtpCode ?? error?.responseCode;
        const smtpCode = Number.isSafeInteger(code) && code >= 400 && code <= 599 ? code : null;
        try { config.monitorLogger?.({ event: 'recovery_email_delivery_failed', category, ...(smtpCode === null ? {} : { smtpCode }) }); } catch { /* Operational logging cannot stop recovery cleanup. */ }
        await settle(row, 'failed', category, row.attempts === 1 ? 30000 : 120000);
      }
    }
    const [pending] = await db.query('SELECT MIN(CASE WHEN expires_at < CASE WHEN lease_until > next_check_at THEN lease_until ELSE next_check_at END THEN expires_at ELSE CASE WHEN lease_until > next_check_at THEN lease_until ELSE next_check_at END END) AS next_at FROM password_recovery_jobs WHERE state IN (?, ?, ?)', ['queued', 'retry', 'sending']);
    return { sent, attempted, nextAt: pending?.next_at === null || pending?.next_at === undefined ? null : Math.max(now(), Number(pending.next_at)) };
  }
  return { get enabled() { return enabled(); }, request, sweep };
}
