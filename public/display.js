// Waiting-room display board. Public data only: ticket numbers, counters, departments.
const { api, esc, $ } = SQHS;

let board = null;
// Browsers block audio until someone taps the screen, so sound always starts off after a reload.
let soundOn = false;
let audioCtx = null;
let lastCall = null;
const announceQueue = [];
let announcing = false;

async function load() {
  try {
    board = await api('/public/board', { auth: false });
    render();
    $('#b-status').textContent = `Updated ${new Date(board.generated_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  } catch (err) {
    $('#b-status').textContent = `⚠ ${err.message}`;
  }
}

function render() {
  $('#b-title').textContent = `🏥 ${board.facility_name} — Queue Status`;
  document.title = `${board.facility_name} — Display`;

  // Hero: the most recent call (from the live event, else the latest active ticket).
  const all = board.departments.flatMap((d) => d.serving.map((s) => ({ ...s, department_name: d.name })));
  all.sort((a, b) => new Date(b.called_at) - new Date(a.called_at));
  const hero = lastCall && all.some((s) => s.ticket_number === lastCall.ticket_number) ? lastCall : all[0];
  $('#b-hero-ticket').textContent = hero ? hero.ticket_number : '—';
  $('#b-hero-counter').textContent = hero ? `→ ${hero.counter_name}` : 'Please wait for your number';
  $('#b-hero').classList.toggle('is-idle', !hero);

  $('#b-cells').innerHTML = board.departments.map((d) => `
    <article class="board-cell ${d.serving.length ? 'active' : ''}">
      <div class="bc-dept">${esc(d.icon || '')} ${esc(d.name)}</div>
      <div class="bc-serving">${d.serving.length ? d.serving.map((s) => `
        <div class="bc-row ${lastCall && lastCall.ticket_number === s.ticket_number ? 'flash' : ''}">
          <span class="bc-num">${esc(s.ticket_number)}</span><span class="bc-counter">${esc(s.counter_name)}</span>
        </div>`).join('') : '<div class="bc-row"><span class="bc-num bc-none">—</span></div>'}</div>
      <div class="bc-next">${d.upcoming.length ? `Next: ${d.upcoming.map((t) => `<span>${esc(t)}</span>`).join('')}` : (d.waiting ? `${d.waiting} waiting` : 'No one waiting')}</div>
    </article>`).join('');
}

// ─── Audio announcements ─────────────────────────────────────────────
function updateSoundButton() {
  const enabled = soundOn && board?.audio !== false;
  $('#b-sound').textContent = board && board.audio === false ? '🔇 Sound disabled in settings' : enabled ? '🔊 Sound on' : '🔇 Enable sound';
}

$('#b-sound').addEventListener('click', () => {
  soundOn = !soundOn;
  // Browsers only allow audio after a user gesture — create the context here.
  if (soundOn && !audioCtx && window.AudioContext) audioCtx = new AudioContext();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  updateSoundButton();
  if (soundOn) chime();
});

function chime() {
  if (!audioCtx) return Promise.resolve();
  const now = audioCtx.currentTime;
  [[659.25, 0], [880, 0.28]].forEach(([freq, at]) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + at);
    gain.gain.exponentialRampToValueAtTime(0.3, now + at + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.9);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now + at);
    osc.stop(now + at + 1);
  });
  return new Promise((r) => setTimeout(r, 1100));
}

// "G004" → "G, 4" so speech engines read it clearly.
function spoken(ticket) {
  const m = /^([A-Z]+)0*(\d+)$/.exec(ticket);
  return m ? `${m[1].split('').join(' ')}, ${m[2]}` : ticket;
}

function speak(text) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-GB';
    u.rate = 0.9;
    u.onend = resolve;
    u.onerror = resolve;
    speechSynthesis.speak(u);
    setTimeout(resolve, 8000);
  });
}

async function drainAnnouncements() {
  if (announcing) return;
  announcing = true;
  while (announceQueue.length) {
    const call = announceQueue.shift();
    if (!soundOn || board?.audio === false) continue;
    await chime();
    const text = `Ticket ${spoken(call.ticket_number)}, please go to ${call.counter_name}.`;
    await speak(text);
    await speak(text);
  }
  announcing = false;
}

function onCall(call) {
  lastCall = call;
  announceQueue.push(call);
  load().then(() => {
    const hero = $('#b-hero');
    hero.classList.remove('pulse');
    void hero.offsetWidth; // restart animation
    hero.classList.add('pulse');
  });
  drainAnnouncements();
}

// ─── Clock & live updates ────────────────────────────────────────────
function tick() {
  $('#b-clock').textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
setInterval(tick, 1000);
tick();

SQHS.live({
  onChange: load,
  onCall,
  onStatus: (ok) => { if (!ok) $('#b-status').textContent = '⚠ Reconnecting…'; },
  pollMs: 20000
});
load().then(updateSoundButton);
