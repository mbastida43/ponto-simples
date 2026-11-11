// Ponto Simples - frontend em JavaScript puro
const $ = (id) => document.getElementById(id);
const SLOTS = ['e1', 's1', 'e2', 's2'];
const WEEK = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const TOLERANCE = 5; // minutos de tolerancia para atraso na entrada

const state = {
  me: null,         // usuario logado
  employees: [],    // admin: todos da empresa; colaborador: apenas ele mesmo
  empId: null,      // colaborador exibido
  month: null,      // 'AAAA-MM'
  today: null,      // 'AAAA-MM-DD' (data do servidor, no fuso da empresa)
  records: {},      // { 'AAAA-MM-DD': { e1, s1, e2, s2, abono } }
  dirty: new Set(), // datas alteradas e ainda nao salvas
  editingId: null,
};
const isAdmin = () => state.me?.role === 'admin';

// ---------- Utilitarios ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toMin = (t) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : null);
const span = (a, b) => (a && b && toMin(b) > toMin(a) ? toMin(b) - toMin(a) : 0);
function fmt(min, sign = false) {
  if (min === null || min === undefined) return '';
  const a = Math.abs(min);
  const s = `${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
  return (min < 0 ? '-' : sign && min > 0 ? '+' : '') + s;
}
const currentEmp = () => state.employees.find((e) => e.id === state.empId);
const emptyRec = () => ({ e1: '', s1: '', e2: '', s2: '' });

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Erro ao comunicar com o servidor.');
    err.status = res.status;
    if (res.status === 401 && state.me) showAuth(); // sessao expirou
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}
const run = (fn) => (...args) => Promise.resolve(fn(...args)).catch((e) => toast(e.message, true));

// ---------- Calculo do dia ----------
function calcDay(emp, date, rec) {
  const dow = new Date(date + 'T12:00:00').getDay();
  const sch = emp.schedule;
  const active = date >= emp.startDate;
  const isWork = active && emp.workdays.includes(dow);
  const expected = isWork ? span(sch.e1, sch.s1) + span(sch.e2, sch.s2) : 0;
  const filled = SLOTS.filter((k) => rec[k]).length;
  const worked = span(rec.e1, rec.s1) + span(rec.e2, rec.s2);
  const badPair = (a, b) => !!a !== !!b || (a && b && toMin(b) <= toMin(a));
  const incomplete = badPair(rec.e1, rec.s1) || badPair(rec.e2, rec.s2);
  const isToday = date === state.today;
  const future = date > state.today;

  let status;
  if (filled === 0) {
    if (rec.abono && isWork) status = 'abonado';
    else if (!active || future) status = 'none';
    else if (!isWork) status = 'folga';
    else status = isToday ? 'pendente' : 'falta';
  } else if (incomplete) status = isToday ? 'andamento' : 'atencao';
  else if (isToday && isWork && filled < 4) status = 'andamento';
  else status = 'ok';

  // O dia so entra no saldo quando esta "fechado"
  const counted = ['ok', 'falta', 'atencao', 'abonado'].includes(status);
  let saldo = counted ? worked - expected : null;
  if (rec.abono && saldo < 0) saldo = 0;
  const lateMin = isWork && rec.e1 ? toMin(rec.e1) - toMin(sch.e1) : 0;
  const late = lateMin > TOLERANCE ? lateMin : 0;

  return { dow, isWork, isToday, expected, worked, filled, status, counted, saldo, late, extra: saldo > 0 ? saldo : 0 };
}

function monthDates() {
  const [y, m] = state.month.split('-').map(Number);
  const n = new Date(y, m, 0).getDate();
  return Array.from({ length: n }, (_, i) => `${state.month}-${String(i + 1).padStart(2, '0')}`);
}

// ---------- Renderizacao ----------
const STATUS_ICON = {
  ok: ['&#10003;', 'Completo'], falta: ['&#10007;', 'Falta'], atencao: ['!', 'Marcação incompleta'],
  andamento: ['&#8226;', 'Em andamento'], folga: ['&#9790;', 'Folga'], abonado: ['A', 'Abonado'],
  pendente: ['', ''], none: ['', ''],
};

function statusHtml(c) {
  const [icon, title] = STATUS_ICON[c.status];
  return icon ? `<span class="st ${c.status}" title="${title}">${icon}</span>` : '';
}

function renderEmployees() {
  const sel = $('empSelect');
  sel.innerHTML = state.employees.map((e) => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('');
  if (!currentEmp()) state.empId = state.me.id;
  const emp = currentEmp();
  sel.value = emp.id;
  sel.disabled = state.employees.length < 2;
  const s = emp.schedule;
  $('avatar').textContent = emp.name.split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
  $('empMeta').textContent = `${emp.job ? emp.job + ' · ' : ''}Jornada ${s.e1}–${s.s1} / ${s.e2}–${s.s2}`;
}

function renderTable() {
  const emp = currentEmp();
  const [y, m] = state.month.split('-').map(Number);
  $('monthLabel').textContent = new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  const s = emp.schedule;
  const lock = isAdmin() ? '' : 'disabled'; // colaborador apenas consulta
  $('rows').innerHTML = monthDates().map((date) => {
    const rec = state.records[date] ?? emptyRec();
    const c = calcDay(emp, date, rec);
    const inputs = SLOTS.map((k) =>
      `<td class="t-${k}"><input type="time" data-date="${date}" data-slot="${k}" value="${esc(rec[k] || '')}" aria-label="${k} ${date}" ${lock}></td>`).join('');
    return `<tr data-date="${date}" class="${c.isToday ? 'today' : ''} ${c.isWork ? '' : 'off'}">
      <td class="c-status"></td>
      <td class="left">${date.slice(8)}/${date.slice(5, 7)} · ${WEEK[c.dow]}</td>
      <td>${c.isWork ? `${s.e1.slice(0, 2)}-${s.s1.slice(0, 2)}/${s.e2.slice(0, 2)}-${s.s2.slice(0, 2)}` : 'Folga'}</td>
      ${inputs}
      <td class="c-worked"></td><td class="c-late late"></td><td class="c-extra pos"></td><td class="c-saldo"></td>
      <td><input type="checkbox" data-date="${date}" data-abono ${rec.abono ? 'checked' : ''} ${c.isWork ? lock : 'disabled'} title="Abonar o dia" aria-label="Abonar ${date}"></td>
    </tr>`;
  }).join('');
  monthDates().forEach(updateRow);
  renderSummary();
}

// Atualiza apenas as celulas calculadas da linha (mantem o foco nos campos)
function updateRow(date) {
  const tr = document.querySelector(`tr[data-date="${date}"]`);
  if (!tr) return;
  const c = calcDay(currentEmp(), date, state.records[date] ?? emptyRec());
  tr.querySelector('.c-status').innerHTML = statusHtml(c);
  tr.querySelector('.c-worked').textContent = c.filled ? fmt(c.worked) : '';
  tr.querySelector('.c-late').textContent = c.late ? fmt(c.late) : '';
  tr.querySelector('.c-extra').textContent = c.extra ? fmt(c.extra) : '';
  const saldo = tr.querySelector('.c-saldo');
  saldo.textContent = c.saldo ? fmt(c.saldo, true) : '';
  saldo.className = 'c-saldo ' + (c.saldo < 0 ? 'neg' : 'pos');
  tr.querySelector('.t-e1').classList.toggle('late', c.late > 0);
}

function renderSummary() {
  const emp = currentEmp();
  const t = { worked: 0, expected: 0, saldo: 0, extra: 0, late: 0, lateDays: 0, faltas: 0 };
  for (const date of monthDates()) {
    const c = calcDay(emp, date, state.records[date] ?? emptyRec());
    t.worked += c.worked;
    if (c.counted) { t.expected += c.expected; t.saldo += c.saldo; t.extra += c.extra; }
    if (c.late) { t.late += c.late; t.lateDays++; }
    if (c.status === 'falta') t.faltas++;
  }
  const tile = (label, value, cls = '') => `<div class="tile"><div class="label">${label}</div><div class="value ${cls}">${value}</div></div>`;
  $('summary').innerHTML =
    tile('Trabalhado / Previsto', `${fmt(t.worked)}<small> / ${fmt(t.expected)}</small>`) +
    tile('Saldo do mês', fmt(t.saldo, true) || '0:00', t.saldo < 0 ? 'neg' : t.saldo > 0 ? 'pos' : '') +
    tile('Horas extras', fmt(t.extra)) +
    tile('Atrasos', `${fmt(t.late)}<small> · ${t.lateDays} dia(s)</small>`) +
    tile('Faltas', `${t.faltas}<small> dia(s)</small>`, t.faltas ? 'neg' : '');
}

function setDirty(date) {
  if (date) state.dirty.add(date); else state.dirty.clear();
  $('dirtyBar').hidden = state.dirty.size === 0;
}

// ---------- Carga de dados ----------
async function loadEmployees() {
  state.employees = (await api('GET', '/api/employees')).employees;
  renderEmployees();
}

async function loadRecords() {
  setDirty(null);
  const data = await api('GET', `/api/employees/${state.empId}/records?month=${state.month}`);
  state.today = data.today;
  state.records = data.records;
  renderTable();
}

async function save() {
  if (!state.dirty.size) return;
  const days = {};
  for (const d of state.dirty) days[d] = state.records[d] ?? emptyRec();
  await api('PUT', `/api/employees/${state.empId}/records`, { days });
  setDirty(null);
  toast('Alterações salvas.');
}

// Confirma antes de descartar edicoes pendentes
const canLeave = () => state.dirty.size === 0 || confirm('Há alterações não salvas. Deseja descartá-las?');

// ---------- Login / cadastro ----------
function showAuth() {
  state.me = null;
  $('appView').hidden = true;
  $('authView').hidden = false;
}

async function start() {
  let data;
  try { data = await api('GET', '/api/me'); }
  catch (e) { if (e.status === 401) return showAuth(); throw e; }
  state.me = data.user;
  state.today = data.today;
  state.month = data.today.slice(0, 7);
  state.empId = data.user.id;
  $('companyName').textContent = data.company.name;
  $('userName').textContent = data.user.name;
  document.body.classList.toggle('is-admin', isAdmin());
  $('authView').hidden = true;
  $('appView').hidden = false;
  await loadEmployees();
  await loadRecords();
}

function setTab(signup) {
  $('tabLogin').classList.toggle('active', !signup);
  $('tabSignup').classList.toggle('active', signup);
  $('loginForm').hidden = signup;
  $('signupForm').hidden = !signup;
  $('authError').hidden = true;
}
$('tabLogin').onclick = () => setTab(false);
$('tabSignup').onclick = () => setTab(true);

function authSubmit(url, getBody) {
  return async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    $('authError').hidden = true;
    try {
      await api('POST', url, getBody(f));
      f.reset();
      await start();
    } catch (e) {
      $('authError').textContent = e.message;
      $('authError').hidden = false;
    }
  };
}
$('loginForm').addEventListener('submit', authSubmit('/api/login', (f) => ({ email: f.email.value, password: f.password.value })));
$('signupForm').addEventListener('submit', authSubmit('/api/signup', (f) => ({
  company: f.company.value, name: f.name.value, email: f.email.value, password: f.password.value,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
})));

$('btnLogout').onclick = run(async () => {
  if (!canLeave()) return;
  await api('POST', '/api/logout');
  setDirty(null);
  showAuth();
});

$('btnPassword').onclick = () => { $('pwdForm').reset(); $('pwdError').hidden = true; $('pwdDialog').showModal(); };
$('btnClosePwd').onclick = () => $('pwdDialog').close();
$('pwdForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  try {
    await api('POST', '/api/me/password', { current: f.current.value, next: f.next.value });
    $('pwdDialog').close();
    toast('Senha alterada.');
  } catch (e) {
    $('pwdError').textContent = e.message;
    $('pwdError').hidden = false;
  }
});

// ---------- Eventos da apuracao ----------
$('rows').addEventListener('input', (ev) => {
  const el = ev.target;
  const date = el.dataset.date;
  if (!date) return;
  const rec = (state.records[date] ??= emptyRec());
  if (el.dataset.slot) rec[el.dataset.slot] = el.value;
  else if ('abono' in el.dataset) { if (el.checked) rec.abono = true; else delete rec.abono; }
  setDirty(date);
  updateRow(date);
  renderSummary();
});

$('btnSave').onclick = run(save);
$('btnCancel').onclick = run(loadRecords);

// O ponto e sempre batido para o proprio usuario logado
$('btnPunch').onclick = run(async () => {
  await save(); // garante que edicoes pendentes nao se percam
  const r = await api('POST', '/api/punch');
  toast(`${r.label} registrada às ${r.time}`);
  state.empId = state.me.id;
  state.month = r.date.slice(0, 7);
  renderEmployees();
  await loadRecords();
});

function switchEmp(id) {
  if (!canLeave()) { $('empSelect').value = state.empId; return; }
  state.empId = id;
  renderEmployees();
  return loadRecords();
}
function stepEmp(delta) {
  const n = state.employees.length;
  if (n < 2) return;
  const i = state.employees.findIndex((e) => e.id === state.empId);
  return switchEmp(state.employees[(i + delta + n) % n].id);
}
$('empSelect').onchange = run((ev) => switchEmp(ev.target.value));
$('btnPrevEmp').onclick = run(() => stepEmp(-1));
$('btnNextEmp').onclick = run(() => stepEmp(1));

function stepMonth(delta) {
  if (!canLeave()) return;
  const [y, m] = state.month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  state.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return loadRecords();
}
$('btnPrevMonth').onclick = run(() => stepMonth(-1));
$('btnNextMonth').onclick = run(() => stepMonth(1));

$('btnPrint').onclick = () => window.print();

$('btnExport').onclick = () => {
  const emp = currentEmp();
  const lines = [['Data', 'Dia', 'Status', 'Ent1', 'Sai1', 'Ent2', 'Sai2', 'Trabalhado', 'Atraso', 'Extra', 'Saldo', 'Abono']];
  for (const date of monthDates()) {
    const rec = state.records[date] ?? emptyRec();
    const c = calcDay(emp, date, rec);
    lines.push([date.split('-').reverse().join('/'), WEEK[c.dow], STATUS_ICON[c.status][1], rec.e1, rec.s1, rec.e2, rec.s2,
      c.filled ? fmt(c.worked) : '', c.late ? fmt(c.late) : '', c.extra ? fmt(c.extra) : '', c.saldo ? fmt(c.saldo, true) : '', rec.abono ? 'Sim' : '']);
  }
  // Aspas em todos os campos; o apostrofo inicial evita que o Excel interprete texto como formula
  const cell = (v) => { const s = String(v ?? ''); return `"${(/^[=@\t\r]/.test(s) ? "'" + s : s).replace(/"/g, '""')}"`; };
  const csv = '﻿' + lines.map((l) => l.map(cell).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `ponto_${emp.name.replace(/[^\p{L}\p{N}]+/gu, '_')}_${state.month}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
};

// ---------- Cadastro de colaborador (admin) ----------
$('workdays').innerHTML = WEEK.map((d, i) => `<label><input type="checkbox" name="wd" value="${i}"> ${d}</label>`).join('');

function openDialog(emp) {
  const f = $('empForm');
  state.editingId = emp?.id ?? null;
  $('empDialogTitle').textContent = emp ? 'Editar colaborador' : 'Novo colaborador';
  $('pwdLabel').textContent = emp ? 'Nova senha (opcional)' : 'Senha inicial';
  $('btnDeleteEmp').hidden = !emp || emp.id === state.me.id;
  $('empError').hidden = true;
  f.reset();
  f.name.value = emp?.name ?? '';
  f.email.value = emp?.email ?? '';
  f.password.required = !emp;
  f.job.value = emp?.job ?? '';
  f.role.value = emp?.role ?? 'employee';
  f.role.disabled = emp?.id === state.me.id;
  f.startDate.value = emp?.startDate ?? state.today;
  const sch = emp?.schedule ?? { e1: '08:00', s1: '12:00', e2: '13:00', s2: '17:00' };
  for (const k of SLOTS) f[k].value = sch[k];
  const wd = emp?.workdays ?? [1, 2, 3, 4, 5];
  f.querySelectorAll('[name=wd]').forEach((c) => (c.checked = wd.includes(Number(c.value))));
  $('empDialog').showModal();
}
$('btnNewEmp').onclick = () => openDialog(null);
$('btnEditEmp').onclick = () => openDialog(currentEmp());
$('btnCloseDialog').onclick = () => $('empDialog').close();

$('empForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const body = {
    name: f.name.value, email: f.email.value, password: f.password.value, job: f.job.value, role: f.role.value,
    startDate: f.startDate.value,
    schedule: Object.fromEntries(SLOTS.map((k) => [k, f[k].value])),
    workdays: [...f.querySelectorAll('[name=wd]:checked')].map((c) => Number(c.value)),
  };
  try {
    const emp = state.editingId
      ? await api('PUT', `/api/employees/${state.editingId}`, body)
      : await api('POST', '/api/employees', body);
    $('empDialog').close();
    const changed = state.empId !== emp.id;
    state.empId = emp.id;
    if (emp.id === state.me.id) { state.me = emp; $('userName').textContent = emp.name; }
    await loadEmployees();
    if (changed) await loadRecords(); else renderTable();
    toast('Colaborador salvo.');
  } catch (e) {
    $('empError').textContent = e.message;
    $('empError').hidden = false;
  }
});

$('btnDeleteEmp').onclick = run(async () => {
  const emp = currentEmp();
  if (!confirm(`Excluir ${emp.name} e todas as suas marcações? Esta ação não pode ser desfeita.`)) return;
  await api('DELETE', `/api/employees/${emp.id}`);
  $('empDialog').close();
  state.empId = state.me.id;
  await loadEmployees();
  await loadRecords();
  toast('Colaborador excluído.');
});

window.addEventListener('beforeunload', (ev) => { if (state.dirty.size) ev.preventDefault(); });

// ---------- Inicio ----------
function tick() { $('clock').textContent = new Date().toLocaleTimeString('pt-BR'); }
tick();
setInterval(tick, 1000);
run(start)();
