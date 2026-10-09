let pbUrl = ' ';
let pbConnected = false;
let allStudents = [];
let selectedFiles = [];
let currentVoucher = null;
let allPayments = [];
let currentUser = null;

const PB_PORT = '8093';
const AUTH_TOKEN_KEY = 'insight_academy_auth_token';
const AUTH_USER_KEY = 'insight_academy_auth_user';

function getDefaultPbUrl() {
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
    return window.location.origin;
  }
  return localStorage.getItem('pbUrl') || `http://127.0.0.1:${PB_PORT}`;
}

function isLocalHost() {
  const h = window.location.hostname;
  return h === 'localhost' || h === '127.0.0.1';
}

async function detectLocalNetworkIp() {
  if (!window.RTCPeerConnection) return null;
  return new Promise((resolve) => {
    let resolved = false;
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.createDataChannel('');
    pc.onicecandidate = (e) => {
      if (!e?.candidate?.candidate || resolved) return;
      const match = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(e.candidate.candidate);
      if (match && !match[1].startsWith('127.') && !match[1].startsWith('169.254.')) {
        resolved = true;
        resolve(match[1]);
        pc.close();
      }
    };
    pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => resolve(null));
    setTimeout(() => { if (!resolved) { pc.close(); resolve(null); } }, 2500);
  });
}

function getPcIpFromUrl() {
  const ip = new URLSearchParams(window.location.search).get('pcIp');
  if (!ip) return null;

  const octets = ip.split('.');
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) return null;
  return ip;
}

async function updateNetworkHint() {
  const el = document.getElementById('pb-network-hint');
  if (!el) return;

  if (!isLocalHost()) {
    el.style.display = 'none';
    return;
  }

  const ip = getPcIpFromUrl() || await detectLocalNetworkIp();
  const port = window.location.port || PB_PORT;
  const networkUrl = ip ? `http://${ip}:${port}` : `http://YOUR_PC_IP:${port}`;
  el.innerHTML = `📱 <strong>Phone / tablet:</strong> use the same Wi‑Fi, then open <code>${networkUrl}</code> in the browser.`;
  el.style.display = 'block';
}

