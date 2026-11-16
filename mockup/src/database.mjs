import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const schema = [
  `CREATE TABLE IF NOT EXISTS pro_api_key (id INTEGER PRIMARY KEY, key_hash VARCHAR(64) NOT NULL, license_version VARCHAR(80) NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS pro_delivery (event_id VARCHAR(64) NOT NULL, destination VARCHAR(12) NOT NULL, license_version VARCHAR(80) NOT NULL, payload_json LONGTEXT NOT NULL, status VARCHAR(16) NOT NULL, details VARCHAR(32) NOT NULL, attempts INTEGER NOT NULL, next_at BIGINT NOT NULL, lease_until BIGINT NOT NULL, lease_id VARCHAR(36) NULL, created_at BIGINT NOT NULL, PRIMARY KEY (event_id, destination))`,
  `CREATE TABLE IF NOT EXISTS installation_license (id INTEGER PRIMARY KEY, installation_id VARCHAR(36) NOT NULL, credential VARCHAR(43) NOT NULL, registered INTEGER NOT NULL, token LONGTEXT NULL, remote_state VARCHAR(16) NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS notifications (id VARCHAR(64) PRIMARY KEY, recipient_type VARCHAR(16) NOT NULL, recipient_id VARCHAR(36) NOT NULL, title VARCHAR(120) NOT NULL, body VARCHAR(500) NOT NULL, url VARCHAR(500) NOT NULL, event_key VARCHAR(64) NOT NULL, created_at BIGINT NOT NULL, read_at BIGINT NULL)`,
  `CREATE TABLE IF NOT EXISTS notification_devices (id VARCHAR(64) PRIMARY KEY, recipient_type VARCHAR(16) NOT NULL, recipient_id VARCHAR(36) NOT NULL, session_hash VARCHAR(64) NOT NULL, endpoint_hash VARCHAR(64) NOT NULL UNIQUE, endpoint LONGTEXT NOT NULL, keys_json TEXT NOT NULL, expiration_at BIGINT NULL, active INTEGER NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS notification_outbox (id VARCHAR(64) PRIMARY KEY, notification_id VARCHAR(64) NOT NULL, device_id VARCHAR(64) NOT NULL, state VARCHAR(16) NOT NULL, attempts INTEGER NOT NULL, lease_until BIGINT NOT NULL, next_check_at BIGINT NOT NULL, last_error VARCHAR(40) NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, FOREIGN KEY (notification_id) REFERENCES notifications(id), FOREIGN KEY (device_id) REFERENCES notification_devices(id))`,
  `CREATE TABLE IF NOT EXISTS business_settings (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, draft_json LONGTEXT NOT NULL, published_json LONGTEXT NULL, published_at BIGINT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (id VARCHAR(36) PRIMARY KEY, email VARCHAR(254) NOT NULL UNIQUE, name VARCHAR(120) NOT NULL, role VARCHAR(20) NOT NULL, professional_id VARCHAR(36) NULL, password_hash VARCHAR(256) NULL, active INTEGER NOT NULL, created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash VARCHAR(64) PRIMARY KEY, user_id VARCHAR(36) NOT NULL, csrf VARCHAR(64) NOT NULL, expires_at BIGINT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id))`,
  `CREATE TABLE IF NOT EXISTS account_tokens (token_hash VARCHAR(64) PRIMARY KEY, user_id VARCHAR(36) NOT NULL, kind VARCHAR(20) NOT NULL, expires_at BIGINT NOT NULL, used_at BIGINT NULL, FOREIGN KEY (user_id) REFERENCES users(id))`,
  `CREATE TABLE IF NOT EXISTS receiving_preferences (professional_id VARCHAR(36) PRIMARY KEY, require_payment INTEGER NOT NULL, connection_status VARCHAR(24) NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS business_images (image_key VARCHAR(36) PRIMARY KEY, image_base64 LONGTEXT NOT NULL, version VARCHAR(36) NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS landing_traffic (hour_at BIGINT NOT NULL, campaign_key VARCHAR(64) NOT NULL, utm_json VARCHAR(2048) NOT NULL, hits BIGINT NOT NULL, PRIMARY KEY (hour_at, campaign_key))`,
  `CREATE TABLE IF NOT EXISTS landing_visits (visit_key VARCHAR(64) PRIMARY KEY, created_at BIGINT NOT NULL, utm_json VARCHAR(2048) NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS auth_attempts (attempt_key VARCHAR(64) PRIMARY KEY, hits INTEGER NOT NULL, window_start BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS password_recovery_jobs (id VARCHAR(36) PRIMARY KEY, recipient_type VARCHAR(16) NOT NULL, recipient_id VARCHAR(36) NULL, email_hash VARCHAR(64) NOT NULL, payload_cipher LONGTEXT NULL, token_hash VARCHAR(64) NULL, state VARCHAR(16) NOT NULL, attempts INTEGER NOT NULL, lease_until BIGINT NOT NULL, next_check_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, last_error VARCHAR(40) NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS password_recovery_dispatch (slug VARCHAR(48) PRIMARY KEY, revision INTEGER NOT NULL, next_check_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit_events (id VARCHAR(36) PRIMARY KEY, actor_id VARCHAR(36) NULL, event_name VARCHAR(64) NOT NULL, detail_json LONGTEXT NOT NULL, created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS customers (id VARCHAR(36) PRIMARY KEY, name VARCHAR(120) NOT NULL, phone VARCHAR(20) NOT NULL, email VARCHAR(254) NOT NULL UNIQUE, password_hash VARCHAR(256) NULL, created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS customer_sessions (token_hash VARCHAR(64) PRIMARY KEY, customer_id VARCHAR(36) NOT NULL, csrf VARCHAR(64) NOT NULL, expires_at BIGINT NOT NULL, FOREIGN KEY (customer_id) REFERENCES customers(id))`,
  `CREATE TABLE IF NOT EXISTS customer_tokens (token_hash VARCHAR(64) PRIMARY KEY, customer_id VARCHAR(36) NOT NULL, expires_at BIGINT NOT NULL, used_at BIGINT NULL, FOREIGN KEY (customer_id) REFERENCES customers(id))`,
  `CREATE TABLE IF NOT EXISTS appointments (id VARCHAR(36) PRIMARY KEY, customer_id VARCHAR(36) NOT NULL, professional_id VARCHAR(36) NOT NULL, service_id VARCHAR(36) NOT NULL, starts_at BIGINT NOT NULL, ends_at BIGINT NOT NULL, occupied_until BIGINT NOT NULL, status VARCHAR(24) NOT NULL, revision INTEGER NOT NULL, snapshot_json LONGTEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT ('{}'), created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, FOREIGN KEY (customer_id) REFERENCES customers(id))`,
  `CREATE TABLE IF NOT EXISTS landing_visit_bookings (appointment_id VARCHAR(36) PRIMARY KEY, visit_key VARCHAR(64) NOT NULL, FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE, FOREIGN KEY (visit_key) REFERENCES landing_visits(visit_key))`,
  `CREATE TABLE IF NOT EXISTS booking_requests (request_key VARCHAR(64) PRIMARY KEY, customer_id VARCHAR(36) NOT NULL, signature VARCHAR(64) NOT NULL, kind VARCHAR(24) NOT NULL, appointment_id VARCHAR(36) NOT NULL, created_at BIGINT NOT NULL, FOREIGN KEY (appointment_id) REFERENCES appointments(id))`,
  `CREATE TABLE IF NOT EXISTS booking_events (id VARCHAR(36) PRIMARY KEY, appointment_id VARCHAR(36) NOT NULL, actor_type VARCHAR(20) NOT NULL, actor_id VARCHAR(36) NOT NULL, event_name VARCHAR(40) NOT NULL, detail_json LONGTEXT NOT NULL, created_at BIGINT NOT NULL, FOREIGN KEY (appointment_id) REFERENCES appointments(id))`,
  `CREATE TABLE IF NOT EXISTS calendar_blocks (id VARCHAR(36) PRIMARY KEY, professional_id VARCHAR(36) NOT NULL, starts_at BIGINT NOT NULL, ends_at BIGINT NOT NULL, reason VARCHAR(200) NOT NULL, active INTEGER NOT NULL, created_by VARCHAR(36) NOT NULL, created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS mp_oauth_states (state_hash VARCHAR(64) PRIMARY KEY, user_id VARCHAR(36) NOT NULL, professional_id VARCHAR(36) NOT NULL, session_hash VARCHAR(64) NOT NULL, verifier_cipher LONGTEXT NOT NULL, expires_at BIGINT NOT NULL, used_at BIGINT NULL)`,
  `CREATE TABLE IF NOT EXISTS mp_connections (id VARCHAR(36) PRIMARY KEY, professional_id VARCHAR(36) NOT NULL, collector_id VARCHAR(32) NOT NULL, receiver_name VARCHAR(120) NOT NULL, mode VARCHAR(16) NOT NULL, status VARCHAR(24) NOT NULL, secrets_cipher LONGTEXT NULL, expires_at BIGINT NOT NULL, refresh_lease_until BIGINT NOT NULL, revision INTEGER NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS subscription_receiving_settings (id INTEGER PRIMARY KEY, mode VARCHAR(16) NOT NULL, revision INTEGER NOT NULL, connection_id VARCHAR(36) NULL, updated_by VARCHAR(36) NOT NULL, updated_at BIGINT NOT NULL, FOREIGN KEY (connection_id) REFERENCES mp_connections(id))`,
  `CREATE TABLE IF NOT EXISTS mp_intents (id VARCHAR(36) PRIMARY KEY, appointment_id VARCHAR(36) NOT NULL UNIQUE, connection_id VARCHAR(36) NOT NULL, collector_id VARCHAR(32) NOT NULL, amount_cents INTEGER NOT NULL, mode VARCHAR(16) NOT NULL, state VARCHAR(32) NOT NULL, expires_at BIGINT NOT NULL, preference_id VARCHAR(128) NULL, checkout_url LONGTEXT NULL, checkout_state VARCHAR(24) NOT NULL, checkout_lease_until BIGINT NOT NULL, approved_payment_id VARCHAR(64) NULL, resolution VARCHAR(40) NOT NULL, check_lease_until BIGINT NOT NULL, next_check_at BIGINT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, FOREIGN KEY (appointment_id) REFERENCES appointments(id), FOREIGN KEY (connection_id) REFERENCES mp_connections(id))`,
  `CREATE TABLE IF NOT EXISTS mp_payments (id VARCHAR(64) PRIMARY KEY, intent_id VARCHAR(36) NOT NULL, provider_id VARCHAR(64) NOT NULL, status VARCHAR(32) NOT NULL, amount_cents INTEGER NOT NULL, refunded_cents INTEGER NOT NULL, provider_updated_at BIGINT NOT NULL, detail_code VARCHAR(80) NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, FOREIGN KEY (intent_id) REFERENCES mp_intents(id))`,
  `CREATE TABLE IF NOT EXISTS mp_events (id VARCHAR(64) PRIMARY KEY, intent_id VARCHAR(36) NOT NULL, provider_id VARCHAR(64) NOT NULL, event_name VARCHAR(48) NOT NULL, detail_json LONGTEXT NOT NULL, created_at BIGINT NOT NULL, FOREIGN KEY (intent_id) REFERENCES mp_intents(id))`,
  `CREATE TABLE IF NOT EXISTS subscription_plans (id VARCHAR(36) PRIMARY KEY, professional_id VARCHAR(36) NOT NULL, active INTEGER NOT NULL, snapshot_json LONGTEXT NOT NULL, created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS subscriptions (id VARCHAR(36) PRIMARY KEY, plan_id VARCHAR(36) NOT NULL, customer_id VARCHAR(36) NOT NULL, professional_id VARCHAR(36) NOT NULL, connection_id VARCHAR(36) NULL, collector_id VARCHAR(32) NULL, payer_email VARCHAR(254) NULL, mode VARCHAR(16) NOT NULL, request_key VARCHAR(64) NOT NULL UNIQUE, provider_id VARCHAR(128) NULL UNIQUE, checkout_url LONGTEXT NULL, state VARCHAR(24) NOT NULL, create_state VARCHAR(24) NOT NULL, lease_until BIGINT NOT NULL, next_check_at BIGINT NOT NULL, resolution VARCHAR(40) NOT NULL, snapshot_json LONGTEXT NOT NULL, provider_updated_at BIGINT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, FOREIGN KEY (plan_id) REFERENCES subscription_plans(id), FOREIGN KEY (customer_id) REFERENCES customers(id), FOREIGN KEY (connection_id) REFERENCES mp_connections(id))`,
  `CREATE TABLE IF NOT EXISTS subscription_controls (customer_id VARCHAR(36) NOT NULL, plan_id VARCHAR(36) NOT NULL, allowed INTEGER NOT NULL, revision INTEGER NOT NULL, updated_by VARCHAR(36) NOT NULL, updated_at BIGINT NOT NULL, PRIMARY KEY (customer_id, plan_id), FOREIGN KEY (customer_id) REFERENCES customers(id), FOREIGN KEY (plan_id) REFERENCES subscription_plans(id), FOREIGN KEY (updated_by) REFERENCES users(id))`,
  `CREATE TABLE IF NOT EXISTS subscription_renewal_jobs (subscription_id VARCHAR(36) PRIMARY KEY, control_revision INTEGER NOT NULL, state VARCHAR(16) NOT NULL, attempts INTEGER NOT NULL, lease_until BIGINT NOT NULL, next_check_at BIGINT NOT NULL, last_error VARCHAR(64) NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, FOREIGN KEY (subscription_id) REFERENCES subscriptions(id))`,
  `CREATE TABLE IF NOT EXISTS subscription_creation_withdrawals (subscription_id VARCHAR(36) PRIMARY KEY, customer_id VARCHAR(36) NOT NULL, plan_id VARCHAR(36) NOT NULL, source_hash VARCHAR(64) NOT NULL, revision INTEGER NOT NULL, successor_id VARCHAR(36) NULL UNIQUE, withdrawn_by VARCHAR(36) NOT NULL, withdrawn_at BIGINT NOT NULL, check_state VARCHAR(24) NOT NULL, lease_until BIGINT NOT NULL, next_check_at BIGINT NOT NULL, last_issue VARCHAR(40) NOT NULL, updated_at BIGINT NOT NULL, FOREIGN KEY (subscription_id) REFERENCES subscriptions(id), FOREIGN KEY (customer_id) REFERENCES customers(id), FOREIGN KEY (plan_id) REFERENCES subscription_plans(id))`,
  `CREATE TABLE IF NOT EXISTS subscription_cycles (id VARCHAR(64) PRIMARY KEY, subscription_id VARCHAR(36) NOT NULL, invoice_id VARCHAR(32) NULL UNIQUE, payment_id VARCHAR(32) NULL UNIQUE, starts_at BIGINT NOT NULL, ends_at BIGINT NOT NULL, valid INTEGER NOT NULL, provider_updated_at BIGINT NOT NULL, created_at BIGINT NOT NULL, FOREIGN KEY (subscription_id) REFERENCES subscriptions(id))`,
  `CREATE TABLE IF NOT EXISTS subscription_usage (appointment_id VARCHAR(36) PRIMARY KEY, subscription_id VARCHAR(36) NOT NULL, cycle_id VARCHAR(64) NOT NULL, released INTEGER NOT NULL, created_at BIGINT NOT NULL, FOREIGN KEY (appointment_id) REFERENCES appointments(id), FOREIGN KEY (subscription_id) REFERENCES subscriptions(id), FOREIGN KEY (cycle_id) REFERENCES subscription_cycles(id))`,
  `CREATE TABLE IF NOT EXISTS customer_profiles (customer_id VARCHAR(36) PRIMARY KEY, revision INTEGER NOT NULL, notes LONGTEXT NOT NULL, updated_at BIGINT NOT NULL, FOREIGN KEY (customer_id) REFERENCES customers(id))`,
  `CREATE TABLE IF NOT EXISTS customer_imports (request_key VARCHAR(64) PRIMARY KEY, signature VARCHAR(64) NOT NULL, result_json LONGTEXT NOT NULL, actor_id VARCHAR(36) NOT NULL, created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS financial_entries (id VARCHAR(64) PRIMARY KEY, request_key VARCHAR(64) NULL UNIQUE, signature VARCHAR(64) NOT NULL, customer_id VARCHAR(36) NOT NULL, professional_id VARCHAR(36) NOT NULL, appointment_id VARCHAR(36) NULL, subscription_id VARCHAR(36) NULL, source VARCHAR(24) NOT NULL, kind VARCHAR(16) NOT NULL, method VARCHAR(24) NOT NULL, amount_cents INTEGER NOT NULL, occurred_at BIGINT NOT NULL, date_source VARCHAR(24) NOT NULL, actor_id VARCHAR(36) NULL, note VARCHAR(250) NOT NULL, reverse_of VARCHAR(64) NULL, created_at BIGINT NOT NULL, FOREIGN KEY (customer_id) REFERENCES customers(id), FOREIGN KEY (appointment_id) REFERENCES appointments(id), FOREIGN KEY (subscription_id) REFERENCES subscriptions(id))`,
  `CREATE TABLE IF NOT EXISTS financial_provider_snapshots (payment_key VARCHAR(64) PRIMARY KEY, owner_key VARCHAR(64) NOT NULL, net_cents INTEGER NOT NULL, provider_updated_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS license_contracts (id VARCHAR(36) PRIMARY KEY, payer_email VARCHAR(254) NOT NULL, mode VARCHAR(16) NOT NULL, provider_id VARCHAR(128) NULL UNIQUE, collector_id VARCHAR(32) NULL, status VARCHAR(24) NOT NULL, checkout_url LONGTEXT NULL, create_state VARCHAR(24) NOT NULL, lease_until BIGINT NOT NULL, check_lease_until BIGINT NOT NULL, next_check_at BIGINT NOT NULL, provider_updated_at BIGINT NOT NULL, resolution VARCHAR(40) NOT NULL, grace_days INTEGER NOT NULL, time_zone VARCHAR(64) NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS license_offer_controls (mode VARCHAR(16) PRIMARY KEY, test_visible INTEGER NOT NULL, revision INTEGER NOT NULL, updated_by VARCHAR(36) NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS license_trial (id INTEGER PRIMARY KEY, starts_at BIGINT NOT NULL, ends_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS license_trial_extensions (id VARCHAR(36) PRIMARY KEY, request_key VARCHAR(64) NOT NULL UNIQUE, signature VARCHAR(64) NOT NULL, days INTEGER NOT NULL, note VARCHAR(500) NOT NULL, previous_ends_at BIGINT NOT NULL, base_at BIGINT NOT NULL, ends_at BIGINT NOT NULL, extended_at BIGINT NOT NULL, operator_id VARCHAR(36) NOT NULL, operator_tenant VARCHAR(48) NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS license_cycles (id VARCHAR(64) PRIMARY KEY, contract_id VARCHAR(36) NULL, source VARCHAR(16) NOT NULL, mode VARCHAR(16) NOT NULL, invoice_id VARCHAR(32) NULL UNIQUE, payment_id VARCHAR(32) NULL UNIQUE, amount_cents INTEGER NOT NULL, starts_at BIGINT NOT NULL, ends_at BIGINT NOT NULL, valid INTEGER NOT NULL, status VARCHAR(32) NOT NULL, paid_at BIGINT NULL, provider_updated_at BIGINT NOT NULL, request_key VARCHAR(64) NULL UNIQUE, signature VARCHAR(64) NOT NULL, actor_id VARCHAR(36) NULL, note VARCHAR(250) NOT NULL, created_at BIGINT NOT NULL, FOREIGN KEY (contract_id) REFERENCES license_contracts(id))`,
  `CREATE TABLE IF NOT EXISTS license_money_entries (id VARCHAR(64) PRIMARY KEY, cycle_id VARCHAR(64) NOT NULL, mode VARCHAR(16) NOT NULL, source VARCHAR(16) NOT NULL, kind VARCHAR(16) NOT NULL, amount_cents INTEGER NOT NULL, occurred_at BIGINT NOT NULL, note VARCHAR(250) NOT NULL, created_at BIGINT NOT NULL, FOREIGN KEY (cycle_id) REFERENCES license_cycles(id))`,
  `CREATE TABLE IF NOT EXISTS license_money_snapshots (payment_key VARCHAR(64) PRIMARY KEY, cycle_id VARCHAR(64) NOT NULL, received_cents INTEGER NOT NULL, reversed_cents INTEGER NOT NULL, provider_updated_at BIGINT NOT NULL, FOREIGN KEY (cycle_id) REFERENCES license_cycles(id))`,
  `CREATE TABLE IF NOT EXISTS operation_requests (id VARCHAR(36) PRIMARY KEY, slug VARCHAR(48) NOT NULL UNIQUE, name VARCHAR(120) NOT NULL, owner_name VARCHAR(120) NOT NULL, owner_email VARCHAR(254) NOT NULL, status VARCHAR(24) NOT NULL, notes VARCHAR(500) NOT NULL, metadata_json TEXT NOT NULL DEFAULT ('{}'), archived_at BIGINT NULL, archived_by VARCHAR(36) NULL, deleted_at BIGINT NULL, deleted_by VARCHAR(36) NULL, deletion_key VARCHAR(64) NULL UNIQUE, revision INTEGER NOT NULL, created_by VARCHAR(36) NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS onboarding_submissions (request_key VARCHAR(64) PRIMARY KEY, signature VARCHAR(64) NOT NULL, request_id VARCHAR(36) NULL, created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS onboarding_access_grants (request_id VARCHAR(36) PRIMARY KEY, user_id VARCHAR(36) NOT NULL, issued_at BIGINT NOT NULL, expires_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS mp_integration_settings (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, payload_cipher LONGTEXT NOT NULL, client_id VARCHAR(32) NOT NULL, owner_id VARCHAR(32) NOT NULL, owner_name VARCHAR(120) NOT NULL, mode VARCHAR(16) NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS mp_application_claims (client_id VARCHAR(32) PRIMARY KEY, tenant_slug VARCHAR(48) NOT NULL UNIQUE, updated_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS mp_diagnostic_probes (id VARCHAR(36) PRIMARY KEY, binding_key VARCHAR(64) NOT NULL, tenant_slug VARCHAR(48) NOT NULL, source_subscription_id VARCHAR(36) NOT NULL, request_key VARCHAR(64) NOT NULL UNIQUE, snapshot_json LONGTEXT NOT NULL, provider_id VARCHAR(128) NULL UNIQUE, checkout_url LONGTEXT NULL, state VARCHAR(24) NOT NULL, provider_status VARCHAR(24) NULL, issue VARCHAR(40) NOT NULL, lease_until BIGINT NOT NULL, revision INTEGER NOT NULL, diagnostic_json LONGTEXT NOT NULL, invoice_count INTEGER NOT NULL, has_approved_invoice INTEGER NOT NULL, created_by VARCHAR(36) NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS managed_tenants (slug VARCHAR(48) PRIMARY KEY, registration_id VARCHAR(36) NOT NULL UNIQUE, database_key VARCHAR(64) NOT NULL UNIQUE, user_key VARCHAR(64) NOT NULL UNIQUE, entry_cipher LONGTEXT NOT NULL, created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS automatic_registrations (request_key VARCHAR(64) PRIMARY KEY, id VARCHAR(36) NOT NULL UNIQUE, slug VARCHAR(48) NOT NULL UNIQUE, signature VARCHAR(64) NOT NULL, claim_cipher LONGTEXT NOT NULL, payload_cipher LONGTEXT NOT NULL, state VARCHAR(24) NOT NULL, attempt_count INTEGER NOT NULL, lease_until BIGINT NOT NULL, next_attempt_at BIGINT NOT NULL, category VARCHAR(40) NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tenant_identity (id INTEGER PRIMARY KEY, registration_id VARCHAR(36) NOT NULL UNIQUE, slug VARCHAR(48) NOT NULL UNIQUE)`,
  `CREATE TABLE IF NOT EXISTS tenant_lifecycle (slug VARCHAR(48) PRIMARY KEY, state VARCHAR(24) NOT NULL, revision INTEGER NOT NULL, archived_at BIGINT NULL, deleted_at BIGINT NULL, updated_by VARCHAR(36) NOT NULL, summary_json LONGTEXT NOT NULL, deletion_key VARCHAR(64) NULL UNIQUE, deletion_stage VARCHAR(24) NOT NULL, error_code VARCHAR(40) NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tenant_finance_archives (slug VARCHAR(48) PRIMARY KEY, name VARCHAR(120) NOT NULL, payload_json LONGTEXT NOT NULL, archived_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tenant_runtime_leases (token VARCHAR(64) PRIMARY KEY, slug VARCHAR(48) NOT NULL, instance_id VARCHAR(36) NOT NULL, host VARCHAR(255) NOT NULL, pid INTEGER NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, expires_at BIGINT NOT NULL)`,
];

