// ═══════════════ DATA ═══════════════
const DEPTS = [
  { name:'General Consultation', icon:'🩺', color:'teal' },
  { name:'Maternity & Pediatrics', icon:'👶', color:'pink' },
  { name:'Lab & Diagnostics', icon:'🧪', color:'blue' },
  { name:'Pharmacy', icon:'💊', color:'amber' },
  { name:'Emergency', icon:'🚨', color:'red' },
  { name:'Dental', icon:'🦷', color:'gray' },
];
 
let patients = [
  { id:1, ticket:'A001', fname:'MUSONERA', lname:'IRAHARI Junior', phone:'+250 788 123 456', dept:'General Consultation', priority:'normal', time: new Date(Date.now()-42*60000), status:'done', notes:'' },
  { id:2, ticket:'B001', fname:'MUSONI', lname:'Junior', phone:'+250 722 654 321', dept:'Maternity & Pediatrics', priority:'priority', time: new Date(Date.now()-30*60000), status:'done', notes:'First prenatal visit' },
  { id:3, ticket:'E001', fname:'NIYONZIMA', lname:'BANA Luc Owen', phone:'+250 782 111 222', dept:'Emergency', priority:'emergency', time: new Date(Date.now()-18*60000), status:'in-progress', notes:'Chest pain' },
  { id:4, ticket:'A002', fname:'RWABUNEZA', lname:'Nick', phone:'+250 788 333 444', dept:'General Consultation', priority:'normal', time: new Date(Date.now()-15*60000), status:'in-progress', notes:'' },
  { id:5, ticket:'L001', fname:'NTARINDWA', lname:'Brian', phone:'+250 722 555 666', dept:'Lab & Diagnostics', priority:'normal', time: new Date(Date.now()-12*60000), status:'waiting', notes:'Blood test order' },
  { id:6, ticket:'P001', fname:'MUNEZERO', lname:'Eric', phone:'+250 782 777 888', dept:'Pharmacy', priority:'priority', time: new Date(Date.now()-8*60000), status:'waiting', notes:'Elderly, 78' },
  { id:7, ticket:'A003', fname:'IMPANO', lname:'MANZI Heritier', phone:'+250 788 999 000', dept:'General Consultation', priority:'normal', time: new Date(Date.now()-5*60000), status:'waiting', notes:'' },
  { id:8, ticket:'D001', fname:'NTSINZI', lname:'Davis', phone:'+250 722 100 200', dept:'Dental', priority:'normal', time: new Date(Date.now()-3*60000), status:'waiting', notes:'' },
];
let nextId = 9;
let ticketCounters = { A:4, B:2, E:2, L:2, P:2, D:2, M:2 };
const deptPrefix = {
  'General Consultation':'A','Maternity & Pediatrics':'M',
  'Lab & Diagnostics':'L','Pharmacy':'P','Emergency':'E','Dental':'D'
};
 
let smsLog = [
  { to:'MUSONERA IRAHARI Junior', msg:'Your queue no. is A001. Est. wait: ~8 min.', time: new Date(Date.now()-42*60000), auto:true },
  { to:'NIYONZIMA BANA Luc Owen', msg:'EMERGENCY: You are being seen now — Room 3.', time: new Date(Date.now()-18*60000), auto:true },
];
 
let kioskSelectedDept = null;
 
// ═══════════════ UTILS ═══════════════
function fmt(d) {
  return d.toLocaleTimeString('en-RW',{hour:'2-digit',minute:'2-digit'});
}
function minutesAgo(d) {
  return Math.max(0, Math.floor((Date.now()-d)/60000));
}
function showToast(msg) {
  const t = document.getElementById('toast');
  document.getElementById('toast-msg').textContent = msg;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 2800);
}
function showPage(id) {
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('page-'+id).classList.add('active');
  const tabs = {dashboard:0,queue:1,kiosk:2,display:3,analytics:4,sms:5,settings:6};
  document.querySelectorAll('.nav-tab')[tabs[id]].classList.add('active');
  if(id==='display') renderBoard();
  if(id==='analytics') renderAnalytics();
  if(id==='sms') renderSmsPage();
  if(id==='settings') renderSettings();
  if(id==='dashboard') renderDashboard();
  if(id==='queue') renderQueue();
}
function openModal() { document.getElementById('modal-add').classList.add('open'); }
function closeModal() { document.getElementById('modal-add').classList.remove('open'); }
 
