// ═══════════════ SQHS STAFF CONSOLE ═══════════════
// All data comes from the API; nothing here is mock or cached across sessions.
const { api, esc, $, $$, toast, fmtTime, fmtMinutes, fmtEta, store, TOKEN_KEY, PRIORITY_LABEL, STATUS_LABEL, NEED_LABEL } = SQHS;

const COUNTER_KEY = 'sqhs.counter';
const state = {
  user: null,
  perms: new Set(),
  settings: null,
  departments: [],
  counters: [],
  dashboard: null,
  tickets: [],
  page: 'dashboard',
  liveConn: null,
  accessibility: ['wheelchair', 'visual', 'hearing', 'interpreter', 'mobility']
};
const can = (p) => state.perms.has(p);
const tz = () => state.settings?.timezone;

// ═══════════════ AUTH ═══════════════
function showLogin(message) {
  $('#app').hidden = true;
  $('#login-screen').hidden = false;
  const err = $('#login-error');
  err.hidden = !message;
  err.textContent = message || '';
  $('#login-user').focus();
  if (state.liveConn) { state.liveConn.stop(); state.liveConn = null; }
}

SQHS.setUnauthorizedHandler((data) => {
  store.remove(TOKEN_KEY);
  showLogin(data?.error || 'Please sign in again');
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter || $('#login-form button[type=submit]');
  btn.disabled = true;
  try {
    const r = await api('/auth/login', { method: 'POST', auth: false, body: { username: $('#login-user').value.trim(), password: $('#login-pass').value } });
    store.set(TOKEN_KEY, r.token);
    $('#login-pass').value = '';
    await boot();
  } catch (err) {
    const el = $('#login-error');
    el.hidden = false;
    el.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

async function boot() {
  if (!store.get(TOKEN_KEY)) return showLogin();
  try {
    const me = await api('/auth/me');
    state.user = me;
    state.perms = new Set(me.permissions);
    [state.settings, state.departments, state.counters] = await Promise.all([
      api('/settings'), api('/departments'), api('/counters')
    ]);
  } catch (err) {
    if (err.status !== 401) showLogin(err.message);
    return;
  }
  $('#login-screen').hidden = true;
  $('#app').hidden = false;
  $('#user-name').textContent = state.user.full_name;
  $('#user-role').textContent = state.user.role;
  $('#user-avatar').textContent = initials(state.user.full_name);
  $('#brand-facility').textContent = state.settings.facility_name;
  applyPermissions();
  fillDepartmentSelects();
  state.liveConn = SQHS.live({
    onChange: () => refreshCurrent(),
    onStatus: (ok) => {
      const el = $('#live-status');
      el.classList.toggle('offline', !ok);
      el.querySelector('span').textContent = ok ? 'Live' : 'Reconnecting…';
    }
  });
  showPage(location.hash.slice(1) || 'dashboard');
}

function applyPermissions() {
  $$('[data-perm]').forEach((el) => { el.hidden = !can(el.dataset.perm); });
}

function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0].toUpperCase()).join('');
}

// ═══════════════ NAVIGATION ═══════════════
const PAGES = ['dashboard', 'queue', 'kiosk', 'display', 'analytics', 'sms', 'settings'];

