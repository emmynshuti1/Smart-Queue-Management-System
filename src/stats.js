// Every figure here is computed from the patients table at request time — nothing is cached or estimated
// except the explicitly-labelled wait-time forecasts.
const { tx, pool } = require('./db');
const settings = require('./settings');
const queue = require('./queue');
const { HttpError } = require('./http');

const num = (v, digits = 1) => (v === null || v === undefined ? null : Math.round(Number(v) * 10 ** digits) / 10 ** digits);

async function dashboard(can) {
  const s = await settings.getAll();
  const tz = s.timezone;
  // One snapshot: every number on the dashboard reflects the same instant.
  return tx(async (c) => {
    const { rows: [totals] } = await c.query(
      `WITH t AS (SELECT (now() AT TIME ZONE $1)::date AS today)
       SELECT
         COUNT(*) FILTER (WHERE status = 'waiting')::int AS waiting,
         COUNT(*) FILTER (WHERE status IN ('called','in-progress'))::int AS serving,
         COUNT(*) FILTER (WHERE ticket_date = t.today)::int AS registered_today,
         COUNT(*) FILTER (WHERE status = 'done' AND (completed_at AT TIME ZONE $1)::date = t.today)::int AS served_today,
         COUNT(*) FILTER (WHERE status = 'no-show' AND ticket_date = t.today)::int AS no_show_today,
         COUNT(*) FILTER (WHERE status = 'cancelled' AND ticket_date = t.today)::int AS cancelled_today,
         COUNT(*) FILTER (WHERE priority = 'emergency' AND ticket_date = t.today)::int AS emergencies_today,
         COUNT(*) FILTER (WHERE priority = 'emergency' AND status = 'waiting')::int AS emergencies_waiting,
         COUNT(*) FILTER (WHERE needs_triage AND status = 'waiting')::int AS triage_required,
         COUNT(*) FILTER (WHERE status = 'waiting' AND registered_at < now() - make_interval(mins => $2))::int AS delayed,
         AVG(EXTRACT(EPOCH FROM first_called_at - registered_at) / 60)
           FILTER (WHERE (first_called_at AT TIME ZONE $1)::date = t.today) AS avg_wait_today,
         AVG(EXTRACT(EPOCH FROM completed_at - COALESCE(service_started_at, called_at)) / 60)
           FILTER (WHERE status = 'done' AND (completed_at AT TIME ZONE $1)::date = t.today) AS avg_service_today,
         MAX(EXTRACT(EPOCH FROM now() - registered_at) / 60) FILTER (WHERE status = 'waiting') AS longest_wait
       FROM patients, t
       WHERE ticket_date >= t.today - 1 OR status IN ('waiting','called','in-progress')`,
      [tz, s.delay_alert_minutes]
    );

    const caps = await queue.departmentCapacity(c);
    const { rows: depts } = await c.query(
      `WITH ${queue.rankedCte(s)}, t AS (SELECT (now() AT TIME ZONE $1)::date AS today)
       SELECT d.id, d.name, d.icon, d.code,
              COUNT(p.id) FILTER (WHERE p.status = 'waiting')::int AS waiting,
              COUNT(p.id) FILTER (WHERE p.status IN ('called','in-progress'))::int AS serving,
              COUNT(p.id) FILTER (WHERE p.status = 'done' AND (p.completed_at AT TIME ZONE $1)::date = t.today)::int AS served_today,
              COUNT(p.id) FILTER (WHERE p.status = 'waiting' AND p.priority = 'emergency')::int AS emergencies_waiting,
              MAX(EXTRACT(EPOCH FROM now() - p.registered_at) / 60) FILTER (WHERE p.status = 'waiting') AS longest_wait,
              (SELECT COUNT(*)::int FROM ranked r WHERE r.department_id = d.id) AS callable_waiting
         FROM departments d CROSS JOIN t
         LEFT JOIN patients p ON p.department_id = d.id
              AND (p.status IN ('waiting','called','in-progress') OR p.ticket_date = t.today)
        WHERE d.is_active
        GROUP BY d.id, t.today ORDER BY d.sort_order, d.name`,
      [tz]
    );

    const { rows: serving } = await c.query(
      `SELECT p.id, p.ticket_number, p.first_name, p.last_name, p.priority, p.status, p.call_count,
              p.accessibility_needs, p.department_id, d.name AS department_name, p.counter_id, c.name AS counter_name,
              ROUND(EXTRACT(EPOCH FROM now() - p.called_at) / 60)::int AS minutes_since_called
         FROM patients p JOIN departments d ON d.id = p.department_id JOIN counters c ON c.id = p.counter_id
        WHERE p.status IN ('called','in-progress') ORDER BY p.called_at DESC`
    );

    const { rows: alerts } = await c.query(
      `SELECT p.id, p.ticket_number, p.first_name, p.last_name, p.priority, p.needs_triage, d.name AS department_name,
              ROUND(EXTRACT(EPOCH FROM now() - p.registered_at) / 60)::int AS wait_minutes
         FROM patients p JOIN departments d ON d.id = p.department_id
        WHERE p.status = 'waiting'
          AND (p.priority = 'emergency' OR p.needs_triage OR p.registered_at < now() - make_interval(mins => $1))
        ORDER BY (p.priority = 'emergency') DESC, p.registered_at LIMIT 12`,
      [s.delay_alert_minutes]
    );

    const { rows: recent } = await c.query(
      `SELECT p.id, p.ticket_number, p.first_name, p.last_name, p.phone, p.priority, p.status, p.needs_triage,
              p.department_id, d.name AS department_name, p.registered_at,
              ROUND(EXTRACT(EPOCH FROM COALESCE(p.first_called_at, p.cancelled_at, now()) - p.registered_at) / 60)::int AS wait_minutes
         FROM patients p JOIN departments d ON d.id = p.department_id
        WHERE p.ticket_date = (now() AT TIME ZONE $1)::date
        ORDER BY p.registered_at DESC LIMIT 8`,
      [tz]
    );

    return {
      facility_name: s.facility_name,
      timezone: tz,
      delay_alert_minutes: s.delay_alert_minutes,
      emergency_mode: s.emergency_mode,
      totals: {
        ...totals,
        avg_wait_today: num(totals.avg_wait_today),
        avg_service_today: num(totals.avg_service_today),
        longest_wait: totals.longest_wait === null ? null : Math.round(totals.longest_wait)
      },
      departments: depts.map((d) => ({
        ...d,
        longest_wait: d.longest_wait === null ? null : Math.round(d.longest_wait),
        counters_open: caps[d.id]?.counters ?? 0,
        avg_service_minutes: caps[d.id]?.avgServiceMinutes ?? null,
        estimate_basis: caps[d.id]?.basis ?? 'default',
        eta_new_patient: queue.estimateWait(d.callable_waiting + 1, caps[d.id])
      })),
      serving,
      alerts: alerts.map((a) => ({
        ...a,
        kind: a.needs_triage ? 'triage' : a.priority === 'emergency' ? 'emergency' : 'delayed'
      })),
      recent: recent.map((p) => (can('patient:contact') ? p : { ...p, phone: undefined })),
      generated_at: new Date().toISOString()
    };
  }, { isolation: 'REPEATABLE READ', readOnly: true });
}