const optionalSubscriptionColumns = {
  subscriptions: { connection_id: 'VARCHAR(36)', collector_id: 'VARCHAR(32)' },
  subscription_cycles: { invoice_id: 'VARCHAR(32)', payment_id: 'VARCHAR(32)' },
};

// Manual memberships have neither a provider account nor provider invoice IDs.
// SQLite cannot change nullability in place. Keep child references pointing to
// the original table name throughout the documented create/copy/drop/rename
// procedure; renaming the old table would rewrite those foreign keys.
function migrateSqliteSubscriptions(connection) {
  const needsMigration = table => connection.prepare(`PRAGMA table_info(${table})`).all()
    .some(column => Object.hasOwn(optionalSubscriptionColumns[table], column.name) && column.notnull);
  if (!Object.keys(optionalSubscriptionColumns).some(needsMigration)) return;
  connection.exec('PRAGMA foreign_keys=OFF');
  let started = false;
  try {
    connection.exec('BEGIN IMMEDIATE'); started = true;
    // A different process may have completed the migration before this lock.
    for (const table of Object.keys(optionalSubscriptionColumns)) {
      if (!needsMigration(table)) continue;
      const objects = connection.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL").all(table);
      const columns = connection.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
      if (columns.some(column => !/^[a-z_]+$/.test(column))) throw new Error('Coluna inesperada na migração de assinaturas.');
      const temporary = `${table}_migration_12`, definition = schema.find(sql => sql.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`));
      connection.exec(definition.replace(`IF NOT EXISTS ${table}`, temporary));
      connection.exec(`INSERT INTO ${temporary} (${columns.join(', ')}) SELECT ${columns.join(', ')} FROM ${table}`);
      connection.exec(`DROP TABLE ${table}`);
      connection.exec(`ALTER TABLE ${temporary} RENAME TO ${table}`);
      for (const object of objects) connection.exec(object.sql);
    }
    if (connection.prepare('PRAGMA foreign_key_check').all().length) throw new Error('A migração de assinaturas encontrou uma referência inválida.');
    connection.exec('COMMIT'); started = false;
  } catch (error) {
    if (started) connection.exec('ROLLBACK');
    throw error;
  } finally { connection.exec('PRAGMA foreign_keys=ON'); }
}

export async function openDatabase(config) {
  let db, migrateSubscriptions;
  if (config.driver === 'sqlite') {
    await mkdir(dirname(config.path), { recursive: true });
    const { DatabaseSync } = await import('node:sqlite');
    const connection = new DatabaseSync(config.path);
    connection.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    let queue = Promise.resolve();
    const serial = fn => {
      const result = queue.then(fn);
      queue = result.catch(() => {});
      return result;
    };
    const query = async (sql, params = []) => {
      const statement = connection.prepare(sql);
      if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params);
      return statement.run(...params);
    };
    db = {
      driver: 'sqlite', lock: '',
      query: (sql, params) => serial(() => query(sql, params)),
      transaction: fn => serial(async () => {
        connection.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn({ query, lock: '' });
          connection.exec('COMMIT');
          return result;
        } catch (error) { connection.exec('ROLLBACK'); throw error; }
      }),
      close: () => serial(() => connection.close()),
    };
    migrateSubscriptions = () => serial(() => migrateSqliteSubscriptions(connection));
  } else if (config.driver === 'mysql') {
    const { createPool } = await import('mysql2/promise');
    const pool = createPool({
      host: config.host, port: config.port ?? 3306, user: config.user,
      password: config.password, database: config.database,
      charset: 'utf8mb4', connectionLimit: 2, maxIdle: 1, idleTimeout: 60000,
      queueLimit: 30, waitForConnections: true, multipleStatements: false,
      maxPreparedStatements: 64, supportBigNumbers: true,
      ...(config.ssl ? { ssl: { rejectUnauthorized: true, ...(config.ca ? { ca: config.ca } : {}) } } : {}),
    });
    db = {
      driver: 'mysql', lock: ' FOR UPDATE',
      query: async (sql, params = []) => (await pool.execute(sql, params))[0],
      transaction: async fn => {
        const connection = await pool.getConnection();
        try {
          await connection.beginTransaction();
          const result = await fn({ query: async (sql, params = []) => (await connection.execute(sql, params))[0], lock: ' FOR UPDATE' });
          await connection.commit();
          return result;
        } catch (error) { await connection.rollback(); throw error; }
        finally { connection.release(); }
      },
      close: () => pool.end(),
    };
    migrateSubscriptions = async () => {
      for (const [table, columns] of Object.entries(optionalSubscriptionColumns)) {
        const actual = await db.query('SELECT COLUMN_NAME AS name, IS_NULLABLE AS nullable FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
        const changes = actual.filter(column => Object.hasOwn(columns, column.name) && column.nullable === 'NO');
        // The ALTER retains existing keys, indexes and rows. Competing workers
        // may repeat the same nullable definition safely after metadata locks.
        if (changes.length) await db.query(`ALTER TABLE ${table} ${changes.map(column => `MODIFY COLUMN ${column.name} ${columns[column.name]} NULL`).join(', ')}`);
      }
    };
  } else throw new Error('Driver de persistência não suportado.');
  try {
    for (const statement of schema) await db.query(statement);
    for (const [name, target] of [['password_recovery_due', 'password_recovery_jobs(state, next_check_at, lease_until)'], ['password_recovery_recipient', 'password_recovery_jobs(recipient_type, recipient_id, created_at)'], ['password_recovery_dispatch_due', 'password_recovery_dispatch(next_check_at)']]) {
      try { await db.query(`CREATE INDEX ${db.driver === 'sqlite' ? 'IF NOT EXISTS ' : ''}${name} ON ${target}`); }
      catch (error) { if (error.code !== 'ER_DUP_KEYNAME') throw error; }
    }
    await migrateSubscriptions();
    // Existing tenant databases keep all rows; only the two attribution columns
    // are added. Separate Node workers may discover the old schema together.
    for (const table of ['appointments', 'operation_requests']) {
      const columns = db.driver === 'sqlite'
        ? await db.query(`PRAGMA table_info(${table})`)
        : await db.query('SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [table, 'metadata_json']);
      if (!columns.some(column => column.name === 'metadata_json')) {
        try { await db.query(`ALTER TABLE ${table} ADD COLUMN metadata_json TEXT NOT NULL DEFAULT ('{}')`); }
        catch (error) { if (error.code !== 'ER_DUP_FIELDNAME' && !(db.driver === 'sqlite' && /duplicate column name: metadata_json/i.test(error.message))) throw error; }
      }
    }
    // Existing contracts keep their agreed R$ 60 price. New offers are disabled
    // unless an operator explicitly creates the per-business visibility rule.
    for (const [table, additions] of Object.entries({
      subscriptions: { payer_email: 'VARCHAR(254) NULL' },
      operation_requests: { archived_at: 'BIGINT NULL', archived_by: 'VARCHAR(36) NULL', deleted_at: 'BIGINT NULL', deleted_by: 'VARCHAR(36) NULL', deletion_key: 'VARCHAR(64) NULL' },
      license_contracts: { plan_id: "VARCHAR(16) NOT NULL DEFAULT 'standard'", amount_cents: 'INTEGER NOT NULL DEFAULT 6000' },
      license_cycles: { plan_id: "VARCHAR(16) NOT NULL DEFAULT 'standard'", payment_method: "VARCHAR(24) NOT NULL DEFAULT 'other'" },
    })) {
      const columns = db.driver === 'sqlite' ? await db.query(`PRAGMA table_info(${table})`) : await db.query('SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
      for (const [name, definition] of Object.entries(additions)) if (!columns.some(column => column.name === name)) {
        try { await db.query(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`); }
        catch (error) { if (error.code !== 'ER_DUP_FIELDNAME' && !(db.driver === 'sqlite' && new RegExp(`duplicate column name: ${name}`, 'i').test(error.message))) throw error; }
      }
    }
    const [offerMigration] = await db.query('SELECT version FROM schema_migrations WHERE version = 15');
    try { await db.query(`CREATE UNIQUE INDEX ${db.driver === 'sqlite' ? 'IF NOT EXISTS ' : ''}operation_requests_delete_key ON operation_requests(deletion_key)`); }
    catch (error) { if (error.code !== 'ER_DUP_KEYNAME') throw error; }
    if (!offerMigration) await db.query("UPDATE license_cycles SET payment_method = 'mercadopago' WHERE source = 'mercadopago' AND payment_method = 'other'");
    for (const [name, target] of [['notifications_recipient', 'notifications(recipient_type, recipient_id, created_at, id)'], ['notification_devices_owner', 'notification_devices(recipient_type, recipient_id, active)'], ['notification_outbox_due', 'notification_outbox(state, next_check_at, lease_until)'], ['appointments_prof_time', 'appointments(professional_id, starts_at, occupied_until)'], ['appointments_client_time', 'appointments(customer_id, starts_at)'], ['blocks_prof_time', 'calendar_blocks(professional_id, starts_at, ends_at)'], ['mp_prof_mode', 'mp_connections(professional_id, mode)'], ['mp_intents_due', 'mp_intents(next_check_at, created_at)'], ['subscriptions_due', 'subscriptions(next_check_at)'], ['subscriptions_owner', 'subscriptions(customer_id, professional_id)'], ['subscription_renewal_jobs_due', 'subscription_renewal_jobs(state, next_check_at, lease_until)'], ['subscription_withdrawals_due', 'subscription_creation_withdrawals(check_state, next_check_at, lease_until)'], ['subscription_cycle_time', 'subscription_cycles(subscription_id, starts_at, ends_at)'], ['finance_period', 'financial_entries(professional_id, occurred_at)'], ['license_money_period', 'license_money_entries(mode, occurred_at)'], ['license_money_cycle', 'license_money_entries(cycle_id)']]) {
      try { await db.query(`CREATE INDEX ${db.driver === 'sqlite' ? 'IF NOT EXISTS ' : ''}${name} ON ${target}`); }
      catch (error) { if (error.code !== 'ER_DUP_KEYNAME') throw error; }
    }
    const insert = db.driver === 'mysql' ? 'INSERT IGNORE' : 'INSERT OR IGNORE';
    await db.query(`${insert} INTO schema_migrations(version, applied_at) VALUES (?, ?)`, [1, Date.now()]);
    await db.query(`${insert} INTO schema_migrations(version, applied_at) VALUES (?, ?)`, [2, Date.now()]);
    await db.query(`${insert} INTO schema_migrations(version, applied_at) VALUES (?, ?)`, [3, Date.now()]);
    await db.query(`${insert} INTO schema_migrations(version, applied_at) VALUES (?, ?)`, [4, Date.now()]);
    await db.query(`${insert} INTO schema_migrations(version, applied_at) VALUES (?, ?)`, [5, Date.now()]);
    await db.query(`${insert} INTO schema_migrations(version, applied_at) VALUES (?, ?)`, [6, Date.now()]);
    await db.query(`${insert} INTO schema_migrations(version, applied_at) VALUES (?, ?)`, [7, Date.now()]);
    await db.query(`${insert} INTO schema_migrations(version, applied_at) VALUES (?, ?)`, [8, Date.now()]);
    await db.query(`${insert} INTO schema_migrations(version, applied_at) VALUES (?, ?)`, [9, Date.now()]);
    await db.query(`${insert} INTO schema_migrations(version, applied_at) VALUES (?, ?)`, [10, Date.now()]);
    await db.query(`${insert} INTO schema_migrations(version, applied_at) VALUES (?, ?)`, [11, Date.now()]);
    await db.query(`${insert} INTO schema_migrations(version, applied_at) VALUES (?, ?)`, [12, Date.now()]);
    await db.query(`${insert} INTO schema_migrations(version, applied_at) VALUES (?, ?)`, [13, Date.now()]);
    await db.query(`${insert} INTO schema_migrations(version, applied_at) VALUES (?, ?)`, [14, Date.now()]);
    await db.query(`${insert} INTO schema_migrations(version, applied_at) VALUES (?, ?)`, [15, Date.now()]);
    await db.query(`${insert} INTO schema_migrations(version, applied_at) VALUES (?, ?)`, [16, Date.now()]);
    await db.query(`${insert} INTO schema_migrations(version, applied_at) VALUES (?, ?)`, [17, Date.now()]);
    await db.query(`${insert} INTO schema_migrations(version, applied_at) VALUES (?, ?)`, [18, Date.now()]);
    await db.query(`${insert} INTO schema_migrations(version, applied_at) VALUES (?, ?)`, [19, Date.now()]);
    await db.query(`${insert} INTO schema_migrations(version, applied_at) VALUES (?, ?)`, [20, Date.now()]);
    await db.query(`${insert} INTO schema_migrations(version, applied_at) VALUES (?, ?)`, [21, Date.now()]);
    await db.query(`${insert} INTO schema_migrations(version, applied_at) VALUES (?, ?)`, [22, Date.now()]);
    await db.query(`${insert} INTO schema_migrations(version, applied_at) VALUES (?, ?)`, [23, Date.now()]);
    try { await db.query(`CREATE INDEX ${db.driver === 'sqlite' ? 'IF NOT EXISTS ' : ''}appointments_created ON appointments(created_at)`); }
    catch (error) { if (error.code !== 'ER_DUP_KEYNAME') throw error; }
    await db.query(`${insert} INTO schema_migrations(version, applied_at) VALUES (?, ?)`, [24, Date.now()]);
    for (const [name, target] of [['landing_visits_period', 'landing_visits(created_at)'], ['landing_bookings_visit', 'landing_visit_bookings(visit_key)']]) {
      try { await db.query(`CREATE INDEX ${db.driver === 'sqlite' ? 'IF NOT EXISTS ' : ''}${name} ON ${target}`); }
      catch (error) { if (error.code !== 'ER_DUP_KEYNAME') throw error; }
    }
    await db.query(`${insert} INTO schema_migrations(version, applied_at) VALUES (?, ?)`, [25, Date.now()]);
    return db;
  } catch (error) { await db.close(); throw error; }
}

export async function readSettings(db, lock = false) {
  const [row] = await db.query('SELECT * FROM business_settings WHERE id = 1' + (lock ? db.lock : ''));
  if (!row) throw new Error('Negócio ainda não provisionado.');
  return { revision: Number(row.revision), draft: JSON.parse(row.draft_json), published: row.published_json ? JSON.parse(row.published_json) : null, publishedAt: row.published_at ? Number(row.published_at) : null };
}
