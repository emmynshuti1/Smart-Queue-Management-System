const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('./db');
const { HttpError, wrap, rateLimit } = require('./http');
const auth = require('./auth');
const queue = require('./queue');
const stats = require('./stats');
const notify = require('./notify');
const settings = require('./settings');

const { authenticate, requirePermission: allow } = auth;
const canFor = (req) => (p) => auth.can(req.user, p);

const PUBLIC_SETTINGS = ['facility_name', 'facility_location', 'facility_phone', 'kiosk_enabled',
  'kiosk_require_phone', 'display_audio'];

function buildRouter() {
  const api = express.Router();

  // ═══════════════ PUBLIC (kiosk + display board) ═══════════════
  // These endpoints never return names, phone numbers, priorities or notes.
  api.get('/public/info', wrap(async (_req, res) => {
    const s = await settings.getAll();
    const caps = await queue.departmentCapacity(pool);
    const { rows } = await pool.query(
      `WITH ${queue.rankedCte(s)}
       SELECT d.id, d.name, d.code, d.icon, d.description,
              (SELECT COUNT(*)::int FROM ranked r WHERE r.department_id = d.id) AS waiting
         FROM departments d WHERE d.is_active ORDER BY d.sort_order, d.name`
    );
    res.json({
      settings: Object.fromEntries(PUBLIC_SETTINGS.map((k) => [k, s[k]])),
      sms_available: notify.providerStatus().configured,
      accessibility_needs: queue.ACCESSIBILITY_NEEDS,
      departments: rows.map((d) => ({ ...d, eta_minutes: queue.estimateWait(d.waiting + 1, caps[d.id]) }))
    });
  }));

  api.get('/public/board', wrap(async (_req, res) => res.json(await queue.publicBoard())));

  const kioskLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 30, message: 'Too many tickets requested from this kiosk. Please ask reception for help.' });
  api.post('/public/tickets', kioskLimiter, wrap(async (req, res) => {
    const s = await settings.getAll();
    if (!s.kiosk_enabled) throw new HttpError(403, 'Self-registration is currently disabled. Please visit reception.');
    const { full_name, phone, department_id, priority, accessibility_needs } = req.body || {};
    const name = typeof full_name === 'string' ? full_name.trim().replace(/\s+/g, ' ') : '';
    if (!name) throw new HttpError(400, 'Please enter your name', { fields: { full_name: 'required' } });
    if (s.kiosk_require_phone && !phone) throw new HttpError(400, 'Please enter your phone number', { fields: { phone: 'required' } });
    const [first, ...rest] = name.split(' ');
    const result = await queue.register({
      department_id, first_name: first, last_name: rest.join(' ') || '-', phone, priority, accessibility_needs
    }, { source: 'kiosk' });
    const { patient, department, position, eta } = result;
    res.status(201).json({
      ticket_number: patient.ticket_number,
      department: department.name,
      position,
      eta_minutes: eta,
      needs_triage: patient.needs_triage,
      emergency: patient.priority === 'emergency',
      sms: !!patient.phone && s.sms_on_register && notify.providerStatus().configured,
      registered_at: patient.registered_at
    });
  }));

  // ═══════════════ AUTH ═══════════════
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 10,
    key: (req) => `${req.ip}|${String(req.body?.username || '').toLowerCase()}`,
    message: 'Too many sign-in attempts. Try again in 15 minutes.'
  });
  api.post('/auth/login', loginLimiter, wrap(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) throw new HttpError(400, 'Username and password are required');
    const { rows: [user] } = await pool.query('SELECT * FROM users WHERE lower(username) = lower($1)', [String(username)]);
    const ok = user && user.is_active && (await bcrypt.compare(String(password), user.password));
    if (!ok) throw new HttpError(401, 'Invalid username or password');
    await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    const role = auth.normaliseRole(user.role);
    res.json({
      token: auth.sign(user),
      user: { id: user.id, username: user.username, full_name: user.full_name, role, permissions: auth.permissionsFor({ role }) }
    });
  }));

  api.use(authenticate); // ─── everything below requires a signed-in staff member ───

  api.get('/auth/me', (req, res) => {
    res.json({ ...req.user, permissions: auth.permissionsFor(req.user) });
  });

  api.post('/auth/change-password', wrap(async (req, res) => {
    const { current_password, new_password } = req.body || {};
    validatePassword(new_password);
    const { rows: [user] } = await pool.query('SELECT password FROM users WHERE id = $1', [req.user.id]);
    if (!(await bcrypt.compare(String(current_password || ''), user.password))) throw new HttpError(400, 'Current password is incorrect');
    await pool.query('UPDATE users SET password = $2, updated_at = now() WHERE id = $1', [req.user.id, await bcrypt.hash(new_password, 10)]);
    res.json({ success: true });
  }));

  // ═══════════════ QUEUE ═══════════════
  api.get('/dashboard', allow('queue:view'), wrap(async (req, res) => res.json(await stats.dashboard(canFor(req)))));

  api.get('/tickets', allow('queue:view'), wrap(async (req, res) => res.json(await queue.listTickets(req.query, canFor(req)))));
  api.get('/tickets/:id', allow('queue:view'), wrap(async (req, res) => res.json(await queue.getTicket(req.params.id, canFor(req)))));

  api.post('/tickets', allow('queue:register'), wrap(async (req, res) => {
    const { patient, department, position, eta } = await queue.register(req.body || {}, { userId: req.user.id });
    res.status(201).json({ patient: shape(req, patient), department: department.name, position, eta_minutes: eta });
  }));

  api.post('/counters/:id/call-next', allow('queue:serve'), wrap(async (req, res) => {
    const { patient, counter } = await queue.callNext(req.params.id, req.user);
    res.json({ patient: patient && shape(req, patient), counter, message: patient ? null : `No patients waiting for ${counter.department_name}` });
  }));

  api.post('/tickets/:id/call', allow('queue:serve'), wrap(async (req, res) => {
    const { patient, counter } = await queue.callSpecific(req.params.id, req.body?.counter_id, req.user);
    res.json({ patient: shape(req, patient), counter });
  }));

  api.post('/tickets/:id/:action(start|complete|absent|requeue|recall|cancel)',
    (req, res, next) => allow(queue.ACTION_PERMISSION[req.params.action])(req, res, next),
    wrap(async (req, res) => {
      const { patient } = await queue.transition(req.params.id, req.params.action, req.user, { reason: req.body?.reason });
      res.json({ patient: shape(req, patient) });
    }));

  api.patch('/tickets/:id/priority', allow('queue:triage'), wrap(async (req, res) => {
    const { patient } = await queue.setPriority(req.params.id, req.body || {}, req.user);
    res.json({ patient: shape(req, patient) });
  }));

  api.post('/tickets/:id/refer', allow('queue:register'), wrap(async (req, res) => {
    const { patient, department, position, eta } = await queue.refer(req.params.id, req.body?.department_id, req.user);
    res.status(201).json({ patient: shape(req, patient), department: department.name, position, eta_minutes: eta });
  }));

  // ═══════════════ DEPARTMENTS & COUNTERS ═══════════════
  api.get('/departments', allow('queue:view'), wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT * FROM departments ${req.query.include_inactive && auth.can(req.user, 'admin:manage') ? '' : 'WHERE is_active'}
        ORDER BY sort_order, name`
    );
    res.json(rows);
  }));

  api.post('/departments', allow('admin:manage'), wrap(async (req, res) => {
    const d = cleanDepartment(req.body || {}, true);
    const { rows: [dept] } = await pool.query(
      `INSERT INTO departments (name, code, icon, description, default_service_minutes, sort_order, is_active)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM departments)), COALESCE($7, TRUE))
       RETURNING *`,
      [d.name, d.code, d.icon, d.description, d.default_service_minutes, d.sort_order, d.is_active]
    );
    await pool.query(`INSERT INTO counters (department_id, name) VALUES ($1, 'Counter 1')`, [dept.id]);
    queue.events.emit('changed', { departmentIds: [dept.id], reason: 'config' });
    res.status(201).json(dept);
  }));

  api.patch('/departments/:id', allow('admin:manage'), wrap(async (req, res) => {
    const d = cleanDepartment(req.body || {}, false);
    const id = queue.cleanId(req.params.id);
    if (d.is_active === false) {
      const { rows: [{ n }] } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM patients WHERE department_id = $1 AND status IN ('waiting','called','in-progress')`, [id]
      );
      if (n) throw new HttpError(409, `This department still has ${n} active ticket(s). Serve, cancel or refer them first.`);
    }
    const { rows: [dept] } = await pool.query(
      `UPDATE departments SET name = COALESCE($2, name), code = COALESCE($3, code), icon = COALESCE($4, icon),
              description = COALESCE($5, description), default_service_minutes = COALESCE($6, default_service_minutes),
              sort_order = COALESCE($7, sort_order), is_active = COALESCE($8, is_active)
        WHERE id = $1 RETURNING *`,
      [id, d.name, d.code, d.icon, d.description, d.default_service_minutes, d.sort_order, d.is_active]
    );
    if (!dept) throw new HttpError(404, 'Department not found');
    queue.events.emit('changed', { departmentIds: [id], reason: 'config' });
    res.json(dept);
  }));

  api.get('/counters', allow('queue:view'), wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT c.*, d.name AS department_name, d.is_active AS department_active,
              p.id AS active_ticket_id, p.ticket_number AS active_ticket, p.status AS active_status
         FROM counters c JOIN departments d ON d.id = c.department_id
         LEFT JOIN patients p ON p.counter_id = c.id AND p.status IN ('called','in-progress')
        ORDER BY d.sort_order, d.name, c.name`
    );
    res.json(rows);
  }));

  api.post('/counters', allow('admin:manage'), wrap(async (req, res) => {
    const name = cleanText(req.body?.name, 'Counter name', 100, true);
    const departmentId = queue.cleanId(req.body?.department_id, 'department');
    const { rows: [counter] } = await pool.query(
      'INSERT INTO counters (department_id, name) VALUES ($1, $2) RETURNING *', [departmentId, name]
    );
    queue.events.emit('changed', { departmentIds: [departmentId], reason: 'config' });
    res.status(201).json(counter);
  }));

  api.patch('/counters/:id', allow('admin:manage'), wrap(async (req, res) => {
    const id = queue.cleanId(req.params.id);
    const name = req.body?.name === undefined ? null : cleanText(req.body.name, 'Counter name', 100, true);
    const isActive = typeof req.body?.is_active === 'boolean' ? req.body.is_active : null;
    if (isActive === false) {
      const { rows: [busy] } = await pool.query(
        `SELECT ticket_number FROM patients WHERE counter_id = $1 AND status IN ('called','in-progress')`, [id]
      );
      if (busy) throw new HttpError(409, `Counter is attending ${busy.ticket_number}. Finish that ticket before closing it.`);
    }
    const { rows: [counter] } = await pool.query(
      'UPDATE counters SET name = COALESCE($2, name), is_active = COALESCE($3, is_active) WHERE id = $1 RETURNING *',
      [id, name, isActive]
    );
    if (!counter) throw new HttpError(404, 'Counter not found');
    queue.events.emit('changed', { departmentIds: [counter.department_id], reason: 'config' });
    res.json(counter);
  }));

  // ═══════════════ ANALYTICS ═══════════════
  api.get('/analytics', allow('analytics:view'), wrap(async (req, res) => res.json(await stats.analytics(req.query))));
  api.get('/analytics/export.csv', allow('analytics:view'), wrap(async (req, res) => {
    const { filename, body } = await stats.exportCsv(req.query);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(body);
  }));

  // ═══════════════ NOTIFICATIONS ═══════════════
  api.get('/notifications/status', allow('queue:view'), (_req, res) => res.json(notify.providerStatus()));
  api.get('/notifications/log', allow('notify:send'), wrap(async (req, res) => {
    const rows = await notify.listLog(req.query);
    res.json(auth.can(req.user, 'patient:contact') ? rows : rows.map((r) => ({ ...r, recipient_phone: maskPhone(r.recipient_phone) })));
  }));
  api.post('/notifications/sms', allow('notify:send'), wrap(async (req, res) => {
    res.json(await notify.sendManual(req.body?.patient_id, req.body?.message, req.user));
  }));
  api.post('/notifications/broadcast', allow('notify:send'), wrap(async (req, res) => {
    res.json(await notify.broadcast(req.body?.message, req.body?.department_id, req.user));
  }));

  // ═══════════════ SETTINGS ═══════════════
  api.get('/settings', allow('queue:view'), wrap(async (_req, res) => res.json(await settings.getAll())));
  api.put('/settings', allow('admin:manage'), wrap(async (req, res) => {
    const updated = await settings.update(req.body, req.user.id);
    queue.events.emit('changed', { departmentIds: [], reason: 'config' });
    res.json(updated);
  }));

  // ═══════════════ USERS (admin) ═══════════════
  api.get('/users', allow('admin:manage'), wrap(async (_req, res) => {
    const { rows } = await pool.query(
      'SELECT id, username, email, full_name, role, phone, is_active, last_login_at, created_at FROM users ORDER BY is_active DESC, full_name'
    );
    res.json(rows.map((u) => ({ ...u, role: auth.normaliseRole(u.role) })));
  }));

  api.post('/users', allow('admin:manage'), wrap(async (req, res) => {
    const b = req.body || {};
    const username = cleanText(b.username, 'Username', 50, true);
    if (!/^[a-z0-9._-]{3,50}$/i.test(username)) throw new HttpError(400, 'Username may contain letters, numbers, dot, dash and underscore (3–50 characters)');
    const fullName = cleanText(b.full_name, 'Full name', 120, true);
    const email = cleanText(b.email, 'Email', 255, false) || `${username.toLowerCase()}@sqhs.local`;
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpError(400, 'Email is not valid');
    if (!auth.ROLES.includes(b.role)) throw new HttpError(400, `Role must be one of: ${auth.ROLES.join(', ')}`);
    validatePassword(b.password);
    const { rows: [user] } = await pool.query(
      `INSERT INTO users (username, email, password, full_name, role, phone)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, username, email, full_name, role, is_active`,
      [username, email, await bcrypt.hash(b.password, 10), fullName, b.role, b.phone || null]
    );
    res.status(201).json(user);
  }));

  api.patch('/users/:id', allow('admin:manage'), wrap(async (req, res) => {
    const id = queue.cleanId(req.params.id);
    const b = req.body || {};
    if (b.role !== undefined && !auth.ROLES.includes(b.role)) throw new HttpError(400, 'Invalid role');
    if (id === req.user.id && (b.is_active === false || (b.role && b.role !== 'admin'))) {
      throw new HttpError(400, 'You cannot deactivate or demote your own account');
    }
    if (b.password !== undefined) validatePassword(b.password);
    const { rows: [user] } = await pool.query(
      `UPDATE users SET role = COALESCE($2, role), is_active = COALESCE($3, is_active),
              full_name = COALESCE($4, full_name), password = COALESCE($5, password), updated_at = now()
        WHERE id = $1 RETURNING id, username, email, full_name, role, is_active`,
      [id, b.role || null, typeof b.is_active === 'boolean' ? b.is_active : null,
        b.full_name ? cleanText(b.full_name, 'Full name', 120, true) : null,
        b.password ? await bcrypt.hash(b.password, 10) : null]
    );
    if (!user) throw new HttpError(404, 'User not found');
    res.json(user);
  }));

  api.use((_req, _res, next) => next(new HttpError(404, 'Not found')));
  return api;
}

// ─── helpers ─────────────────────────────────────────────────────────
const shape = (req, patient) => queue.shapeForRole(patient, canFor(req));
const { maskPhone } = queue;

function cleanText(v, label, max, required) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw new HttpError(400, `${label} is required`);
  if (s.length > max) throw new HttpError(400, `${label} is too long`);
  return s || null;
}

function validatePassword(p) {
  if (typeof p !== 'string' || p.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
}

function cleanDepartment(b, creating) {
  const out = {
    name: b.name === undefined && !creating ? null : cleanText(b.name, 'Department name', 120, true),
    code: null,
    icon: b.icon === undefined ? (creating ? '🏥' : null) : cleanText(b.icon, 'Icon', 8, false),
    description: b.description === undefined ? null : cleanText(b.description, 'Description', 500, false) || '',
    default_service_minutes: null,
    sort_order: null,
    is_active: typeof b.is_active === 'boolean' ? b.is_active : null
  };
  if (b.code !== undefined || creating) {
    const code = String(b.code || '').trim().toUpperCase();
    if (!/^[A-Z]{1,3}$/.test(code)) throw new HttpError(400, 'Ticket prefix must be 1–3 letters', { fields: { code: 'invalid' } });
    out.code = code;
  }
  if (b.default_service_minutes !== undefined || creating) {
    const m = Number(b.default_service_minutes ?? 10);
    if (!Number.isInteger(m) || m < 1 || m > 240) throw new HttpError(400, 'Typical service time must be 1–240 minutes');
    out.default_service_minutes = m;
  }
  if (b.sort_order !== undefined) {
    const n = Number(b.sort_order);
    if (!Number.isInteger(n)) throw new HttpError(400, 'Sort order must be a whole number');
    out.sort_order = n;
  }
  return out;
}

module.exports = { buildRouter };
