const { EventEmitter } = require('events');
const { pool, tx } = require('./db');
const { HttpError } = require('./http');
const settings = require('./settings');
const { PRIORITIES } = require('./schema');

// Emits 'changed' ({ departmentIds, reason }) and 'called' ({ patient, counter, department })
// strictly after the transaction has committed.
const events = new EventEmitter();

const ACCESSIBILITY_NEEDS = ['wheelchair', 'visual', 'hearing', 'interpreter', 'mobility'];
const ACTIVE = ['called', 'in-progress'];
const STATUS_LABEL = {
  waiting: 'waiting', called: 'called', 'in-progress': 'in service',
  done: 'served', 'no-show': 'marked absent', cancelled: 'cancelled'
};

// ─── Input validation ────────────────────────────────────────────────
const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || '250';

function normalisePhone(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  let s = String(raw).replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  else if (s.startsWith('0')) s = `+${DEFAULT_COUNTRY_CODE}${s.slice(1)}`;
  else if (!s.startsWith('+') && s.startsWith(DEFAULT_COUNTRY_CODE)) s = '+' + s;
  if (!/^\+\d{8,15}$/.test(s)) throw new HttpError(400, 'Phone number is not valid', { fields: { phone: 'invalid phone number' } });
  return s;
}

function cleanName(v, field) {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (!s) throw new HttpError(400, `${field === 'first_name' ? 'First' : 'Last'} name is required`, { fields: { [field]: 'required' } });
  if (s.length > 100) throw new HttpError(400, 'Name is too long', { fields: { [field]: 'too long' } });
  return s;
}

function cleanPriority(v) {
  const p = v || 'normal';
  if (!PRIORITIES.includes(p)) throw new HttpError(400, 'Invalid priority', { fields: { priority: 'invalid' } });
  return p;
}

function cleanNeeds(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((n) => !ACCESSIBILITY_NEEDS.includes(n))) {
    throw new HttpError(400, 'Invalid accessibility needs', { fields: { accessibility_needs: 'invalid' } });
  }
  return [...new Set(v)];
}

