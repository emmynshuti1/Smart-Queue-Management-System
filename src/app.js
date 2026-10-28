const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const config = require('./config');
const { pool } = require('./db');
const { migrate } = require('./schema');
const settings = require('./settings');
const queue = require('./queue');
const notify = require('./notify');
const { buildRouter } = require('./routes');
const { errorHandler } = require('./http');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function securityHeaders(_req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self' ws: wss:",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; ')
  });
  next();
}

function createApp() {
  const app = express();
  app.set('trust proxy', 1); // correct client IPs for rate limiting behind Railway/Render/nginx
  app.disable('x-powered-by');
  app.use(securityHeaders);
  if (config.frontendUrl) app.use('/api', cors({ origin: config.frontendUrl }));
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', database: 'ok' });
    } catch (_) {
      res.status(503).json({ status: 'degraded', database: 'unreachable' });
    }
  });

  // API responses carry patient data — never cache them.
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, buildRouter());

  app.get('/kiosk', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'kiosk.html')));
  app.get('/display', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'display.html')));
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', extensions: ['html'] }));

  app.use(errorHandler);
  return app;
}

function attachRealtime(server) {
  const io = new Server(server, config.frontendUrl ? { cors: { origin: config.frontendUrl } } : {});

  // Only change signals and public ticket numbers go over the socket — never names or contact
  // details. Clients refetch through the authenticated REST API, which applies role rules.
  let pending = new Set();
  let timer = null;
  queue.events.on('changed', ({ departmentIds, reason }) => {
    departmentIds.forEach((id) => pending.add(id));
    if (timer) return;
    timer = setTimeout(() => {
      io.emit('queue:changed', { department_ids: [...pending], reason, at: new Date().toISOString() });
      pending = new Set();
      timer = null;
    }, 150);
  });
  queue.events.on('called', ({ patient, counter, recall }) => {
    io.emit('board:call', {
      ticket_number: patient.ticket_number,
      counter_name: counter?.name,
      department_id: patient.department_id,
      recall: !!recall,
      at: new Date().toISOString()
    });
  });
  return io;
}

async function start({ port = config.port } = {}) {
  await migrate(pool);
  await settings.load();
  notify.attach();

  const app = createApp();
  const server = http.createServer(app);
  const io = attachRealtime(server);

  await queue.expireStale().catch((e) => console.error('Ticket expiry failed:', e.message));
  const expiryTimer = setInterval(() => {
    queue.expireStale().catch((e) => console.error('Ticket expiry failed:', e.message));
  }, 5 * 60 * 1000);
  expiryTimer.unref();

  await new Promise((resolve) => server.listen(port, resolve));
  const sms = notify.providerStatus();
  console.log(`✓ SQHS running on http://localhost:${server.address().port}`);
  console.log(`  Staff console  /         Kiosk  /kiosk         Display board  /display`);
  console.log(`  SMS: ${sms.configured ? 'Twilio configured' : 'NOT configured — messages are logged, not delivered'}`);

  const stop = async () => {
    clearInterval(expiryTimer);
    io.close();
    await new Promise((r) => server.close(r));
  };
  return { app, server, io, stop };
}

module.exports = { createApp, start };
