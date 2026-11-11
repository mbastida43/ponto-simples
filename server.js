// Ponto Simples (SaaS) - backend sem dependencias externas
// Requer Node.js 22.13+ (usa o SQLite embutido: node:sqlite)
// Uso: node server.js          (inicia em http://localhost:3000)
//      node server.js --demo   (cria uma empresa de exemplo se o banco estiver vazio - apenas para testes)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const scrypt = promisify(crypto.scrypt);

const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production'; // em producao o cookie exige HTTPS
const TRUST_PROXY = process.env.TRUST_PROXY === '1'; // use atras de um proxy reverso (nginx, etc.)
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SESSION_DAYS = 7;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// E-mails aceitos: somente os dominios cadastrados aqui
const CORP_DOMAINS = ['qintess.com', 'marlonbastida.com.br'];
const isCorporate = (email) => CORP_DOMAINS.includes(email.split('@')[1]);
const CORP_MSG = 'Use um e-mail corporativo de um domínio cadastrado: ' + CORP_DOMAINS.map((d) => '@' + d).join(' ou ') + '.';
const SLOTS = ['e1', 's1', 'e2', 's2'];
const SLOT_NAMES = { e1: 'Entrada', s1: 'Saída para intervalo', e2: 'Retorno do intervalo', s2: 'Saída' };

// ---------- Banco de dados (SQLite) ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'ponto.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, timezone TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'employee')),
    job TEXT NOT NULL DEFAULT '', start_date TEXT NOT NULL,
    e1 TEXT NOT NULL, s1 TEXT NOT NULL, e2 TEXT NOT NULL, s2 TEXT NOT NULL,
    workdays TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id);
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS records (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    e1 TEXT NOT NULL DEFAULT '', s1 TEXT NOT NULL DEFAULT '',
    e2 TEXT NOT NULL DEFAULT '', s2 TEXT NOT NULL DEFAULT '',
    abono INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, date)
  );
`);

// Todas as consultas sao parametrizadas e filtradas pela empresa (tenant) da sessao.
const q = {
  userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
  insertCompany: db.prepare('INSERT INTO companies (id, name, timezone, created_at) VALUES (?, ?, ?, ?)'),
  insertUser: db.prepare(`INSERT INTO users (id, company_id, name, email, password_hash, role, job, start_date, e1, s1, e2, s2, workdays)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  updateUser: db.prepare(`UPDATE users SET name = ?, email = ?, role = ?, job = ?, start_date = ?, e1 = ?, s1 = ?, e2 = ?, s2 = ?, workdays = ?
                          WHERE id = ? AND company_id = ?`),
  setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ? AND company_id = ?'),
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userInCompany: db.prepare('SELECT * FROM users WHERE id = ? AND company_id = ?'),
  usersOfCompany: db.prepare('SELECT * FROM users WHERE company_id = ? ORDER BY name COLLATE NOCASE'),
  company: db.prepare('SELECT * FROM companies WHERE id = ?'),
  insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  session: db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  recordsOfMonth: db.prepare('SELECT * FROM records WHERE user_id = ? AND date LIKE ?'),
  record: db.prepare('SELECT * FROM records WHERE user_id = ? AND date = ?'),
  upsertRecord: db.prepare(`INSERT INTO records (user_id, date, e1, s1, e2, s2, abono) VALUES (?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT (user_id, date) DO UPDATE SET e1 = excluded.e1, s1 = excluded.s1, e2 = excluded.e2, s2 = excluded.s2, abono = excluded.abono`),
  deleteRecord: db.prepare('DELETE FROM records WHERE user_id = ? AND date = ?'),
};

function transaction(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------- Utilitarios ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const pad = (n) => String(n).padStart(2, '0');

// Data e hora atuais no fuso da empresa (o servidor pode estar em qualquer fuso)
function nowIn(timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

function validTimezone(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const hash = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Limite simples de tentativas em memoria (login e cadastro)
const attempts = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.reset < now) { attempts.set(key, { count: 1, reset: now + windowMs }); return; }
  if (++entry.count > max) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos e tente novamente.');
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k);
  q.purgeSessions.run(now);
}, 10 * 60 * 1000).unref();

function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress ?? '';
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extraHeaders });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 200_000) { reject(new HttpError(413, 'Requisição muito grande.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch { reject(new HttpError(400, 'JSON inválido.')); }
    });
    req.on('error', reject);
  });
}

// ---------- Sessao ----------
function sessionCookie(token, maxAgeSeconds) {
  return `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${PROD ? '; Secure' : ''}`;
}

function readToken(req) {
  const m = /(?:^|;\s*)sid=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '');
  return m ? m[1] : null;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  q.insertSession.run(sha256(token), userId, Date.now() + SESSION_DAYS * 86400_000); // so o hash vai para o banco
  return sessionCookie(token, SESSION_DAYS * 86400);
}