function showPage(id) {
  if (!PAGES.includes(id)) id = 'dashboard';
  const tab = $(`.nav-tab[data-page="${id}"]`);
  if (tab && tab.hidden) id = 'dashboard';
  state.page = id;
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${id}`));
  $$('.nav-tab').forEach((t) => t.classList.toggle('active', t.dataset.page === id));
  if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
  // Load iframes lazily so preview screens don't run in the background.
  $$('.preview-frame').forEach((f) => {
    const visible = f.closest('.page').classList.contains('active');
    if (visible && !f.src) f.src = f.dataset.src;
    if (!visible && f.src) f.removeAttribute('src');
  });
  refreshCurrent();
}

window.addEventListener('hashchange', () => state.user && showPage(location.hash.slice(1)));

async function refreshCurrent() {
  try {
    if (state.page === 'dashboard') await loadDashboard();
    else if (state.page === 'queue') await loadQueue();
    else if (state.page === 'analytics') await loadAnalytics();
    else if (state.page === 'sms') await loadSms();
    else if (state.page === 'settings') await loadSettings();
  } catch (err) {
    if (err.status !== 401) toast(err.message, 'error');
  }
}

// ═══════════════ SHARED RENDER HELPERS ═══════════════
function badgePriority(p, needsTriage) {
  if (needsTriage) return `<span class="badge badge-triage" title="Self-declared at kiosk — confirm or change">⚠ Triage needed</span>`;
  if (p === 'emergency') return `<span class="badge badge-emergency">🚨 Emergency</span>`;
  if (p === 'priority') return `<span class="badge badge-priority">⭐ Priority</span>`;
  return `<span class="badge badge-normal">Normal</span>`;
}
const badgeStatus = (s) => `<span class="badge badge-${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;
const needsChips = (needs) => (needs || []).map((n) => `<span class="need" title="${esc(n)}">${esc(NEED_LABEL[n] || n)}</span>`).join('');
const patientName = (p) => `${esc(p.first_name)} ${p.last_name && p.last_name !== '-' ? esc(p.last_name) : ''}`.trim();
const avatar = (p) => `<div class="avatar">${esc(initials(`${p.first_name} ${p.last_name === '-' ? '' : p.last_name}`))}</div>`;

function emptyState(icon, text) {
  return `<div class="empty-state"><div class="empty-icon">${icon}</div><p>${esc(text)}</p></div>`;
}

function fillDepartmentSelects() {
  const opts = state.departments.map((d) => `<option value="${d.id}">${esc(d.icon || '')} ${esc(d.name)}</option>`).join('');
  for (const id of ['#filter-dept', '#an-dept', '#broadcast-dept']) {
    const sel = $(id);
    const keep = sel.value;
    sel.innerHTML = `<option value="">All departments</option>${opts}`;
    sel.value = keep;
  }
  renderCounterSelect();
}

function renderCounterSelect() {
  const sel = $('#console-counter');
  const saved = store.get(COUNTER_KEY);
  const active = state.counters.filter((c) => c.is_active && c.department_active);
  const groups = state.departments.map((d) => {
    const cs = active.filter((c) => c.department_id === d.id);
    if (!cs.length) return '';
    return `<optgroup label="${esc(d.name)}">${cs.map((c) => `<option value="${c.id}">${esc(c.name)} — ${esc(d.name)}</option>`).join('')}</optgroup>`;
  }).join('');
  sel.innerHTML = `<option value="">— Select your counter —</option>${groups}`;
  if (saved && active.some((c) => String(c.id) === saved)) sel.value = saved;
}

const myCounter = () => state.counters.find((c) => String(c.id) === $('#console-counter').value);

// ═══════════════ DASHBOARD ═══════════════
async function loadDashboard() {
  const d = await api('/dashboard');
  state.dashboard = d;
  renderDashboard(d);
}

function renderDashboard(d) {
  const now = new Date();
  const hour = Number(now.toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: d.timezone }));
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  $('#dash-greeting').textContent = `${part}, ${state.user.full_name.split(' ')[0]}`;
  $('#dash-date').textContent = `${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: d.timezone })} — ${d.facility_name}`;
  $('#dash-updated').textContent = `Updated ${fmtTime(d.generated_at, d.timezone)}`;

  const t = d.totals;
  $('#stat-waiting').textContent = t.waiting;
  $('#stat-waiting-sub').textContent = t.longest_wait !== null ? `longest ${fmtMinutes(t.longest_wait)}` : 'queue is empty';
  $('#stat-serving').textContent = t.serving;
  $('#stat-served').textContent = t.served_today;
  $('#stat-served-sub').textContent = `${t.registered_today} registered · ${t.no_show_today} absent`;
  $('#stat-avg').innerHTML = t.avg_wait_today === null ? '—' : `${esc(t.avg_wait_today)}<span class="unit"> min</span>`;
  $('#stat-avg-sub').textContent = t.avg_service_today === null ? 'arrival → first call' : `service ${t.avg_service_today} min avg`;
  $('#stat-emer').textContent = t.emergencies_today;
  $('#stat-emer-sub').textContent = t.emergencies_waiting ? `${t.emergencies_waiting} waiting now` : 'today, none waiting';
  $('#stat-emer').closest('.stat').classList.toggle('stat-alert', t.emergencies_waiting > 0);

  // Alerts: emergencies, triage, delays.
  const alerts = d.alerts;
  const delayed = alerts.filter((a) => a.kind === 'delayed');
  const urgent = alerts.filter((a) => a.kind !== 'delayed');
  let html = urgent.map((a) => `
    <div class="alert alert-${a.kind === 'triage' ? 'warning' : 'critical'}" role="alert">
      <span class="alert-icon">${a.kind === 'triage' ? '⚠' : '🚨'}</span>
      <div class="alert-text">
        <strong>${a.kind === 'triage' ? 'Triage required' : 'Emergency waiting'} — ${esc(a.ticket_number)}</strong>
        <span>${patientName(a)} · ${esc(a.department_name)} · waiting ${fmtMinutes(a.wait_minutes)}${a.kind === 'triage' ? ' · self-declared at kiosk' : ''}</span>
      </div>
      ${can('queue:triage') ? `<button class="btn btn-sm btn-outline" data-action="triage" data-id="${a.id}">Review priority</button>` : ''}
      ${can('queue:serve') ? `<button class="btn btn-sm btn-danger-solid" data-action="call-specific" data-id="${a.id}" data-dept="${esc(departmentIdByName(a.department_name))}">Call now</button>` : ''}
    </div>`).join('');
  if (t.delayed) {
    html += `<div class="alert alert-serious"><span class="alert-icon">⏱</span><div class="alert-text">
      <strong>${t.delayed} patient${t.delayed === 1 ? '' : 's'} waiting over ${d.delay_alert_minutes} min</strong>
      <span>${delayed.slice(0, 5).map((a) => `${esc(a.ticket_number)} (${esc(a.department_name)}, ${fmtMinutes(a.wait_minutes)})`).join(' · ')}</span>
    </div><button class="btn btn-sm btn-outline" data-page="queue">View queue</button></div>`;
  }
  if (d.emergency_mode === 'manual' && t.emergencies_waiting) {
    html += `<p class="hint">Emergency handling is set to <strong>manual</strong>: “Call next” will not pick emergencies — call them explicitly.</p>`;
  }
  $('#dash-alerts').innerHTML = html;

  // Now serving.
  $('#now-serving').innerHTML = d.serving.length ? `<div class="serving-list">${d.serving.map((p) => `
    <div class="serving-item ${p.priority === 'emergency' ? 'is-emergency' : ''}">
      <div class="serving-ticket">${esc(p.ticket_number)}</div>
      <div class="serving-meta">
        <div class="serving-name">${patientName(p)} ${needsChips(p.accessibility_needs)}</div>
        <div class="serving-sub">${esc(p.counter_name)} · ${esc(p.department_name)}</div>
      </div>
      <div class="serving-state">${badgeStatus(p.status)}<span class="hint">${p.status === 'called' ? `called ${fmtMinutes(p.minutes_since_called)} ago${p.call_count > 1 ? ` · ${p.call_count}×` : ''}` : `${fmtMinutes(p.minutes_since_called)}`}</span></div>
    </div>`).join('')}</div>` : emptyState('🔔', 'No patient is being served right now');

  // Department workload — single-hue bars, value labels in text ink.
  const max = Math.max(1, ...d.departments.map((x) => x.waiting));
  $('#dept-workload').innerHTML = d.departments.map((x) => `
    <div class="workload-row" title="${esc(x.name)}: ${x.waiting} waiting, ${x.serving} being served, ${x.served_today} served today">
      <div class="workload-name"><span>${esc(x.icon || '')}</span> ${esc(x.name)}</div>
      <div class="workload-bar"><div class="bar-track"><div class="bar-fill" style="width:${Math.round((x.waiting / max) * 100)}%"></div></div></div>
      <div class="workload-num">${x.waiting}</div>
      <div class="workload-meta">
        ${x.emergencies_waiting ? `<span class="badge badge-emergency">🚨 ${x.emergencies_waiting}</span>` : ''}
        <span>${x.counters_open} counter${x.counters_open === 1 ? '' : 's'}</span>
        <span title="Estimate for a new arrival, based on ${x.estimate_basis === 'default' ? 'configured typical service time' : 'recent service times'}">${fmtEta(x.eta_new_patient)}</span>
      </div>
    </div>`).join('') || emptyState('🏥', 'No active departments');

  $('#dash-recent').innerHTML = d.recent.length ? d.recent.map((p) => `
    <tr class="row-link" data-action="ticket-detail" data-id="${p.id}">
      <td><strong class="ticket-no">${esc(p.ticket_number)}</strong></td>
      <td><div class="cell-patient">${avatar(p)}<span>${patientName(p)}</span></div></td>
      <td><span class="tag">${esc(p.department_name)}</span></td>
      <td>${badgePriority(p.priority, p.needs_triage)}</td>
      <td class="muted">${fmtMinutes(p.wait_minutes)}</td>
      <td>${badgeStatus(p.status)}</td>
    </tr>`).join('') : `<tr><td colspan="6">${emptyState('📋', 'No registrations yet today')}</td></tr>`;
}

function departmentIdByName(name) {
  return state.departments.find((d) => d.name === name)?.id || '';
}

// ═══════════════ QUEUE ═══════════════
async function loadQueue() {
  const params = new URLSearchParams();
  const status = $('#filter-status').value;
  if (status) params.set('status', status);
  if ($('#filter-dept').value) params.set('department_id', $('#filter-dept').value);
  if ($('#filter-q').value.trim()) params.set('q', $('#filter-q').value.trim());
  const [tickets, counters] = await Promise.all([api(`/tickets?${params}`), api('/counters')]);
  state.tickets = tickets;
  state.counters = counters;
  renderQueue();
  renderConsole();
}

