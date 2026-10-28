// Self-service kiosk. Uses only public endpoints — no staff session, and it never
// displays anyone else's details.
const { api, esc, $, $$, fmtEta, NEED_LABEL } = SQHS;

const RESET_AFTER_TICKET_S = 30;
const RESET_AFTER_IDLE_S = 90;

let info = null;
let selected = null;
let idleTimer = null;
let countdown = null;

function step(n) {
  ['#k-step-0', '#k-step-1', '#k-step-2', '#k-disabled'].forEach((id, i) => { $(id).hidden = i !== n; });
  window.scrollTo(0, 0);
}

async function loadInfo() {
  try {
    info = await api('/public/info', { auth: false });
  } catch (err) {
    $('#k-depts').innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
    return;
  }
  const s = info.settings;
  $('#k-facility').textContent = s.facility_name;
  document.title = `${s.facility_name} — Kiosk`;
  if (!s.kiosk_enabled) return step(3);
  if ($('#k-disabled').hidden === false) step(0);
  $('#k-phone-label').textContent = s.kiosk_require_phone ? 'Phone number *' : 'Phone number (optional — for SMS updates)';
  if (!info.sms_available && !s.kiosk_require_phone) $('#k-phone-label').textContent = 'Phone number (optional)';
  if (!$('#k-needs').children.length) {
    $('#k-needs').innerHTML = info.accessibility_needs.map((n) => `<label class="chip chip-lg"><input type="checkbox" value="${n}"> ${esc(NEED_LABEL[n] || n)}</label>`).join('');
  }
  renderDepartments();
}

function renderDepartments() {
  $('#k-depts').innerHTML = info.departments.map((d) => `
    <button class="dept-card ${selected && selected.id === d.id ? 'selected' : ''}" data-dept="${d.id}">
      <div class="dept-icon">${esc(d.icon || '🏥')}</div>
      <div class="dept-name">${esc(d.name)}</div>
      <div class="dept-wait">${d.waiting} waiting · ${d.eta_minutes === 0 ? 'no wait' : `${fmtEta(d.eta_minutes)} wait`}</div>
    </button>`).join('') || '<p>No services available right now. Please visit reception.</p>';
}

$('#k-depts').addEventListener('click', (e) => {
  const card = e.target.closest('[data-dept]');
  if (!card) return;
  selected = info.departments.find((d) => String(d.id) === card.dataset.dept);
  $('#k-selected-dept').textContent = `${selected.icon || ''} ${selected.name}`;
  $('#k-error').hidden = true;
  step(1);
  $('#k-name').focus();
});

$('#k-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('[type=submit]');
  const err = $('#k-error');
  err.hidden = true;
  if (!f.full_name.value.trim()) {
    err.textContent = 'Please enter your name';
    err.hidden = false;
    return f.full_name.focus();
  }
  btn.disabled = true;
  btn.textContent = 'Please wait…';
  try {
    const r = await api('/public/tickets', {
      method: 'POST', auth: false,
      body: {
        department_id: selected.id,
        full_name: f.full_name.value,
        phone: f.phone.value,
        priority: f.priority.value,
        accessibility_needs: $$('#k-needs input:checked').map((i) => i.value)
      }
    });
    showTicket(r);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Get my number →';
  }
});

function showTicket(r) {
  $('#k-ticket-num').textContent = r.ticket_number;
  $('#k-ticket-dept').textContent = r.department;
  $('#k-ticket').classList.toggle('ticket-emergency', r.emergency);
  $('#k-ticket-est').textContent = r.emergency
    ? 'Please tell a staff member now'
    : r.eta_minutes === 0 ? 'You are next — watch the display board' : `Position ${r.position} · estimated wait ${fmtEta(r.eta_minutes)}`;
  let msg = '';
  if (r.emergency) {
    msg = `<div class="alert alert-critical"><span class="alert-icon">🚨</span><div class="alert-text"><strong>Go to the reception desk now</strong><span>A nurse will assess you straight away. Staff have been alerted on their screens.</span></div></div>`;
  }
  msg += r.sms
    ? `<div class="sms-preview">📱 We will text you when it is your turn.</div>`
    : `<p class="hint center">Keep this number and watch the display board — your number and counter will appear there when it is your turn.</p>`;
  $('#k-ticket-msg').innerHTML = msg;
  step(2);
  scheduleReset(RESET_AFTER_TICKET_S);
}

function scheduleReset(seconds) {
  clearInterval(countdown);
  let left = seconds;
  const note = $('#k-reset-note');
  note.textContent = `This screen resets in ${left} s`;
  countdown = setInterval(() => {
    left -= 1;
    note.textContent = `This screen resets in ${left} s`;
    if (left <= 0) reset();
  }, 1000);
}

function reset() {
  clearInterval(countdown);
  selected = null;
  $('#k-form').reset();
  $$('#k-needs input').forEach((i) => { i.checked = false; });
  $('#k-ticket-num').textContent = '—';
  step(info && !info.settings.kiosk_enabled ? 3 : 0);
  if (info) renderDepartments();
}

// Clear half-entered personal details if someone walks away from the kiosk.
function bumpIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!$('#k-step-1').hidden) reset(); }, RESET_AFTER_IDLE_S * 1000);
}
['pointerdown', 'keydown', 'input'].forEach((ev) => document.addEventListener(ev, bumpIdle));

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.action === 'back') { selected = null; step(0); renderDepartments(); }
  if (el.dataset.action === 'reset') reset();
  if (el.dataset.action === 'print') { window.print(); scheduleReset(RESET_AFTER_TICKET_S); }
});

function tick() {
  $('#k-clock').textContent = new Date().toLocaleString('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit' });
}
setInterval(tick, 15000);
tick();

SQHS.live({
  onChange: () => { if ($('#k-step-2').hidden) loadInfo(); },
  pollMs: 60000
});
loadInfo();
