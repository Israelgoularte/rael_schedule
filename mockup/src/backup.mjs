import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
const tables = {
  notifications: ['id', 'recipient_type', 'recipient_id', 'title', 'body', 'url', 'event_key', 'created_at', 'read_at'],
  notification_devices: ['id', 'recipient_type', 'recipient_id', 'session_hash', 'endpoint_hash', 'endpoint', 'keys_json', 'expiration_at', 'active', 'created_at', 'updated_at'],
  notification_outbox: ['id', 'notification_id', 'device_id', 'state', 'attempts', 'lease_until', 'next_check_at', 'last_error', 'created_at', 'updated_at'],
  business_settings: ['id', 'revision', 'draft_json', 'published_json', 'published_at'],
  users: ['id', 'email', 'name', 'role', 'professional_id', 'password_hash', 'active', 'created_at'],
  receiving_preferences: ['professional_id', 'require_payment', 'connection_status'],
  business_images: ['image_key', 'image_base64', 'version', 'updated_at'],
  landing_traffic: ['hour_at', 'campaign_key', 'utm_json', 'hits'],
  landing_visits: ['visit_key', 'created_at', 'utm_json'],
  customers: ['id', 'name', 'phone', 'email', 'password_hash', 'created_at'],
  appointments: ['id', 'customer_id', 'professional_id', 'service_id', 'starts_at', 'ends_at', 'occupied_until', 'status', 'revision', 'snapshot_json', 'metadata_json', 'created_at', 'updated_at'],
  landing_visit_bookings: ['appointment_id', 'visit_key'],
  calendar_blocks: ['id', 'professional_id', 'starts_at', 'ends_at', 'reason', 'active', 'created_by', 'created_at'],
  booking_requests: ['request_key', 'customer_id', 'signature', 'kind', 'appointment_id', 'created_at'],
  booking_events: ['id', 'appointment_id', 'actor_type', 'actor_id', 'event_name', 'detail_json', 'created_at'],
  mp_connections: ['id', 'professional_id', 'collector_id', 'receiver_name', 'mode', 'status', 'expires_at', 'refresh_lease_until', 'revision', 'updated_at'],
  subscription_receiving_settings: ['id', 'mode', 'revision', 'connection_id', 'updated_by', 'updated_at'],
  mp_intents: ['id', 'appointment_id', 'connection_id', 'collector_id', 'amount_cents', 'mode', 'state', 'expires_at', 'preference_id', 'checkout_url', 'checkout_state', 'checkout_lease_until', 'approved_payment_id', 'resolution', 'check_lease_until', 'next_check_at', 'created_at', 'updated_at'],
  mp_payments: ['id', 'intent_id', 'provider_id', 'status', 'amount_cents', 'refunded_cents', 'provider_updated_at', 'detail_code', 'created_at', 'updated_at'],
  mp_events: ['id', 'intent_id', 'provider_id', 'event_name', 'detail_json', 'created_at'],
  mp_diagnostic_probes: ['id', 'binding_key', 'tenant_slug', 'source_subscription_id', 'request_key', 'snapshot_json', 'provider_id', 'checkout_url', 'state', 'provider_status', 'issue', 'lease_until', 'revision', 'diagnostic_json', 'invoice_count', 'has_approved_invoice', 'created_by', 'created_at', 'updated_at'],
  subscription_plans: ['id', 'professional_id', 'active', 'snapshot_json', 'created_at'],
  subscriptions: ['id', 'plan_id', 'customer_id', 'professional_id', 'connection_id', 'collector_id', 'payer_email', 'mode', 'request_key', 'provider_id', 'checkout_url', 'state', 'create_state', 'lease_until', 'next_check_at', 'resolution', 'snapshot_json', 'provider_updated_at', 'created_at', 'updated_at'],
  subscription_controls: ['customer_id', 'plan_id', 'allowed', 'revision', 'updated_by', 'updated_at'],
  subscription_renewal_jobs: ['subscription_id', 'control_revision', 'state', 'attempts', 'lease_until', 'next_check_at', 'last_error', 'created_at', 'updated_at'],
  subscription_creation_withdrawals: ['subscription_id', 'customer_id', 'plan_id', 'source_hash', 'revision', 'successor_id', 'withdrawn_by', 'withdrawn_at', 'check_state', 'lease_until', 'next_check_at', 'last_issue', 'updated_at'],
  subscription_cycles: ['id', 'subscription_id', 'invoice_id', 'payment_id', 'starts_at', 'ends_at', 'valid', 'provider_updated_at', 'created_at'],
  subscription_usage: ['appointment_id', 'subscription_id', 'cycle_id', 'released', 'created_at'],
  customer_profiles: ['customer_id', 'revision', 'notes', 'updated_at'],
  customer_imports: ['request_key', 'signature', 'result_json', 'actor_id', 'created_at'],
  financial_entries: ['id', 'request_key', 'signature', 'customer_id', 'professional_id', 'appointment_id', 'subscription_id', 'source', 'kind', 'method', 'amount_cents', 'occurred_at', 'date_source', 'actor_id', 'note', 'reverse_of', 'created_at'],
  financial_provider_snapshots: ['payment_key', 'owner_key', 'net_cents', 'provider_updated_at'],
  license_contracts: ['id', 'payer_email', 'mode', 'provider_id', 'collector_id', 'status', 'checkout_url', 'create_state', 'lease_until', 'check_lease_until', 'next_check_at', 'provider_updated_at', 'resolution', 'grace_days', 'time_zone', 'created_at', 'updated_at', 'plan_id', 'amount_cents'],
  license_offer_controls: ['mode', 'test_visible', 'revision', 'updated_by', 'updated_at'],
  license_trial: ['id', 'starts_at', 'ends_at'],
  license_trial_extensions: ['id', 'request_key', 'signature', 'days', 'note', 'previous_ends_at', 'base_at', 'ends_at', 'extended_at', 'operator_id', 'operator_tenant'],
  license_cycles: ['id', 'contract_id', 'source', 'mode', 'invoice_id', 'payment_id', 'amount_cents', 'starts_at', 'ends_at', 'valid', 'status', 'paid_at', 'provider_updated_at', 'request_key', 'signature', 'actor_id', 'note', 'created_at', 'plan_id', 'payment_method'],
  license_money_entries: ['id', 'cycle_id', 'mode', 'source', 'kind', 'amount_cents', 'occurred_at', 'note', 'created_at'],
  license_money_snapshots: ['payment_key', 'cycle_id', 'received_cents', 'reversed_cents', 'provider_updated_at'],
  operation_requests: ['id', 'slug', 'name', 'owner_name', 'owner_email', 'status', 'notes', 'metadata_json', 'archived_at', 'archived_by', 'deleted_at', 'deleted_by', 'deletion_key', 'revision', 'created_by', 'created_at', 'updated_at'],
  managed_tenants: ['slug', 'registration_id', 'database_key', 'user_key', 'entry_cipher', 'created_at'],
  tenant_identity: ['id', 'registration_id', 'slug'],
  tenant_lifecycle: ['slug', 'state', 'revision', 'archived_at', 'deleted_at', 'updated_by', 'summary_json', 'deletion_key', 'deletion_stage', 'error_code', 'created_at', 'updated_at'],
  tenant_finance_archives: ['slug', 'name', 'payload_json', 'archived_at'],
  audit_events: ['id', 'actor_id', 'event_name', 'detail_json', 'created_at'],
};
function keyBytes(key) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/i.test(key)) throw new Error('Informe uma chave de backup de 32 bytes em hexadecimal.');
  return Buffer.from(key, 'hex');
}
// The v1 helpers remain compatible with existing operator backups. New scheduled
// backups bind the encrypted payload to a business and an opaque source identity.
function validSource(source) {
  return source && typeof source === 'object' && !Array.isArray(source)
    && typeof source.slug === 'string' && /^[a-z0-9][a-z0-9-]{1,47}$/.test(source.slug) && !source.slug.endsWith('-')
    && typeof source.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(source.fingerprint);
}
export function databaseFingerprint(entry) {
  const identity = entry.driver === 'mysql'
    ? { driver: 'mysql', host: entry.host, port: entry.port ?? 3306, database: entry.database, user: entry.user }
    : { driver: 'sqlite', path: entry.path };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
export function encryptBackupPayload(payload, key, purpose = 'database') {
  if (!['database', 'configuration'].includes(purpose)) throw new Error('Finalidade de backup inválida.');
  const version = payload.version;
  if (![1, 2].includes(version) || (purpose !== 'database' && version !== 2)) throw new Error('Versão de backup desconhecida.');
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', keyBytes(key), iv);
  cipher.setAAD(Buffer.from(version === 1 ? 'rael-backup-v1' : `rael-backup-v2:${purpose}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return JSON.stringify({ version, ...(version === 2 ? { purpose } : {}), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
}
export function decryptBackupPayload(encrypted, key, purpose = 'database') {
  const container = JSON.parse(encrypted);
  if (!container || ![1, 2].includes(container.version) || (container.version === 1 && purpose !== 'database') || (container.version === 2 && container.purpose !== purpose)) throw new Error('Versão ou finalidade de backup desconhecida.');
  if (typeof container.iv !== 'string' || typeof container.tag !== 'string' || typeof container.ciphertext !== 'string' || Buffer.from(container.iv, 'base64').length !== 12 || Buffer.from(container.tag, 'base64').length !== 16) throw new Error('Backup inválido.');
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(key), Buffer.from(container.iv, 'base64'));
  decipher.setAAD(Buffer.from(container.version === 1 ? 'rael-backup-v1' : `rael-backup-v2:${purpose}`)); decipher.setAuthTag(Buffer.from(container.tag, 'base64'));
  const payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(container.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
  if (payload?.version !== container.version) throw new Error('Backup inválido.');
  return payload;
}
async function databasePayload(tx, source) {
  const data = {};
  for (const [name, columns] of Object.entries(tables)) data[name] = await tx.query(`SELECT ${columns.join(', ')} FROM ${name}`);
  return { version: source ? 2 : 1, createdAt: Date.now(), ...(source ? { source } : {}), tables: data };
}
export async function backupDatabase(db, key, source) {
  if (source !== undefined && !validSource(source)) throw new Error('Identidade de origem do backup inválida.');
  return encryptBackupPayload(await db.transaction(tx => databasePayload(tx, source)), key);
}
// Sensitive integration settings are captured in the same transaction as business
// data, but returned separately to be stored only in the encrypted configuration vault.
export async function backupDatabaseSnapshot(db, key, source) {
  if (!validSource(source)) throw new Error('Identidade de origem do backup inválida.');
  const snapshot = await db.transaction(async tx => ({
    data: await databasePayload(tx, source),
    privateConfiguration: {
      connections: await tx.query('SELECT id, collector_id, professional_id, secrets_cipher FROM mp_connections'),
      settings: await tx.query('SELECT * FROM mp_integration_settings'),
      claims: await tx.query('SELECT * FROM mp_application_claims'),
      // Pending registrations can grant access or create external resources.
      // Keep their encrypted recovery evidence in the private vault only; a
      // logical restoration must never replay or resume that queue by itself.
      automaticRegistrations: await tx.query('SELECT * FROM automatic_registrations'),
    },
  }));
  return { database: encryptBackupPayload(snapshot.data, key), privateConfiguration: snapshot.privateConfiguration };
}
function checkedDatabasePayload(encrypted, key) {
  const payload = decryptBackupPayload(encrypted, key);
  if (payload.version === 2 && !validSource(payload.source)) throw new Error('Identidade de origem do backup inválida.');
  // Legacy v1 backups predate profile images.
  for (const name of ['business_images', 'customers', 'appointments', 'calendar_blocks', 'booking_requests', 'booking_events', 'mp_connections', 'mp_intents', 'mp_payments', 'mp_events', 'subscription_plans', 'subscriptions', 'subscription_cycles', 'subscription_usage', 'customer_profiles', 'customer_imports', 'financial_entries', 'financial_provider_snapshots', 'license_contracts', 'license_trial', 'license_cycles', 'operation_requests']) if (payload?.tables && !Object.hasOwn(payload.tables, name)) payload.tables[name] = [];
  for (const name of ['license_money_entries', 'license_money_snapshots', 'managed_tenants', 'tenant_identity']) if (payload?.tables && !Object.hasOwn(payload.tables, name)) payload.tables[name] = [];
  // Before migration 13, an absent rule means renewal remains allowed. Never
  // invent a block or a provider cancellation when restoring an older backup.
  for (const name of ['subscription_controls', 'subscription_renewal_jobs', 'subscription_receiving_settings']) if (payload?.tables && !Object.hasOwn(payload.tables, name)) payload.tables[name] = [];
  for (const name of ['notifications', 'notification_devices', 'notification_outbox']) if (payload?.tables && !Object.hasOwn(payload.tables, name)) payload.tables[name] = [];
  if (payload?.tables && !Object.hasOwn(payload.tables, 'license_offer_controls')) payload.tables.license_offer_controls = [];
  if (payload?.tables && !Object.hasOwn(payload.tables, 'license_trial_extensions')) payload.tables.license_trial_extensions = [];
  for (const name of ['tenant_lifecycle', 'tenant_finance_archives']) if (payload?.tables && !Object.hasOwn(payload.tables, name)) payload.tables[name] = [];
  if (payload?.tables && !Object.hasOwn(payload.tables, 'subscription_creation_withdrawals')) payload.tables.subscription_creation_withdrawals = [];
  if (payload?.tables && !Object.hasOwn(payload.tables, 'mp_diagnostic_probes')) payload.tables.mp_diagnostic_probes = [];
  for (const table of ['landing_traffic', 'landing_visits', 'landing_visit_bookings']) {
    if (payload?.tables && !Object.hasOwn(payload.tables, table)) payload.tables[table] = [];
  }
  if (!payload.tables || Object.keys(payload.tables).sort().join(',') !== Object.keys(tables).sort().join(',') || Object.values(payload.tables).some(rows => !Array.isArray(rows))) throw new Error('Backup inválido.');
  // Backups before migration 11 have these rows but no attribution column.
  // Normalize only a missing column; authenticated metadata is retained exactly.
  for (const name of ['appointments', 'operation_requests']) for (const row of payload.tables[name]) if (row && typeof row === 'object' && !Object.hasOwn(row, 'metadata_json')) row.metadata_json = '{}';
  // Older backups cannot tell us which email was used for payment.
  for (const row of payload.tables.subscriptions) if (row && typeof row === 'object' && !Object.hasOwn(row, 'payer_email')) row.payer_email = null;
  for (const row of payload.tables.operation_requests) if (row && typeof row === 'object') for (const column of ['archived_at', 'archived_by', 'deleted_at', 'deleted_by', 'deletion_key']) if (!Object.hasOwn(row, column)) row[column] = null;
  for (const row of payload.tables.license_contracts) {
    if (!Object.hasOwn(row, 'plan_id')) row.plan_id = 'standard';
    if (!Object.hasOwn(row, 'amount_cents')) row.amount_cents = 6000;
  }
  for (const row of payload.tables.license_cycles) {
    if (!Object.hasOwn(row, 'plan_id')) row.plan_id = 'standard';
    if (!Object.hasOwn(row, 'payment_method')) row.payment_method = row.source === 'mercadopago' ? 'mercadopago' : 'other';
  }
  return payload;
}
export function inspectDatabaseBackup(encrypted, key) {
  const payload = checkedDatabasePayload(encrypted, key);
  return { version: payload.version, createdAt: payload.createdAt, source: payload.source ?? null, rows: Object.fromEntries(Object.entries(payload.tables).map(([name, rows]) => [name, rows.length])) };
}
const rowDigest = rows => createHash('sha256').update(JSON.stringify(rows.map(row => JSON.stringify(Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])))).sort())).digest('hex');
export async function verifyRestoredDatabase(db, encrypted, key) {
  const payload = checkedDatabasePayload(encrypted, key), counts = {};
  for (const [name, columns] of Object.entries(tables)) {
    const actual = await db.query(`SELECT ${columns.join(', ')} FROM ${name}`);
    if (rowDigest(actual) !== rowDigest(payload.tables[name])) throw new Error('Os dados restaurados não correspondem ao backup autenticado.');
    counts[name] = actual.length;
  }
  for (const name of ['sessions', 'account_tokens', 'customer_sessions', 'customer_tokens', 'password_recovery_jobs', 'password_recovery_dispatch', 'mp_oauth_states', 'mp_integration_settings', 'installation_license', 'pro_api_key', 'pro_delivery', 'pro_webhook_receipt', 'mp_application_claims', 'onboarding_submissions', 'onboarding_access_grants', 'automatic_registrations', 'tenant_runtime_leases']) {
    const [row] = await db.query(`SELECT COUNT(*) AS total FROM ${name}`);
    if (Number(row.total) !== 0) throw new Error('A restauração não deve ativar sessões ou integrações.');
  }
  return { matched: true, rows: counts, integrationsActivated: false };
}
export async function restoreDatabase(db, encrypted, key, options = {}) {
  const payload = checkedDatabasePayload(encrypted, key);
  if (payload.version === 2 && (options.confirmSource !== payload.source.slug || (options.sourceFingerprint && options.sourceFingerprint !== payload.source.fingerprint))) throw new Error('Confirme a origem exata do backup antes de restaurar.');
  const destination = options.destinationSlug ?? options.confirmSource;
  if (payload.version === 2 && destination !== payload.source.slug && options.allowDifferentDestination !== destination) throw new Error('A restauração em outro negócio exige confirmação explícita do destino.');
  await db.transaction(async tx => {
    for (const name of [...Object.keys(tables), 'sessions', 'account_tokens', 'customer_sessions', 'customer_tokens', 'password_recovery_jobs', 'password_recovery_dispatch', 'mp_oauth_states', 'mp_integration_settings', 'installation_license', 'pro_api_key', 'pro_delivery', 'pro_webhook_receipt', 'mp_application_claims', 'onboarding_submissions', 'onboarding_access_grants', 'automatic_registrations', 'auth_attempts', 'tenant_runtime_leases']) {
      const [row] = await tx.query(`SELECT COUNT(*) AS total FROM ${name}`);
      if (Number(row.total) !== 0) throw new Error('A restauração só é permitida em um banco vazio, nunca sobre dados existentes.');
    }
    for (const [name, columns] of Object.entries(tables)) {
      if (!Array.isArray(payload.tables[name])) throw new Error('Tabela de backup inválida.');
      for (const row of payload.tables[name]) await tx.query(`INSERT INTO ${name}(${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, columns.map(column => row[column] ?? null));
    }
    // Login sessions and one-time links are intentionally not restored.
  });
}
