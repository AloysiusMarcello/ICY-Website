'use strict';
// ICY NUS server: serves icy.html and its assets, and keeps cell group sign-ups, events,
// questions, prayer requests and uploaded files.
//   node server.js          reachable from this laptop only
//   node server.js --lan    also reachable from other devices on the same network
// On a host such as Render it listens publicly on the PORT it is given.
// Everything goes to Postgres when DATABASE_URL is set (the only dependency, "pg", is loaded just for that),
// otherwise to data/store.json and data/files/ (DATA_DIR moves that folder, e.g. onto a mounted disk).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8090;
const ON_RENDER = Boolean(process.env.RENDER);
const HOST = process.env.HOST || (ON_RENDER || process.argv.includes('--lan') ? '0.0.0.0' : '127.0.0.1');
const PAGE = path.join(__dirname, 'icy.html');
const ASSETS = path.join(__dirname, 'assets');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE = path.join(DATA_DIR, 'store.json');
const FILES = path.join(DATA_DIR, 'files');
const MAX_BODY = 64 * 1024, MAX_FILE = 10 * 1024 * 1024;
const LIMIT = { cg: 1000, events: 500, questions: 2000, prayers: 2000, files: 2000, people: 300, docs: 20, replies: 100 };
const DATE = /^\d{4}-\d{2}-\d{2}$/, TIME = /^([01]\d|2[0-3]):[0-5]\d$/, ID = /^[a-f0-9]{16}$/;
const COLORS = ['lime', 'lav', 'pink', 'sky', 'peach', 'mint'];
const IMAGE = /^image\/(jpeg|png|webp|gif)$/;

// ---------- storage ----------
// Records are held in memory and written through to the database or the data file.
// Render's free plan wipes the disk whenever the service restarts, so it needs the database.
const db = { cg: {}, events: {}, questions: {}, prayers: {}, files: {} }; // kind -> id -> record
const unsaved = new Set(); // 'kind/id' changed since the last write
let pool = null, saveTimer = null, writes = Promise.resolve();

function loadFile() {
  if (!fs.existsSync(STORE)) return;
  try {
    const o = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    for (const kind of Object.keys(db)) if (o[kind] && typeof o[kind] === 'object') Object.assign(db[kind], o[kind]);
  } catch (e) {
    const kept = STORE + '.unreadable-' + Date.now();
    fs.copyFileSync(STORE, kept);
    console.error('data/store.json could not be read. Kept a copy at ' + kept + ' and started empty.');
  }
}
async function openDatabase(url) {
  const { Pool } = require('pg');
  let lastError;
  for (const ssl of [{ rejectUnauthorized: false }, false]) { // hosted databases usually want TLS; fall back to plain
    const p = new Pool({ connectionString: url, ssl, max: 3 });
    p.on('error', (e) => console.error('Database connection problem: ' + e.message));
    try {
      await p.query('CREATE TABLE IF NOT EXISTS icy_records (kind text NOT NULL, id text NOT NULL, data jsonb NOT NULL, PRIMARY KEY (kind, id))');
      await p.query('CREATE TABLE IF NOT EXISTS icy_files (id text PRIMARY KEY, data bytea NOT NULL)');
      for (const row of (await p.query('SELECT kind, id, data FROM icy_records')).rows) if (db[row.kind]) db[row.kind][row.id] = row.data;
      return p;
    } catch (e) { lastError = e; await p.end().catch(() => {}); }
  }
  throw lastError;
}
async function writeOut() {
  const keys = [...unsaved];
  unsaved.clear();
  if (!keys.length) return;
  if (!pool) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STORE + '.tmp', JSON.stringify(db));
      fs.renameSync(STORE + '.tmp', STORE);
    } catch (e) { console.error('Could not save data/store.json: ' + e.message); }
    return;
  }
  for (const key of keys) {
    const [kind, id] = key.split('/'), rec = db[kind][id];
    try {
      if (rec) await pool.query('INSERT INTO icy_records (kind, id, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data', [kind, id, JSON.stringify(rec)]);
      else await pool.query('DELETE FROM icy_records WHERE kind = $1 AND id = $2', [kind, id]);
    } catch (e) { console.error('Could not save ' + key + ' to the database: ' + e.message); unsaved.add(key); }
  }
  if (unsaved.size && !saveTimer) saveTimer = setTimeout(flush, 5000); // try again shortly
}
function flush() { // one write at a time, so an older copy can never land after a newer one
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  writes = writes.then(writeOut, writeOut);
  return writes;
}
function persist(kind, id) { unsaved.add(kind + '/' + id); if (!saveTimer) saveTimer = setTimeout(flush, 150); }