function rowActions(p) {
  const b = [];
  const serve = can('queue:serve');
  if (p.status === 'waiting') {
    if (serve) b.push(`<button class="btn btn-sm btn-primary" data-action="call-specific" data-id="${p.id}" data-dept="${p.department_id}">Call</button>`);
    if (can('queue:triage')) b.push(`<button class="btn btn-sm btn-outline" data-action="triage" data-id="${p.id}">Priority</button>`);
    if (can('queue:cancel')) b.push(`<button class="btn btn-sm btn-danger" data-action="cancel" data-id="${p.id}" title="Cancel ticket">Cancel</button>`);
  } else if (p.status === 'called' && serve) {
    b.push(`<button class="btn btn-sm btn-primary" data-action="tx" data-tx="start" data-id="${p.id}">Start</button>`);
    b.push(`<button class="btn btn-sm btn-outline" data-action="tx" data-tx="complete" data-id="${p.id}">Served</button>`);
    b.push(`<button class="btn btn-sm btn-amber" data-action="tx" data-tx="absent" data-id="${p.id}">Absent</button>`);
  } else if (p.status === 'in-progress' && serve) {
    b.push(`<button class="btn btn-sm btn-primary" data-action="tx" data-tx="complete" data-id="${p.id}">Served</button>`);
  } else if (p.status === 'done' && can('queue:register')) {
    b.push(`<button class="btn btn-sm btn-outline" data-action="refer" data-id="${p.id}">Refer →</button>`);
  }
  return b.join('');
}

function renderQueue() {
  const list = state.tickets;
  $('#queue-count').textContent = `${list.length} ticket${list.length === 1 ? '' : 's'}`;
  const delay = state.settings.delay_alert_minutes;
  $('#queue-tbody').innerHTML = list.length ? list.map((p) => `
    <tr class="${p.priority === 'emergency' && p.status === 'waiting' ? 'row-emergency' : ''} ${p.status === 'waiting' && p.wait_minutes >= delay ? 'row-delayed' : ''}">
      <td class="muted">${p.position || (p.awaiting_clinical_call ? '<span title="Awaiting explicit clinical call">✚</span>' : '')}</td>
      <td><button class="link ticket-no" data-action="ticket-detail" data-id="${p.id}">${esc(p.ticket_number)}</button></td>
      <td><div class="cell-patient">${avatar(p)}<div>
        <div>${patientName(p)} ${needsChips(p.accessibility_needs)}</div>
        <div class="cell-sub">${p.phone ? esc(p.phone) : ''}${p.notes ? ` · <span title="${esc(p.notes)}">📝 ${esc(p.notes.slice(0, 40))}${p.notes.length > 40 ? '…' : ''}</span>` : ''}</div>
      </div></div></td>
      <td><span class="tag">${esc(p.department_name)}</span>${p.counter_name ? `<div class="cell-sub">${esc(p.counter_name)}</div>` : ''}</td>
      <td>${badgePriority(p.priority, p.needs_triage)}</td>
      <td class="nowrap muted">${fmtTime(p.registered_at, tz())}</td>
      <td class="nowrap ${p.status === 'waiting' && p.wait_minutes >= delay ? 'text-serious' : ''}">${fmtMinutes(p.wait_minutes)}</td>
      <td class="nowrap muted">${p.status === 'waiting' ? fmtEta(p.eta_minutes) : ''}</td>
      <td>${badgeStatus(p.status)}${p.cancel_reason ? `<div class="cell-sub">${esc(p.cancel_reason)}</div>` : ''}</td>
      <td><div class="row-actions">${rowActions(p)}</div></td>
    </tr>`).join('') : `<tr><td colspan="10">${emptyState('📋', 'No tickets match these filters')}</td></tr>`;
}

function renderConsole() {
  if (!can('queue:serve')) return;
  renderCounterSelect();
  const counter = myCounter();
  const box = $('#console-current');
  $('#btn-call-next').disabled = !counter || !!counter.active_ticket_id;
  if (!counter) {
    box.innerHTML = `<p class="hint">Choose the counter you are working at. “Call next” then picks the next patient for that counter's department, following the priority rules.</p>`;
    return;
  }
  const waitingHere = state.tickets.filter((p) => p.status === 'waiting' && p.department_id === counter.department_id).length;
  if (!counter.active_ticket_id) {
    box.innerHTML = `<div class="console-idle">${esc(counter.name)} is free · <strong>${waitingHere}</strong> waiting for ${esc(counter.department_name)}</div>`;
    return;
  }
  const p = state.tickets.find((x) => x.id === counter.active_ticket_id);
  if (!p) {
    box.innerHTML = `<div class="console-idle">Attending <strong>${esc(counter.active_ticket)}</strong></div>`;
    return;
  }
  const maxCalls = state.settings.max_recalls;
  box.innerHTML = `
    <div class="console-current ${p.priority === 'emergency' ? 'is-emergency' : ''}">
      <div class="console-ticket">${esc(p.ticket_number)}</div>
      <div class="console-info">
        <div class="console-name">${patientName(p)} ${needsChips(p.accessibility_needs)}</div>
        <div class="cell-sub">${badgePriority(p.priority, p.needs_triage)} ${badgeStatus(p.status)}
          ${p.status === 'called' ? `· called ${p.call_count} of ${maxCalls} time${maxCalls === 1 ? '' : 's'}` : ''}</div>
        ${p.notes ? `<div class="console-notes">📝 ${esc(p.notes)}</div>` : ''}
      </div>
      <div class="console-actions">
        ${p.status === 'called' ? `
          <button class="btn btn-primary" data-action="tx" data-tx="start" data-id="${p.id}">▶ Start service</button>
          <button class="btn btn-outline" data-action="tx" data-tx="complete" data-id="${p.id}">✓ Served</button>
          <button class="btn btn-outline" data-action="tx" data-tx="recall" data-id="${p.id}" ${p.call_count >= maxCalls ? 'disabled' : ''}>🔁 Recall</button>
          <button class="btn btn-amber" data-action="tx" data-tx="absent" data-id="${p.id}">Absent</button>
          <button class="btn btn-ghost" data-action="tx" data-tx="requeue" data-id="${p.id}" title="Patient stepped away — keep their place">↩ Return to queue</button>`
        : `<button class="btn btn-primary btn-lg" data-action="tx" data-tx="complete" data-id="${p.id}">✓ Mark served</button>`}
      </div>
    </div>`;
}

