// ═══════════════ API CONFIG ═══════════════
const API_URL = 'http://localhost:5000/api';
let authToken = localStorage.getItem('authToken');

// ═══════════════ FETCH HELPER ═══════════════
async function apiCall(endpoint, method = 'GET', data = null) {
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(authToken && { 'Authorization': `Bearer ${authToken}` })
    }
  };
  
  if (data) options.body = JSON.stringify(data);
  
  const response = await fetch(`${API_URL}${endpoint}`, options);
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'API Error');
  }
  
  return response.json();
}

// ═══════════════ AUTH API ═══════════════
async function loginUser(username, password) {
  try {
    const result = await apiCall('/auth/login', 'POST', { username, password });
    authToken = result.token;
    localStorage.setItem('authToken', authToken);
    return result.user;
  } catch (error) {
    showToast('❌ Login failed: ' + error.message);
    throw error;
  }
}

async function registerUser(username, email, password, full_name, phone, role = 'staff') {
  try {
    const result = await apiCall('/auth/register', 'POST', {
      username, email, password, full_name, phone, role
    });
    showToast('✓ User registered successfully');
    return result.user;
  } catch (error) {
    showToast('❌ Registration failed: ' + error.message);
    throw error;
  }
}

function logoutUser() {
  authToken = null;
  localStorage.removeItem('authToken');
  showToast('Logged out');
  // Redirect to login page
  window.location.href = '/login.html';
}

// ═══════════════ PATIENT API ═══════════════
async function registerPatient(fname, lname, phone, email, priority, department_id, notes = '') {
  try {
    const result = await apiCall('/patients/register', 'POST', {
      first_name: fname,
      last_name: lname,
      phone,
      email,
      priority,
      department_id,
      notes
    });
    showToast(`✓ Ticket ${result.patient.ticket_number} issued`);
    return result.patient;
  } catch (error) {
    showToast('❌ Registration failed: ' + error.message);
    throw error;
  }
}

async function getPatients(status = null, department_id = null) {
  try {
    let endpoint = '/patients';
    const params = [];
    if (status) params.push(`status=${status}`);
    if (department_id) params.push(`department_id=${department_id}`);
    if (params.length) endpoint += '?' + params.join('&');
    
    return await apiCall(endpoint);
  } catch (error) {
    console.error('Error fetching patients:', error);
    return [];
  }
}

async function getPatient(id) {
  try {
    return await apiCall(`/patients/${id}`);
  } catch (error) {
    console.error('Error fetching patient:', error);
    return null;
  }
}

async function updatePatientStatus(id, status) {
  try {
    const result = await apiCall(`/patients/${id}/status`, 'PATCH', { status });
    showToast(`✓ Patient status updated to ${status}`);
    return result.patient;
  } catch (error) {
    showToast('❌ Update failed: ' + error.message);
    throw error;
  }
}

async function removePatient(id) {
  try {
    await apiCall(`/patients/${id}`, 'DELETE');
    showToast('✓ Patient removed');
    return true;
  } catch (error) {
    showToast('❌ Remove failed: ' + error.message);
    throw error;
  }
}

// ═══════════════ DEPARTMENT API ═══════════════
async function getDepartments() {
  try {
    return await apiCall('/departments');
  } catch (error) {
    console.error('Error fetching departments:', error);
    return [];
  }
}

// ═══════════════ QUEUE OPERATIONS ═══════════════
async function callNextPatient() {
  try {
    const result = await apiCall('/queue/call-next', 'POST');
    showToast(`📣 Called: ${result.patient.first_name} ${result.patient.last_name}`);
    return result.patient;
  } catch (error) {
    showToast('❌ ' + error.message);
    throw error;
  }
}

// ═══════════════ STATS API ═══════════════
async function getDashboardStats() {
  try {
    return await apiCall('/stats');
  } catch (error) {
    console.error('Error fetching stats:', error);
    return { waiting: 0, served: 0, avgWait: 0, emergency: 0 };
  }
}

// ═══════════════ WEBSOCKET INTEGRATION ═══════════════
const socket = io('http://localhost:5000');

socket.on('connect', () => {
  console.log('Connected to backend');
});

socket.on('patient_registered', (patient) => {
  console.log('New patient registered:', patient);
  renderDashboard();
  renderQueue();
});

socket.on('patient_updated', (patient) => {
  console.log('Patient updated:', patient);
  renderDashboard();
  renderQueue();
});

socket.on('patient_called', (patient) => {
  console.log('Patient called:', patient);
  renderDashboard();
  renderBoard();
});

socket.on('patient_removed', (data) => {
  console.log('Patient removed:', data);
  renderDashboard();
  renderQueue();
});

socket.on('queue_update', (patients) => {
  console.log('Queue updated:', patients);
});

// ═══════════════ INTEGRATION WITH EXISTING SCRIPT ═══════════════
// Override the registerPatient function in script1.js
const originalRegisterPatient = registerPatient;

async function registerPatientWithAPI() {
  const fn = document.getElementById('f-fname').value.trim();
  const ln = document.getElementById('f-lname').value.trim();
  const ph = document.getElementById('f-phone').value.trim();
  const dept = document.getElementById('f-dept').value;
  const pri = document.getElementById('f-priority').value;
  const notes = document.getElementById('f-notes').value.trim();

  if (!fn || !ln || !ph) {
    showToast('⚠️ Please fill all required fields');
    return;
  }

  try {
    // Get department ID
    const departments = await getDepartments();
    const department = departments.find(d => d.name === dept);
    if (!department) {
      showToast('⚠️ Invalid department');
      return;
    }

    await registerPatient(fn, ln, ph, '', pri, department.id, notes);
    
    closeModal();
    ['f-fname', 'f-lname', 'f-phone', 'f-notes'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('f-priority').value = 'normal';
  } catch (error) {
    console.error('Registration error:', error);
  }
}

// Override callNext with API version
async function callNextWithAPI() {
  try {
    await callNextPatient();
    renderDashboard();
    renderQueue();
  } catch (error) {
    console.error('Call next error:', error);
  }
}

// Override markDone with API version
async function markDoneWithAPI(id) {
  try {
    await updatePatientStatus(id, 'done');
    renderDashboard();
    renderQueue();
  } catch (error) {
    console.error('Mark done error:', error);
  }
}

// Override removePatient with API version
async function removePatientWithAPI(id) {
  try {
    await removePatient(id);
    renderDashboard();
    renderQueue();
  } catch (error) {
    console.error('Remove patient error:', error);
  }
}

// ═══════════════ EXPORT FOR USE ═══════════════
// Replace the original functions in script1.js button calls:
// onclick="registerPatientWithAPI()" instead of "registerPatient()"
// onclick="callNextWithAPI()" instead of "callNext()"
// This ensures real-time database updates!