// ── PocketBase ──────────────────────────────────────
async function connectPocketBase() {
  const urlInput = document.getElementById('pb-url');
  pbUrl = (urlInput?.value.trim() || pbUrl || getDefaultPbUrl()).replace(/\/$/, '');
  try {
    const res = await fetch(pbUrl + '/api/health', { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      pbConnected = true;
      localStorage.setItem('pbUrl', pbUrl);

      const token = localStorage.getItem(AUTH_TOKEN_KEY);
      if (token) {
        try {
          const authRes = await fetch(`${pbUrl}/api/collections/users/auth-refresh`, {
            headers: { Authorization: `Bearer ${token}` }
          });
          if (authRes.ok) {
            const authData = await authRes.json();
            currentUser = authData.record || null;
            if (!currentUser) throw new Error('Session could not be verified');
            localStorage.setItem(AUTH_USER_KEY, JSON.stringify(currentUser));
          } else {
            localStorage.removeItem(AUTH_TOKEN_KEY);
            localStorage.removeItem(AUTH_USER_KEY);
            currentUser = null;
          }
        } catch {
          localStorage.removeItem(AUTH_TOKEN_KEY);
          localStorage.removeItem(AUTH_USER_KEY);
          currentUser = null;
        }
      }

      setStatus('Connected to PocketBase', 'connected');
      document.getElementById('login-status').textContent = currentUser
        ? 'Session verified.'
        : 'Sign in with your staff account to continue.';
      if (currentUser) await openApp();
    } else throw new Error();
  } catch {
    pbConnected = false;
    currentUser = null;
    document.getElementById('login-status').textContent = 'Cannot connect to PocketBase. Check the server address and try again.';
  }
}

function setStatus(msg, type) {
  document.getElementById('pb-status-text').textContent = msg;
  const dot = document.getElementById('pb-dot');
  dot.className = 'pb-dot' + (type ? ' ' + type : '');
}

function renderAuthBar() {
  const loggedIn = document.getElementById('auth-logged-in');
  const userName = document.getElementById('auth-user-name');
  if (!loggedIn || !userName) return;

  const email = currentUser.email || 'Staff';
  userName.textContent = `Signed in: ${email}`;
  loggedIn.style.display = 'flex';
}

async function openApp() {
  document.getElementById('login-screen').hidden = true;
  document.getElementById('app-shell').hidden = false;
  renderAuthBar();
  await loadStudents();
  await loadPaymentHistory();
}

async function loginToPocketBase() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const status = document.getElementById('login-status');
  if (!pbUrl) pbUrl = getDefaultPbUrl();

  if (!email || !password) {
    status.textContent = 'Enter your email and password to continue.';
    return;
  }

  status.textContent = 'Signing in...';
  try {
    const res = await fetch(`${pbUrl}/api/collections/users/auth-with-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: email, password })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || 'Login failed');
    if (!data?.token || !data?.record) throw new Error('PocketBase returned an invalid login response');

    localStorage.setItem(AUTH_TOKEN_KEY, data.token);
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(data.record));
    currentUser = data.record;
    document.getElementById('login-password').value = '';
    await openApp();
    toast(`Welcome, ${data.record.email || 'staff'}!`, 'success');
  } catch (e) {
    status.textContent = 'Login failed: ' + e.message;
    toast('Login failed: ' + e.message, 'error');
  }
}

function logoutFromPocketBase() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_USER_KEY);
  currentUser = null;
  document.getElementById('app-shell').hidden = true;
  document.getElementById('login-screen').hidden = false;
  document.getElementById('login-password').value = '';
  document.getElementById('login-status').textContent = 'Signed out. Sign in to continue.';
}

function ensureCloudSyncAuth() {
  if (!pbConnected || currentUser) return true;
  toast('Login required to save data to PocketBase', 'error');
  return false;
}

// ── Fee Calc ────────────────────────────────────────
function calcFee() {
  const base = parseFloat(document.getElementById('base-fee').value) || 0;
  const pct = parseFloat(document.getElementById('discount-pct').value) || 0;
  const discAmt = Math.round(base * pct / 100);
  document.getElementById('discount-amt').value = discAmt || '';
  updateFeeDisplay(base, discAmt);
}
function calcFeeFromAmt() {
  const base = parseFloat(document.getElementById('base-fee').value) || 0;
  const discAmt = parseFloat(document.getElementById('discount-amt').value) || 0;
  const pct = base > 0 ? Math.round(discAmt / base * 100) : 0;
  document.getElementById('discount-pct').value = pct || '';
  updateFeeDisplay(base, discAmt);
}
function updateFeeDisplay(base, disc) {
  const net = base - disc;
  document.getElementById('display-base').textContent = 'PKR ' + base.toLocaleString();
  document.getElementById('display-discount').textContent = '- PKR ' + disc.toLocaleString();
  document.getElementById('display-net').textContent = 'PKR ' + net.toLocaleString();
}

// ── File Upload ─────────────────────────────────────
function handleFiles(input) {
  const files = Array.from(input.files);
  if (selectedFiles.length + files.length > 10) {
    toast('You can upload up to 10 documents per student.', 'error');
    input.value = '';
    return;
  }
  files.forEach(f => selectedFiles.push(f));
  input.value = '';
  renderFileList();
}
function renderFileList() {
  const el = document.getElementById('file-list');
  el.innerHTML = selectedFiles.map((f, i) =>
    `<div class="file-chip"><span>${f.name}</span><span class="remove" onclick="removeFile(${i})">×</span></div>`
  ).join('');
}
function removeFile(i) { selectedFiles.splice(i, 1); renderFileList(); }

/** Next STD-0001 style number: max existing STD-nnnn + 1 (ignores bad/old ids). */
async function getNextStudentSerial(pbBaseUrl) {
  let max = 0;
  let page = 1;
  let totalPages = 1;
  do {
    const res = await fetch(
      `${pbBaseUrl}/api/collections/students/records?perPage=500&page=${page}&fields=student_id`,
      { headers: { Authorization: `Bearer ${localStorage.getItem(AUTH_TOKEN_KEY) || ''}` } }
    );
    if (!res.ok) break;
    const data = await res.json();
    totalPages = data.totalPages || 1;
    for (const r of data.items || []) {
      const m = /^STD-(\d+)$/i.exec(String(r.student_id || '').trim());
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    page++;
  } while (page <= totalPages);
  return max + 1;
}

// ── Save Student ────────────────────────────────────
async function saveStudent() {
  const name = document.getElementById('full-name').value.trim();
  const contact = document.getElementById('contact').value.trim();
  const baseFee = parseFloat(document.getElementById('base-fee').value) || 0;
  if (!name) { toast('Please enter student name', 'error'); return; }
  if (!contact) { toast('Please enter contact number', 'error'); return; }
  if (!baseFee) { toast('Please enter base fee', 'error'); return; }

  const discAmt = parseFloat(document.getElementById('discount-amt').value) || 0;
  const studentData = {
    full_name: name,
    father_name: document.getElementById('father-name').value.trim(),
    dob: document.getElementById('dob').value,
    gender: document.getElementById('gender').value,
    contact: contact,
    email: document.getElementById('email').value.trim(),
    address: document.getElementById('address').value.trim(),
    class_name: document.getElementById('class-name').value.trim(),
    program: document.getElementById('program').value.trim(),
    cnic: document.getElementById('cnic').value.trim(),
    prev_school: document.getElementById('prev-school').value.trim(),
    enrollment_date: document.getElementById('enrollment-date').value || new Date().toISOString().split('T')[0],
    base_fee: baseFee,
    discount_pct: parseFloat(document.getElementById('discount-pct').value) || 0,
    discount_amt: discAmt,
    net_fee: baseFee - discAmt,
    fee_notes: document.getElementById('fee-notes').value.trim(),
  };

  if (!pbConnected) {
    const students = JSON.parse(localStorage.getItem('students') || '[]');
    const id = 'STD-' + String(students.length + 1).padStart(4, '0');
    studentData.student_id = id;
    studentData.id = id;
    students.push(studentData);
    localStorage.setItem('students', JSON.stringify(students));
    document.getElementById('student-id-display').textContent = id;
    toast('Saved locally (PocketBase not connected): ' + id, 'success');
    allStudents = students;
    return;
  }

  if (!ensureCloudSyncAuth()) return;

  try {
    const formData = new FormData();
    Object.entries(studentData).forEach(([k, v]) => formData.append(k, v));
    selectedFiles.forEach(f => formData.append('documents', f));

    const res = await fetch(pbUrl + '/api/collections/students/records', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${localStorage.getItem(AUTH_TOKEN_KEY) || ''}`
      },
      body: formData
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Save failed');

    const serial = await getNextStudentSerial(pbUrl);
    const sid = 'STD-' + String(serial).padStart(4, '0');
    const patchRes = await fetch(pbUrl + '/api/collections/students/records/' + data.id, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem(AUTH_TOKEN_KEY) || ''}`
      },
      body: JSON.stringify({ student_id: sid })
    });

    if (!patchRes.ok) {
      const errBody = await patchRes.json().catch(() => ({}));
      throw new Error(errBody.message || 'Could not assign student ID');
    }

    document.getElementById('student-id-display').textContent = sid;
    toast('Student registered: ' + sid, 'success');
    loadStudents();
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

// ── Load Students ───────────────────────────────────
async function loadStudents() {
  if (!pbConnected) {
    allStudents = JSON.parse(localStorage.getItem('students') || '[]');
  } else {
    try {
      const res = await fetch(pbUrl + '/api/collections/students/records?perPage=500&sort=created', {
        headers: { Authorization: `Bearer ${localStorage.getItem(AUTH_TOKEN_KEY) || ''}` }
      });
      const data = await res.json();
      allStudents = data.items || [];
    } catch { allStudents = JSON.parse(localStorage.getItem('students') || '[]'); }
  }
  renderStudentTable();
}

function renderStudentTable() {
  const q = (document.getElementById('search-input').value || '').toLowerCase();
  const filtered = allStudents.filter(s =>
    !q || (s.full_name||'').toLowerCase().includes(q) ||
    (s.student_id||'').toLowerCase().includes(q) ||
    (s.class_name||'').toLowerCase().includes(q) ||
    (s.contact||'').toLowerCase().includes(q)
  );
  const wrap = document.getElementById('student-table-wrap');
  if (!filtered.length) {
    wrap.innerHTML = '<div class="empty-state">No students found.</div>'; return;
  }
  wrap.innerHTML = `<table class="student-table">
    <thead><tr>
      <th>ID</th><th>Name</th><th>Father</th><th>Class</th><th>Contact</th><th>Net Fee</th><th>Actions</th>
    </tr></thead>
    <tbody>${filtered.map(s => `<tr>
      <td><span class="id-tag">${s.student_id || s.id}</span></td>
      <td><strong>${s.full_name || ''}</strong></td>
      <td>${s.father_name || ''}</td>
      <td>${s.class_name || ''}</td>
      <td>${s.contact || ''}</td>
      <td>PKR ${(s.net_fee || 0).toLocaleString()}</td>
      <td>
        <button class="btn btn-sm btn-outline" onclick="openStudentProfile(${allStudents.indexOf(s)})">Profile</button>
        <button class="btn btn-sm btn-outline" onclick="openVoucherForStudent('${s.student_id || s.id}')">Voucher</button>
      </td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function appendStudentProfileSection(container, title, fields) {
  const section = document.createElement('section');
  section.className = 'student-profile-section';
  const heading = document.createElement('h3');
  heading.textContent = title;
  section.appendChild(heading);

  const grid = document.createElement('div');
  grid.className = 'student-profile-grid';
  for (const [label, value] of fields) {
    const field = document.createElement('div');
    field.className = 'student-profile-field';
    const fieldLabel = document.createElement('div');
    fieldLabel.className = 'student-profile-label';
    fieldLabel.textContent = label;
    const fieldValue = document.createElement('div');
    fieldValue.className = 'student-profile-value';
    fieldValue.textContent = value === undefined || value === null || value === '' ? '—' : String(value);
    field.append(fieldLabel, fieldValue);
    grid.appendChild(field);
  }
  section.appendChild(grid);
  container.appendChild(section);
}

function openStudentProfile(studentIndex) {
  const student = allStudents[studentIndex];
  if (!student) {
    toast('Student profile could not be found. Refresh the student list and try again.', 'error');
    return;
  }

  const studentId = student.student_id || student.id;
  const dialog = document.getElementById('student-profile-dialog');
  const title = document.getElementById('student-profile-title');
  const subtitle = document.getElementById('student-profile-subtitle');
  const content = document.getElementById('student-profile-content');
  title.textContent = student.full_name || 'Student Profile';
  subtitle.textContent = studentId || '';
  content.replaceChildren();

  appendStudentProfileSection(content, 'Personal Information', [
    ['Student ID', studentId],
    ['Full Name', student.full_name],
    ["Father's Name", student.father_name],
    ['Date of Birth', student.dob],
    ['Gender', student.gender],
    ['Contact Number', student.contact],
    ['Email', student.email],
    ['Address', student.address]
  ]);
  appendStudentProfileSection(content, 'Academic Information', [
    ['Class / Grade', student.class_name],
    ['Program / Department', student.program],
    ['Previous School', student.prev_school],
    ['Enrollment Date', student.enrollment_date],
    ['CNIC / B-Form Number', student.cnic]
  ]);
  appendStudentProfileSection(content, 'Fee Structure', [
    ['Base Fee', `PKR ${Number(student.base_fee || 0).toLocaleString()}`],
    ['Discount', `${Number(student.discount_pct || 0)}% (PKR ${Number(student.discount_amt || 0).toLocaleString()})`],
    ['Net Monthly Fee', `PKR ${Number(student.net_fee || student.base_fee || 0).toLocaleString()}`],
    ['Fee Notes', student.fee_notes]
  ]);

  const documents = Array.isArray(student.documents) ? student.documents : [];
  const documentSection = document.createElement('section');
  documentSection.className = 'student-profile-section';
  const documentHeading = document.createElement('h3');
  documentHeading.textContent = 'Uploaded Documents';
  documentSection.appendChild(documentHeading);
  if (!documents.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No documents uploaded.';
    documentSection.appendChild(empty);
  } else {
    const documentList = document.createElement('ul');
    for (const fileName of documents) {
      const item = document.createElement('li');
      if (pbConnected && student.id) {
        const link = document.createElement('a');
        link.href = `${pbUrl}/api/files/pbc_3827815851/${encodeURIComponent(student.id)}/${encodeURIComponent(fileName)}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = fileName;
        item.appendChild(link);
      } else {
        item.textContent = fileName;
      }
      documentList.appendChild(item);
    }
    documentSection.appendChild(documentList);
  }
  content.appendChild(documentSection);

  const payments = allPayments.filter((payment) => payment.student_id === studentId);
  const paymentSection = document.createElement('section');
  paymentSection.className = 'student-profile-section';
  const paymentHeading = document.createElement('h3');
  paymentHeading.textContent = 'Fee Payment History';
  paymentSection.appendChild(paymentHeading);
  if (!payments.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No voucher or payment records found.';
    paymentSection.appendChild(empty);
  } else {
    const table = document.createElement('table');
    table.className = 'student-profile-payments';
    const head = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const label of ['Month', 'Voucher', 'Amount', 'Status']) {
      const cell = document.createElement('th');
      cell.textContent = label;
      headerRow.appendChild(cell);
    }
    head.appendChild(headerRow);
    table.appendChild(head);
    const body = document.createElement('tbody');
    for (const payment of payments) {
      const row = document.createElement('tr');
      for (const value of [
        `${payment.month || ''} ${payment.year || ''}`.trim(),
        payment.voucher_no || '—',
        `PKR ${Number(payment.amount || 0).toLocaleString()}`,
        (payment.status || 'pending').toLowerCase() === 'paid' ? 'Paid' : 'Pending'
      ]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.appendChild(cell);
      }
      body.appendChild(row);
    }
    table.appendChild(body);
    paymentSection.appendChild(table);
  }
  content.appendChild(paymentSection);
  dialog.showModal();
}