// ─── Analytics ───────────────────────────────────────────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function resolveRange(q) {
  const s = await settings.getAll();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: s.timezone }).format(new Date());
  const to = q.to || today;
  const from = q.from || to;
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw new HttpError(400, 'Dates must be YYYY-MM-DD');
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (Number.isNaN(days) || days < 0) throw new HttpError(400, '"from" must be on or before "to"');
  if (days > 366) throw new HttpError(400, 'Range is limited to one year');
  const departmentId = q.department_id ? queue.cleanId(q.department_id, 'department') : null;
  return { from, to, departmentId, tz: s.timezone, today };
}

const BASE = `
  base AS (
    SELECT p.*, d.name AS department_name,
           EXTRACT(EPOCH FROM p.first_called_at - p.registered_at) / 60 AS wait_min,
           CASE WHEN p.status = 'done'
                THEN EXTRACT(EPOCH FROM p.completed_at - COALESCE(p.service_started_at, p.called_at)) / 60 END AS service_min
      FROM patients p JOIN departments d ON d.id = p.department_id
     WHERE p.ticket_date BETWEEN $1::date AND $2::date
       AND ($3::int IS NULL OR p.department_id = $3)
  )`;

const AGG = `
  COUNT(*)::int AS total,
  COUNT(*) FILTER (WHERE status = 'done')::int AS served,
  COUNT(*) FILTER (WHERE status = 'no-show')::int AS no_show,
  COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
  COUNT(*) FILTER (WHERE priority = 'emergency')::int AS emergencies,
  AVG(wait_min) AS avg_wait,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY wait_min) AS median_wait,
  PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY wait_min) AS p90_wait,
  AVG(service_min) AS avg_service`;

function cleanAgg(r) {
  return {
    ...r,
    avg_wait: num(r.avg_wait), median_wait: num(r.median_wait), p90_wait: num(r.p90_wait), avg_service: num(r.avg_service),
    no_show_rate: r.total ? num((r.no_show / r.total) * 100) : null
  };
}

