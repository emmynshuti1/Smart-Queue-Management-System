const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let t;
let nurse;

before(async () => {
  t = await startServer();
  nurse = await t.createUser('nurse1', 'nurse');
});
after(async () => { await t.stop(); });

const reg = (body) => t.request('POST', '/api/tickets', { token: t.adminToken, body });
const act = (id, a) => t.request('POST', `/api/tickets/${id}/${a}`, { token: nurse });

test('dashboard and analytics match the underlying records exactly', async () => {
  const counters = (await t.request('GET', '/api/counters', { token: t.adminToken })).data;
  const counterFor = (deptId) => counters.find((c) => c.department_id === deptId).id;

  // Build a known day: dept 1 → 2 served, 1 absent, 1 waiting; dept 2 → 1 cancelled, 1 emergency waiting.
  const p = [];
  for (const [i, body] of [
    { first_name: 'A', last_name: '1', department_id: 1 },
    { first_name: 'A', last_name: '2', department_id: 1 },
    { first_name: 'A', last_name: '3', department_id: 1 },
    { first_name: 'A', last_name: '4', department_id: 1 },
    { first_name: 'B', last_name: '1', department_id: 2 },
    { first_name: 'B', last_name: '2', department_id: 2, priority: 'emergency' }
  ].entries()) {
    const r = await reg(body);
    assert.equal(r.status, 201, `reg ${i}`);
    p.push(r.data.patient);
  }
  // Give arrivals known registration times so wait figures are deterministic.
  const minsAgo = [60, 50, 40, 5, 30, 2];
  for (const [i, m] of minsAgo.entries()) {
    await t.pool.query(`UPDATE patients SET registered_at = now() - make_interval(mins => $2) WHERE id = $1`, [p[i].id, m]);
  }

  const c1 = counterFor(1);
  for (const expected of [p[0], p[1], p[2]]) {
    const r = await t.request('POST', `/api/counters/${c1}/call-next`, { token: nurse });
    assert.equal(r.data.patient.id, expected.id);
    await act(expected.id, expected === p[2] ? 'absent' : 'complete');
  }
  await t.request('POST', `/api/tickets/${p[4].id}/cancel`, { token: t.adminToken, body: { reason: 'left' } });

  const dash = (await t.request('GET', '/api/dashboard', { token: nurse })).data;
  assert.equal(dash.totals.waiting, 2);
  assert.equal(dash.totals.served_today, 2);
  assert.equal(dash.totals.no_show_today, 1);
  assert.equal(dash.totals.cancelled_today, 1);
  assert.equal(dash.totals.registered_today, 6);
  assert.equal(dash.totals.emergencies_today, 1);
  assert.equal(dash.totals.emergencies_waiting, 1);
  assert.equal(dash.totals.serving, 0);

  // Compare with an independent SQL calculation of average wait for patients first called today.
  const { rows: [{ avg }] } = await t.pool.query(
    `SELECT ROUND(AVG(EXTRACT(EPOCH FROM first_called_at - registered_at) / 60)::numeric, 1)::float AS avg
       FROM patients WHERE first_called_at IS NOT NULL`
  );
  assert.equal(dash.totals.avg_wait_today, avg);
  assert.ok(avg > 45 && avg < 55, `avg wait ${avg} should be ≈50 min`);

  const d1 = dash.departments.find((d) => d.id === 1);
  assert.equal(d1.waiting, 1);
  assert.equal(d1.served_today, 2);
  assert.ok(dash.alerts.some((a) => a.kind === 'emergency' && a.id === p[5].id));

  const an = (await t.request('GET', '/api/analytics', { token: nurse })).data;
  assert.equal(an.summary.total, 6);
  assert.equal(an.summary.served, 2);
  assert.equal(an.summary.no_show, 1);
  assert.equal(an.summary.cancelled, 1);
  assert.equal(an.summary.no_show_rate, 16.7);
  assert.equal(an.summary.avg_wait, avg);
  assert.equal(an.by_hour.reduce((s, h) => s + h.arrivals, 0), 6);
  const ad1 = an.by_department.find((d) => d.department_id === 1);
  assert.equal(ad1.total, 4);
  assert.equal(ad1.served, 2);

  const csv = await t.request('GET', '/api/analytics/export.csv', { token: nurse });
  assert.equal(csv.status, 200);
  const lines = csv.data.trim().split('\n');
  assert.equal(lines.length, 7, 'header + 6 rows');
  assert.ok(!/\bA\b,1\b/.test(csv.data) && !csv.data.includes('first_name'), 'export is de-identified');
});

test('analytics rejects malformed ranges', async () => {
  const bad = await t.request('GET', '/api/analytics?from=2026-10-10&to=2026-10-01', { token: nurse });
  assert.equal(bad.status, 400);
  const junk = await t.request('GET', '/api/analytics?from=yesterday', { token: nurse });
  assert.equal(junk.status, 400);
});