function cleanId(v, field = 'id') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${field}`);
  return n;
}

// ─── Ordering ────────────────────────────────────────────────────────
// Settings values are validated enums/integers, so inlining them is safe.
function rankSql(s) {
  const whens = [];
  if (s.emergency_mode === 'auto_top') whens.push(`WHEN p.priority = 'emergency' AND NOT p.needs_triage THEN 0`);
  whens.push(`WHEN p.priority IN ('priority', 'emergency') THEN 1`);
  if (s.fairness_boost_minutes > 0) {
    whens.push(`WHEN p.registered_at < now() - interval '${Number(s.fairness_boost_minutes)} minutes' THEN 1`);
  }
  return `CASE ${whens.join(' ')} ELSE 2 END`;
}

// In manual mode emergencies are never picked by "Call next" — clinicians call them explicitly.
const callableSql = (s) => (s.emergency_mode === 'manual' ? `AND p.priority <> 'emergency'` : '');

const orderSql = (s) => `${rankSql(s)}, p.registered_at, p.id`;

// CTE yielding (id, department_id, position) for every auto-callable waiting ticket.
const rankedCte = (s) => `ranked AS (
  SELECT p.id, p.department_id,
         ROW_NUMBER() OVER (PARTITION BY p.department_id ORDER BY ${orderSql(s)}) AS position
    FROM patients p
   WHERE p.status = 'waiting' ${callableSql(s)}
)`;

// ─── Wait-time estimation ────────────────────────────────────────────
// Per-department service time from the last 30 completed services (14 days), shrunk
// toward the configured default when history is thin, combined with open counters.
async function departmentCapacity(db, departmentIds = null) {
  const { rows } = await db.query(
    `WITH recent AS (
       SELECT department_id,
              EXTRACT(EPOCH FROM completed_at - COALESCE(service_started_at, called_at)) / 60 AS mins,
              ROW_NUMBER() OVER (PARTITION BY department_id ORDER BY completed_at DESC) AS rn
         FROM patients
        WHERE status = 'done' AND completed_at > now() - interval '14 days' AND called_at IS NOT NULL
     ), hist AS (
       SELECT department_id, AVG(mins) AS avg_mins, COUNT(*)::int AS samples
         FROM recent WHERE rn <= 30 AND mins BETWEEN 0.5 AND 240
        GROUP BY department_id
     )
     SELECT d.id, d.default_service_minutes, h.avg_mins, COALESCE(h.samples, 0) AS samples,
            (SELECT COUNT(*)::int FROM counters c WHERE c.department_id = d.id AND c.is_active) AS counters,
            (SELECT COUNT(*)::int FROM patients p WHERE p.department_id = d.id AND p.status IN ('called','in-progress')) AS busy
       FROM departments d LEFT JOIN hist h ON h.department_id = d.id
      WHERE $1::int[] IS NULL OR d.id = ANY($1::int[])`,
    [departmentIds]
  );
  const PRIOR_WEIGHT = 3;
  return Object.fromEntries(rows.map((r) => {
    const avg = r.samples
      ? (r.samples * Number(r.avg_mins) + PRIOR_WEIGHT * r.default_service_minutes) / (r.samples + PRIOR_WEIGHT)
      : r.default_service_minutes;
    return [r.id, {
      avgServiceMinutes: Math.round(avg * 10) / 10,
      samples: r.samples,
      basis: r.samples >= 5 ? 'history' : r.samples > 0 ? 'blended' : 'default',
      counters: r.counters,
      busy: r.busy
    }];
  }));
}

// position is 1-based among auto-callable waiting tickets.
function estimateWait(position, cap) {
  if (!cap || !position) return null;
  const counters = Math.max(1, cap.counters);
  const free = Math.max(0, counters - cap.busy);
  const ahead = position - 1;
  if (ahead < free) return 0;
  const rounds = Math.floor((ahead - free) / counters);
  return Math.round(cap.avgServiceMinutes * (rounds + (cap.busy > 0 ? 0.5 : 1)));
}

// ─── Logging ─────────────────────────────────────────────────────────
function log(db, p, { action, fromStatus, userId, note }) {
  return db.query(
    `INSERT INTO queue_logs (patient_id, department_id, ticket_number, status, from_status, action, counter_id, processed_by, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [p.id, p.department_id, p.ticket_number, p.status, fromStatus || null, action, p.counter_id || null, userId || null, note || null]
  );
}

const todaySql = `(now() AT TIME ZONE $TZ)::date`;
const withTz = (sql, idx) => sql.replaceAll('$TZ', `$${idx}`);

// ─── Registration ────────────────────────────────────────────────────
async function register(input, { userId = null, source = 'staff' } = {}) {
  const s = await settings.getAll();
  const departmentId = cleanId(input.department_id, 'department');
  const firstName = cleanName(input.first_name, 'first_name');
  const lastName = cleanName(input.last_name, 'last_name');
  const phone = normalisePhone(input.phone);
  const priority = cleanPriority(input.priority);
  const needs = cleanNeeds(input.accessibility_needs);
  const notes = typeof input.notes === 'string' && input.notes.trim() ? input.notes.trim().slice(0, 1000) : null;
  const needsTriage = priority === 'emergency' && source === 'kiosk' && s.kiosk_emergency_requires_triage;

  const result = await tx(async (c) => {
    const { rows: [dept] } = await c.query('SELECT * FROM departments WHERE id = $1 AND is_active', [departmentId]);
    if (!dept) throw new HttpError(400, 'Department not found or inactive', { fields: { department_id: 'invalid' } });

    // Serialise registrations for the same person so a double-click / double-tap
    // can never create two tickets.
    const identity = `${departmentId}|${firstName.toLowerCase()}|${lastName.toLowerCase()}|${phone || ''}`;
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [identity]);
    const { rows: [existing] } = await c.query(
      `SELECT ticket_number FROM patients
        WHERE department_id = $1 AND lower(first_name) = lower($2) AND lower(last_name) = lower($3)
          AND COALESCE(phone, '') = COALESCE($4, '') AND status IN ('waiting','called','in-progress')`,
      [departmentId, firstName, lastName, phone]
    );
    if (existing) {
      throw new HttpError(409, `This patient already has an active ticket (${existing.ticket_number}) in ${dept.name}`, {
        ticket_number: existing.ticket_number
      });
    }

    // Atomic per-department/per-day counter. The first ticket of a day continues from any
    // tickets already recorded (e.g. created by the previous version) to avoid collisions.
    const { rows: [seq] } = await c.query(
      withTz(`INSERT INTO ticket_sequences (department_id, ticket_date, last_number)
       VALUES ($1, ${todaySql}, 1 + COALESCE((
         SELECT MAX(NULLIF(regexp_replace(ticket_number, '\\D', '', 'g'), '')::int)
           FROM patients WHERE department_id = $1 AND ticket_date = ${todaySql}), 0))
       ON CONFLICT (department_id, ticket_date)
       DO UPDATE SET last_number = ticket_sequences.last_number + 1
       RETURNING last_number, ticket_date`, 2),
      [departmentId, s.timezone]
    );
    const ticketNumber = dept.code + String(seq.last_number).padStart(3, '0');

    const { rows: [patient] } = await c.query(
      `INSERT INTO patients (ticket_number, ticket_date, first_name, last_name, phone, priority, department_id,
                             status, notes, accessibility_needs, needs_triage, source, registered_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'waiting', $8, $9, $10, $11, $12) RETURNING *`,
      [ticketNumber, seq.ticket_date, firstName, lastName, phone, priority, departmentId,
        notes, needs, needsTriage, source, userId]
    );
    await log(c, patient, { action: 'register', userId, note: source === 'staff' ? null : `via ${source}` });
    return { patient, department: dept };
  });
  // Outside the transaction so the per-department sequence lock is held as briefly as possible.
  [result.position, result.eta] = await positionAndEta(pool, s, result.patient);

  events.emit('changed', { departmentIds: [departmentId], reason: 'register' });
  events.emit('registered', result);
  return result;
}