function currentUser(req) {
  const token = readToken(req);
  if (!token) return null;
  return q.session.get(sha256(token), Date.now()) ?? null;
}

// ---------- Validacao ----------
function cleanPassword(value, required) {
  const password = typeof value === 'string' ? value : '';
  if (!password && !required) return null;
  if (password.length < 8 || password.length > 200) throw new HttpError(400, 'A senha deve ter pelo menos 8 caracteres.');
  return password;
}

function cleanEmail(value) {
  const email = String(value ?? '').trim().toLowerCase().slice(0, 120);
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Informe um e-mail válido.');
  if (!isCorporate(email)) throw new HttpError(400, CORP_MSG);
  return email;
}

function cleanName(value, message) {
  const name = String(value ?? '').trim().slice(0, 80);
  if (!name) throw new HttpError(400, message);
  return name;
}

function cleanEmployee(body) {
  const name = cleanName(body.name, 'Informe o nome do colaborador.');
  const email = cleanEmail(body.email);
  const role = body.role === 'admin' ? 'admin' : 'employee';
  const job = String(body.job ?? '').trim().slice(0, 80);
  const startDate = String(body.startDate ?? '');
  if (!DATE_RE.test(startDate)) throw new HttpError(400, 'Data de início inválida.');
  const schedule = {};
  for (const k of SLOTS) {
    const v = String(body.schedule?.[k] ?? '');
    if (!TIME_RE.test(v)) throw new HttpError(400, 'Preencha os quatro horários da jornada.');
    schedule[k] = v;
  }
  if (!(schedule.e1 < schedule.s1 && schedule.s1 <= schedule.e2 && schedule.e2 < schedule.s2)) {
    throw new HttpError(400, 'Os horários da jornada devem estar em ordem crescente.');
  }
  const workdays = [...new Set((Array.isArray(body.workdays) ? body.workdays : []).map(Number))]
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
  if (!workdays.length) throw new HttpError(400, 'Selecione ao menos um dia de trabalho.');
  return { name, email, role, job, startDate, schedule, workdays };
}

function cleanRecord(body) {
  const rec = {};
  for (const k of SLOTS) {
    const v = String(body?.[k] ?? '');
    if (v !== '' && !TIME_RE.test(v)) throw new HttpError(400, 'Horário inválido.');
    rec[k] = v;
  }
  rec.abono = body?.abono === true;
  return rec;
}

const toEmployee = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role, job: u.job, startDate: u.start_date,
  schedule: { e1: u.e1, s1: u.s1, e2: u.e2, s2: u.s2 }, workdays: JSON.parse(u.workdays),
});

const toRecord = (r) => ({ e1: r.e1, s1: r.s1, e2: r.e2, s2: r.s2, ...(r.abono ? { abono: true } : {}) });

function insertUser(companyId, e, passwordHash) {
  const id = crypto.randomUUID();
  try {
    q.insertUser.run(id, companyId, e.name, e.email, passwordHash, e.role, e.job, e.startDate,
      e.schedule.e1, e.schedule.s1, e.schedule.e2, e.schedule.s2, JSON.stringify(e.workdays));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'Este e-mail já está cadastrado.');
    throw err;
  }
  return id;
}

// ---------- Rotas publicas (sem login) ----------
const DEFAULT_SCHEDULE = { e1: '08:00', s1: '12:00', e2: '13:00', s2: '17:00' };

async function signup(req, res) {
  rateLimit('signup|' + clientIp(req), 10, 60 * 60 * 1000);
  const body = await readBody(req);
  const companyName = cleanName(body.company, 'Informe o nome da empresa.');
  const name = cleanName(body.name, 'Informe o seu nome.');
  const email = cleanEmail(body.email);
  const password = cleanPassword(body.password, true);
  const timezone = validTimezone(body.timezone) ? String(body.timezone) : 'America/Sao_Paulo';
  if (q.userByEmail.get(email)) throw new HttpError(409, 'Este e-mail já está cadastrado.');
  const passwordHash = await hashPassword(password);
  const userId = transaction(() => {
    const companyId = crypto.randomUUID();
    q.insertCompany.run(companyId, companyName, timezone, new Date().toISOString());
    return insertUser(companyId, {
      name, email, role: 'admin', job: 'Administrador', startDate: nowIn(timezone).date,
      schedule: DEFAULT_SCHEDULE, workdays: [1, 2, 3, 4, 5],
    }, passwordHash);
  });
  sendJson(res, 201, { ok: true }, { 'Set-Cookie': createSession(userId) });
}

// Hash usado quando o e-mail nao existe, para o tempo de resposta nao revelar quais e-mails estao cadastrados
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