// file contents live beside the records: a bytea row, or one file per upload in data/files
async function putFileData(id, buf) {
  if (pool) return pool.query('INSERT INTO icy_files (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data', [id, buf]);
  fs.mkdirSync(FILES, { recursive: true });
  fs.writeFileSync(path.join(FILES, id), buf);
}
async function getFileData(id) {
  if (pool) { const r = await pool.query('SELECT data FROM icy_files WHERE id = $1', [id]); return r.rows[0] ? r.rows[0].data : null; }
  try { return fs.readFileSync(path.join(FILES, id)); } catch (e) { return null; }
}
function dropFile(id) {
  if (!id || !db.files[id]) return;
  delete db.files[id];
  persist('files', id);
  const gone = pool ? pool.query('DELETE FROM icy_files WHERE id = $1', [id]) : fs.promises.unlink(path.join(FILES, id));
  gone.catch((e) => console.error('Could not remove file ' + id + ': ' + e.message));
}

// ---------- model ----------
const newId = () => crypto.randomBytes(8).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const text = (v, max) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim().slice(0, max);
const line = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
function realDate(d) {
  if (typeof d !== 'string' || !DATE.test(d)) return false;
  const t = new Date(d + 'T00:00:00Z');
  return !isNaN(t) && t.toISOString().slice(0, 10) === d;
}
function owns(rec, key) { // posts are removed only with the key handed back when they were made
  if (typeof key !== 'string' || !rec.keyHash) return false;
  return crypto.timingSafeEqual(Buffer.from(sha(key), 'hex'), Buffer.from(rec.keyHash, 'hex'));
}
function room(kind) { if (Object.keys(db[kind]).length >= LIMIT[kind]) throw fail(409, 'full'); }

function fileMeta(id) {
  const f = db.files[id];
  return f ? { id: f.id, name: f.name, type: f.type, size: f.size, at: f.at, by: f.by } : null;
}
function cgSession(date) {
  if (!db.cg[date]) { room('cg'); db.cg[date] = { date, topic: '', location: '', dinner: '18:00', time: '19:00', off: false, people: [], docs: [] }; }
  return db.cg[date];
}
function publicCg(s) {
  return { date: s.date, topic: s.topic, location: s.location, dinner: s.dinner, time: s.time, off: s.off, people: s.people, docs: s.docs.map(fileMeta).filter(Boolean) };
}
function publicEvent(e) {
  return { id: e.id, title: e.title, desc: e.desc, date: e.date, end: e.end, time: e.time, location: e.location, color: e.color, image: fileMeta(e.image), joins: e.joins, created: e.created };
}
function publicQuestion(q) {
  return { id: q.id, text: q.text, name: q.name, dm: q.dm, created: q.created, replies: q.replies.map((r) => ({ id: r.id, name: r.name, text: r.text, created: r.created })) };
}
function publicPrayer(p, client) {
  return { id: p.id, text: p.text, name: p.name, created: p.created, praying: p.praying.length, mine: Boolean(client) && p.praying.includes(sha(client).slice(0, 16)) };
}
function state(client) {
  const byNew = (a, b) => b.created - a.created;
  return {
    cg: Object.values(db.cg).map(publicCg),
    events: Object.values(db.events).map(publicEvent),
    questions: Object.values(db.questions).sort(byNew).map(publicQuestion),
    prayers: Object.values(db.prayers).sort(byNew).map((p) => publicPrayer(p, client))
  };
}
function eventFields(o, old) {
  const title = line(o.title, 100), date = String(o.date || ''), end = String(o.end || ''), time = String(o.time || '');
  if (!title) throw fail(400, 'title');
  if (!realDate(date)) throw fail(400, 'date');
  if (end && (!realDate(end) || end < date)) throw fail(400, 'end');
  if (time && !TIME.test(time)) throw fail(400, 'time');
  let image = o.image ? String(o.image) : null;
  if (image && image !== (old && old.image)) {
    const f = db.files[image];
    if (!f || f.kind !== 'image' || f.owner) throw fail(400, 'image');
  }
  return {
    title, desc: text(o.desc, 2000), date, end: end && end !== date ? end : '', time, location: line(o.location, 120),
    color: COLORS.includes(o.color) ? o.color : 'lime', image
  };
}

