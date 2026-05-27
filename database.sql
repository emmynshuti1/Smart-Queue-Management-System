-- Drop existing database if exists (for fresh start)
DROP DATABASE IF EXISTS sqhs_db;
CREATE DATABASE sqhs_db;

-- Connect to the database
\c sqhs_db;

-- Users/Staff Table
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(255) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'staff', -- admin, nurse, receptionist, doctor
  full_name VARCHAR(255) NOT NULL,
  phone VARCHAR(20),
  department VARCHAR(255),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Departments Table
CREATE TABLE departments (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  icon VARCHAR(50),
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Patients Table
CREATE TABLE patients (
  id SERIAL PRIMARY KEY,
  ticket_number VARCHAR(50) UNIQUE NOT NULL,
  first_name VARCHAR(255) NOT NULL,
  last_name VARCHAR(255) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  email VARCHAR(255),
  priority VARCHAR(50) NOT NULL DEFAULT 'normal', -- normal, priority, emergency
  department_id INTEGER REFERENCES departments(id),
  status VARCHAR(50) NOT NULL DEFAULT 'waiting', -- waiting, in-progress, done, no-show
  notes TEXT,
  registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  called_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Queue Log Table (for analytics)
CREATE TABLE queue_logs (
  id SERIAL PRIMARY KEY,
  patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
  department_id INTEGER REFERENCES departments(id),
  ticket_number VARCHAR(50),
  status VARCHAR(50),
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  processed_by INTEGER REFERENCES users(id)
);

-- SMS Log Table
CREATE TABLE sms_logs (
  id SERIAL PRIMARY KEY,
  patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
  recipient_name VARCHAR(255) NOT NULL,
  recipient_phone VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  is_auto BOOLEAN DEFAULT FALSE,
  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(50) DEFAULT 'sent' -- sent, failed, pending
);

-- Analytics Table
CREATE TABLE analytics (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  department_id INTEGER REFERENCES departments(id),
  total_patients INTEGER DEFAULT 0,
  avg_wait_time INTEGER DEFAULT 0, -- in minutes
  total_served INTEGER DEFAULT 0,
  emergency_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for better performance
CREATE INDEX idx_patients_status ON patients(status);
CREATE INDEX idx_patients_department ON patients(department_id);
CREATE INDEX idx_patients_created_at ON patients(created_at);
CREATE INDEX idx_queue_logs_patient ON queue_logs(patient_id);
CREATE INDEX idx_sms_logs_patient ON sms_logs(patient_id);
CREATE INDEX idx_users_role ON users(role);

-- Insert Default Departments
INSERT INTO departments (name, icon, description) VALUES
  ('General Consultation', '🩺', 'General medical consultations'),
  ('Maternity & Pediatrics', '👶', 'Maternal and child health'),
  ('Lab & Diagnostics', '🧪', 'Laboratory tests and imaging'),
  ('Pharmacy', '💊', 'Medication dispensing'),
  ('Emergency', '🚨', 'Emergency care'),
  ('Dental', '🦷', 'Dental services');

-- Insert Default Admin User (password: admin123)
INSERT INTO users (username, email, password, role, full_name, phone) VALUES
  ('admin', 'admin@sqhs.rw', '$2a$10$YJi6.SXHBfBHI5gqhN0cE.GFwmHd3uEjzC9cKqcFXVVvIFX0YM1jO', 'admin', 'System Administrator', '+250788000000');