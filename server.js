require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST']
  }
});

// Database Pool
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'sqhs_db'
});

// Middleware
app.use(cors());
app.use(express.json());

// ═══════════════ AUTH MIDDLEWARE ═══════════════
const validateToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
    req.user = decoded;
    next();
  } catch (err) {
    res.status(403).json({ error: 'Invalid token' });
  }
};

// ═══════════════ AUTH ROUTES ═══════════════
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password, full_name, phone, role } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const result = await pool.query(
      'INSERT INTO users (username, email, password, full_name, phone, role) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, username, email, role',
      [username, email, hashedPassword, full_name, phone, role || 'staff']
    );
    
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    
    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password);
    
    if (!validPassword) return res.status(401).json({ error: 'Invalid credentials' });
    
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: '24h' }
    );
    
    res.json({ token, user: { id: user.id, username: user.username, role: user.role, full_name: user.full_name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════ PATIENTS ROUTES ═══════════════
app.post('/api/patients/register', async (req, res) => {
  try {
    const { first_name, last_name, phone, email, priority, department_id, notes } = req.body;
    
    // Generate ticket number
    const dept = await pool.query('SELECT * FROM departments WHERE id = $1', [department_id]);
    if (!dept.rows.length) return res.status(400).json({ error: 'Department not found' });
    
    const deptName = dept.rows[0].name;
    const prefix = deptName.split(' ')[0][0].toUpperCase();
    const counter = await pool.query('SELECT COUNT(*) as count FROM patients WHERE department_id = $1 AND DATE(created_at) = CURRENT_DATE', [department_id]);
    const ticketNumber = prefix + String(parseInt(counter.rows[0].count) + 1).padStart(3, '0');
    
    const result = await pool.query(
      'INSERT INTO patients (ticket_number, first_name, last_name, phone, email, priority, department_id, status, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *',
      [ticketNumber, first_name, last_name, phone, email || null, priority || 'normal', department_id, 'waiting', notes || null]
    );
    
    const patient = result.rows[0];
    
    // Log to queue_logs
    await pool.query(
      'INSERT INTO queue_logs (patient_id, department_id, ticket_number, status) VALUES ($1, $2, $3, $4)',
      [patient.id, department_id, ticketNumber, 'waiting']
    );
    
    // Emit event via WebSocket
    io.emit('patient_registered', patient);
    
    res.json({ success: true, patient });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/patients', async (req, res) => {
  try {
    const { status, department_id } = req.query;
    let query = 'SELECT p.*, d.name as department_name FROM patients p LEFT JOIN departments d ON p.department_id = d.id';
    const params = [];
    
    if (status) {
      query += ' WHERE p.status = $1';
      params.push(status);
    }
    if (department_id) {
      query += params.length ? ' AND p.department_id = $' + (params.length + 1) : ' WHERE p.department_id = $1';
      params.push(department_id);
    }
    
    query += ' ORDER BY p.created_at DESC';
    const result = await pool.query(query, params);
    
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/patients/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT p.*, d.name as department_name FROM patients p LEFT JOIN departments d ON p.department_id = d.id WHERE p.id = $1', [req.params.id]);
    
    if (!result.rows.length) return res.status(404).json({ error: 'Patient not found' });
    
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/patients/:id/status', validateToken, async (req, res) => {
  try {
    const { status } = req.body;
    const timestamp = status === 'in-progress' ? 'called_at' : status === 'done' ? 'completed_at' : null;
    
    const updateQuery = timestamp 
      ? `UPDATE patients SET status = $1, ${timestamp} = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`
      : 'UPDATE patients SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *';
    
    const result = await pool.query(updateQuery, [status, req.params.id]);
    
    if (!result.rows.length) return res.status(404).json({ error: 'Patient not found' });
    
    const patient = result.rows[0];
    
    // Log the status change
    await pool.query(
      'INSERT INTO queue_logs (patient_id, department_id, ticket_number, status, processed_by) VALUES ($1, $2, $3, $4, $5)',
      [patient.id, patient.department_id, patient.ticket_number, status, req.user.id]
    );
    
    // Emit event
    io.emit('patient_updated', patient);
    
    res.json({ success: true, patient });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/patients/:id', validateToken, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM patients WHERE id = $1 RETURNING *', [req.params.id]);
    
    if (!result.rows.length) return res.status(404).json({ error: 'Patient not found' });
    
    io.emit('patient_removed', { id: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════ DEPARTMENTS ROUTES ═══════════════
app.get('/api/departments', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM departments WHERE is_active = true ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════ DASHBOARD STATS ═══════════════
app.get('/api/stats', async (req, res) => {
  try {
    const waiting = await pool.query('SELECT COUNT(*) as count FROM patients WHERE status = $1', ['waiting']);
    const served = await pool.query('SELECT COUNT(*) as count FROM patients WHERE status = $1 AND DATE(created_at) = CURRENT_DATE', ['done']);
    const avgWait = await pool.query('SELECT AVG(EXTRACT(EPOCH FROM (completed_at - called_at))/60) as avg_minutes FROM patients WHERE DATE(created_at) = CURRENT_DATE AND completed_at IS NOT NULL');
    const emergency = await pool.query('SELECT COUNT(*) as count FROM patients WHERE priority = $1 AND status = $2', ['emergency', 'waiting']);
    
    res.json({
      waiting: parseInt(waiting.rows[0].count),
      served: parseInt(served.rows[0].count),
      avgWait: Math.round(avgWait.rows[0].avg_minutes || 0),
      emergency: parseInt(emergency.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════ QUEUE OPERATIONS ═══════════════
app.post('/api/queue/call-next', validateToken, async (req, res) => {
  try {
    // Mark current in-progress as done
    await pool.query('UPDATE patients SET status = $1, completed_at = CURRENT_TIMESTAMP WHERE status = $2', ['done', 'in-progress']);
    
    // Get next waiting patient (prioritize emergency)
    const result = await pool.query(
      'SELECT * FROM patients WHERE status = $1 ORDER BY priority = $2 DESC, created_at ASC LIMIT 1',
      ['waiting', 'emergency']
    );
    
    if (!result.rows.length) return res.status(400).json({ error: 'No patients waiting' });
    
    const patient = result.rows[0];
    
    // Update patient status
    await pool.query(
      'UPDATE patients SET status = $1, called_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['in-progress', patient.id]
    );
    
    io.emit('patient_called', patient);
    res.json({ success: true, patient });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════ WEBSOCKET ═══════════════
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
  
  socket.on('request_refresh', async () => {
    const patients = await pool.query('SELECT p.*, d.name as department_name FROM patients p LEFT JOIN departments d ON p.department_id = d.id WHERE DATE(p.created_at) = CURRENT_DATE ORDER BY p.created_at DESC');
    socket.emit('queue_update', patients.rows);
  });
});

// ═══════════════ ERROR HANDLER ═══════════════
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ═══════════════ START SERVER ═══════════════
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`✓ SQHS Backend running on port ${PORT}`);
  console.log(`✓ Database: ${process.env.DB_NAME || 'sqhs_db'}`);
  console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = { app, io, pool };