async function login(req, res) {
  const body = await readBody(req);
  const email = String(body.email ?? '').trim().toLowerCase().slice(0, 120);
  const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
  rateLimit(`login|${clientIp(req)}|${email}`, 10, 15 * 60 * 1000);
  rateLimit(`login|${clientIp(req)}`, 50, 15 * 60 * 1000);
  const user = q.userByEmail.get(email);
  const ok = await verifyPassword(password, user ? user.password_hash : await DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'E-mail ou senha incorretos.');
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': createSession(user.id) });
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const { method } = req;
  const parts = url.pathname.split('/').filter(Boolean); // ['api', recurso, id, sub]
  const [, resource, id, sub] = parts;

  // Protecao contra CSRF: alem do cookie SameSite=Strict, toda escrita exige JSON e mesma origem
  if (method !== 'GET') {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'Envie os dados como JSON.');
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Origem não permitida.');
  }

  if (resource === 'signup' && method === 'POST') return signup(req, res);
  if (resource === 'login' && method === 'POST') return login(req, res);

  // Daqui para baixo, tudo exige sessao valida (negado por padrao)
  const me = currentUser(req);
  if (!me) throw new HttpError(401, 'Sessão expirada. Entre novamente.');
  const company = q.company.get(me.company_id);
  const isAdmin = me.role === 'admin';
  const requireAdmin = () => { if (!isAdmin) throw new HttpError(403, 'Apenas administradores podem fazer isso.'); };
  // Busca sempre restrita a empresa da sessao: um id de outra empresa simplesmente "nao existe"
  const findEmployee = (empId) => {
    const u = q.userInCompany.get(empId, me.company_id);
    if (!u) throw new HttpError(404, 'Colaborador não encontrado.');
    return u;
  };

  if (resource === 'logout' && method === 'POST') {
    q.deleteSession.run(sha256(readToken(req)));
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  if (resource === 'me') {
    if (!id && method === 'GET') {
      return sendJson(res, 200, { user: toEmployee(me), company: { name: company.name }, today: nowIn(company.timezone).date });
    }
    if (id === 'password' && method === 'POST') {
      const body = await readBody(req);
      rateLimit('pwd|' + me.id, 10, 15 * 60 * 1000);
      if (!(await verifyPassword(String(body.current ?? ''), me.password_hash))) throw new HttpError(400, 'Senha atual incorreta.');
      q.setPassword.run(await hashPassword(cleanPassword(body.next, true)), me.id);
      q.deleteUserSessions.run(me.id); // encerra as outras sessoes
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': createSession(me.id) });
    }
    throw new HttpError(404, 'Rota não encontrada.');
  }

  // Bater ponto: sempre para o proprio usuario logado, com a hora do servidor no fuso da empresa
  if (resource === 'punch' && method === 'POST') {
    const { date, time } = nowIn(company.timezone);
    const rec = q.record.get(me.id, date) ?? { e1: '', s1: '', e2: '', s2: '', abono: 0 };
    const slot = SLOTS.find((k) => !rec[k]);
    if (!slot) throw new HttpError(409, 'Todas as marcações de hoje já foram registradas.');
    rec[slot] = time;
    q.upsertRecord.run(me.id, date, rec.e1, rec.s1, rec.e2, rec.s2, rec.abono ? 1 : 0);
    return sendJson(res, 200, { date, slot, time, label: SLOT_NAMES[slot] });
  }

  if (resource !== 'employees') throw new HttpError(404, 'Rota não encontrada.');

  // /api/employees
  if (!id) {
    if (method === 'GET') {
      const list = isAdmin ? q.usersOfCompany.all(me.company_id) : [me];
      return sendJson(res, 200, { employees: list.map(toEmployee) });
    }
    if (method === 'POST') {
      requireAdmin();
      const body = await readBody(req);
      const data = cleanEmployee(body);
      const newId = insertUser(me.company_id, data, await hashPassword(cleanPassword(body.password, true)));
      return sendJson(res, 201, toEmployee(findEmployee(newId)));
    }
    throw new HttpError(405, 'Método não permitido.');
  }

  // /api/employees/:id
  if (!sub) {
    requireAdmin();
    const target = findEmployee(id);
    if (method === 'PUT') {
      const body = await readBody(req);
      const d = cleanEmployee(body);
      if (target.id === me.id) d.role = 'admin'; // o admin nao rebaixa a si mesmo (sempre sobra um admin)
      const password = cleanPassword(body.password, false);
      const passwordHash = password ? await hashPassword(password) : null;
      try {
        q.updateUser.run(d.name, d.email, d.role, d.job, d.startDate, d.schedule.e1, d.schedule.s1, d.schedule.e2, d.schedule.s2,
          JSON.stringify(d.workdays), target.id, me.company_id);
      } catch (err) {
        if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'Este e-mail já está cadastrado.');
        throw err;
      }
      if (passwordHash) {
        q.setPassword.run(passwordHash, target.id);
        if (target.id !== me.id) q.deleteUserSessions.run(target.id);
      }
      return sendJson(res, 200, toEmployee(findEmployee(id)));
    }
    if (method === 'DELETE') {
      if (target.id === me.id) throw new HttpError(400, 'Você não pode excluir a própria conta.');
      q.deleteUser.run(target.id, me.company_id); // marcacoes e sessoes saem em cascata
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(405, 'Método não permitido.');
  }

  // /api/employees/:id/records
  if (sub === 'records') {
    if (!isAdmin && id !== me.id) throw new HttpError(403, 'Você só pode ver o seu próprio ponto.');
    const target = findEmployee(id);
    if (method === 'GET') {
      const month = url.searchParams.get('month') ?? '';
      if (!MONTH_RE.test(month)) throw new HttpError(400, 'Mês inválido.');
      const records = {};
      for (const r of q.recordsOfMonth.all(target.id, month + '-%')) records[r.date] = toRecord(r);
      return sendJson(res, 200, { today: nowIn(company.timezone).date, records });
    }
    if (method === 'PUT') {
      requireAdmin(); // somente o administrador corrige marcacoes
      const body = await readBody(req);
      const days = body.days && typeof body.days === 'object' ? Object.entries(body.days) : [];
      if (days.length > 62) throw new HttpError(400, 'Muitos dias em uma única requisição.');
      const cleaned = days.map(([date, rec]) => {
        if (!DATE_RE.test(date)) throw new HttpError(400, 'Data inválida.');
        return [date, cleanRecord(rec)];
      });
      transaction(() => {
        for (const [date, r] of cleaned) {
          if (!r.e1 && !r.s1 && !r.e2 && !r.s2 && !r.abono) q.deleteRecord.run(target.id, date);
          else q.upsertRecord.run(target.id, date, r.e1, r.s1, r.e2, r.s2, r.abono ? 1 : 0);
        }
      });
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(405, 'Método não permitido.');
  }

  throw new HttpError(404, 'Rota não encontrada.');
}

// ---------- Arquivos estaticos ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método não permitido.');
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, 'URL inválida.'); }
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Acesso negado.');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS }); return res.end('Não encontrado'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

