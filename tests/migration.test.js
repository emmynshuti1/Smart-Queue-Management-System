// Upgrading a database created by the original v1 database.sql must keep its data.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { adminQuery, TEST_DB } = require('./helpers');
const { Client } = require('pg');
const config = require('../src/config');

const LEGACY = `
CREATE TABLE users (id SERIAL PRIMARY KEY, username VARCHAR(255) UNIQUE NOT NULL, email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL, role VARCHAR(50) NOT NULL DEFAULT 'staff', full_name VARCHAR(255) NOT NULL,
  phone VARCHAR(20), department VARCHAR(255), is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE departments (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, icon VARCHAR(50), description TEXT,
  is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE patients (id SERIAL PRIMARY KEY, ticket_number VARCHAR(50) UNIQUE NOT NULL, first_name VARCHAR(255) NOT NULL,
  last_name VARCHAR(255) NOT NULL, phone VARCHAR(20) NOT NULL, email VARCHAR(255), priority VARCHAR(50) NOT NULL DEFAULT 'normal',
  department_id INTEGER REFERENCES departments(id), status VARCHAR(50) NOT NULL DEFAULT 'waiting', notes TEXT,
  registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, called_at TIMESTAMP, completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE queue_logs (id SERIAL PRIMARY KEY, patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
  department_id INTEGER REFERENCES departments(id), ticket_number VARCHAR(50), status VARCHAR(50),
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP, processed_by INTEGER REFERENCES users(id));
CREATE TABLE sms_logs (id SERIAL PRIMARY KEY, patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
  recipient_name VARCHAR(255) NOT NULL, recipient_phone VARCHAR(20) NOT NULL, message TEXT NOT NULL,
  is_auto BOOLEAN DEFAULT FALSE, sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, status VARCHAR(50) DEFAULT 'sent');
CREATE TABLE analytics (id SERIAL PRIMARY KEY, date DATE NOT NULL, department_id INTEGER REFERENCES departments(id),
  total_patients INTEGER DEFAULT 0, avg_wait_time INTEGER DEFAULT 0, total_served INTEGER DEFAULT 0,
  emergency_count INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
INSERT INTO departments (name, icon) VALUES ('General Consultation','🩺'), ('Pharmacy','💊'), ('Physiotherapy','🦴');
INSERT INTO users (username, email, password, role, full_name) VALUES ('legacy', 'l@x', 'x', 'staff', 'Legacy User');
INSERT INTO patients (ticket_number, first_name, last_name, phone, department_id, status, registered_at)
  VALUES ('G001','Old','One','+250788000000',1,'done', now() - interval '3 days'),
         ('G002','Old','Two','+250788000001',1,'in-progress', now() - interval '3 days'),
         ('G003','Today','Three','+250788000002',1,'waiting', now());
`;

after(async () => {
  const { pool } = require('../src/db');
  await pool.end();
  await adminQuery(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
});

test('v1 database upgrades in place without data loss', async () => {
  await adminQuery(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
  await adminQuery(`CREATE DATABASE "${TEST_DB}"`);
  const c = new Client({ ...config.db, database: TEST_DB });
  await c.connect();
  await c.query(LEGACY);
  await c.end();

  const { pool } = require('../src/db');
  const { migrate } = require('../src/schema');
  await migrate(pool);
  await migrate(pool); // idempotent

  const { rows: patients } = await pool.query('SELECT ticket_number, status, ticket_date FROM patients ORDER BY id');
  assert.equal(patients.length, 3, 'existing patients preserved');
  const { rows: depts } = await pool.query('SELECT name, code FROM departments ORDER BY id');
  assert.deepEqual(depts.map((d) => d.code), ['G', 'P', 'H'], 'codes backfilled without collision (Physiotherapy gets H)');
  const { rows: users } = await pool.query('SELECT username FROM users');
  assert.deepEqual(users.map((u) => u.username), ['legacy'], 'no extra admin created when users exist');

  const { rows: [col] } = await pool.query(
    `SELECT data_type FROM information_schema.columns WHERE table_name = 'patients' AND column_name = 'registered_at'`
  );
  assert.equal(col.data_type, 'timestamp with time zone');

  // Numbering continues after legacy tickets instead of colliding with G003.
  const settings = require('../src/settings');
  await settings.load();
  const queue = require('../src/queue');
  await settings.update({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, null);
  const r = await queue.register({ first_name: 'New', last_name: 'Patient', department_id: 1 });
  assert.equal(r.patient.ticket_number, 'G004');

  // Stale legacy in-progress ticket from 3 days ago is closed, today's waiting one is not.
  await queue.expireStale();
  const { rows: after } = await pool.query(`SELECT ticket_number, status FROM patients ORDER BY id`);
  assert.deepEqual(after.map((p) => p.status), ['done', 'cancelled', 'waiting', 'waiting']);
});