async function positionAndEta(db, s, patient) {
  const { rows: [r] } = await db.query(
    `WITH ${rankedCte(s)} SELECT position::int FROM ranked WHERE id = $1`, [patient.id]
  );
  if (!r) return [null, null]; // e.g. emergency awaiting explicit clinical call
  const caps = await departmentCapacity(db, [patient.department_id]);
  return [r.position, estimateWait(r.position, caps[patient.department_id])];
}

// ─── Calling ─────────────────────────────────────────────────────────
async function lockFreeCounter(c, counterId) {
  const { rows: [counter] } = await c.query(
    `SELECT c.*, d.name AS department_name FROM counters c JOIN departments d ON d.id = c.department_id
      WHERE c.id = $1 FOR UPDATE OF c`,
    [counterId]
  );
  if (!counter) throw new HttpError(404, 'Counter not found');
  if (!counter.is_active) throw new HttpError(409, `${counter.name} is closed`);
  const { rows: [busy] } = await c.query(
    `SELECT ticket_number, status FROM patients WHERE counter_id = $1 AND status IN ('called','in-progress')`,
    [counterId]
  );
  if (busy) {
    throw new HttpError(409, `${counter.name} is still attending ${busy.ticket_number}. Mark it served or absent first.`, {
      ticket_number: busy.ticket_number
    });
  }
  return counter;
}

async function markCalled(c, patientId, counter, userId, note) {
  const { rows: [patient] } = await c.query(
    `UPDATE patients SET status = 'called', counter_id = $2, called_by = $3, called_at = now(),
            first_called_at = COALESCE(first_called_at, now()), call_count = call_count + 1, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [patientId, counter.id, userId]
  );
  await log(c, patient, { action: 'call', fromStatus: 'waiting', userId, note });
  return patient;
}

async function callNext(counterId, user) {
  counterId = cleanId(counterId, 'counter');
  const s = await settings.getAll();
  const result = await tx(async (c) => {
    // The counter row lock serialises concurrent "Call next" presses at the same counter;
    // SKIP LOCKED lets other counters of the department pick different patients in parallel.
    const counter = await lockFreeCounter(c, counterId);
    const { rows: [next] } = await c.query(
      `SELECT p.id FROM patients p
        WHERE p.department_id = $1 AND p.status = 'waiting' ${callableSql(s)}
        ORDER BY ${orderSql(s)}
        LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [counter.department_id]
    );
    if (!next) return { patient: null, counter };
    const patient = await markCalled(c, next.id, counter, user.id);
    return { patient, counter };
  });
  if (result.patient) afterCall(result);
  return result;
}