function closeStudentProfile() {
  document.getElementById('student-profile-dialog').close();
}

function openVoucherForStudent(sid) {
  switchPage('voucher');
  document.getElementById('voucher-student-id').value = sid;
  fetchStudentForVoucher();
}

// ── Fee payments (persist paid status) ─────────────
function buildVoucherNo(studentId, month, year) {
  return 'VCH-' + String(studentId).replace('STD-', '') + '-' + month.slice(0, 3).toUpperCase() + String(year).slice(-2);
}

function paymentKey(studentId, month, year) {
  return `${studentId}|${month}|${year}`;
}

function getLocalPayments() {
  return JSON.parse(localStorage.getItem('feePayments') || '[]');
}

function saveLocalPayment(record) {
  const payments = getLocalPayments();
  const key = paymentKey(record.student_id, record.month, record.year);
  const idx = payments.findIndex(p => paymentKey(p.student_id, p.month, p.year) === key);
  if (idx >= 0) payments[idx] = { ...payments[idx], ...record };
  else payments.push(record);
  localStorage.setItem('feePayments', JSON.stringify(payments));
  allPayments = payments;
}

function findPayment(studentId, month, year) {
  const key = paymentKey(studentId, month, year);
  return allPayments.find(p => paymentKey(p.student_id, p.month, String(p.year)) === key);
}