$('#console-counter').addEventListener('change', (e) => {
  store.set(COUNTER_KEY, e.target.value);
  renderConsole();
});
let searchTimer;
$('#filter-q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadQueue, 250); });
$('#filter-dept').addEventListener('change', loadQueue);
$('#filter-status').addEventListener('change', loadQueue);

// Run an action, disabling the button so it can't be pressed twice, and refresh after.
async function runAction(btn, fn, successMsg) {
  if (btn) btn.disabled = true;
  try {
    const r = await fn();
    if (successMsg) toast(typeof successMsg === 'function' ? successMsg(r) : successMsg);
    return r;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  } finally {
    if (btn) btn.disabled = false;
    refreshCurrent();
  }
}

const TX_MESSAGES = {
  start: (p) => `${p.ticket_number} — service started`,
  complete: (p) => `${p.ticket_number} marked as served`,
  absent: (p) => `${p.ticket_number} marked absent`,
  recall: (p) => `${p.ticket_number} called again`,
  requeue: (p) => `${p.ticket_number} returned to the queue`,
  cancel: (p) => `${p.ticket_number} cancelled`
};

async function doTransition(btn, id, action, body) {
  if (action === 'absent' && !(await confirmDialog('Mark this patient as absent? Their ticket will be closed.', { confirm: 'Mark absent', danger: true }))) return;
  return runAction(btn, () => api(`/tickets/${id}/${action}`, { method: 'POST', body: body || {} }), (r) => TX_MESSAGES[action](r.patient));
}

async function callSpecific(btn, id, deptId) {
  let counter = myCounter();
  if (!counter || String(counter.department_id) !== String(deptId)) {
    const options = state.counters.filter((c) => c.is_active && String(c.department_id) === String(deptId) && !c.active_ticket_id);
    if (!options.length) return toast('No free counter in that department. Finish the current patient first.', 'error');
    counter = options.length === 1 ? options[0] : await pickCounter(options);
    if (!counter) return;
  }
  return runAction(btn, () => api(`/tickets/${id}/call`, { method: 'POST', body: { counter_id: counter.id } }),
    (r) => `📣 Calling ${r.patient.ticket_number} to ${r.counter.name}`);
}

function pickCounter(options) {
  return new Promise((resolve) => {
    openModal('Call to which counter?', `<div class="pick-list">${options.map((c) => `<button class="btn btn-outline btn-block" data-pick="${c.id}">${esc(c.name)} — ${esc(c.department_name)}</button>`).join('')}</div>`, (body) => {
      body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-pick]');
        if (!b) return;
        closeModal();
        resolve(options.find((c) => String(c.id) === b.dataset.pick));
      });
    }, () => resolve(null));
  });
}

// ═══════════════ REGISTRATION ═══════════════
function openRegister() {
  const node = $('#tpl-register').content.cloneNode(true);
  openModal('Register new patient', node, (body) => {
    const deptSel = $('#f-dept', body);
    deptSel.innerHTML = state.departments.map((d) => `<option value="${d.id}">${esc(d.icon || '')} ${esc(d.name)}</option>`).join('');
    const filter = $('#filter-dept').value;
    if (filter) deptSel.value = filter;
    $('#f-needs', body).innerHTML = state.accessibility.map((n) => `<label class="chip"><input type="checkbox" value="${n}"> ${esc(NEED_LABEL[n])}</label>`).join('');
    $('#f-fname', body).focus();
    $('#form-register', body).addEventListener('submit', submitRegister);
  });
}

async function submitRegister(e) {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('[type=submit]');
  const err = $('#register-error');
  err.hidden = true;
  const body = {
    first_name: f.first_name.value, last_name: f.last_name.value, phone: f.phone.value,
    department_id: Number(f.department_id.value), priority: f.priority.value, notes: f.notes.value,
    accessibility_needs: $$('#f-needs input:checked').map((i) => i.value)
  };
  btn.disabled = true;
  try {
    const r = await api('/tickets', { method: 'POST', body });
    showIssuedTicket(r);
    refreshCurrent();
  } catch (ex) {
    err.hidden = false;
    err.textContent = ex.message;
    btn.disabled = false;
  }
}

function showIssuedTicket(r) {
  const p = r.patient;
  openModal('Ticket issued', `
    <div class="ticket-display ticket-compact" id="print-ticket">
      <div class="t-label">Queue number</div>
      <div class="t-num">${esc(p.ticket_number)}</div>
      <div class="t-dept">${esc(r.department)}</div>
      <div class="t-est">${r.position ? `Position ${r.position} · estimated wait ${fmtEta(r.eta_minutes)}` : 'Emergency — to be called directly by clinical staff'}</div>
    </div>
    <p class="hint center">${p.phone ? 'An SMS confirmation is attempted automatically — check the SMS log for its delivery status.' : 'No phone number given — the patient should watch the display board.'}</p>
    <div class="modal-actions">
      <button class="btn btn-outline" data-action="print-ticket">🖨 Print</button>
      <button class="btn btn-outline" data-action="open-register">Register another</button>
      <button class="btn btn-primary" data-action="close-modal">Done</button>
    </div>`);
}

// ═══════════════ TICKET DETAIL / TRIAGE / CANCEL / REFER ═══════════════
async function ticketDetail(id) {
  const p = await api(`/tickets/${id}`);
  const ACTION_LABEL = { register: 'Registered', call: 'Called', recall: 'Called again', start: 'Service started', complete: 'Served', absent: 'Marked absent', requeue: 'Returned to queue', cancel: 'Cancelled', triage: 'Priority changed', expire: 'Expired' };
  openModal(`Ticket ${p.ticket_number}`, `
    <div class="detail-grid">
      <div><span class="label">Patient</span>${patientName(p)}</div>
      <div><span class="label">Department</span>${esc(p.department_name)}</div>
      <div><span class="label">Phone</span>${esc(p.phone || '—')}</div>
      <div><span class="label">Priority</span>${badgePriority(p.priority, p.needs_triage)}</div>
      <div><span class="label">Status</span>${badgeStatus(p.status)}</div>
      <div><span class="label">Source</span>${esc(p.source)}</div>
      ${p.accessibility_needs?.length ? `<div class="span-2"><span class="label">Accessibility</span>${needsChips(p.accessibility_needs)}</div>` : ''}
      ${p.notes !== undefined && p.notes ? `<div class="span-2"><span class="label">Clinical notes</span>${esc(p.notes)}</div>` : ''}
    </div>
    <h4 class="sub-title">History</h4>
    <div class="timeline">${p.history.map((h) => `
      <div class="tl-item"><div class="tl-dot"></div>
        <div class="tl-label">${esc(ACTION_LABEL[h.action] || h.action || h.status)}${h.counter_name ? ` · ${esc(h.counter_name)}` : ''}</div>
        <div class="tl-time">${fmtTime(h.timestamp, tz())}${h.by_name ? ` · ${esc(h.by_name)}` : ''}${h.note ? ` · ${esc(h.note)}` : ''}</div>
      </div>`).join('')}</div>`);
}

async function openTriage(id) {
  const p = await api(`/tickets/${id}`);
  openModal(`Priority — ${p.ticket_number}`, `
    <form id="form-triage">
      ${p.needs_triage ? `<div class="alert alert-warning"><span class="alert-icon">⚠</span><div class="alert-text"><strong>Self-declared emergency</strong><span>Assess the patient and confirm or change the priority. This decision is recorded in the audit log.</span></div></div>` : ''}
      <p>${patientName(p)} · ${esc(p.department_name)}</p>
      <div class="form-group"><label>Priority</label>
        <select name="priority">
          ${['normal', 'priority', 'emergency'].map((v) => `<option value="${v}" ${p.priority === v ? 'selected' : ''}>${PRIORITY_LABEL[v]}</option>`).join('')}
        </select></div>
      <fieldset class="form-group"><legend>Accessibility needs</legend><div class="chips">
        ${state.accessibility.map((n) => `<label class="chip"><input type="checkbox" value="${n}" ${p.accessibility_needs.includes(n) ? 'checked' : ''}> ${esc(NEED_LABEL[n])}</label>`).join('')}
      </div></fieldset>
      <div class="modal-actions">
        <button type="button" class="btn btn-outline" data-action="close-modal">Cancel</button>
        <button type="submit" class="btn btn-primary">${p.needs_triage ? 'Confirm triage' : 'Save'}</button>
      </div>
    </form>`, (body) => {
    $('#form-triage', body).addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('[type=submit]');
      const r = await runAction(btn, () => api(`/tickets/${id}/priority`, {
        method: 'PATCH',
        body: { priority: e.target.priority.value, accessibility_needs: $$('.chip input:checked', e.target).map((i) => i.value) }
      }), (res) => `${res.patient.ticket_number}: priority set to ${PRIORITY_LABEL[res.patient.priority]}`);
      if (r) closeModal();
    });
  });
}