// Explicitly call a specific ticket (clinical override, emergencies in manual mode, etc.).
async function callSpecific(patientId, counterId, user) {
  patientId = cleanId(patientId);
  counterId = cleanId(counterId, 'counter');
  const result = await tx(async (c) => {
    const counter = await lockFreeCounter(c, counterId);
    const { rows: [p] } = await c.query('SELECT * FROM patients WHERE id = $1 FOR UPDATE', [patientId]);
    if (!p) throw new HttpError(404, 'Ticket not found');
    if (p.status !== 'waiting') throw new HttpError(409, `Ticket ${p.ticket_number} is already ${STATUS_LABEL[p.status]}`);
    if (p.department_id !== counter.department_id) {
      throw new HttpError(409, `Ticket ${p.ticket_number} belongs to another department than ${counter.name}`);
    }
    const patient = await markCalled(c, p.id, counter, user.id, 'called out of order');
    return { patient, counter };
  });
  afterCall(result);
  return result;
}

function afterCall({ patient, counter }) {
  events.emit('changed', { departmentIds: [patient.department_id], reason: 'call' });
  events.emit('called', { patient, counter });
}

// ─── State transitions ───────────────────────────────────────────────
const ACTIONS = {
  start: { from: ['called'], to: 'in-progress', set: 'service_started_at = now()' },
  complete: {
    from: ['called', 'in-progress'], to: 'done',
    set: 'completed_at = now(), service_started_at = COALESCE(service_started_at, called_at)'
  },
  absent: { from: ['called'], to: 'no-show', set: 'completed_at = now()' },
  // Patient stepped away: back to waiting, keeping their original place in line.
  requeue: { from: ['called'], to: 'waiting', set: 'counter_id = NULL' },
  recall: { from: ['called'], to: 'called', set: 'call_count = call_count + 1, called_at = now()' },
  cancel: { from: ['waiting', 'called'], to: 'cancelled', set: 'cancelled_at = now(), cancel_reason = $2' }
};
const ACTION_PERMISSION = {
  start: 'queue:serve', complete: 'queue:serve', absent: 'queue:serve',
  requeue: 'queue:serve', recall: 'queue:serve', cancel: 'queue:cancel'
};

async function transition(patientId, action, user, { reason } = {}) {
  patientId = cleanId(patientId);
  const def = ACTIONS[action];
  if (!def) throw new HttpError(400, 'Unknown action');
  const s = await settings.getAll();
  const result = await tx(async (c) => {
    // Row lock: two staff pressing different buttons on the same ticket are serialised,
    // and the second sees the first one's result.
    const { rows: [cur] } = await c.query('SELECT * FROM patients WHERE id = $1 FOR UPDATE', [patientId]);
    if (!cur) throw new HttpError(404, 'Ticket not found');
    if (!def.from.includes(cur.status)) {
      throw new HttpError(409, `Ticket ${cur.ticket_number} is ${STATUS_LABEL[cur.status]} — cannot ${action} it`, { status: cur.status });
    }
    if (action === 'recall' && cur.call_count >= s.max_recalls) {
      throw new HttpError(409, `Ticket ${cur.ticket_number} has been called ${cur.call_count} times — mark absent or return to queue`);
    }
    const params = [patientId];
    if (action === 'cancel') params.push(typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 300) : null);
    const { rows: [patient] } = await c.query(
      `UPDATE patients SET status = '${def.to}', ${def.set ? def.set + ',' : ''} updated_at = now()
        WHERE id = $1 RETURNING *`,
      params
    );
    await log(c, { ...patient, counter_id: patient.counter_id || cur.counter_id }, {
      action, fromStatus: cur.status, userId: user.id, note: action === 'cancel' ? params[1] : null
    });
    let counter = null;
    if (action === 'recall') {
      ({ rows: [counter] } = await c.query('SELECT * FROM counters WHERE id = $1', [patient.counter_id]));
    }
    return { patient, counter };
  });
  events.emit('changed', { departmentIds: [result.patient.department_id], reason: action });
  if (action === 'recall') events.emit('called', { ...result, recall: true });
  return result;
}