async function loadPaymentHistory() {
  const local = getLocalPayments();
  if (!pbConnected) {
    allPayments = local;
  } else {
    try {
      const res = await fetch(pbUrl + '/api/collections/fee_payments/records?perPage=500&sort=-paid_at,-created', {
        headers: { Authorization: `Bearer ${localStorage.getItem(AUTH_TOKEN_KEY) || ''}` }
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.message || 'Could not load shared vouchers');
      }

      const remote = (await res.json()).items || [];
      const remoteByKey = new Map(remote.map((p) => [
        paymentKey(p.student_id, p.month, String(p.year)),
        p
      ]));
      if (ensureCloudSyncAuth()) {
        for (const payment of local) {
          const key = paymentKey(payment.student_id, payment.month, String(payment.year));
          const sharedPayment = remoteByKey.get(key);
          if (sharedPayment) {
            if ((payment.status || '').toLowerCase() === 'paid' &&
                (sharedPayment.status || '').toLowerCase() !== 'paid') {
              try {
                const syncedPayment = await savePaymentRecord(payment);
                remoteByKey.set(key, syncedPayment);
              } catch (error) {
                console.error('Could not sync locally saved voucher:', error);
                toast('Voucher is still saved only on this PC: ' + error.message, 'error');
              }
            } else {
              saveLocalPayment(sharedPayment);
            }
            continue;
          }

          try {
            const shared = await savePaymentRecord(payment);
            remoteByKey.set(key, shared);
          } catch (error) {
            console.error('Could not sync locally saved voucher:', error);
            toast('Voucher is still saved only on this PC: ' + error.message, 'error');
          }
        }
      } else {
        for (const payment of local) {
          const key = paymentKey(payment.student_id, payment.month, String(payment.year));
          const existing = remoteByKey.get(key);
          if (!existing || ((payment.status || '').toLowerCase() === 'paid' &&
              (existing.status || '').toLowerCase() !== 'paid')) {
            remoteByKey.set(key, payment);
          }
        }
      }
      allPayments = Array.from(remoteByKey.values());
    } catch (error) {
      allPayments = local;
      console.error('Could not load shared vouchers:', error);
      toast('Could not load shared vouchers: ' + error.message, 'error');
    }
  }
  renderPaymentHistory();
}

