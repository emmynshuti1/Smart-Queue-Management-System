const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let t; // harness
let nurse;
let depts;
let counters;

const reg = (body, token = t.adminToken) => t.request('POST', '/api/tickets', { token, body });
const act = (id, action, token = nurse, body = {}) => t.request('POST', `/api/tickets/${id}/${action}`, { token, body });
const callNext = (counterId, token = nurse) => t.request('POST', `/api/counters/${counterId}/call-next`, { token });

async function addCounter(departmentId, name) {
  const r = await t.request('POST', '/api/counters', { token: t.adminToken, body: { department_id: departmentId, name } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

async function freshDepartment(code) {
  const r = await t.request('POST', '/api/departments', {
    token: t.adminToken, body: { name: `Test ${code}`, code, default_service_minutes: 10 }
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const { data: all } = await t.request('GET', '/api/counters', { token: t.adminToken });
  return { dept: r.data, counter: all.find((c) => c.department_id === r.data.id) };
}

before(async () => {
  t = await startServer();
  nurse = await t.createUser('nurse1', 'nurse');
  depts = (await t.request('GET', '/api/departments', { token: t.adminToken })).data;
  counters = (await t.request('GET', '/api/counters', { token: t.adminToken })).data;
});

after(async () => { await t.stop(); });

test('concurrent registrations produce unique, gap-free ticket numbers per department', async () => {
  const [a, b] = depts;
  const jobs = [];
  for (let i = 0; i < 25; i++) {
    jobs.push(reg({ first_name: 'P', last_name: `A${i}`, department_id: a.id }));
    jobs.push(reg({ first_name: 'P', last_name: `B${i}`, department_id: b.id }));
  }
  const results = await Promise.all(jobs);
  assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.find((r) => r.status !== 201)?.data));
  for (const d of [a, b]) {
    const numbers = results.map((r) => r.data.patient).filter((p) => p.department_id === d.id).map((p) => p.ticket_number).sort();
    const expected = Array.from({ length: 25 }, (_, i) => d.code + String(i + 1).padStart(3, '0'));
    assert.deepEqual(numbers, expected);
  }
  await t.pool.query(`UPDATE patients SET status = 'cancelled' WHERE status = 'waiting'`);
});

test('double submission of the same patient creates exactly one ticket', async () => {
  const body = { first_name: 'Alice', last_name: 'Mukamana', phone: '0788000001', department_id: depts[2].id };
  const results = await Promise.all([reg(body), reg(body), reg(body)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409]);
  assert.match(results.find((r) => r.status === 409).data.error, /already has an active ticket/);
});

test('validation rejects bad input', async () => {
  assert.equal((await reg({ first_name: '', last_name: 'X', department_id: depts[0].id })).status, 400);
  assert.equal((await reg({ first_name: 'A', last_name: 'X', department_id: 99999 })).status, 400);
  assert.equal((await reg({ first_name: 'A', last_name: 'X', department_id: depts[0].id, phone: 'abc' })).status, 400);
  assert.equal((await reg({ first_name: 'A', last_name: 'X', department_id: depts[0].id, priority: 'vip' })).status, 400);
  const ok = await reg({ first_name: 'A', last_name: 'Phone', department_id: depts[0].id, phone: '0788 123 456' });
  assert.equal(ok.data.patient.phone, '+250788123456');
});

test('parallel "call next" from several counters never assigns the same patient twice', async () => {
  const { dept, counter } = await freshDepartment('CN');
  const c2 = await addCounter(dept.id, 'Counter 2');
  const c3 = await addCounter(dept.id, 'Counter 3');
  for (let i = 0; i < 6; i++) await reg({ first_name: 'Q', last_name: `N${i}`, department_id: dept.id });

  const seen = new Set();
  for (let round = 0; round < 2; round++) {
    const calls = await Promise.all([counter.id, c2.id, c3.id].map((id) => callNext(id)));
    for (const r of calls) {
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.ok(r.data.patient, 'expected a patient');
      assert.ok(!seen.has(r.data.patient.id), `patient ${r.data.patient.ticket_number} assigned twice`);
      seen.add(r.data.patient.id);
      await act(r.data.patient.id, 'complete');
    }
  }
  assert.equal(seen.size, 6);
  const empty = await callNext(counter.id);
  assert.equal(empty.data.patient, null);
});

test('a counter cannot be handed a second patient while one is active', async () => {
  const { dept, counter } = await freshDepartment('ONE');
  for (let i = 0; i < 3; i++) await reg({ first_name: 'R', last_name: `S${i}`, department_id: dept.id });
  const results = await Promise.all([callNext(counter.id), callNext(counter.id), callNext(counter.id)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
  const { rows } = await t.pool.query(
    `SELECT COUNT(*)::int AS n FROM patients WHERE counter_id = $1 AND status IN ('called','in-progress')`, [counter.id]
  );
  assert.equal(rows[0].n, 1);
});

test('state machine rejects invalid transitions and serialises conflicting actions', async () => {
  const { dept, counter } = await freshDepartment('SM');
  const { data: { patient } } = await reg({ first_name: 'T', last_name: 'One', department_id: dept.id });

  assert.equal((await act(patient.id, 'complete')).status, 409, 'cannot complete a waiting ticket');
  assert.equal((await act(patient.id, 'absent')).status, 409, 'cannot mark a waiting ticket absent');

  await callNext(counter.id);
  // Two staff press "Served" and "Absent" at the same moment — exactly one wins.
  const [x, y] = await Promise.all([act(patient.id, 'complete'), act(patient.id, 'absent')]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  assert.equal((await act(patient.id, 'cancel')).status, 409, 'finished tickets are terminal');
  assert.equal((await act(patient.id, 'start')).status, 409);

  const { rows } = await t.pool.query('SELECT action FROM queue_logs WHERE patient_id = $1 ORDER BY id', [patient.id]);
  assert.deepEqual(rows.map((r) => r.action).slice(0, 2), ['register', 'call']);
  assert.equal(rows.length, 3, 'register + call + one terminal action logged');
});

test('recall is limited by max_recalls and requeue keeps the original place', async () => {
  const { dept, counter } = await freshDepartment('RC');
  const first = (await reg({ first_name: 'U', last_name: 'First', department_id: dept.id })).data.patient;
  await reg({ first_name: 'U', last_name: 'Second', department_id: dept.id });
  const called = (await callNext(counter.id)).data.patient;
  assert.equal(called.id, first.id);

  await t.request('PUT', '/api/settings', { token: t.adminToken, body: { max_recalls: 2 } });
  assert.equal((await act(first.id, 'recall')).status, 200);
  assert.equal((await act(first.id, 'recall')).status, 409, 'third call exceeds max_recalls=2');

  assert.equal((await act(first.id, 'requeue')).status, 200);
  const again = (await callNext(counter.id)).data.patient;
  assert.equal(again.id, first.id, 'requeued patient keeps their place at the front');
  await t.request('PUT', '/api/settings', { token: t.adminToken, body: { max_recalls: 3 } });
});

test('priority rules: verified emergency → priority/unverified → normal; manual mode never auto-calls emergencies', async () => {
  const { dept, counter } = await freshDepartment('PR');
  const normal = (await reg({ first_name: 'V', last_name: 'Normal', department_id: dept.id })).data.patient;
  const prio = (await reg({ first_name: 'V', last_name: 'Elderly', department_id: dept.id, priority: 'priority' })).data.patient;
  const kiosk = await t.request('POST', '/api/public/tickets', {
    body: { full_name: 'V Kiosk', department_id: dept.id, priority: 'emergency' }
  });
  assert.equal(kiosk.status, 201);
  assert.equal(kiosk.data.needs_triage, true, 'self-declared emergency must be triaged');
  const emer = (await reg({ first_name: 'V', last_name: 'Emergency', department_id: dept.id, priority: 'emergency' })).data.patient;

  const order = [];
  for (let i = 0; i < 4; i++) {
    const p = (await callNext(counter.id)).data.patient;
    order.push(p.last_name);
    await act(p.id, 'complete');
  }
  assert.deepEqual(order, ['Emergency', 'Elderly', 'Kiosk', 'Normal']);
  assert.ok(normal && prio && emer);

  await t.request('PUT', '/api/settings', { token: t.adminToken, body: { emergency_mode: 'manual' } });
  const e2 = (await reg({ first_name: 'W', last_name: 'Emergency', department_id: dept.id, priority: 'emergency' })).data.patient;
  const n2 = (await reg({ first_name: 'W', last_name: 'Normal', department_id: dept.id })).data.patient;
  const next = (await callNext(counter.id)).data.patient;
  assert.equal(next.id, n2.id, 'manual mode: routine call skips the emergency');
  await act(n2.id, 'complete');
  assert.equal((await callNext(counter.id)).data.patient, null, 'emergency is not auto-called');
  const explicit = await t.request('POST', `/api/tickets/${e2.id}/call`, { token: nurse, body: { counter_id: counter.id } });
  assert.equal(explicit.status, 200, 'clinician can call the emergency explicitly');
  await act(e2.id, 'complete');
  await t.request('PUT', '/api/settings', { token: t.adminToken, body: { emergency_mode: 'auto_top' } });
});

test('triage confirms or downgrades a self-declared emergency and is audited', async () => {
  const { dept } = await freshDepartment('TR');
  const k = await t.request('POST', '/api/public/tickets', { body: { full_name: 'X Kiosk', department_id: dept.id, priority: 'emergency' } });
  const { rows: [p] } = await t.pool.query('SELECT id FROM patients WHERE ticket_number = $1 AND department_id = $2', [k.data.ticket_number, dept.id]);
  const r = await t.request('PATCH', `/api/tickets/${p.id}/priority`, { token: nurse, body: { priority: 'normal' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.patient.needs_triage, false);
  assert.equal(r.data.patient.priority, 'normal');
  const { rows } = await t.pool.query(`SELECT note FROM queue_logs WHERE patient_id = $1 AND action = 'triage'`, [p.id]);
  assert.match(rows[0].note, /self-declared emergency → normal/);
});

test('tickets left open from a previous day are expired, not counted as waiting', async () => {
  const { dept } = await freshDepartment('EX');
  const p = (await reg({ first_name: 'Y', last_name: 'Old', department_id: dept.id })).data.patient;
  await t.pool.query(`UPDATE patients SET ticket_date = ticket_date - 1 WHERE id = $1`, [p.id]);
  const n = await require('../src/queue').expireStale();
  assert.ok(n >= 1);
  const { rows: [row] } = await t.pool.query('SELECT status, cancel_reason FROM patients WHERE id = $1', [p.id]);
  assert.equal(row.status, 'cancelled');
  assert.match(row.cancel_reason, /Expired/);
});

test('wait estimate uses queue position, counters and service history', async () => {
  const { estimateWait } = require('../src/queue');
  const cap = { avgServiceMinutes: 10, counters: 2, busy: 2 };
  assert.equal(estimateWait(1, cap), 5);   // both counters busy: about half a service
  assert.equal(estimateWait(3, cap), 15);
  assert.equal(estimateWait(1, { ...cap, busy: 0 }), 0);
  assert.equal(estimateWait(3, { ...cap, busy: 0 }), 10);
  assert.equal(estimateWait(2, { avgServiceMinutes: 10, counters: 1, busy: 0 }), 10);
});
