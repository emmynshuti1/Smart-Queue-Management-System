// Shared by the staff console, kiosk and display board.
(function (global) {
  const TOKEN_KEY = 'sqhs.token';

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* storage unavailable */ } },
    remove(k) { try { localStorage.removeItem(k); } catch (_) { /* storage unavailable */ } }
  };

  class ApiError extends Error {
    constructor(status, data) {
      super((data && data.error) || `Request failed (${status})`);
      this.status = status;
      this.data = data || {};
    }
  }

  let onUnauthorized = null;

  async function api(path, { method = 'GET', body, auth = true } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = store.get(TOKEN_KEY);
    if (auth && token) headers.Authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetch('/api' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (_) {
      throw new ApiError(0, { error: 'Cannot reach the server. Check the network connection.' });
    }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 401 && auth && onUnauthorized) onUnauthorized(data);
      throw new ApiError(res.status, data);
    }
    return data;
  }

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => (v === null || v === undefined ? '' : String(v).replace(/[&<>"']/g, (c) => ESC[c]));

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  let toastTimer;
  function toast(msg, kind = 'ok') {
    const t = $('#toast');
    if (!t) return;
    $('#toast-msg').textContent = msg;
    $('#toast-icon').textContent = kind === 'error' ? '⚠' : kind === 'info' ? 'ℹ' : '✓';
    t.className = `toast show toast-${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), kind === 'error' ? 5000 : 3000);
  }

  function fmtTime(iso, tz) {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', ...(tz && { timeZone: tz }) });
  }

  function fmtMinutes(m) {
    if (m === null || m === undefined) return '—';
    if (m < 1) return '<1 min';
    if (m < 60) return `${Math.round(m)} min`;
    const h = Math.floor(m / 60);
    const r = Math.round(m % 60);
    return r ? `${h} h ${r} min` : `${h} h`;
  }

  function fmtEta(m) {
    if (m === null || m === undefined) return '—';
    if (m === 0) return 'Next';
    return `~${fmtMinutes(m)}`;
  }

  /**
   * Live updates: socket.io push with debounced refresh, plus a polling fallback so screens
   * stay correct even if the socket drops. onChange(event) is called for any change.
   */
  function live({ onChange, onCall, onStatus, pollMs = 30000 }) {
    let timer = null;
    const trigger = (evt) => {
      clearTimeout(timer);
      timer = setTimeout(() => onChange(evt || {}), 120);
    };
    let socket = null;
    if (global.io) {
      socket = global.io({ transports: ['websocket', 'polling'] });
      socket.on('connect', () => { onStatus && onStatus(true); trigger({ reason: 'reconnect' }); });
      socket.on('disconnect', () => onStatus && onStatus(false));
      socket.on('connect_error', () => onStatus && onStatus(false));
      socket.on('queue:changed', trigger);
      if (onCall) socket.on('board:call', onCall);
    } else if (onStatus) {
      onStatus(false);
    }
    const poll = setInterval(() => trigger({ reason: 'poll' }), pollMs);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) trigger({ reason: 'visible' }); });
    return { socket, refresh: trigger, stop: () => { clearInterval(poll); socket && socket.close(); } };
  }

  const PRIORITY_LABEL = { normal: 'Normal', priority: 'Priority', emergency: 'Emergency' };
  const STATUS_LABEL = {
    waiting: 'Waiting', called: 'Called', 'in-progress': 'In service',
    done: 'Served', 'no-show': 'Absent', cancelled: 'Cancelled'
  };
  const NEED_LABEL = { wheelchair: '♿ Wheelchair', visual: '👁 Visual', hearing: '🦻 Hearing', interpreter: '🗣 Interpreter', mobility: '🦯 Mobility' };

  global.SQHS = {
    api, ApiError, esc, $, $$, toast, fmtTime, fmtMinutes, fmtEta, live, store, TOKEN_KEY,
    PRIORITY_LABEL, STATUS_LABEL, NEED_LABEL,
    setUnauthorizedHandler(fn) { onUnauthorized = fn; }
  };
})(window);