function renderPaymentHistory() {
  const wrap = document.getElementById('payment-history-wrap');
  if (!wrap) return;

  const q = (document.getElementById('payment-search-input')?.value || '').toLowerCase();
  const filtered = allPayments.filter(p => {
    if (!q) return true;
    return (p.student_id || '').toLowerCase().includes(q) ||
      (p.student_name || '').toLowerCase().includes(q) ||
      (p.month || '').toLowerCase().includes(q) ||
      (p.voucher_no || '').toLowerCase().includes(q);
  });

  if (!filtered.length) {
    wrap.innerHTML = '<div class="empty-state">No vouchers yet. Generate a voucher to see it here and share it with your staff.</div>';
    return;
  }

  wrap.innerHTML = `<table class="student-table">
    <thead><tr>
      <th>Student ID</th><th>Name</th><th>Month</th><th>Voucher No.</th><th>Amount</th><th>Status</th><th>Paid On</th><th></th>
    </tr></thead>
    <tbody>${filtered.map(p => {
      const isPaid = (p.status || '').toLowerCase() === 'paid';
      const paidOn = p.paid_at ? new Date(p.paid_at).toLocaleDateString('en-PK', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
      return `<tr>
        <td><span class="id-tag">${p.student_id || ''}</span></td>
        <td><strong>${p.student_name || ''}</strong></td>
        <td>${p.month || ''} ${p.year || ''}</td>
        <td style="font-family:monospace;font-size:0.82rem">${p.voucher_no || ''}</td>
        <td>PKR ${(p.amount || 0).toLocaleString()}</td>
        <td><span class="badge ${isPaid ? 'badge-paid' : 'badge-pending'}">${isPaid ? '✓ Paid' : 'Pending'}</span></td>
        <td>${paidOn}</td>
        <td><button class="btn btn-sm btn-outline" onclick="openVoucherFromPayment('${p.student_id}', '${p.month}', ${p.year})">View</button></td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

function openVoucherFromPayment(studentId, month, year) {
  document.getElementById('voucher-student-id').value = studentId;
  document.getElementById('voucher-month').value = month;
  document.getElementById('voucher-year').value = year;
  fetchStudentForVoucher({ allowHistorical: true });
  document.getElementById('voucher-output')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setVoucherStatusBadge(status) {
  const badge = document.getElementById('voucher-status-badge');
  const markBtn = document.getElementById('mark-paid-btn');
  const paidStamp = document.getElementById('v-paid-stamp');
  const isPaid = status === 'paid';
  badge.className = 'badge ' + (isPaid ? 'badge-paid' : 'badge-pending');
  badge.textContent = isPaid ? '✓ Paid' : 'Pending';
  if (paidStamp) paidStamp.style.display = isPaid ? 'inline-block' : 'none';
  if (markBtn) {
    markBtn.disabled = isPaid;
    markBtn.textContent = isPaid ? 'Already Paid' : 'Mark as Paid';
  }
}

async function savePaymentRecord(record) {
  if (!pbConnected) {
    saveLocalPayment(record);
    return record;
  }
  saveLocalPayment(record);
  if (!ensureCloudSyncAuth()) throw new Error('Log in to PocketBase to share vouchers.');

  const filter = encodeURIComponent(
    `(student_id='${record.student_id}' && month='${record.month}' && year=${record.year})`
  );
  const existingRes = await fetch(pbUrl + `/api/collections/fee_payments/records?filter=${filter}&perPage=1`, {
      headers: {
        Authorization: `Bearer ${localStorage.getItem(AUTH_TOKEN_KEY) || ''}`
      }
    });

  if (!existingRes.ok) {
    const error = await existingRes.json().catch(() => ({}));
    throw new Error(error.message || 'Could not find the shared voucher.');
  }

  const existingData = await existingRes.json();
  const existing = existingData.items && existingData.items[0];
  if (existing && (existing.status || '').toLowerCase() === 'paid' &&
      (record.status || '').toLowerCase() !== 'paid') {
    saveLocalPayment(existing);
    return existing;
  }

  const payload = {
    student_id: record.student_id,
    student_name: record.student_name,
    month: record.month,
    year: Number(record.year),
    voucher_no: record.voucher_no,
    status: record.status,
    amount: record.amount,
    paid_at: record.paid_at || ''
  };

  let res;
  if (existing) {
      res = await fetch(pbUrl + '/api/collections/fee_payments/records/' + existing.id, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem(AUTH_TOKEN_KEY) || ''}`
        },
        body: JSON.stringify(payload)
      });
    } else {
      res = await fetch(pbUrl + '/api/collections/fee_payments/records', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem(AUTH_TOKEN_KEY) || ''}`
        },
        body: JSON.stringify(payload)
      });
    }

    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.message || 'Could not save the shared voucher.');
    }
    const data = await res.json();
    saveLocalPayment(data);
    return data;
}

