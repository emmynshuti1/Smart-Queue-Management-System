// Test harness: a dedicated, freshly created database and a real server on a random port.
// Must be required before anything from src/ so the environment below is used.
const crypto = require('crypto');

const TEST_DB = process.env.TEST_DB_NAME || `sqhs_test_${process.pid}`;
process.env.DB_NAME = TEST_DB;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.ADMIN_INITIAL_PASSWORD = 'admin-test-pass';
process.env.TWILIO_ACCOUNT_SID = '';
process.env.TWILIO_AUTH_TOKEN = '';
process.env.TWILIO_PHONE_NUMBER = '';
delete process.env.DATABASE_URL;
delete process.env.FRONTEND_URL;

const { Client } = require('pg');
const config = require('../src/config');

async function adminQuery(sql) {
  const c = new Client({ ...config.db, database: 'postgres' });
  await c.connect();
  try { return await c.query(sql); } finally { await c.end(); }
}

async function createDatabase() {
  await adminQuery(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
  await adminQuery(`CREATE DATABASE "${TEST_DB}"`);
}

async function dropDatabase() {
  await adminQuery(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
}

async function startServer() {
  await createDatabase();
  const { start } = require('../src/app');
  const { pool } = require('../src/db');
  const instance = await start({ port: 0 });
  const base = `http://127.0.0.1:${instance.server.address().port}`;

  async function request(method, path, { body, token } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(token && { Authorization: `Bearer ${token}` })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch (_) { /* not JSON */ }
    return { status: res.status, data, headers: res.headers };
  }

  async function login(username, password) {
    const r = await request('POST', '/api/auth/login', { body: { username, password } });
    if (r.status !== 200) throw new Error(`login failed for ${username}: ${JSON.stringify(r.data)}`);
    return r.data.token;
  }

  const adminToken = await login('admin', 'admin-test-pass');

  async function createUser(username, role) {
    const r = await request('POST', '/api/users', {
      token: adminToken,
      body: { username, role, full_name: `${role} ${username}`, password: 'password-123' }
    });
    if (r.status !== 201) throw new Error(JSON.stringify(r.data));
    return login(username, 'password-123');
  }

  async function stop() {
    await instance.stop();
    await pool.end();
    await dropDatabase();
  }

  return { base, request, login, adminToken, createUser, pool, stop, settings: require('../src/settings') };
}

module.exports = { startServer, adminQuery, TEST_DB };