async function cancelTicket(btn, id) {
  const reason = await confirmDialog('Cancel this ticket? The patient will be removed from the queue.', {
    confirm: 'Cancel ticket', danger: true, input: 'Reason (optional) — e.g. patient left'
  });
  if (reason === false) return;
  return runAction(btn, () => api(`/tickets/${id}/cancel`, { method: 'POST', body: { reason } }), (r) => TX_MESSAGES.cancel(r.patient));
}

async function referTicket(id) {
  const p = state.tickets.find((x) => x.id === Number(id));
  openModal(`Refer ${p ? p.ticket_number : ''}`, `
    <form id="form-refer">
      <p class="hint">Issues a new ticket for the same patient in another department (e.g. consultation → pharmacy).</p>
      <div class="form-group"><label>Department</label><select name="department_id">
        ${state.departments.filter((d) => !p || d.id !== p.department_id).map((d) => `<option value="${d.id}">${esc(d.icon || '')} ${esc(d.name)}</option>`).join('')}
      </select></div>
      <div class="modal-actions"><button type="button" class="btn btn-outline" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Issue ticket</button></div>
    </form>`, (body) => {
    $('#form-refer', body).addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await runAction(e.target.querySelector('[type=submit]'),
        () => api(`/tickets/${id}/refer`, { method: 'POST', body: { department_id: Number(e.target.department_id.value) } }));
      if (r) showIssuedTicket(r);
    });
  });
}

// ═══════════════ ANALYTICS ═══════════════
function isoDate(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz() }).format(d);
}

function setRange(days) {
  const to = new Date();
  const from = new Date(Date.now() - days * 86400000);
  $('#an-from').value = isoDate(from);
  $('#an-to').value = isoDate(to);
  $$('#an-presets button').forEach((b) => b.classList.toggle('active', Number(b.dataset.range) === days));
}

function analyticsQuery() {
  const q = new URLSearchParams({ from: $('#an-from').value, to: $('#an-to').value });
  if ($('#an-dept').value) q.set('department_id', $('#an-dept').value);
  return q;
}

async function loadAnalytics() {
  if (!$('#an-from').value) setRange(0);
  const a = await api(`/analytics?${analyticsQuery()}`);
  const s = a.summary;
  const dept = $('#an-dept').value ? state.departments.find((d) => String(d.id) === $('#an-dept').value)?.name : 'All departments';
  $('#an-range-label').textContent = `${a.range.from === a.range.to ? a.range.from : `${a.range.from} → ${a.range.to}`} · ${dept} · computed from ticket records`;
  const tile = (title, value, unit, sub, cls = '') => `
    <div class="card stat ${cls}"><div class="card-title">${title}</div>
      <div class="card-value">${value === null || value === undefined ? '—' : esc(value)}${value !== null && value !== undefined && unit ? `<span class="unit"> ${unit}</span>` : ''}</div>
      <div class="card-sub">${sub}</div></div>`;
  $('#an-stats').innerHTML = [
    tile('Tickets', s.total, '', `${s.served} served · ${s.emergencies} emergencies`),
    tile('Avg wait', s.avg_wait, 'min', s.median_wait === null ? 'arrival → first call' : `median ${s.median_wait} · 90% under ${s.p90_wait} min`),
    tile('Avg service', s.avg_service, 'min', 'first call → served'),
    tile('Throughput', s.throughput_per_hour, '/hr', `over ${s.service_hours} active hour${s.service_hours === 1 ? '' : 's'}`),
    tile('Absent', s.no_show, '', s.no_show_rate === null ? 'no tickets' : `${s.no_show_rate}% of tickets · ${s.cancelled} cancelled`)
  ].join('');
  $('#an-peak').textContent = s.peak_hour === null ? 'no arrivals' : `peak ${String(s.peak_hour).padStart(2, '0')}:00–${String(s.peak_hour + 1).padStart(2, '0')}:00 (${s.peak_hour_arrivals})`;

  // Trim the hourly chart to the hours that matter (06–20, widened if needed).
  const used = a.by_hour.filter((h) => h.arrivals).map((h) => h.hour);
  const lo = Math.min(6, ...used);
  const hi = Math.max(19, ...used);
  barChart($('#an-hourly'), a.by_hour.filter((h) => h.hour >= lo && h.hour <= hi).map((h) => ({
    label: String(h.hour).padStart(2, '0'),
    value: h.arrivals,
    tip: `${String(h.hour).padStart(2, '0')}:00 — ${h.arrivals} arrival${h.arrivals === 1 ? '' : 's'}${h.avg_wait !== null ? ` · avg wait ${h.avg_wait} min` : ''}`
  })), { highlight: s.peak_hour !== null ? String(s.peak_hour).padStart(2, '0') : null });

  const manyDays = a.by_day.length > 14;
  barChart($('#an-daily'), a.by_day.map((d) => {
    const dt = new Date(`${d.date}T12:00:00Z`);
    return {
      label: manyDays ? String(dt.getUTCDate()) : dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', timeZone: 'UTC' }),
      value: d.total,
      tip: `${d.date} — ${d.total} tickets · ${d.served} served${d.avg_wait !== null ? ` · avg wait ${d.avg_wait} min` : ''}`
    };
  }));

  const pct = (v) => (v === null ? '—' : `${v}%`);
  const min = (v) => (v === null ? '—' : `${v} min`);
  $('#an-dept-table').innerHTML = a.by_department.length ? a.by_department.map((d) => `
    <tr><td>${esc(d.department_name)}</td><td class="num">${d.total}</td><td class="num">${d.served}</td><td class="num">${d.no_show}</td>
    <td class="num">${d.cancelled}</td><td class="num">${min(d.avg_wait)}</td><td class="num">${min(d.median_wait)}</td><td class="num">${min(d.p90_wait)}</td>
    <td class="num">${min(d.avg_service)}</td><td class="num">${pct(d.no_show_rate)}</td></tr>`).join('')
    : `<tr><td colspan="10">${emptyState('📈', 'No tickets in this period')}</td></tr>`;
}