// ── Voucher ─────────────────────────────────────────
function setVoucherPeriodToCurrentMonth() {
  const now = new Date();
  const month = new Intl.DateTimeFormat('en', { month: 'long' }).format(now);
  const year = now.getFullYear();
  const monthInput = document.getElementById('voucher-month');
  const yearInput = document.getElementById('voucher-year');
  monthInput.value = month;
  yearInput.value = year;
  yearInput.min = year;
  yearInput.max = year;
}

async function fetchStudentForVoucher({ allowHistorical = false } = {}) {
  const sid = document.getElementById('voucher-student-id').value.trim();
  if (!sid) { toast('Enter a Student ID', 'error'); return; }

  const month = document.getElementById('voucher-month').value;
  const year = Number(document.getElementById('voucher-year').value);
  const now = new Date();
  const monthIndex = Array.from(document.getElementById('voucher-month').options)
    .findIndex(option => option.value === month);
  const isCurrentPeriod = Number.isInteger(year) && year === now.getFullYear() && monthIndex === now.getMonth();
  const hasExistingPayment = allowHistorical && findPayment(sid, month, year);
  if (!isCurrentPeriod && !hasExistingPayment) {
    toast('Only vouchers for the current month can be generated.', 'error');
    return;
  }

  let student = allStudents.find(s => (s.student_id || s.id) === sid);

  if (!student && pbConnected) {
    try {
      const res = await fetch(pbUrl + `/api/collections/students/records?filter=(student_id='${sid}')`, {
        headers: { Authorization: `Bearer ${localStorage.getItem(AUTH_TOKEN_KEY) || ''}` }
      });
      const data = await res.json();
      student = data.items && data.items[0];
    } catch {}
  }

  if (!student) { toast('Student not found: ' + sid, 'error'); return; }

  const today = new Date();
  const dueDate = new Date(year, monthIndex + 1, 10);
  const voucherNo = buildVoucherNo(student.student_id || student.id, month, year);
  const netFee = student.net_fee || student.base_fee || 0;

  document.getElementById('v-student-id').textContent = student.student_id || student.id;
  document.getElementById('v-name').textContent = student.full_name || '';
  document.getElementById('v-father').textContent = student.father_name || '';
  document.getElementById('v-class').textContent = [student.class_name, student.program].filter(Boolean).join(' — ');
  document.getElementById('v-month').textContent = month + ' ' + year;
  document.getElementById('v-issue-date').textContent = today.toLocaleDateString('en-PK', {day:'2-digit',month:'short',year:'numeric'});
  document.getElementById('v-due-date').textContent = dueDate.toLocaleDateString('en-PK', {day:'2-digit',month:'short',year:'numeric'});
  document.getElementById('v-voucher-no').textContent = voucherNo;
  document.getElementById('v-base-fee').textContent = 'PKR ' + (student.base_fee || 0).toLocaleString();
  document.getElementById('v-discount').textContent = '- PKR ' + (student.discount_amt || 0).toLocaleString();
  document.getElementById('v-net-fee').textContent = 'PKR ' + netFee.toLocaleString();
  if (student.fee_notes) {
    document.getElementById('v-notes-row').style.display = '';
    document.getElementById('v-notes-label').textContent = '📌 ' + student.fee_notes;
  } else {
    document.getElementById('v-notes-row').style.display = 'none';
  }

  currentVoucher = {
    student_id: student.student_id || student.id,
    student_name: student.full_name || '',
    student_phone: student.contact || '',
    month,
    year,
    voucher_no: voucherNo,
    amount: netFee
  };

  try {
    const saved = await savePaymentRecord({ ...currentVoucher, status: 'pending', paid_at: '' });
    currentVoucher.status = (saved.status || 'pending').toLowerCase();
    currentVoucher.paid_at = saved.paid_at || '';
  } catch (error) {
    console.error('Could not share voucher:', error);
    toast('Voucher saved only on this PC for now; sharing failed: ' + error.message, 'error');
  }
  if (!pbConnected) {
    toast('Voucher saved only on this PC. Connect to PocketBase to share it.', 'error');
  }

  await loadPaymentHistory();
  const payment = findPayment(currentVoucher.student_id, month, year);
  const status = payment && (payment.status || '').toLowerCase() === 'paid' ? 'paid' : 'pending';
  currentVoucher.status = status;
  currentVoucher.paid_at = payment?.paid_at || '';

  document.getElementById('voucher-output').style.display = 'block';
  setVoucherStatusBadge(status);
}

