const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let t;
let tokens;
let patient;
let counterId;

before(async () => {
  t = await startServer();
  tokens = {
    receptionist: await t.createUser('rec1', 'receptionist'),
    nurse: await t.createUser('nurse1', 'nurse'),
    doctor: await t.createUser('doc1', 'doctor')
  };
  const r = await t.request('POST', '/api/tickets', {
    token: tokens.receptionist,
    body: { first_name: 'Claudine', last_name: 'Ingabire', phone: '0788555444', department_id: 1, notes: 'Suspected malaria' }
  });
  assert.equal(r.status, 201);
  patient = r.data.patient;
  counterId = (await t.request('GET', '/api/counters', { token: t.adminToken })).data.find((c) => c.department_id === 1).id;
});

after(async () => { await t.stop(); });

const SECRETS = ['Claudine', 'Ingabire', '555444', '788555', 'malaria'];
const assertNoPII = (data, where) => {
  const json = JSON.stringify(data);
  for (const s of SECRETS) assert.ok(!json.includes(s), `${where} leaked "${s}"`);
};

test('public kiosk and display endpoints expose no personal or clinical data', async () => {
  await t.request('POST', `/api/counters/${counterId}/call-next`, { token: tokens.nurse });
  const board = await t.request('GET', '/api/public/board');
  assert.equal(board.status, 200);
  assertNoPII(board.data, 'public board');
  assert.ok(JSON.stringify(board.data).includes(patient.ticket_number), 'board shows the ticket number');
  assert.ok(!JSON.stringify(board.data).includes('priority'), 'board does not reveal priority');

  const info = await t.request('GET', '/api/public/info');
  assertNoPII(info.data, 'public info');

  const kiosk = await t.request('POST', '/api/public/tickets', {
    body: { full_name: 'Kiosk Person', phone: '0722000111', department_id: 2 }
  });
  assert.equal(kiosk.status, 201);
  assert.deepEqual(Object.keys(kiosk.data).sort(),
    ['department', 'emergency', 'eta_minutes', 'needs_triage', 'position', 'registered_at', 'sms', 'ticket_number']);
});

test('staff endpoints require authentication', async () => {
  for (const [m, p] of [['GET', '/api/tickets'], ['GET', '/api/dashboard'], ['GET', `/api/tickets/${patient.id}`],
    ['GET', '/api/analytics'], ['GET', '/api/notifications/log'], ['POST', '/api/counters/1/call-next'], ['GET', '/api/users']]) {
    const r = await t.request(m, p);
    assert.equal(r.status, 401, `${m} ${p}`);
  }
  const forged = await t.request('GET', '/api/tickets', { token: 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MSwicm9sZSI6ImFkbWluIn0.x' });
  assert.equal(forged.status, 401);
});

test('open self-registration of staff accounts is gone', async () => {
  const r = await t.request('POST', '/api/auth/register', {
    body: { username: 'evil', email: 'e@x', password: 'password-123', full_name: 'E', role: 'admin' }
  });
  assert.notEqual(r.status, 200);
  assert.notEqual(r.status, 201);
  const { rows } = await t.pool.query(`SELECT 1 FROM users WHERE username = 'evil'`);
  assert.equal(rows.length, 0);
});

test('role permissions are enforced', async () => {
  const callNext = await t.request('POST', `/api/counters/${counterId}/call-next`, { token: tokens.receptionist });
  assert.equal(callNext.status, 403, 'receptionists cannot call patients');
  const settings = await t.request('PUT', '/api/settings', { token: tokens.nurse, body: { max_recalls: 5 } });
  assert.equal(settings.status, 403, 'only admins change settings');
  const users = await t.request('GET', '/api/users', { token: tokens.doctor });
  assert.equal(users.status, 403);
  const triage = await t.request('PATCH', `/api/tickets/${patient.id}/priority`, { token: tokens.receptionist, body: { priority: 'emergency' } });
  assert.equal(triage.status, 403, 'receptionists cannot change clinical priority');
});

test('patient data is minimised per role', async () => {
  const get = async (role) => (await t.request('GET', `/api/tickets/${patient.id}`, { token: tokens[role] || t.adminToken })).data;
  const rec = await get('receptionist');
  assert.equal(rec.phone, '+250788555444', 'reception sees contact details');
  assert.equal(rec.notes, undefined, 'reception does not see clinical notes');

  const nurse = await get('nurse');
  assert.equal(nurse.notes, 'Suspected malaria', 'clinicians see notes');
  assert.ok(!nurse.phone.includes('555'), `clinicians see a masked phone, got ${nurse.phone}`);
  assert.ok(nurse.phone.endsWith('444'));

  const list = (await t.request('GET', '/api/tickets', { token: tokens.doctor })).data;
  assert.ok(list.every((p) => !p.phone || p.phone.includes('•')));
});

test('server source and secrets are not served as static files', async () => {
  for (const p of ['/server.js', '/.env', '/package.json', '/src/config.js', '/../.env']) {
    const r = await t.request('GET', p);
    assert.notEqual(r.status, 200, p);
  }
  const page = await t.request('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await t.request('GET', '/api/tickets', { token: tokens.nurse })).headers.get('cache-control'), 'no-store');
});

test('deactivated accounts lose access immediately', async () => {
  const token = await t.createUser('temp1', 'nurse');
  const { rows: [u] } = await t.pool.query(`SELECT id FROM users WHERE username = 'temp1'`);
  assert.equal((await t.request('GET', '/api/tickets', { token })).status, 200);
  await t.request('PATCH', `/api/users/${u.id}`, { token: t.adminToken, body: { is_active: false } });
  assert.equal((await t.request('GET', '/api/tickets', { token })).status, 401);
});

test('SMS without a configured provider is recorded honestly as not delivered', async () => {
  const status = await t.request('GET', '/api/notifications/status', { token: tokens.nurse });
  assert.equal(status.data.configured, false);
  const r = await t.request('POST', '/api/notifications/sms', {
    token: tokens.receptionist, body: { patient_id: patient.id, message: 'Please come to reception' }
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'not_configured');
  const { rows } = await t.pool.query(`SELECT status FROM sms_logs WHERE kind = 'manual'`);
  assert.deepEqual(rows.map((x) => x.status), ['not_configured']);
  const { rows: sent } = await t.pool.query(`SELECT COUNT(*)::int AS n FROM sms_logs WHERE status = 'sent'`);
  assert.equal(sent[0].n, 0, 'nothing is ever marked sent without a provider');
});