// ---------- Dados de exemplo (apenas para testes locais) ----------
async function seedDemo() {
  const tz = 'America/Sao_Paulo';
  const today = nowIn(tz).date;
  const firstDay = today.slice(0, 8) + '01';
  const hash = await hashPassword('demo1234');
  const companyId = crypto.randomUUID();
  const schedule = { e1: '08:00', s1: '12:00', e2: '13:00', s2: '18:00' };
  const addMin = (t, m) => {
    const total = Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) + m;
    return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
  };
  transaction(() => {
    q.insertCompany.run(companyId, 'Empresa Demo', tz, new Date().toISOString());
    insertUser(companyId, { name: 'Admin Demo', email: 'admin@demo.com', role: 'admin', job: 'Gestor de RH', startDate: today, schedule, workdays: [1, 2, 3, 4, 5] }, hash);
    const anaId = insertUser(companyId, { name: 'Ana Souza', email: 'ana@demo.com', role: 'employee', job: 'Assistente Administrativo', startDate: firstDay, schedule, workdays: [1, 2, 3, 4, 5] }, hash);
    const offsets = [-3, 0, 2, 12, 0, -5, 1, 25];
    let i = 0;
    for (let day = 1; day < Number(today.slice(8)); day++) {
      const date = today.slice(0, 8) + pad(day);
      const dow = new Date(date + 'T12:00:00Z').getUTCDay();
      if (dow === 0 || dow === 6) continue;
      if (i === 3) { i++; continue; } // um dia de falta
      const s2 = i === 6 ? '' : addMin('18:00', (i % 5) * 9 - 5); // um dia com marcacao incompleta
      q.upsertRecord.run(anaId, date, addMin('08:00', offsets[i % 8]), addMin('12:00', i % 3), addMin('13:00', i % 4), s2, 0);
      i++;
    }
  });
  console.log('Empresa de exemplo criada. Logins: admin@demo.com e ana@demo.com (senha: demo1234)');
}

// ---------- Servidor ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    if (!res.headersSent) sendJson(res, err.status ?? 500, { error: err.status ? err.message : 'Erro interno.' });
  }
});

(async () => {
  if (process.argv.includes('--demo') && q.userCount.get().n === 0) await seedDemo();
  server.listen(PORT, () => console.log(`Ponto Simples rodando em http://localhost:${PORT}`));
})();