// ═══════════════ REGISTER ═══════════════
function registerPatient() {
  const fn = document.getElementById('f-fname').value.trim();
  const ln = document.getElementById('f-lname').value.trim();
  const ph = document.getElementById('f-phone').value.trim();
  const dept = document.getElementById('f-dept').value;
  const pri = document.getElementById('f-priority').value;
  const notes = document.getElementById('f-notes').value.trim();
  if(!fn||!ln) { showToast('⚠️ Please enter a name'); return; }
  const pre = deptPrefix[dept]||'X';
  if(!ticketCounters[pre]) ticketCounters[pre]=1;
  const ticket = pre + String(ticketCounters[pre]++).padStart(3,'0');
  const p = { id:nextId++, ticket, fname:fn, lname:ln, phone:ph||'—', dept, priority:pri, time:new Date(), status:'waiting', notes };
  if(pri==='emergency') patients.unshift(p); else patients.push(p);
  // auto-sms
  smsLog.unshift({ to:fn+' '+ln, msg:`SQHS: Your queue no. is ${ticket} for ${dept}. Est. wait: ~${Math.max(3,patients.filter(x=>x.status==='waiting').length*4)} min.`, time:new Date(), auto:true });
  closeModal();
  ['f-fname','f-lname','f-phone','f-notes'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('f-priority').value='normal';
  showToast(`✓ Ticket ${ticket} issued — SMS sent`);
  renderDashboard(); renderQueue();
}
 
// ═══════════════ QUEUE ACTIONS ═══════════════
function callNext() {
  const nxt = patients.find(p=>p.status==='waiting');
  if(!nxt) { showToast('No more patients waiting'); return; }
  // mark current in-progress as done
  patients.filter(p=>p.status==='in-progress').forEach(p=>p.status='done');
  nxt.status='in-progress';
  smsLog.unshift({ to:nxt.fname+' '+nxt.lname, msg:`SQHS: It's your turn! Ticket ${nxt.ticket} — please come to ${nxt.dept} desk now.`, time:new Date(), auto:true });
  showToast(`📣 Calling ${nxt.fname} ${nxt.lname} — ${nxt.ticket}`);
  renderDashboard(); renderQueue();
}
function markDone(id) {
  const p = patients.find(x=>x.id===id);
  if(p) { p.status='done'; renderDashboard(); renderQueue(); showToast('✓ Patient marked as done'); }
}
function skipPatient(id) {
  const p = patients.find(x=>x.id===id);
  if(!p) return;
  const i = patients.indexOf(p);
  patients.splice(i,1); patients.push(p);
  showToast(`↷ ${p.fname} moved to end of queue`);
  renderDashboard(); renderQueue();
}
function removePatient(id) {
  patients = patients.filter(x=>x.id!==id);
  renderDashboard(); renderQueue(); showToast('Patient removed');
}
 
// ═══════════════ RENDER DASHBOARD ═══════════════
function renderDashboard() {
  const waiting = patients.filter(p=>p.status==='waiting');
  const done = patients.filter(p=>p.status==='done');
  const emr = patients.filter(p=>p.priority==='emergency');
  document.getElementById('stat-waiting').textContent = waiting.length;
  document.getElementById('stat-served').textContent = done.length;
  document.getElementById('stat-avg').textContent = '12';
  document.getElementById('stat-emer').textContent = emr.length;
 
  // now serving
  const cur = patients.find(p=>p.status==='in-progress');
  const nsb = document.getElementById('now-serving-block');
  if(cur) {
    nsb.innerHTML = `
      <div class="queue-now">
        <div class="label">Now Serving</div>
        <div class="number">${cur.ticket}</div>
        <div class="name">${cur.fname} ${cur.lname}</div>
        <div class="dept">${cur.dept}</div>
      </div>`;
  } else {
    nsb.innerHTML = `<div class="empty-state"><div class="empty-icon">🔔</div><p>No patient currently being served</p></div>`;
  }
 
  // dept bars
  const deptCounts = {};
  DEPTS.forEach(d=>deptCounts[d.name]=0);
  waiting.forEach(p=>{ if(deptCounts[p.dept]!==undefined) deptCounts[p.dept]++; });
  const max = Math.max(1,...Object.values(deptCounts));
  document.getElementById('dept-bars').innerHTML = Object.entries(deptCounts).map(([d,c])=>`
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
      <div style="width:120px;font-size:12px;color:var(--text-secondary);text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${d.split(' ')[0]}</div>
      <div style="flex:1;"><div class="progress-bar"><div class="progress-fill" style="width:${Math.round(c/max*100)}%"></div></div></div>
      <div style="width:20px;font-size:13px;font-weight:600;color:var(--accent-dark)">${c}</div>
    </div>`).join('');
 
  // recent table
  const recent = [...patients].sort((a,b)=>b.time-a.time).slice(0,6);
  document.getElementById('dash-tbody').innerHTML = recent.map((p,i)=>`
    <tr>
      <td style="font-size:12px;color:var(--text-muted)">${i+1}</td>
      <td><div style="display:flex;align-items:center;gap:8px;"><div class="avatar">${p.fname[0]}${p.lname[0]}</div><span>${p.fname} ${p.lname}</span></div></td>
      <td><span class="tag">${p.dept.split(' ')[0]}</span></td>
      <td>${badgeP(p.priority)}</td>
      <td style="font-size:13px;color:var(--text-muted)">${minutesAgo(p.time)} min</td>
      <td>${badgeS(p.status)}</td>
      <td>${p.status==='waiting'?`<button class="btn btn-sm btn-primary" onclick="callNext()">Call</button>`:(p.status==='in-progress'?`<button class="btn btn-sm btn-outline" onclick="markDone(${p.id})">Done</button>`:'—')}</td>
    </tr>`).join('');
}
 
function badgeP(pri) {
  if(pri==='emergency') return `<span class="badge badge-emergency">🚨 Emergency</span>`;
  if(pri==='priority') return `<span class="badge badge-priority">⭐ Priority</span>`;
  return `<span class="badge badge-normal">Normal</span>`;
}
function badgeS(s) {
  if(s==='waiting') return `<span class="badge badge-waiting">Waiting</span>`;
  if(s==='in-progress') return `<span class="badge badge-in-progress">In Progress</span>`;
  return `<span class="badge badge-done">✓ Done</span>`;
}
 
// ═══════════════ RENDER QUEUE ═══════════════
function renderQueue() {
  const fd = document.getElementById('filter-dept').value;
  const fs = document.getElementById('filter-status').value;
  let list = [...patients];
  if(fd) list = list.filter(p=>p.dept===fd);
  if(fs) list = list.filter(p=>p.status===fs);
  document.getElementById('queue-tbody').innerHTML = list.length ? list.map((p,i)=>`
    <tr>
      <td style="font-size:12px;color:var(--text-muted)">${i+1}</td>
      <td><strong>${p.ticket}</strong></td>
      <td><div style="display:flex;align-items:center;gap:8px;"><div class="avatar">${p.fname[0]}${p.lname[0]}</div><div><div style="font-size:14px;">${p.fname} ${p.lname}</div>${p.notes?`<div style="font-size:11px;color:var(--text-muted)">${p.notes}</div>`:''}</div></div></td>
      <td style="font-size:13px;">${p.phone}</td>
      <td><span class="tag">${p.dept}</span></td>
      <td>${badgeP(p.priority)}</td>
      <td style="font-size:12px;color:var(--text-muted)">${fmt(p.time)}</td>
      <td style="font-size:13px;">${minutesAgo(p.time)} min</td>
      <td>${badgeS(p.status)}</td>
      <td><div class="flex-gap">
        ${p.status==='waiting'?`<button class="btn btn-sm btn-primary" onclick="callNext()">Call</button><button class="btn btn-sm btn-amber" onclick="skipPatient(${p.id})">Skip</button>`:''}
        ${p.status==='in-progress'?`<button class="btn btn-sm btn-outline" onclick="markDone(${p.id})">Done</button>`:''}
        <button class="btn btn-sm btn-danger" onclick="removePatient(${p.id})">✕</button>
      </div></td>
    </tr>`).join('') : `<tr><td colspan="10"><div class="empty-state"><div class="empty-icon">📋</div><p>No patients match the filter</p></div></td></tr>`;
}
 
// ═══════════════ KIOSK ═══════════════
function renderKioskDepts() {
  document.getElementById('kiosk-dept-grid').innerHTML = DEPTS.map(d=>`
    <div class="dept-card" id="kd-${d.name.replace(/\s/g,'_')}" onclick="selectKioskDept('${d.name}')">
      <div class="dept-icon">${d.icon}</div>
      <div class="dept-name">${d.name}</div>
      <div class="dept-wait">~${Math.max(5,patients.filter(p=>p.dept===d.name&&p.status==='waiting').length*4+5)} min wait</div>
    </div>`).join('');
}
function selectKioskDept(name) {
  kioskSelectedDept = name;
  document.querySelectorAll('.dept-card').forEach(c=>c.classList.remove('selected'));
  const el = document.getElementById('kd-'+name.replace(/\s/g,'_'));
  if(el) el.classList.add('selected');
}
function kioskStep1() {
  if(!kioskSelectedDept) { showToast('Please select a department first'); return; }
  document.getElementById('kiosk-step-0').style.display='none';
  document.getElementById('kiosk-step-1').style.display='';
}
function kioskStep2() {
  const name = document.getElementById('k-name').value.trim();
  if(!name) { showToast('Please enter your name'); return; }
  const phone = document.getElementById('k-phone').value.trim()||'—';
  const pri = document.getElementById('k-priority').value;
  const pre = deptPrefix[kioskSelectedDept]||'X';
  if(!ticketCounters[pre]) ticketCounters[pre]=1;
  const ticket = pre + String(ticketCounters[pre]++).padStart(3,'0');
  const parts = name.split(' ');
  const p = { id:nextId++, ticket, fname:parts[0], lname:parts.slice(1).join(' ')||'—', phone, dept:kioskSelectedDept, priority:pri, time:new Date(), status:'waiting', notes:'Kiosk registration' };
  if(pri==='emergency') patients.unshift(p); else patients.push(p);
  const waitMin = Math.max(5, patients.filter(x=>x.status==='waiting').length*4);
  document.getElementById('k-ticket-num').textContent = ticket;
  document.getElementById('k-ticket-dept').textContent = kioskSelectedDept;
  document.getElementById('k-ticket-est').textContent = `Estimated wait: ~${waitMin} min`;
  document.getElementById('k-sms-num').textContent = ticket;
  smsLog.unshift({ to:name, msg:`SQHS: Queue no. ${ticket} for ${kioskSelectedDept}. Wait: ~${waitMin} min. We'll notify you when it's your turn.`, time:new Date(), auto:true });
  document.getElementById('kiosk-step-1').style.display='none';
  document.getElementById('kiosk-step-2').style.display='';
}
function kioskBack() {
  document.getElementById('kiosk-step-1').style.display='none';
  document.getElementById('kiosk-step-0').style.display='';
}
function kioskReset() {
  kioskSelectedDept = null;
  document.getElementById('k-name').value='';
  document.getElementById('k-phone').value='';
  document.getElementById('k-priority').value='normal';
  document.getElementById('kiosk-step-2').style.display='none';
  document.getElementById('kiosk-step-0').style.display='';
  renderKioskDepts();
}
 
// ═══════════════ DISPLAY BOARD ═══════════════
function renderBoard() {
  const now = new Date();
  document.getElementById('board-clock').textContent = now.toLocaleTimeString('en-RW',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const cells = DEPTS.map(d=>{
    const active = patients.find(p=>p.dept===d.name&&p.status==='in-progress');
    const waiting = patients.filter(p=>p.dept===d.name&&p.status==='waiting').length;
    const cls = active ? (active.priority==='emergency'?'emergency':'active') : '';
    return `<div class="board-cell ${cls}">
      <div class="bc-dept">${d.icon} ${d.name.split(' ')[0]}</div>
      <div class="bc-num">${active?active.ticket:'—'}</div>
      <div class="bc-name">${active?active.fname+' '+active.lname:'Waiting: '+waiting}</div>
    </div>`;
  });
  document.getElementById('board-cells').innerHTML = cells.join('');
}
 
// ═══════════════ ANALYTICS ═══════════════
function renderAnalytics() {
  const hours = [6,2,4,12,18,15,9,7,4,3,2,1];
  const labels = ['7','8','9','10','11','12','13','14','15','16','17','18'];
  const max = Math.max(...hours);
  document.getElementById('hourly-chart').innerHTML = hours.map((h,i)=>`
    <div class="chart-bar-col">
      <div class="chart-val">${h}</div>
      <div class="chart-bar ${h===max?'high':h<5?'low':''}" style="height:${Math.round(h/max*80)}px"></div>
      <div class="chart-label">${labels[i]}</div>
    </div>`).join('');
 
  const weekly = [42,38,51,47,55,31,28];
  const wlabs = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const wmax = Math.max(...weekly);
  document.getElementById('weekly-chart').innerHTML = weekly.map((h,i)=>`
    <div class="chart-bar-col">
      <div class="chart-val">${h}</div>
      <div class="chart-bar ${i===4?'high':''}" style="height:${Math.round(h/wmax*80)}px"></div>
      <div class="chart-label">${wlabs[i]}</div>
    </div>`).join('');
 
  const deptStat = DEPTS.map(d=>({
    name:d.name, icon:d.icon,
    count: patients.filter(p=>p.dept===d.name).length
  }));
  const dmax = Math.max(1,...deptStat.map(d=>d.count));
  document.getElementById('dept-stat-list').innerHTML = deptStat.map(d=>`
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
      <span style="font-size:16px;width:22px">${d.icon}</span>
      <div style="flex:1;">
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:3px;">${d.name}</div>
        <div class="progress-bar"><div class="progress-fill" style="width:${Math.round(d.count/dmax*100)}%"></div></div>
      </div>
      <div style="font-size:13px;font-weight:600;color:var(--accent-dark);width:20px">${d.count}</div>
    </div>`).join('');
}
 
// ═══════════════ SMS ═══════════════
function renderSmsPage() {
  const sel = document.getElementById('sms-to');
  sel.innerHTML = '<option value="">— Select patient —</option>' +
    patients.filter(p=>p.status==='waiting'||p.status==='in-progress').map(p=>`<option value="${p.id}">${p.fname} ${p.lname} (${p.ticket})</option>`).join('');
  renderSmsLog();
}
function renderSmsLog() {
  document.getElementById('sms-log').innerHTML = smsLog.length ? smsLog.map(s=>`
    <div style="padding:10px 0;border-bottom:1px solid var(--border);">
      <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted);margin-bottom:4px;">
        <span><strong style="color:var(--text-secondary)">${s.to}</strong></span>
        <span>${fmt(s.time)} ${s.auto?'<span class="tag" style="font-size:10px;">auto</span>':''}</span>
      </div>
      <div style="font-size:13px;color:var(--text-primary);">${s.msg}</div>
    </div>`).join('') : '<div class="empty-state"><div class="empty-icon">💬</div><p>No messages yet</p></div>';
}
function fillTemplate() {
  const v = document.getElementById('sms-template').value;
  if(v) document.getElementById('sms-body').value = v;
}
function sendSms() {
  const selVal = document.getElementById('sms-to').value;
  const body = document.getElementById('sms-body').value.trim();
  if(!selVal||!body) { showToast('⚠️ Select a patient and enter a message'); return; }
  const p = patients.find(x=>x.id==selVal);
  if(!p) return;
  smsLog.unshift({ to:`${p.fname} ${p.lname}`, msg:body, time:new Date(), auto:false });
  showToast(`📤 SMS sent to ${p.fname} ${p.lname}`);
  renderSmsLog();
}
function sendBroadcast() {
  const msg = document.getElementById('broadcast-msg').value.trim();
  if(!msg) { showToast('⚠️ Enter a message first'); return; }
  const waiting = patients.filter(p=>p.status==='waiting');
  waiting.forEach(p=>smsLog.unshift({ to:`${p.fname} ${p.lname}`, msg:`[Broadcast] ${msg}`, time:new Date(), auto:false }));
  showToast(`📢 Sent to ${waiting.length} waiting patients`);
  document.getElementById('broadcast-msg').value='';
  renderSmsLog();
}
 
// ═══════════════ SETTINGS ═══════════════
function renderSettings() {
  document.getElementById('dept-settings-list').innerHTML = DEPTS.map(d=>`
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);">
      <div style="display:flex;align-items:center;gap:8px;"><span style="font-size:16px">${d.icon}</span><span style="font-size:14px">${d.name}</span></div>
      <div class="flex-gap">
        <span class="tag">Active</span>
        <button class="btn-icon" onclick="showToast('Edit dept')">✏️</button>
      </div>
    </div>`).join('');
}
 
// ═══════════════ CLOCK ═══════════════
function updateClock() {
  const t = document.getElementById('board-clock');
  if(t && document.getElementById('page-display').classList.contains('active')) {
    t.textContent = new Date().toLocaleTimeString('en-RW',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  }
}
setInterval(updateClock, 1000);
setInterval(()=>{ renderDashboard(); }, 30000);
 
// ═══════════════ INIT ═══════════════
document.getElementById('dash-date').textContent = new Date().toLocaleDateString('en-RW',{weekday:'long',year:'numeric',month:'long',day:'numeric'}) + ' — Muhima Health Center';
renderKioskDepts();
renderDashboard();