async function setPriority(patientId, input, user) {
  patientId = cleanId(patientId);
  const priority = cleanPriority(input.priority);
  const needs = input.accessibility_needs === undefined ? undefined : cleanNeeds(input.accessibility_needs);
  const result = await tx(async (c) => {
    const { rows: [cur] } = await c.query('SELECT * FROM patients WHERE id = $1 FOR UPDATE', [patientId]);
    if (!cur) throw new HttpError(404, 'Ticket not found');
    if (!['waiting', 'called'].includes(cur.status)) {
      throw new HttpError(409, `Ticket ${cur.ticket_number} is ${STATUS_LABEL[cur.status]} — priority can no longer change`);
    }
    const { rows: [patient] } = await c.query(
      `UPDATE patients SET priority = $2, needs_triage = FALSE,
              accessibility_needs = COALESCE($3, accessibility_needs), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [patientId, priority, needs || null]
    );
    const note = cur.needs_triage
      ? `triaged: self-declared emergency → ${priority}`
      : `priority ${cur.priority} → ${priority}`;
    await log(c, patient, { action: 'triage', fromStatus: cur.status, userId: user.id, note });
    return { patient };
  });
  events.emit('changed', { departmentIds: [result.patient.department_id], reason: 'triage' });
  return result;
}

// Send a served patient on to another department (e.g. consultation → pharmacy).
async function refer(patientId, departmentId, user) {
  patientId = cleanId(patientId);
  const { rows: [p] } = await pool.query('SELECT * FROM patients WHERE id = $1', [patientId]);
  if (!p) throw new HttpError(404, 'Ticket not found');
  if (p.status !== 'done') throw new HttpError(409, 'Only served patients can be referred to another department');
  return register({
    department_id: departmentId, first_name: p.first_name, last_name: p.last_name, phone: p.phone,
    priority: p.priority === 'emergency' ? 'priority' : p.priority, accessibility_needs: p.accessibility_needs,
    notes: `Referred from ticket ${p.ticket_number}`
  }, { userId: user.id, source: 'referral' });
}

// Tickets are daily. Anything left open from a previous day is closed so it never
// inflates today's queue or statistics.
async function expireStale() {
  const s = await settings.getAll();
  const { rows } = await pool.query(
    `WITH expired AS (
       UPDATE patients SET status = 'cancelled', cancelled_at = now(), updated_at = now(),
              cancel_reason = 'Expired: still open at end of day'
        WHERE status IN ('waiting','called','in-progress') AND ticket_date < (now() AT TIME ZONE $1)::date
        RETURNING id, department_id, ticket_number, status, counter_id
     )
     INSERT INTO queue_logs (patient_id, department_id, ticket_number, status, action, counter_id, note)
     SELECT id, department_id, ticket_number, status, 'expire', counter_id, 'automatic end-of-day closure' FROM expired
     RETURNING department_id`,
    [s.timezone]
  );
  if (rows.length) {
    events.emit('changed', { departmentIds: [...new Set(rows.map((r) => r.department_id))], reason: 'expire' });
  }
  return rows.length;
}

// ─── Reading ─────────────────────────────────────────────────────────
function maskPhone(phone) {
  if (!phone) return null;
  return phone.slice(0, 4) + phone.slice(4, -3).replace(/\d/g, '•') + phone.slice(-3);
}

// Strip fields the viewer's role should not see.
function shapeForRole(p, can) {
  const out = { ...p };
  if (!can('patient:contact')) out.phone = maskPhone(p.phone);
  if (!can('patient:clinical')) delete out.notes;
  delete out.email;
  return out;
}

async function listTickets(filters, can) {
  const s = await settings.getAll();
  const where = [];
  const params = [s.timezone];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };

  if (filters.status === 'active') where.push(`p.status IN ('waiting','called','in-progress')`);
  else if (filters.status) add('p.status = ?', String(filters.status));
  if (filters.department_id) add('p.department_id = ?', cleanId(filters.department_id, 'department'));
  if (filters.date && /^\d{4}-\d{2}-\d{2}$/.test(filters.date)) add('p.ticket_date = ?::date', filters.date);
  else if (!filters.all_dates) where.push(`p.ticket_date = (now() AT TIME ZONE $1)::date`);
  if (filters.q) {
    params.push(`%${String(filters.q).trim().slice(0, 50)}%`);
    where.push(`(p.ticket_number ILIKE $${params.length} OR (p.first_name || ' ' || p.last_name) ILIKE $${params.length})`);
  }

  const { rows } = await pool.query(
    `WITH ${rankedCte(s)}
     SELECT p.*, d.name AS department_name, d.icon AS department_icon, c.name AS counter_name,
            r.position::int AS position, (now() AT TIME ZONE $1)::date AS today,
            ROUND(EXTRACT(EPOCH FROM COALESCE(p.first_called_at, p.cancelled_at, now()) - p.registered_at) / 60)::int AS wait_minutes
       FROM patients p
       JOIN departments d ON d.id = p.department_id
       LEFT JOIN counters c ON c.id = p.counter_id
       LEFT JOIN ranked r ON r.id = p.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE p.status WHEN 'called' THEN 0 WHEN 'in-progress' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END,
               r.position NULLS LAST,
               CASE WHEN p.status = 'waiting' THEN p.registered_at END,
               p.registered_at DESC
      LIMIT 500`,
    params
  );
  const caps = await departmentCapacity(pool);
  return rows.map((p) => shapeForRole({
    ...p,
    eta_minutes: p.status === 'waiting' && p.position ? estimateWait(p.position, caps[p.department_id]) : null,
    awaiting_clinical_call: p.status === 'waiting' && !p.position
  }, can));
}

async function getTicket(id, can) {
  const { rows: [p] } = await pool.query(
    `SELECT p.*, d.name AS department_name, c.name AS counter_name FROM patients p
       JOIN departments d ON d.id = p.department_id LEFT JOIN counters c ON c.id = p.counter_id
      WHERE p.id = $1`, [cleanId(id)]
  );
  if (!p) throw new HttpError(404, 'Ticket not found');
  const { rows: history } = await pool.query(
    `SELECT l.action, l.from_status, l.status, l.timestamp, l.note, u.full_name AS by_name, c.name AS counter_name
       FROM queue_logs l LEFT JOIN users u ON u.id = l.processed_by LEFT JOIN counters c ON c.id = l.counter_id
      WHERE l.patient_id = $1 ORDER BY l.timestamp, l.id`, [p.id]
  );
  return { ...shapeForRole(p, can), history };
}

// Public waiting-room board: ticket numbers, counters and departments only — no names,
// phone numbers, priorities or clinical details.
async function publicBoard() {
  const s = await settings.getAll();
  const { rows: serving } = await pool.query(
    `SELECT p.ticket_number, p.status, p.called_at, c.name AS counter_name, d.id AS department_id, d.name AS department_name
       FROM patients p JOIN counters c ON c.id = p.counter_id JOIN departments d ON d.id = p.department_id
      WHERE p.status IN ('called','in-progress')
      ORDER BY p.called_at DESC`
  );
  const { rows: upcoming } = await pool.query(
    `WITH ${rankedCte(s)}
     SELECT r.department_id, p.ticket_number FROM ranked r JOIN patients p ON p.id = r.id
      WHERE r.position <= $1 ORDER BY r.department_id, r.position`,
    [s.display_upcoming_count]
  );
  const { rows: departments } = await pool.query(
    `SELECT d.id, d.name, d.icon, d.code,
            (SELECT COUNT(*)::int FROM patients p WHERE p.department_id = d.id AND p.status = 'waiting') AS waiting
       FROM departments d WHERE d.is_active ORDER BY d.sort_order, d.name`
  );
  return {
    facility_name: s.facility_name,
    audio: s.display_audio,
    departments: departments.map((d) => ({
      ...d,
      serving: serving.filter((x) => x.department_id === d.id)
        .map(({ ticket_number, counter_name, status, called_at }) => ({ ticket_number, counter_name, status, called_at })),
      upcoming: upcoming.filter((u) => u.department_id === d.id).map((u) => u.ticket_number)
    })),
    generated_at: new Date().toISOString()
  };
}

module.exports = {
  events, register, callNext, callSpecific, transition, setPriority, refer, expireStale,
  listTickets, getTicket, publicBoard, shapeForRole, maskPhone, departmentCapacity, estimateWait, rankedCte, rankSql,
  normalisePhone, cleanId, ACTIONS, ACTION_PERMISSION, ACCESSIBILITY_NEEDS, STATUS_LABEL
};