async function analytics(q) {
  const { from, to, departmentId, tz } = await resolveRange(q);
  const params = [from, to, departmentId, tz];
  return tx(async (c) => {
    const { rows: [summary] } = await c.query(`WITH ${BASE} SELECT ${AGG} FROM base WHERE $4::text IS NOT NULL`, params);

    // Throughput = served patients per hour in which the facility actually served someone.
    const { rows: [tp] } = await c.query(
      `WITH ${BASE}
       SELECT COUNT(DISTINCT date_trunc('hour', completed_at AT TIME ZONE $4))::int AS service_hours
         FROM base WHERE status = 'done'`, params
    );

    const { rows: byDay } = await c.query(
      `WITH ${BASE}
       SELECT to_char(g.day, 'YYYY-MM-DD') AS date,
              COUNT(b.id)::int AS total,
              COUNT(b.id) FILTER (WHERE b.status = 'done')::int AS served,
              AVG(b.wait_min) AS avg_wait
         FROM generate_series($1::date, $2::date, interval '1 day') AS g(day)
         LEFT JOIN base b ON b.ticket_date = g.day::date
        WHERE $4::text IS NOT NULL
        GROUP BY g.day ORDER BY g.day`, params
    );

    const { rows: byHour } = await c.query(
      `WITH ${BASE}
       SELECT EXTRACT(HOUR FROM registered_at AT TIME ZONE $4)::int AS hour,
              COUNT(*)::int AS arrivals, AVG(wait_min) AS avg_wait
         FROM base GROUP BY 1 ORDER BY 1`, params
    );

    const { rows: byDept } = await c.query(
      `WITH ${BASE}
       SELECT department_id, department_name, ${AGG}
         FROM base WHERE $4::text IS NOT NULL GROUP BY department_id, department_name ORDER BY total DESC`, params
    );

    const { rows: byPriority } = await c.query(
      `WITH ${BASE}
       SELECT priority, COUNT(*)::int AS total, AVG(wait_min) AS avg_wait
         FROM base WHERE $4::text IS NOT NULL GROUP BY priority`, params
    );

    const hours = Array.from({ length: 24 }, (_, h) => {
      const r = byHour.find((x) => x.hour === h);
      return { hour: h, arrivals: r ? r.arrivals : 0, avg_wait: r ? num(r.avg_wait) : null };
    });
    const peak = hours.reduce((best, h) => (h.arrivals > (best?.arrivals || 0) ? h : best), null);

    return {
      range: { from, to, department_id: departmentId, timezone: tz },
      summary: {
        ...cleanAgg(summary),
        service_hours: tp.service_hours,
        throughput_per_hour: tp.service_hours ? num(summary.served / tp.service_hours) : null,
        peak_hour: peak ? peak.hour : null,
        peak_hour_arrivals: peak ? peak.arrivals : 0
      },
      by_day: byDay.map((d) => ({ ...d, avg_wait: num(d.avg_wait) })),
      by_hour: hours,
      by_department: byDept.map(cleanAgg),
      by_priority: byPriority.map((p) => ({ ...p, avg_wait: num(p.avg_wait) }))
    };
  }, { isolation: 'REPEATABLE READ', readOnly: true });
}

// De-identified export: no names, phone numbers or notes.
async function exportCsv(q) {
  const { from, to, departmentId, tz } = await resolveRange(q);
  const { rows } = await pool.query(
    `WITH ${BASE}
     SELECT to_char(b.ticket_date, 'YYYY-MM-DD') AS date, b.ticket_number, b.department_name, b.priority, b.source, b.status,
            to_char(b.registered_at AT TIME ZONE $4, 'YYYY-MM-DD HH24:MI') AS registered_at,
            to_char(b.first_called_at AT TIME ZONE $4, 'YYYY-MM-DD HH24:MI') AS first_called_at,
            to_char(b.completed_at AT TIME ZONE $4, 'YYYY-MM-DD HH24:MI') AS completed_at,
            ROUND(b.wait_min::numeric, 1) AS wait_minutes, ROUND(b.service_min::numeric, 1) AS service_minutes,
            b.call_count, c.name AS counter
       FROM base b LEFT JOIN counters c ON c.id = b.counter_id
      ORDER BY b.registered_at`,
    [from, to, departmentId, tz]
  );
  const cols = ['date', 'ticket_number', 'department_name', 'priority', 'source', 'status', 'registered_at',
    'first_called_at', 'completed_at', 'wait_minutes', 'service_minutes', 'call_count', 'counter'];
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const str = String(v);
    // Neutralise spreadsheet formula injection and quote when needed.
    const safe = /^[=+\-@]/.test(str) ? `'${str}` : str;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return {
    filename: `sqhs-report-${from}_to_${to}.csv`,
    body: [cols.join(','), ...rows.map((r) => cols.map((k) => esc(r[k])).join(','))].join('\n')
  };
}

module.exports = { dashboard, analytics, exportCsv };