async function markPaid() {
  if (!currentVoucher) {
    toast('Generate a voucher first', 'error');
    return;
  }
  if (currentVoucher.status === 'paid') {
    toast('This voucher is already marked as paid', 'error');
    return;
  }

  const paidAt = new Date().toISOString().split('T')[0];
  try {
    await savePaymentRecord({
      ...currentVoucher,
      status: 'paid',
      paid_at: paidAt
    });
    currentVoucher.status = 'paid';
    currentVoucher.paid_at = paidAt;
    setVoucherStatusBadge('paid');
    await loadPaymentHistory();
    toast(pbConnected ? 'Voucher marked as paid and shared' : 'Voucher marked as paid on this PC only', 'success');
  } catch (e) {
    currentVoucher.status = 'paid';
    currentVoucher.paid_at = paidAt;
    setVoucherStatusBadge('paid');
    toast('Paid status saved on this PC, but sharing failed: ' + e.message, 'error');
  }
}

function createVoucherImageFile() {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 1200;
  const ctx = canvas.getContext('2d');
  const colors = { primary: '#1a3a5c', accent: '#c8860a', text: '#1a1a1a', muted: '#5a5248', border: '#d6cfc0', surface: '#fffdf8' };

  ctx.fillStyle = colors.surface;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = colors.border;
  ctx.lineWidth = 2;
  ctx.strokeRect(24, 24, canvas.width - 48, canvas.height - 48);
  ctx.fillStyle = colors.primary;
  ctx.fillRect(24, 24, canvas.width - 48, 205);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 48px Georgia, serif';
  ctx.fillText('Insight Academy', 600, 100);
  ctx.font = '28px Arial, sans-serif';
  ctx.fillText('Fee Payment Voucher', 600, 148);
  ctx.font = 'bold 24px Arial, sans-serif';
  ctx.fillText(`${currentVoucher.voucher_no}  |  ${currentVoucher.month} ${currentVoucher.year}`, 600, 190);

  if (currentVoucher.status === 'paid') {
    ctx.textAlign = 'right';
    ctx.fillStyle = '#d8f3dc';
    ctx.font = 'bold 24px Arial, sans-serif';
    ctx.fillText('PAID', 1110, 65);
  }

  const fields = [
    ['STUDENT ID', currentVoucher.student_id], ['VOUCHER NO.', currentVoucher.voucher_no],
    ['STUDENT NAME', currentVoucher.student_name], ['FATHER\'S NAME', document.getElementById('v-father').textContent],
    ['CLASS / PROGRAM', document.getElementById('v-class').textContent], ['MONTH', `${currentVoucher.month} ${currentVoucher.year}`],
    ['ISSUE DATE', document.getElementById('v-issue-date').textContent], ['DUE DATE', document.getElementById('v-due-date').textContent]
  ];
  ctx.textAlign = 'left';
  fields.forEach(([label, value], index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = column === 0 ? 80 : 635;
    const y = 300 + row * 88;
    ctx.fillStyle = colors.muted;
    ctx.font = 'bold 18px Arial, sans-serif';
    ctx.fillText(label, x, y);
    ctx.fillStyle = colors.text;
    ctx.font = '26px Arial, sans-serif';
    ctx.fillText(String(value || '—'), x, y + 34, 485);
  });

  ctx.strokeStyle = colors.border;
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 7]);
  ctx.beginPath();
  ctx.moveTo(80, 675);
  ctx.lineTo(1120, 675);
  ctx.stroke();
  ctx.setLineDash([]);

  const feeRows = [
    ['Base Monthly Fee', document.getElementById('v-base-fee').textContent],
    ['Discount', document.getElementById('v-discount').textContent]
  ];
  if (document.getElementById('v-notes-row').style.display !== 'none') {
    feeRows.push(['Fee Notes', document.getElementById('v-notes-label').textContent]);
  }
  feeRows.forEach(([label, value], index) => {
    const y = 725 + index * 58;
    ctx.fillStyle = colors.muted;
    ctx.font = '24px Arial, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(label, 90, y);
    ctx.textAlign = 'right';
    ctx.fillStyle = colors.text;
    ctx.fillText(value, 1110, y);
  });

  const totalY = 885;
  ctx.strokeStyle = colors.primary;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(80, totalY - 32);
  ctx.lineTo(1120, totalY - 32);
  ctx.stroke();
  ctx.fillStyle = colors.primary;
  ctx.font = 'bold 30px Georgia, serif';
  ctx.textAlign = 'left';
  ctx.fillText('Net Amount Payable', 90, totalY + 12);
  ctx.textAlign = 'right';
  ctx.fillText(`PKR ${Number(currentVoucher.amount || 0).toLocaleString()}`, 1110, totalY + 12);

  ctx.strokeStyle = colors.border;
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.strokeRect(80, 955, 500, 105);
  ctx.strokeRect(620, 955, 500, 105);
  ctx.setLineDash([]);
  ctx.fillStyle = colors.muted;
  ctx.font = '20px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Signature & Stamp', 330, 1020);
  ctx.fillText('Student / Parent Copy', 870, 1020);
  ctx.font = '18px Arial, sans-serif';
  ctx.fillText('Please pay before the due date. Keep this voucher as proof of payment.', 600, 1125);

  const dataUrl = canvas.toDataURL('image/png');
  const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), char => char.charCodeAt(0));
  const fileName = `voucher-${currentVoucher.student_id}-${currentVoucher.year}-${currentVoucher.month}.png`;
  return new File([bytes], fileName, { type: 'image/png' });
}