// Single-series column chart: one hue, rounded data ends on a shared baseline, hover tooltips.
function barChart(el, data, { highlight } = {}) {
  const max = Math.max(...data.map((d) => d.value));
  if (!data.length || max === 0) {
    el.innerHTML = `<div class="chart-empty">No data for this period</div>`;
    return;
  }
  el.innerHTML = `<div class="chart-bars" role="img" aria-label="${esc(data.map((d) => `${d.label}: ${d.value}`).join(', '))}">${data.map((d) => `
    <div class="chart-col" data-tip="${esc(d.tip)}" tabindex="0">
      <div class="chart-val">${d.value || ''}</div>
      <div class="chart-bar ${d.label === highlight ? 'is-peak' : ''}" style="height:${d.value ? Math.max(3, Math.round((d.value / max) * 100)) : 0}%"></div>
      <div class="chart-label">${esc(d.label)}</div>
    </div>`).join('')}</div><div class="chart-tip" hidden></div>`;
  const tip = $('.chart-tip', el);
  const show = (col) => {
    tip.textContent = col.dataset.tip;
    tip.hidden = false;
    const r = col.getBoundingClientRect();
    const host = el.getBoundingClientRect();
    tip.style.left = `${Math.min(host.width - tip.offsetWidth, Math.max(0, r.left - host.left + r.width / 2 - tip.offsetWidth / 2))}px`;
    col.classList.add('hover');
  };
  const hide = (col) => { tip.hidden = true; col.classList.remove('hover'); };
  $$('.chart-col', el).forEach((col) => {
    col.addEventListener('mouseenter', () => show(col));
    col.addEventListener('focus', () => show(col));
    col.addEventListener('mouseleave', () => hide(col));
    col.addEventListener('blur', () => hide(col));
  });
}

$('#an-presets').addEventListener('click', (e) => {
  const b = e.target.closest('[data-range]');
  if (!b) return;
  setRange(Number(b.dataset.range));
  loadAnalytics().catch((err) => toast(err.message, 'error'));
});
for (const id of ['#an-from', '#an-to', '#an-dept']) {
  $(id).addEventListener('change', () => {
    $$('#an-presets button').forEach((b) => b.classList.remove('active'));
    loadAnalytics().catch((err) => toast(err.message, 'error'));
  });
}

