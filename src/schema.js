// Idempotent, additive migrations. Safe to run on every start and on databases
// created by the original database.sql — nothing is dropped except a constraint
// that made ticket numbers collide from the second day onward.
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const config = require('./config');

const STATUSES = ['waiting', 'called', 'in-progress', 'done', 'no-show', 'cancelled'];
const PRIORITIES = ['normal', 'priority', 'emergency'];

const DEFAULT_DEPARTMENTS = [
  { name: 'General Consultation', code: 'G', icon: '🩺', description: 'General medical consultations', minutes: 12 },
  { name: 'Maternity & Pediatrics', code: 'M', icon: '👶', description: 'Maternal and child health', minutes: 15 },
  { name: 'Lab & Diagnostics', code: 'L', icon: '🧪', description: 'Laboratory tests and imaging', minutes: 8 },
  { name: 'Pharmacy', code: 'P', icon: '💊', description: 'Medication dispensing', minutes: 5 },
  { name: 'Emergency', code: 'E', icon: '🚨', description: 'Emergency care', minutes: 20 },
  { name: 'Dental', code: 'D', icon: '🦷', description: 'Dental services', minutes: 20 }
];

const STEPS = [
  `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'receptionist',
    full_name VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    department VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ`,

  `CREATE TABLE IF NOT EXISTS departments (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    icon VARCHAR(50),
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`,
  `ALTER TABLE departments ADD COLUMN IF NOT EXISTS code VARCHAR(3)`,
  `ALTER TABLE departments ADD COLUMN IF NOT EXISTS default_service_minutes INTEGER NOT NULL DEFAULT 10`,
  `ALTER TABLE departments ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0`,

  `CREATE TABLE IF NOT EXISTS counters (
    id SERIAL PRIMARY KEY,
    department_id INTEGER NOT NULL REFERENCES departments(id),
    name VARCHAR(100) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (department_id, name)
  )`,

  `CREATE TABLE IF NOT EXISTS patients (
    id SERIAL PRIMARY KEY,
    ticket_number VARCHAR(50) NOT NULL,
    first_name VARCHAR(255) NOT NULL,
    last_name VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    email VARCHAR(255),
    priority VARCHAR(50) NOT NULL DEFAULT 'normal',
    department_id INTEGER REFERENCES departments(id),
    status VARCHAR(50) NOT NULL DEFAULT 'waiting',
    notes TEXT,
    registered_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    called_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`,
  `ALTER TABLE patients ALTER COLUMN phone DROP NOT NULL`,
  `ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_ticket_number_key`,
  `ALTER TABLE patients ADD COLUMN IF NOT EXISTS ticket_date DATE`,
  `ALTER TABLE patients ADD COLUMN IF NOT EXISTS counter_id INTEGER REFERENCES counters(id)`,
  `ALTER TABLE patients ADD COLUMN IF NOT EXISTS registered_by INTEGER REFERENCES users(id)`,
  `ALTER TABLE patients ADD COLUMN IF NOT EXISTS called_by INTEGER REFERENCES users(id)`,
  `ALTER TABLE patients ADD COLUMN IF NOT EXISTS first_called_at TIMESTAMPTZ`,
  `ALTER TABLE patients ADD COLUMN IF NOT EXISTS service_started_at TIMESTAMPTZ`,
  `ALTER TABLE patients ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`,
  `ALTER TABLE patients ADD COLUMN IF NOT EXISTS cancel_reason TEXT`,
  `ALTER TABLE patients ADD COLUMN IF NOT EXISTS call_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE patients ADD COLUMN IF NOT EXISTS accessibility_needs TEXT[] NOT NULL DEFAULT '{}'`,
  `ALTER TABLE patients ADD COLUMN IF NOT EXISTS needs_triage BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE patients ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'staff'`,
  `ALTER TABLE patients ADD COLUMN IF NOT EXISTS notified_soon BOOLEAN NOT NULL DEFAULT FALSE`,
  // Legacy statuses from the first version.
  `UPDATE patients SET status = 'no-show' WHERE status IN ('noshow', 'absent')`,
  `UPDATE patients SET ticket_date = registered_at::date WHERE ticket_date IS NULL`,
  `ALTER TABLE patients ALTER COLUMN ticket_date SET NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS patients_ticket_day_key ON patients(ticket_date, ticket_number)`,
  // A counter can only hold one active ticket — enforced by the database, not just the app.
  `CREATE UNIQUE INDEX IF NOT EXISTS patients_one_active_per_counter
     ON patients(counter_id) WHERE status IN ('called', 'in-progress')`,
  `CREATE INDEX IF NOT EXISTS idx_patients_status ON patients(status)`,
  `CREATE INDEX IF NOT EXISTS idx_patients_department ON patients(department_id)`,
  `CREATE INDEX IF NOT EXISTS idx_patients_ticket_date ON patients(ticket_date)`,
  `CREATE INDEX IF NOT EXISTS idx_patients_dept_waiting ON patients(department_id, registered_at) WHERE status = 'waiting'`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patients_status_check') THEN
       ALTER TABLE patients ADD CONSTRAINT patients_status_check
         CHECK (status IN (${STATUSES.map((s) => `'${s}'`).join(',')}));
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patients_priority_check') THEN
       ALTER TABLE patients ADD CONSTRAINT patients_priority_check
         CHECK (priority IN (${PRIORITIES.map((s) => `'${s}'`).join(',')}));
     END IF;
   END $$`,

  // Atomic per-department, per-day ticket numbering.
  `CREATE TABLE IF NOT EXISTS ticket_sequences (
    department_id INTEGER NOT NULL REFERENCES departments(id),
    ticket_date DATE NOT NULL,
    last_number INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (department_id, ticket_date)
  )`,

  `CREATE TABLE IF NOT EXISTS queue_logs (
    id SERIAL PRIMARY KEY,
    patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
    department_id INTEGER REFERENCES departments(id),
    ticket_number VARCHAR(50),
    status VARCHAR(50),
    timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    processed_by INTEGER REFERENCES users(id)
  )`,
  `ALTER TABLE queue_logs ADD COLUMN IF NOT EXISTS from_status VARCHAR(50)`,
  `ALTER TABLE queue_logs ADD COLUMN IF NOT EXISTS action VARCHAR(50)`,
  `ALTER TABLE queue_logs ADD COLUMN IF NOT EXISTS counter_id INTEGER REFERENCES counters(id)`,
  `ALTER TABLE queue_logs ADD COLUMN IF NOT EXISTS note TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_queue_logs_patient ON queue_logs(patient_id)`,

  `CREATE TABLE IF NOT EXISTS sms_logs (
    id SERIAL PRIMARY KEY,
    patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
    recipient_name VARCHAR(255) NOT NULL,
    recipient_phone VARCHAR(20) NOT NULL,
    message TEXT NOT NULL,
    is_auto BOOLEAN DEFAULT FALSE,
    sent_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(50) DEFAULT 'pending'
  )`,
  `ALTER TABLE sms_logs ALTER COLUMN status SET DEFAULT 'pending'`,
  `ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS kind VARCHAR(30)`,
  `ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS provider VARCHAR(30)`,
  `ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS provider_message_id VARCHAR(100)`,
  `ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS error TEXT`,
  `ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS sent_by INTEGER REFERENCES users(id)`,
  `CREATE INDEX IF NOT EXISTS idx_sms_logs_patient ON sms_logs(patient_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sms_logs_sent_at ON sms_logs(sent_at)`,

  `CREATE TABLE IF NOT EXISTS settings (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER REFERENCES users(id)
  )`,

  // Legacy table kept so existing data is preserved; statistics are now computed from patients.
  `CREATE TABLE IF NOT EXISTS analytics (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL,
    department_id INTEGER REFERENCES departments(id),
    total_patients INTEGER DEFAULT 0,
    avg_wait_time INTEGER DEFAULT 0,
    total_served INTEGER DEFAULT 0,
    emergency_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`
];

// Columns created as TIMESTAMP (no time zone) by the original schema.
const TIMESTAMP_COLUMNS = {
  users: ['created_at', 'updated_at'],
  departments: ['created_at'],
  patients: ['registered_at', 'called_at', 'completed_at', 'created_at', 'updated_at'],
  queue_logs: ['timestamp'],
  sms_logs: ['sent_at']
};

async function convertTimestamps(client) {
  const { rows } = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND data_type = 'timestamp without time zone'`
  );
  for (const { table_name: table, column_name: column } of rows) {
    if (!(TIMESTAMP_COLUMNS[table] || []).includes(column)) continue;
    // Existing naive values were written with the server's local clock; interpret them that way.
    await client.query(`ALTER TABLE ${table} ALTER COLUMN "${column}" TYPE TIMESTAMPTZ USING "${column}" AT TIME ZONE current_setting('TimeZone')`);
  }
}

async function backfillDepartmentCodes(client) {
  const { rows } = await client.query('SELECT id, name, code FROM departments ORDER BY id');
  const used = new Set(rows.filter((r) => r.code).map((r) => r.code));
  for (const dept of rows.filter((r) => !r.code)) {
    const letters = dept.name.toUpperCase().replace(/[^A-Z]/g, '') || 'X';
    let code = [...letters].find((ch) => !used.has(ch));
    for (let n = 2; !code; n++) if (!used.has(letters[0] + n)) code = letters[0] + n;
    used.add(code);
    await client.query('UPDATE departments SET code = $1 WHERE id = $2', [code, dept.id]);
  }
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS departments_code_key ON departments(code)');
  await client.query('ALTER TABLE departments ALTER COLUMN code SET NOT NULL');
}

async function seed(client) {
  const { rows: [{ count: deptCount }] } = await client.query('SELECT COUNT(*)::int AS count FROM departments');
  if (deptCount === 0) {
    for (const [i, d] of DEFAULT_DEPARTMENTS.entries()) {
      await client.query(
        `INSERT INTO departments (name, code, icon, description, default_service_minutes, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [d.name, d.code, d.icon, d.description, d.minutes, i]
      );
    }
  }
  // Every department needs at least one counter to be callable.
  await client.query(
    `INSERT INTO counters (department_id, name)
     SELECT d.id, 'Counter 1' FROM departments d
      WHERE NOT EXISTS (SELECT 1 FROM counters c WHERE c.department_id = d.id)`
  );

  const { rows: [{ count: userCount }] } = await client.query('SELECT COUNT(*)::int AS count FROM users');
  if (userCount === 0) {
    const generated = !config.adminInitialPassword;
    const password = config.adminInitialPassword || crypto.randomBytes(9).toString('base64url');
    await client.query(
      `INSERT INTO users (username, email, password, role, full_name)
       VALUES ('admin', 'admin@sqhs.local', $1, 'admin', 'System Administrator')`,
      [await bcrypt.hash(password, 10)]
    );
    console.log('──────────────────────────────────────────────');
    console.log(' Created initial administrator account');
    console.log('   username: admin');
    console.log(`   password: ${generated ? password : '(value of ADMIN_INITIAL_PASSWORD)'}`);
    console.log(' Change it from Settings → My account after signing in.');
    console.log('──────────────────────────────────────────────');
  }
}

async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialise concurrent app instances running migrations at the same time.
    await client.query('SELECT pg_advisory_xact_lock(424242)');
    for (const sql of STEPS) await client.query(sql);
    await convertTimestamps(client);
    await backfillDepartmentCodes(client);
    await seed(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { migrate, STATUSES, PRIORITIES };
