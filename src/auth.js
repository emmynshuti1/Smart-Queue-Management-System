const jwt = require('jsonwebtoken');
const config = require('./config');
const { pool } = require('./db');
const { HttpError } = require('./http');

const ROLES = ['admin', 'receptionist', 'nurse', 'doctor'];

// What each role may do. 'staff' is the legacy default role from v1 and maps to nurse.
const PERMISSIONS = {
  'queue:view': ['admin', 'receptionist', 'nurse', 'doctor'],
  'queue:register': ['admin', 'receptionist', 'nurse'],
  'queue:serve': ['admin', 'nurse', 'doctor'],        // call, start, complete, absent, recall
  'queue:cancel': ['admin', 'receptionist', 'nurse'],
  'queue:triage': ['admin', 'nurse', 'doctor'],       // change priority, confirm emergencies
  'patient:contact': ['admin', 'receptionist'],       // see full phone numbers
  'patient:clinical': ['admin', 'nurse', 'doctor'],   // see clinical notes
  'notify:send': ['admin', 'receptionist', 'nurse'],
  'analytics:view': ['admin', 'nurse', 'doctor', 'receptionist'],
  'admin:manage': ['admin']                           // settings, departments, counters, users
};

const normaliseRole = (role) => (role === 'staff' ? 'nurse' : role);

function can(user, permission) {
  return !!user && (PERMISSIONS[permission] || []).includes(normaliseRole(user.role));
}

function sign(user) {
  return jwt.sign({ id: user.id, username: user.username, role: user.role }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn
  });
}

// Verifies the token AND that the account still exists and is active, so deactivating
// a user or changing their role takes effect immediately rather than at token expiry.
async function authenticate(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new HttpError(401, 'Sign in required');
    let decoded;
    try {
      decoded = jwt.verify(token, config.jwtSecret);
    } catch (_) {
      throw new HttpError(401, 'Session expired — please sign in again');
    }
    const { rows } = await pool.query(
      'SELECT id, username, role, full_name, is_active FROM users WHERE id = $1',
      [decoded.id]
    );
    if (!rows.length || !rows[0].is_active) throw new HttpError(401, 'Account is inactive');
    req.user = { ...rows[0], role: normaliseRole(rows[0].role) };
    next();
  } catch (err) {
    next(err);
  }
}

const requirePermission = (permission) => (req, _res, next) => {
  if (!can(req.user, permission)) return next(new HttpError(403, 'Your role does not allow this action'));
  next();
};

function permissionsFor(user) {
  return Object.keys(PERMISSIONS).filter((p) => can(user, p));
}

module.exports = { ROLES, can, sign, authenticate, requirePermission, permissionsFor, normaliseRole };
