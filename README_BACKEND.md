# SQHS Backend Setup Guide

## Installation

### 1. Install Node.js Dependencies
```bash
npm install
```

### 2. Setup PostgreSQL Database

**On Windows:**
- Download PostgreSQL from https://www.postgresql.org/download/windows/
- Install with default settings
- Open pgAdmin or PowerShell and run:
```bash
psql -U postgres -f database.sql
```

**On macOS:**
```bash
brew install postgresql
psql -U postgres -f database.sql
```

**On Linux:**
```bash
sudo apt-get install postgresql postgresql-contrib
psql -U postgres -f database.sql
```

### 3. Configure Environment Variables

Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Edit `.env` and update:
```
DB_PASSWORD=your_actual_password
JWT_SECRET=your_secret_key_change_this
```

### 4. Run the Server

**Development (with auto-reload):**
```bash
npm run dev
```

**Production:**
```bash
npm start
```

Server will run on `http://localhost:5000`

---

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login and get JWT token

### Patients
- `POST /api/patients/register` - Register new patient
- `GET /api/patients` - Get all patients (with filters)
- `GET /api/patients/:id` - Get patient details
- `PATCH /api/patients/:id/status` - Update patient status
- `DELETE /api/patients/:id` - Remove patient (requires auth)

### Queue Operations
- `POST /api/queue/call-next` - Call next patient in queue

### Dashboard
- `GET /api/stats` - Get dashboard statistics

### Departments
- `GET /api/departments` - Get all departments

---

## Database Schema

**Tables:**
- `users` - Staff/Admin users
- `departments` - Medical departments
- `patients` - Patient records
- `queue_logs` - Queue operation history
- `sms_logs` - SMS message logs
- `analytics` - Daily statistics

---

## Real-time Updates with WebSocket

The server uses Socket.io for live updates. Events:
- `patient_registered` - New patient registered
- `patient_updated` - Patient status changed
- `patient_called` - Patient called to desk
- `patient_removed` - Patient removed from queue
- `queue_update` - General queue refresh

---

## Deployment to Railway.app

1. Create account: https://railway.app
2. Connect GitHub repository
3. Add PostgreSQL plugin in Railway dashboard
4. Set environment variables (JWT_SECRET, Twilio keys, etc.)
5. Deploy!

---

## Default Login
- Username: `admin`
- Password: `admin123`

⚠️ **Change this immediately in production!**

---

## Next Steps

1. ✅ Frontend integration with API
2. ✅ SMS notifications with Twilio
3. ✅ Analytics dashboard
4. ✅ User roles & permissions
5. ✅ Email notifications