// ---------- http ----------
const HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
function send(res, status, body, type, extra) {
  res.writeHead(status, Object.assign({ 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, HEADERS, extra));
  res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function fail(status, message) { return Object.assign(new Error(message), { status }); }
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, over = false;
    req.on('data', (c) => { size += c.length; if (size > max) over = true; else chunks.push(c); });
    req.on('error', reject);
    req.on('end', () => (over ? reject(fail(413, 'too large')) : resolve(Buffer.concat(chunks))));
  });
}
async function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) { req.resume(); throw fail(415, 'json only'); }
  const buf = await readBody(req, MAX_BODY);
  try {
    const o = JSON.parse(buf.toString('utf8'));
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('shape');
    return o;
  } catch (e) { throw fail(400, 'bad json'); }
}
function header(req, name) { // headers carry only ASCII, so the page sends names URI-encoded
  try { return decodeURIComponent(String(req.headers[name] || '')); } catch (e) { return ''; }
}
async function readUpload(req, kind, owner) { // raw file body, named by the X-File-Name header
  if (Object.keys(db.files).length >= LIMIT.files) { req.resume(); throw fail(409, 'full'); }
  const name = line(header(req, 'x-file-name').replace(/[\\/\u0000-\u001f]/g, '_'), 120) || 'file';
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const okType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) && type.length <= 100 ? type : 'application/octet-stream';
  if (kind === 'image' && !IMAGE.test(okType)) { req.resume(); throw fail(415, 'images only'); }
  const buf = await readBody(req, MAX_FILE);
  if (!buf.length) throw fail(400, 'empty');
  const f = { id: newId(), kind, name, type: okType, size: buf.length, at: Date.now(), owner, by: line(header(req, 'x-uploader'), 40) };
  await putFileData(f.id, buf);
  db.files[f.id] = f;
  persist('files', f.id);
  return f;
}
const INLINE = /^(application\/pdf|image\/(jpeg|png|webp|gif)|text\/plain)$/; // shown in the browser; anything else downloads
async function sendFile(res, id) {
  const f = db.files[id];
  const data = f && await getFileData(id);
  if (!data) throw fail(404, 'not found');
  const inline = INLINE.test(f.type), ascii = f.name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  res.writeHead(200, Object.assign({
    'Content-Type': f.type === 'text/plain' ? 'text/plain; charset=utf-8' : f.type,
    'Content-Length': data.length,
    'Content-Disposition': (inline ? 'inline' : 'attachment') + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(f.name),
    'Cache-Control': 'private, max-age=31536000, immutable' // a file id never points at different contents
  }, HEADERS, f.type === 'text/plain' ? { 'Content-Security-Policy': 'sandbox' } : null));
  res.end(data);
}
const ASSET_TYPES = { '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

async function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { throw fail(400, 'bad url'); }
  const p = url.pathname, method = req.method;

  if (method === 'GET' && (p === '/' || p === '/index.html' || p === '/icy.html')) return send(res, 200, fs.readFileSync(PAGE), 'text/html; charset=utf-8');
  if (method === 'GET' && /^\/assets\/[a-z0-9-]+\.(png|webp|svg|ico)$/.test(p)) {
    const file = path.join(ASSETS, path.basename(p));
    if (!fs.existsSync(file)) throw fail(404, 'not found');
    return send(res, 200, fs.readFileSync(file), ASSET_TYPES[path.extname(file)], { 'Cache-Control': 'public, max-age=86400' });
  }
  if (method === 'GET' && p === '/api/ping') {
    // durable is false when data would be lost on the next restart (Render without a database or disk)
    return send(res, 200, {
      ok: true, app: 'icy', store: pool ? 'database' : 'file', durable: Boolean(pool) || !ON_RENDER || Boolean(process.env.DATA_DIR),
      unsaved: unsaved.size, up: Math.round(process.uptime()), keepAwake: KEEP_AWAKE_URL ? awake : false
    });
  }
  if (method === 'GET' && p === '/api/state') return send(res, 200, state(url.searchParams.get('c') || ''));

  let m = /^\/api\/files\/([a-f0-9]{16})$/.exec(p);
  if (m && method === 'GET') return sendFile(res, m[1]);
  if (p === '/api/files' && method === 'POST') { // event pictures, attached to an event when it is saved
    const f = await readUpload(req, 'image', null);
    return send(res, 201, { file: fileMeta(f.id) });
  }

  // ---- cell group sessions, one per date ----
  if ((m = /^\/api\/cg\/(\d{4}-\d{2}-\d{2})(\/rsvp|\/docs(?:\/([a-f0-9]{16}))?)?$/.exec(p))) {
    const date = m[1];
    if (!realDate(date)) throw fail(400, 'date');
    if (!m[2] && method === 'POST') {
      const o = await readJson(req), s = cgSession(date);
      if ('topic' in o) s.topic = line(o.topic, 80);
      if ('location' in o) s.location = line(o.location, 120);
      if ('dinner' in o) { if (o.dinner && !TIME.test(o.dinner)) throw fail(400, 'dinner'); s.dinner = o.dinner || ''; }
      if ('time' in o) { if (!TIME.test(o.time)) throw fail(400, 'time'); s.time = o.time; }
      if ('off' in o) s.off = Boolean(o.off);
      persist('cg', date);
      return send(res, 200, { session: publicCg(s) });
    }
    if (m[2] === '/rsvp' && method === 'POST') {
      const o = await readJson(req), name = line(o.name, 40);
      if (!name) throw fail(400, 'name');
      const s = cgSession(date), i = s.people.findIndex((x) => same(x.name, name));
      if (i >= 0) s.people.splice(i, 1);
      if (o.cg || o.dinner) {
        if (s.people.length >= LIMIT.people) throw fail(409, 'full');
        s.people.push({ name, cg: Boolean(o.cg), dinner: Boolean(o.dinner), at: Date.now() });
      }
      persist('cg', date);
      return send(res, 200, { session: publicCg(s) });
    }
    if (m[2] === '/docs' && method === 'POST') {
      const s = cgSession(date);
      if (s.docs.length >= LIMIT.docs) { req.resume(); throw fail(409, 'full'); }
      const f = await readUpload(req, 'doc', 'cg/' + date);
      s.docs.push(f.id);
      persist('cg', date);
      return send(res, 201, { session: publicCg(s) });
    }
    if (m[3] && method === 'DELETE') {
      const s = db.cg[date], i = s ? s.docs.indexOf(m[3]) : -1;
      if (i < 0) throw fail(404, 'not found');
      s.docs.splice(i, 1);
      dropFile(m[3]);
      persist('cg', date);
      return send(res, 200, { session: publicCg(s) });
    }
    throw fail(404, 'not found');
  }

  // ---- events: anyone can add, edit, delete and join ----
  if (p === '/api/events' && method === 'POST') {
    room('events');
    const e = Object.assign({ id: newId(), joins: [], created: Date.now() }, eventFields(await readJson(req), null));
    if (e.image) { db.files[e.image].owner = 'events/' + e.id; persist('files', e.image); }
    db.events[e.id] = e;
    persist('events', e.id);
    return send(res, 201, { event: publicEvent(e) });
  }
  if ((m = /^\/api\/events\/([a-f0-9]{16})(\/join)?$/.exec(p))) {
    const e = db.events[m[1]];
    if (!e) throw fail(404, 'not found');
    if (!m[2] && method === 'PUT') {
      const fields = eventFields(await readJson(req), e);
      if (e.image !== fields.image) {
        dropFile(e.image);
        if (fields.image) { db.files[fields.image].owner = 'events/' + e.id; persist('files', fields.image); }
      }
      Object.assign(e, fields);
      persist('events', e.id);
      return send(res, 200, { event: publicEvent(e) });
    }
    if (!m[2] && method === 'DELETE') {
      dropFile(e.image);
      delete db.events[e.id];
      persist('events', e.id);
      return send(res, 200, { ok: true });
    }
    if (m[2] && method === 'POST') {
      const o = await readJson(req), name = line(o.name, 40);
      if (!name) throw fail(400, 'name');
      const i = e.joins.findIndex((x) => same(x.name, name));
      if (o.on && i < 0) {
        if (e.joins.length >= LIMIT.people) throw fail(409, 'full');
        e.joins.push({ name, at: Date.now() });
      } else if (!o.on && i >= 0) e.joins.splice(i, 1);
      persist('events', e.id);
      return send(res, 200, { event: publicEvent(e) });
    }
    throw fail(404, 'not found');
  }

  // ---- questions and prayer requests: names are optional, and only the poster can remove a post ----
  if ((p === '/api/questions' || p === '/api/prayers') && method === 'POST') {
    const kind = p.slice(5), o = await readJson(req), body = text(o.text, 2000);
    if (!body) throw fail(400, 'text');
    room(kind);
    const key = crypto.randomBytes(16).toString('hex'), name = line(o.name, 40);
    const rec = { id: newId(), text: body, name, created: Date.now(), keyHash: sha(key) };
    if (kind === 'questions') Object.assign(rec, { dm: Boolean(name && o.dm), replies: [] });
    else rec.praying = [];
    db[kind][rec.id] = rec;
    persist(kind, rec.id);
    return send(res, 201, { item: kind === 'questions' ? publicQuestion(rec) : publicPrayer(rec, ''), key });
  }
  if ((m = /^\/api\/(questions|prayers)\/([a-f0-9]{16})(?:\/(replies|pray)(?:\/([a-f0-9]{16}))?)?$/.exec(p))) {
    const kind = m[1], rec = db[kind][m[2]];
    if (!rec) throw fail(404, 'not found');
    const out = (client) => (kind === 'questions' ? publicQuestion(rec) : publicPrayer(rec, client));
    if (!m[3] && method === 'DELETE') {
      if (!owns(rec, (await readJson(req)).key)) throw fail(403, 'not yours');
      delete db[kind][rec.id];
      persist(kind, rec.id);
      return send(res, 200, { ok: true });
    }
    if (kind === 'questions' && m[3] === 'replies' && !m[4] && method === 'POST') {
      const o = await readJson(req), body = text(o.text, 2000);
      if (!body) throw fail(400, 'text');
      if (rec.replies.length >= LIMIT.replies) throw fail(409, 'full');
      const key = crypto.randomBytes(16).toString('hex');
      rec.replies.push({ id: newId(), name: line(o.name, 40), text: body, created: Date.now(), keyHash: sha(key) });
      persist(kind, rec.id);
      return send(res, 201, { item: out(), key, reply: rec.replies[rec.replies.length - 1].id });
    }
    if (kind === 'questions' && m[3] === 'replies' && m[4] && method === 'DELETE') {
      const i = rec.replies.findIndex((r) => r.id === m[4]);
      if (i < 0) throw fail(404, 'not found');
      if (!owns(rec.replies[i], (await readJson(req)).key)) throw fail(403, 'not yours');
      rec.replies.splice(i, 1);
      persist(kind, rec.id);
      return send(res, 200, { item: out() });
    }
    if (kind === 'prayers' && m[3] === 'pray' && !m[4] && method === 'POST') { // "I'm praying" is counted once per browser
      const o = await readJson(req), client = line(o.client, 64);
      if (!client) throw fail(400, 'client');
      const h = sha(client).slice(0, 16), i = rec.praying.indexOf(h);
      if (o.on && i < 0 && rec.praying.length < 5000) rec.praying.push(h);
      else if (!o.on && i >= 0) rec.praying.splice(i, 1);
      persist(kind, rec.id);
      return send(res, 200, { item: out(client) });
    }
    throw fail(404, 'not found');
  }

  throw fail(404, 'not found');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!e.status) console.error(e);
    if (res.headersSent) res.end(); else send(res, e.status || 500, { error: e.status ? e.message : 'server error' });
  });
});
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? 'Port ' + PORT + ' is already in use. Close the other program or run with a different PORT.' : e.message);
  process.exit(1);
});
// Render's free plan stops a service after 15 minutes without a visit, and the next visitor then waits
// about a minute for it to boot. Requesting our own public address every 10 minutes counts as a visit.
// Render sets RENDER_EXTERNAL_URL itself; KEEP_AWAKE_URL does the same on other hosts.
const KEEP_AWAKE_URL = (process.env.KEEP_AWAKE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
const KEEP_AWAKE_MS = (Number(process.env.KEEP_AWAKE_MINUTES) || 10) * 60000;
const awake = { sent: 0, ok: 0 };
function keepAwake() {
  if (!KEEP_AWAKE_URL || typeof fetch !== 'function') return;
  setInterval(() => {
    awake.sent++;
    fetch(KEEP_AWAKE_URL + '/api/ping', { signal: AbortSignal.timeout(20000) })
      .then((r) => r.arrayBuffer().then(() => { if (r.ok) awake.ok++; }))
      .catch((e) => console.error('Keep-awake request failed: ' + e.message));
  }, KEEP_AWAKE_MS).unref();
}

async function start() {
  if (process.env.DATABASE_URL) {
    try { pool = await openDatabase(process.env.DATABASE_URL); }
    catch (e) { console.error('Could not use the database (' + String(e.message).split('\n')[0] + '). Using the data folder instead.'); }
  }
  if (!pool) loadFile();
  server.listen(PORT, HOST, () => {
    console.log('ICY NUS is running on port ' + PORT + (HOST === '127.0.0.1' ? ', this laptop only: http://localhost:' + PORT : ''));
    console.log(pool ? 'Everything is saved in the database.'
      : 'Everything is saved in ' + DATA_DIR + (ON_RENDER && !process.env.DATA_DIR ? ' (temporary: this host wipes it on restart)' : ''));
    if (KEEP_AWAKE_URL) console.log('Keeping awake by requesting ' + KEEP_AWAKE_URL + ' every ' + KEEP_AWAKE_MS / 60000 + ' minutes.');
    keepAwake();
  });
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flush().then(() => process.exit(0)); });
start();
