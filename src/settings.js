const { pool } = require('./db');
const { HttpError } = require('./http');

// Each setting: default value + validator returning the cleaned value (or throwing).
const str = (max) => (v) => {
  if (typeof v !== 'string') throw new Error('must be text');
  const s = v.trim();
  if (s.length > max) throw new Error(`must be at most ${max} characters`);
  return s;
};
const int = (min, max) => (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`must be a whole number between ${min} and ${max}`);
  return n;
};
const bool = (v) => {
  if (typeof v !== 'boolean') throw new Error('must be true or false');
  return v;
};
const oneOf = (...opts) => (v) => {
  if (!opts.includes(v)) throw new Error(`must be one of: ${opts.join(', ')}`);
  return v;
};
const timezone = (v) => {
  const s = str(64)(v);
  try { new Intl.DateTimeFormat('en', { timeZone: s }); } catch (_) { throw new Error('is not a valid IANA time zone'); }
  return s;
};

const SCHEMA = {
  facility_name: { default: 'Muhima Health Center', validate: str(120) },
  facility_location: { default: 'Nyarugenge, Kigali', validate: str(120) },
  facility_phone: { default: '+250 788 000 111', validate: str(40) },
  timezone: { default: 'Africa/Kigali', validate: timezone },

  // 'auto_top': verified emergencies are called before everyone else by "Call next".
  // 'manual':   emergencies are never auto-called; clinical staff call them explicitly.
  emergency_mode: { default: 'auto_top', validate: oneOf('auto_top', 'manual') },
  // Self-declared emergencies from the kiosk must be confirmed by staff before they jump the queue.
  kiosk_emergency_requires_triage: { default: true, validate: bool },
  // Normal patients waiting longer than this are ranked alongside priority patients (0 = off).
  fairness_boost_minutes: { default: 0, validate: int(0, 600) },
  max_recalls: { default: 3, validate: int(1, 10) },
  delay_alert_minutes: { default: 45, validate: int(5, 600) },

  kiosk_enabled: { default: true, validate: bool },
  kiosk_require_phone: { default: false, validate: bool },
  display_audio: { default: true, validate: bool },
  display_upcoming_count: { default: 4, validate: int(0, 10) },

  sms_on_register: { default: true, validate: bool },
  sms_on_call: { default: true, validate: bool },
  sms_soon_positions: { default: 3, validate: int(0, 20) }
};

let cache = null;

async function load() {
  const { rows } = await pool.query('SELECT key, value FROM settings');
  const values = Object.fromEntries(Object.entries(SCHEMA).map(([k, s]) => [k, s.default]));
  for (const { key, value } of rows) {
    if (key in SCHEMA) values[key] = value;
  }
  cache = values;
  return values;
}

async function getAll() {
  return cache || load();
}

async function update(changes, userId) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new HttpError(400, 'Expected an object of settings');
  const cleaned = {};
  const errors = {};
  for (const [key, value] of Object.entries(changes)) {
    if (!(key in SCHEMA)) { errors[key] = 'unknown setting'; continue; }
    try { cleaned[key] = SCHEMA[key].validate(value); } catch (e) { errors[key] = e.message; }
  }
  if (Object.keys(errors).length) throw new HttpError(400, 'Invalid settings', { fields: errors });
  for (const [key, value] of Object.entries(cleaned)) {
    await pool.query(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [key, JSON.stringify(value), userId]
    );
  }
  return load();
}

module.exports = { getAll, update, load, SCHEMA };
