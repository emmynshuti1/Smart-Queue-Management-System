// SMS notifications. Delivery only happens when a real provider is configured through
// environment variables; otherwise every message is logged with status 'not_configured'
// so staff can see exactly what was (not) sent.
const config = require('./config');
const { pool } = require('./db');
const settings = require('./settings');
const queue = require('./queue');
const { HttpError } = require('./http');

const PLACEHOLDER = /^(your|xxx|changeme|test)/i;

function providerStatus() {
  const { accountSid, authToken, from } = config.twilio;
  const configured = /^AC[0-9a-f]{32}$/i.test(accountSid) && !!authToken && !PLACEHOLDER.test(authToken) && /^\+\d{8,15}$/.test(from);
  return {
    provider: configured ? 'twilio' : null,
    configured,
    from: configured ? from : null,
    reason: configured ? null : 'No SMS provider configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER on the server.'
  };
}

async function deliverViaTwilio(to, body) {
  const { accountSid, authToken, from } = config.twilio;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
    signal: AbortSignal.timeout(10000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Twilio responded with HTTP ${res.status}`);
  // Twilio accepts the message (queued/sent); handset delivery is reported asynchronously.
  const status = ['failed', 'undelivered'].includes(data.status) ? 'failed'
    : ['sent', 'delivered'].includes(data.status) ? 'sent' : 'queued';
  return { id: data.sid, status };
}

/**
 * Send (or record the impossibility of sending) one SMS. Never throws for delivery
 * problems — the outcome is returned and stored in sms_logs.
 */
async function sendSms({ patient, body, kind, auto = true, userId = null }) {
  const label = `Ticket ${patient.ticket_number}`;
  const { rows: [entry] } = await pool.query(
    `INSERT INTO sms_logs (patient_id, recipient_name, recipient_phone, message, is_auto, kind, status, sent_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7) RETURNING id`,
    [patient.id, label, patient.phone, body, auto, kind, userId]
  );
  const status = providerStatus();
  let outcome;
  if (!status.configured) {
    outcome = { status: 'not_configured', error: status.reason };
  } else {
    try {
      const r = await deliverViaTwilio(patient.phone, body);
      outcome = { status: r.status, id: r.id, provider: 'twilio' };
    } catch (err) {
      outcome = { status: 'failed', error: err.message, provider: 'twilio' };
    }
  }
  await pool.query(
    'UPDATE sms_logs SET status = $2, error = $3, provider = $4, provider_message_id = $5, sent_at = now() WHERE id = $1',
    [entry.id, outcome.status, outcome.error || null, outcome.provider || null, outcome.id || null]
  );
  return { id: entry.id, ...outcome };
}

// Messages deliberately avoid names and clinical details.
const templates = {
  registered: (s, p, dept, eta) =>
    `${s.facility_name}: your ticket is ${p.ticket_number} (${dept}). ` +
    (eta === null || eta === undefined ? '' : eta === 0 ? 'You are next in line. ' : `Estimated wait ~${eta} min. `) +
    'We will text you when it is your turn.',
  called: (s, p, counter) => `${s.facility_name}: ticket ${p.ticket_number}, it is your turn. Please go to ${counter} now.`,
  soon: (s, p, position) => `${s.facility_name}: ticket ${p.ticket_number}, you are number ${position} in line. Please stay nearby.`
};

function logFailure(err) {
  console.error('Notification error:', err.message);
}

async function notifySoon(departmentId) {
  const s = await settings.getAll();
  if (!s.sms_soon_positions) return;
  // Atomically claim the "almost your turn" message so it is sent at most once per ticket.
  const { rows } = await pool.query(
    `WITH ${queue.rankedCte(s)}
     UPDATE patients p SET notified_soon = TRUE
       FROM ranked r
      WHERE r.id = p.id AND r.department_id = $1 AND r.position BETWEEN 2 AND $2
        AND p.phone IS NOT NULL AND NOT p.notified_soon
     RETURNING p.*, r.position`,
    [departmentId, s.sms_soon_positions]
  );
  for (const p of rows) await sendSms({ patient: p, body: templates.soon(s, p, p.position), kind: 'soon' });
}

function attach() {
  queue.events.on('registered', async ({ patient, department, eta }) => {
    try {
      const s = await settings.getAll();
      if (s.sms_on_register && patient.phone) {
        await sendSms({ patient, body: templates.registered(s, patient, department.name, eta), kind: 'registered' });
      }
    } catch (err) { logFailure(err); }
  });
  queue.events.on('called', async ({ patient, counter }) => {
    try {
      const s = await settings.getAll();
      if (s.sms_on_call && patient.phone) {
        await sendSms({ patient, body: templates.called(s, patient, counter.name), kind: 'called' });
      }
      await notifySoon(patient.department_id);
    } catch (err) { logFailure(err); }
  });
}

async function sendManual(patientId, message, user) {
  const body = typeof message === 'string' ? message.trim() : '';
  if (!body) throw new HttpError(400, 'Message is required');
  if (body.length > 480) throw new HttpError(400, 'Message is too long (max 480 characters)');
  const { rows: [patient] } = await pool.query('SELECT * FROM patients WHERE id = $1', [queue.cleanId(patientId)]);
  if (!patient) throw new HttpError(404, 'Ticket not found');
  if (!patient.phone) throw new HttpError(400, `Ticket ${patient.ticket_number} has no phone number on file`);
  return sendSms({ patient, body, kind: 'manual', auto: false, userId: user.id });
}

async function broadcast(message, departmentId, user) {
  const body = typeof message === 'string' ? message.trim() : '';
  if (!body) throw new HttpError(400, 'Message is required');
  if (body.length > 480) throw new HttpError(400, 'Message is too long (max 480 characters)');
  const params = [];
  let filter = '';
  if (departmentId) { params.push(queue.cleanId(departmentId, 'department')); filter = 'AND department_id = $1'; }
  const { rows: patients } = await pool.query(
    `SELECT * FROM patients WHERE status = 'waiting' AND phone IS NOT NULL ${filter}`, params
  );
  const summary = { recipients: patients.length, sent: 0, queued: 0, failed: 0, not_configured: 0 };
  for (const patient of patients) {
    const r = await sendSms({ patient, body, kind: 'broadcast', auto: false, userId: user.id });
    summary[r.status] = (summary[r.status] || 0) + 1;
  }
  return summary;
}

async function listLog({ limit = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT l.id, l.recipient_name, l.recipient_phone, l.message, l.is_auto, l.kind, l.status, l.error,
            l.provider, l.sent_at, u.full_name AS sent_by_name
       FROM sms_logs l LEFT JOIN users u ON u.id = l.sent_by
      ORDER BY l.sent_at DESC, l.id DESC LIMIT $1`,
    [Math.min(500, Math.max(1, Number(limit) || 100))]
  );
  return rows;
}

module.exports = { attach, providerStatus, sendManual, broadcast, listLog, templates };