async function shareVoucherOnWhatsApp() {
  if (!currentVoucher) {
    toast('Generate a voucher first', 'error');
    return;
  }

  const file = createVoucherImageFile();
  const cleanPhone = String(currentVoucher.student_phone || '').replace(/\D/g, '');
  const url = URL.createObjectURL(file);
  const download = document.createElement('a');
  download.href = url;
  download.download = file.name;
  download.click();
  URL.revokeObjectURL(url);
  const message = `Fee voucher ${currentVoucher.voucher_no} for ${currentVoucher.student_name}, ${currentVoucher.month} ${currentVoucher.year}. Amount: PKR ${Number(currentVoucher.amount || 0).toLocaleString()}.`;
  const whatsappUrl = cleanPhone
    ? `whatsapp://send?phone=${encodeURIComponent(cleanPhone)}&text=${encodeURIComponent(message)}`
    : `whatsapp://send?text=${encodeURIComponent(message)}`;
  const whatsappLink = document.createElement('a');
  whatsappLink.href = whatsappUrl;
  whatsappLink.click();
  toast('Voucher downloaded and WhatsApp Desktop opened. Attach the PNG from Downloads in the chat to send it.', 'success');
}

// ── Utilities ───────────────────────────────────────
function switchPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  document.querySelectorAll('.nav-btn')[['registration','voucher','students'].indexOf(name)].classList.add('active');
  if (name === 'students') loadStudents();
  if (name === 'voucher') loadPaymentHistory();
}

function clearForm() {
  ['full-name','father-name','dob','contact','email','address','class-name','program','cnic','prev-school','base-fee','discount-pct','discount-amt','fee-notes','enrollment-date'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('gender').value = '';
  document.getElementById('student-id-display').textContent = 'Will be assigned on save';
  selectedFiles = [];
  renderFileList();
  updateFeeDisplay(0, 0);
}

function toast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show' + (type ? ' ' + type : '');
  setTimeout(() => el.className = '', 3200);
}

// ── Init ─────────────────────────────────────────────
window.onload = async () => {
  setVoucherPeriodToCurrentMonth();

  document.getElementById('enrollment-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('voucher-year').value = new Date().getFullYear();
  allStudents = JSON.parse(localStorage.getItem('students') || '[]');
  allPayments = getLocalPayments();

  const urlInput = document.getElementById('pb-url');
  pbUrl = getDefaultPbUrl();
  if (urlInput) urlInput.value = pbUrl;
  updateNetworkHint();
  await connectPocketBase();
};