async function exportCsv() {
  try {
    const res = await fetch(`/api/analytics/export.csv?${analyticsQuery()}`, { headers: { Authorization: `Bearer ${store.get(TOKEN_KEY)}` } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Export failed');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (res.headers.get('Content-Disposition') || '').match(/filename="(.+)"/)?.[1] || 'sqhs-report.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ═══════════════ SMS ═══════════════
const SMS_STATUS = {
  sent: ['badge-done', '✓ Sent'],
  queued: ['badge-in-progress', 'Accepted by provider'],
  pending: ['badge-waiting', 'Sending…'],
  failed: ['badge-emergency', '⚠ Failed'],
  not_configured: ['badge-waiting', 'Not delivered — no provider']
};

async function loadSms() {
  const [status, log, active] = await Promise.all([
    api('/notifications/status'), api('/notifications/log'), api('/tickets?status=active')
  ]);
  $('#sms-provider').innerHTML = status.configured
    ? `<div class="alert alert-good"><span class="alert-icon">✓</span><div class="alert-text"><strong>SMS provider connected (${esc(status.provider)})</strong><span>Sending from ${esc(status.from)}. Statuses below are reported by the provider.</span></div></div>`
    : `<div class="alert alert-warning"><span class="alert-icon">⚠</span><div class="alert-text"><strong>SMS is not configured — messages are logged but NOT delivered</strong><span>${esc(status.reason)}</span></div></div>`;
  const sel = $('#sms-to');
  const keep = sel.value;
  const withPhone = active.filter((p) => p.phone);
  sel.innerHTML = `<option value="">— Select ticket —</option>${withPhone.map((p) => `<option value="${p.id}">${esc(p.ticket_number)} · ${patientName(p)} · ${esc(p.department_name)}</option>`).join('')}`;
  sel.value = keep;
  $('#sms-log').innerHTML = log.length ? log.map((s) => {
    const [cls, label] = SMS_STATUS[s.status] || ['badge-waiting', s.status];
    return `<div class="sms-entry">
      <div class="sms-entry-head">
        <strong>${esc(s.recipient_name)}</strong> <span class="muted">${esc(s.recipient_phone)}</span>
        <span class="tag">${esc(s.kind || (s.is_auto ? 'auto' : 'manual'))}</span>
        <span class="badge ${cls}">${esc(label)}</span>
        <span class="muted sms-time">${fmtTime(s.sent_at, tz())}</span>
      </div>
      <div class="sms-msg">${esc(s.message)}</div>
      ${s.status === 'failed' && s.error ? `<div class="sms-error">${esc(s.error)}</div>` : ''}
      ${s.sent_by_name ? `<div class="hint">by ${esc(s.sent_by_name)}</div>` : ''}
    </div>`;
  }).join('') : emptyState('💬', 'No messages yet');
}

$('#sms-template').addEventListener('change', (e) => { if (e.target.value) { $('#sms-body').value = e.target.value; updateSmsCount(); } });
const updateSmsCount = () => { $('#sms-count').textContent = `${$('#sms-body').value.length}/480`; };
$('#sms-body').addEventListener('input', updateSmsCount);

function smsOutcome(r) {
  if (r.status === 'not_configured') return ['Logged only — no SMS provider is configured, so nothing was delivered', 'info'];
  if (r.status === 'failed') return [`SMS failed: ${r.error}`, 'error'];
  return [r.status === 'queued' ? 'SMS accepted by the provider' : 'SMS sent', 'ok'];
}

// ═══════════════ SETTINGS ═══════════════
async function loadSettings() {
  const isAdmin = can('admin:manage');
  $('#settings-sub').textContent = isAdmin ? 'Configure the system for your health center' : 'Your account. System settings are managed by an administrator.';
  if (!isAdmin) return;
  const [settings, departments, counters, users, sms] = await Promise.all([
    api('/settings'), api('/departments?include_inactive=1'), api('/counters'), api('/users'), api('/notifications/status')
  ]);
  state.settings = settings;
  state.counters = counters;
  for (const form of ['#form-facility', '#form-rules', '#form-notify']) {
    for (const input of $$('[name]', $(form))) {
      const v = settings[input.name];
      if (input.type === 'checkbox') input.checked = !!v;
      else input.value = v ?? '';
    }
  }
  $('#settings-sms-status').innerHTML = sms.configured
    ? `<p class="hint">✓ Provider: ${esc(sms.provider)} (${esc(sms.from)})</p>`
    : `<div class="alert alert-warning"><span class="alert-icon">⚠</span><div class="alert-text"><strong>No SMS provider configured</strong><span>Set the Twilio variables on the server to enable delivery. Until then messages are logged as not delivered.</span></div></div>`;

  $('#dept-settings').innerHTML = departments.map((d) => `
    <div class="setting-row ${d.is_active ? '' : 'is-inactive'}">
      <div class="setting-main"><span class="setting-icon">${esc(d.icon || '')}</span>
        <div><div>${esc(d.name)} <span class="tag">${esc(d.code)}</span></div>
        <div class="hint">typical service ${d.default_service_minutes} min · ${counters.filter((c) => c.department_id === d.id && c.is_active).length} open counter(s)</div></div></div>
      <div class="flex-gap"><span class="badge ${d.is_active ? 'badge-done' : 'badge-waiting'}">${d.is_active ? 'Active' : 'Inactive'}</span>
        <button class="btn-icon" data-action="edit-dept" data-id="${d.id}" aria-label="Edit ${esc(d.name)}">✏️</button></div>
    </div>`).join('');
  state.allDepartments = departments;

  $('#counter-settings').innerHTML = departments.filter((d) => d.is_active).map((d) => {
    const cs = counters.filter((c) => c.department_id === d.id);
    return `<div class="counter-group"><div class="hint">${esc(d.name)}</div>${cs.map((c) => `
      <div class="setting-row ${c.is_active ? '' : 'is-inactive'}">
        <div class="setting-main"><div>${esc(c.name)}${c.active_ticket ? ` <span class="badge badge-in-progress">attending ${esc(c.active_ticket)}</span>` : ''}</div></div>
        <div class="flex-gap">
          <button class="btn btn-sm btn-ghost" data-action="rename-counter" data-id="${c.id}">Rename</button>
          <button class="btn btn-sm ${c.is_active ? 'btn-outline' : 'btn-primary'}" data-action="toggle-counter" data-id="${c.id}" data-active="${c.is_active}">${c.is_active ? 'Close' : 'Open'}</button>
        </div>
      </div>`).join('')}</div>`;
  }).join('');

  $('#user-settings').innerHTML = users.map((u) => `
    <div class="setting-row ${u.is_active ? '' : 'is-inactive'}">
      <div class="setting-main"><div class="avatar avatar-sm">${esc(initials(u.full_name))}</div>
        <div><div>${esc(u.full_name)} <span class="muted">@${esc(u.username)}</span></div>
        <div class="hint">${u.last_login_at ? `last sign-in ${new Date(u.last_login_at).toLocaleDateString('en-GB')}` : 'never signed in'}</div></div></div>
      <div class="flex-gap">
        <select data-action-change="user-role" data-id="${u.id}" ${u.id === state.user.id ? 'disabled' : ''} aria-label="Role">
          ${['admin', 'receptionist', 'nurse', 'doctor'].map((r) => `<option ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}
        </select>
        <button class="btn btn-sm btn-ghost" data-action="reset-password" data-id="${u.id}">Reset password</button>
        ${u.id === state.user.id ? '' : `<button class="btn btn-sm ${u.is_active ? 'btn-danger' : 'btn-primary'}" data-action="toggle-user" data-id="${u.id}" data-active="${u.is_active}">${u.is_active ? 'Deactivate' : 'Activate'}</button>`}
      </div>
    </div>`).join('');
}

function formValues(form) {
  const out = {};
  for (const input of $$('[name]', form)) {
    if (input.type === 'checkbox') out[input.name] = input.checked;
    else if (input.type === 'number') out[input.name] = Number(input.value);
    else out[input.name] = input.value;
  }
  return out;
}

for (const id of ['#form-facility', '#form-rules', '#form-notify']) {
  $(id).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      state.settings = await api('/settings', { method: 'PUT', body: formValues(e.target) });
      $('#brand-facility').textContent = state.settings.facility_name;
      toast('Settings saved');
    } catch (err) {
      toast(err.data?.fields ? `${err.message}: ${Object.entries(err.data.fields).map(([k, v]) => `${k} ${v}`).join('; ')}` : err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

$('#form-password').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await runAction(e.target.querySelector('[type=submit]'), () => api('/auth/change-password', { method: 'POST', body: formValues(e.target) }), 'Password changed');
  if (r) e.target.reset();
});

function editDepartment(id) {
  const d = id ? state.allDepartments.find((x) => x.id === Number(id)) : { name: '', code: '', icon: '🏥', description: '', default_service_minutes: 10, is_active: true };
  openModal(id ? `Edit ${d.name}` : 'New department', `
    <form id="form-dept">
      <div class="two-col">
        <div class="form-group"><label>Name *</label><input name="name" value="${esc(d.name)}" maxlength="120" required></div>
        <div class="form-group"><label>Ticket prefix * <span class="hint">1–3 letters</span></label><input name="code" value="${esc(d.code)}" maxlength="3" pattern="[A-Za-z]{1,3}" required></div>
      </div>
      <div class="two-col">
        <div class="form-group"><label>Icon</label><input name="icon" value="${esc(d.icon || '')}" maxlength="8"></div>
        <div class="form-group"><label>Typical service time (min)</label><input type="number" name="default_service_minutes" value="${d.default_service_minutes}" min="1" max="240"><span class="hint">Used for wait estimates until enough history exists.</span></div>
      </div>
      <div class="form-group"><label>Description</label><input name="description" value="${esc(d.description || '')}" maxlength="500"></div>
      ${id ? `<label class="check"><input type="checkbox" name="is_active" ${d.is_active ? 'checked' : ''}> Active (shown at the kiosk and on the board)</label>` : ''}
      <div class="modal-actions"><button type="button" class="btn btn-outline" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Save</button></div>
    </form>`, (body) => {
    $('#form-dept', body).addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await runAction(e.target.querySelector('[type=submit]'),
        () => api(id ? `/departments/${id}` : '/departments', { method: id ? 'PATCH' : 'POST', body: formValues(e.target) }), 'Department saved');
      if (r) { closeModal(); await reloadReference(); }
    });
  });
}

async function reloadReference() {
  [state.departments, state.counters] = await Promise.all([api('/departments'), api('/counters')]);
  fillDepartmentSelects();
}

function newCounter() {
  openModal('New service counter', `
    <form id="form-counter">
      <div class="form-group"><label>Department</label><select name="department_id">${state.departments.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
      <div class="form-group"><label>Counter name *</label><input name="name" maxlength="100" placeholder="e.g. Room 3 or Window 2" required></div>
      <div class="modal-actions"><button type="button" class="btn btn-outline" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Add counter</button></div>
    </form>`, (body) => {
    $('#form-counter', body).addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = formValues(e.target);
      const r = await runAction(e.target.querySelector('[type=submit]'),
        () => api('/counters', { method: 'POST', body: { department_id: Number(v.department_id), name: v.name } }), 'Counter added');
      if (r) { closeModal(); await reloadReference(); }
    });
  });
}

function newUser() {
  openModal('New staff account', `
    <form id="form-user">
      <div class="two-col">
        <div class="form-group"><label>Full name *</label><input name="full_name" maxlength="120" required></div>
        <div class="form-group"><label>Username *</label><input name="username" maxlength="50" pattern="[A-Za-z0-9._\\-]{3,50}" required></div>
      </div>
      <div class="two-col">
        <div class="form-group"><label>Role</label><select name="role">
          <option value="receptionist">Receptionist — register, cancel, SMS</option>
          <option value="nurse">Nurse — register, call, serve, triage</option>
          <option value="doctor">Doctor — call, serve, triage</option>
          <option value="admin">Administrator — everything</option>
        </select></div>
        <div class="form-group"><label>Email</label><input name="email" type="email" maxlength="255"></div>
      </div>
      <div class="form-group"><label>Initial password * (min 8)</label><input name="password" type="password" minlength="8" autocomplete="new-password" required></div>
      <div class="modal-actions"><button type="button" class="btn btn-outline" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Create account</button></div>
    </form>`, (body) => {
    $('#form-user', body).addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await runAction(e.target.querySelector('[type=submit]'), () => api('/users', { method: 'POST', body: formValues(e.target) }), 'Staff account created');
      if (r) closeModal();
    });
  });
}

document.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-action-change="user-role"]');
  if (!el) return;
  await runAction(el, () => api(`/users/${el.dataset.id}`, { method: 'PATCH', body: { role: el.value } }), 'Role updated');
});

// ═══════════════ MODAL ═══════════════
let modalOnClose = null;
function openModal(title, content, onMount, onClose) {
  $('#modal-title').textContent = title;
  const body = $('#modal-body');
  body.innerHTML = '';
  if (typeof content === 'string') body.innerHTML = content;
  else body.appendChild(content);
  modalOnClose = onClose || null;
  $('#modal').classList.add('open');
  if (onMount) onMount(body);
}
function closeModal() {
  $('#modal').classList.remove('open');
  const cb = modalOnClose;
  modalOnClose = null;
  if (cb) cb();
}
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#modal').classList.contains('open')) closeModal(); });

// Resolves to false when dismissed, otherwise true (or the typed text when `input` is given).
function confirmDialog(message, { confirm = 'Confirm', danger = false, input } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    openModal('Please confirm', `
      <form id="form-confirm"><p>${esc(message)}</p>
        ${input ? `<div class="form-group"><input name="value" placeholder="${esc(input)}" maxlength="300"></div>` : ''}
        <div class="modal-actions"><button type="button" class="btn btn-outline" data-action="close-modal">Go back</button>
        <button type="submit" class="btn ${danger ? 'btn-danger-solid' : 'btn-primary'}">${esc(confirm)}</button></div></form>`, (body) => {
      const f = $('#form-confirm', body);
      (f.value || f.querySelector('[type=submit]')).focus();
      f.addEventListener('submit', (e) => {
        e.preventDefault();
        const v = input ? f.value.value.trim() : true;
        modalOnClose = null;
        closeModal();
        done(v);
      });
    }, () => done(false));
  });
}

// ═══════════════ ACTION DISPATCH ═══════════════
const ACTIONS = {
  logout() {
    store.remove(TOKEN_KEY);
    state.user = null;
    showLogin();
  },
  'open-register': openRegister,
  'close-modal': closeModal,
  'print-ticket'() {
    const ticket = $('#print-ticket');
    if (!ticket) return;
    const w = window.open('', '_blank', 'width=360,height=480');
    if (!w) return toast('Allow pop-ups to print tickets', 'error');
    w.document.write(`<!doctype html><title>Ticket</title><style>body{font-family:sans-serif;text-align:center;padding:24px}.t-num{font-size:64px;font-weight:700;margin:8px 0}</style>${ticket.outerHTML}<p>${esc(state.settings.facility_name)}</p>`);
    w.document.close();
    w.focus();
    w.print();
  },
  async 'call-next'(btn) {
    const counter = myCounter();
    if (!counter) return toast('Select your counter first', 'error');
    const r = await runAction(btn, () => api(`/counters/${counter.id}/call-next`, { method: 'POST' }));
    if (r) toast(r.patient ? `📣 Calling ${r.patient.ticket_number} to ${r.counter.name}` : r.message, r.patient ? 'ok' : 'info');
  },
  'call-specific'(btn) { return callSpecific(btn, btn.dataset.id, btn.dataset.dept); },
  tx(btn) { return doTransition(btn, btn.dataset.id, btn.dataset.tx); },
  cancel(btn) { return cancelTicket(btn, btn.dataset.id); },
  triage(btn) { return openTriage(btn.dataset.id).catch((e) => toast(e.message, 'error')); },
  refer(btn) { return referTicket(btn.dataset.id); },
  'ticket-detail'(el) { return ticketDetail(el.dataset.id).catch((e) => toast(e.message, 'error')); },
  'export-csv'(_el, e) { e.preventDefault(); return exportCsv(); },
  async 'send-sms'(btn) {
    const id = $('#sms-to').value;
    const message = $('#sms-body').value.trim();
    if (!id || !message) return toast('Select a ticket and enter a message', 'error');
    const r = await runAction(btn, () => api('/notifications/sms', { method: 'POST', body: { patient_id: Number(id), message } }));
    if (r) { const [msg, kind] = smsOutcome(r); toast(msg, kind); }
  },
  async broadcast(btn) {
    const message = $('#broadcast-msg').value.trim();
    if (!message) return toast('Enter a message first', 'error');
    const dept = $('#broadcast-dept').value;
    if (!(await confirmDialog(`Send this message to every waiting patient${dept ? ' in the selected department' : ''} who gave a phone number?`, { confirm: 'Broadcast' }))) return;
    const r = await runAction(btn, () => api('/notifications/broadcast', { method: 'POST', body: { message, department_id: dept ? Number(dept) : null } }));
    if (!r) return;
    $('#broadcast-msg').value = '';
    const delivered = r.sent + r.queued;
    toast(r.recipients === 0 ? 'No waiting patients with a phone number'
      : r.not_configured ? `Logged for ${r.recipients} patient(s) — not delivered, no SMS provider configured`
        : `Sent to ${delivered} of ${r.recipients}${r.failed ? ` · ${r.failed} failed` : ''}`, r.failed || r.not_configured ? 'info' : 'ok');
  },
  'refresh-sms'() { return loadSms(); },
  'new-dept'() { editDepartment(null); },
  'edit-dept'(btn) { editDepartment(btn.dataset.id); },
  'new-counter': newCounter,
  async 'rename-counter'(btn) {
    const name = await confirmDialog('New name for this counter', { confirm: 'Rename', input: 'e.g. Room 3' });
    if (!name) return;
    await runAction(btn, () => api(`/counters/${btn.dataset.id}`, { method: 'PATCH', body: { name } }), 'Counter renamed');
    reloadReference();
  },
  async 'toggle-counter'(btn) {
    await runAction(btn, () => api(`/counters/${btn.dataset.id}`, { method: 'PATCH', body: { is_active: btn.dataset.active !== 'true' } }), 'Counter updated');
    reloadReference();
  },
  'new-user': newUser,
  async 'toggle-user'(btn) {
    const activate = btn.dataset.active !== 'true';
    if (!activate && !(await confirmDialog('Deactivate this account? The person is signed out immediately.', { confirm: 'Deactivate', danger: true }))) return;
    await runAction(btn, () => api(`/users/${btn.dataset.id}`, { method: 'PATCH', body: { is_active: activate } }), activate ? 'Account activated' : 'Account deactivated');
  },
  async 'reset-password'(btn) {
    const password = await confirmDialog('Set a new password for this account (min 8 characters).', { confirm: 'Set password', input: 'New password' });
    if (!password) return;
    await runAction(btn, () => api(`/users/${btn.dataset.id}`, { method: 'PATCH', body: { password } }), 'Password updated');
  }
};

document.addEventListener('click', (e) => {
  const pageLink = e.target.closest('[data-page]');
  if (pageLink && !e.target.closest('[data-action]')) {
    e.preventDefault();
    closeModal();
    return showPage(pageLink.dataset.page);
  }
  const el = e.target.closest('[data-action]');
  if (!el || !ACTIONS[el.dataset.action] || el.disabled) return;
  const r = ACTIONS[el.dataset.action](el, e);
  if (r && r.catch) r.catch((err) => toast(err.message, 'error'));
});

boot();
