'use strict';
// Live chat gabungan YouTube + TikTok (versi ringan).
// Chat dari kedua platform disiarkan ke halaman web lewat SSE.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- Konfigurasi ----------
// Prioritas: argumen CLI > environment variable > config.json
// Contoh: node server.js --yt ID_VIDEO --tt namauser
let file = {};
try { file = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch (e) { /* pakai argumen/env */ }

const arg = (n) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : undefined; };

const PORT = Number(arg('port') || process.env.PORT || file.port || 3000);
const HOST = arg('host') || process.env.HOST || '127.0.0.1'; // hanya komputer ini
const YT_KEY = String(process.env.YT_KEY || (file.youtube && file.youtube.apiKey) || '').trim(); // opsional: YouTube Data API
// Milestone Socialbuzz: tempel URL widget milestone (dari dashboard Socialbuzz) di config.json -> socialbuzz.milestoneUrl
const msRaw = String(arg('ms') || process.env.MS || (file.socialbuzz && file.socialbuzz.milestoneUrl) || '').trim();
const MILESTONE = /^https:\/\//i.test(msRaw) ? msRaw : '';
const RETRY_MS = 15000;
const VIEWERS_MS = 20000; // seberapa sering jumlah penonton YouTube dicek
const HISTORY = 30;   // pesan yang dikirim ulang ke halaman yang baru dibuka
const MAX_LEN = 300;  // potong pesan yang terlalu panjang

// Moderasi: komentar baru masuk antrean dulu, baru tampil di display setelah di-approve di /admin.
// Password: argumen --admin-pass > env ADMIN_PASSWORD > config.json (admin.password).
// Jika kosong, dibuat acak setiap server dijalankan dan ditampilkan di konsol.
const adm = file.admin || {};
let ADMIN_PASS = String(arg('admin-pass') || process.env.ADMIN_PASSWORD || adm.password || '').trim();
const PASS_GENERATED = !ADMIN_PASS;
if (PASS_GENERATED) ADMIN_PASS = crypto.randomBytes(6).toString('base64url');
const QUEUE_MAX = Math.max(10, Number(adm.queueMax) || 200); // antrean menunggu maksimal; yang terlama dibuang jika penuh

function parseYouTube(raw) {
  if (!raw) return null;
  raw = raw.trim();
  const m = raw.match(/[?&]v=([\w-]{11})/) || raw.match(/youtu\.be\/([\w-]{11})/) || raw.match(/\/live\/([\w-]{11})/);
  if (m) return { liveId: m[1] };
  if (/^UC[\w-]{22}$/.test(raw)) return { channelId: raw };
  if (/^[\w-]{11}$/.test(raw) && !raw.startsWith('@')) return { liveId: raw };
  return { handle: raw.startsWith('@') ? raw : '@' + raw };
}

let ytOpts = parseYouTube(arg('yt') || process.env.YT);
if (!ytOpts) {
  const y = file.youtube || {};
  if (y.liveId) ytOpts = { liveId: y.liveId };
  else if (y.channelId) ytOpts = { channelId: y.channelId };
  else if (y.handle) ytOpts = { handle: y.handle.startsWith('@') ? y.handle : '@' + y.handle };
}
const ttUser = String(arg('tt') || process.env.TT || (file.tiktok && file.tiktok.username) || '').replace(/^@/, '').trim();

// ---------- SSE ----------
const clients = new Set();      // halaman tampilan (publik, hanya menerima komentar yang sudah di-approve)
const adminClients = new Set(); // halaman admin (wajib login, menerima antrean komentar)
const history = [];             // komentar yang sudah di-approve (dikirim ulang ke halaman yang baru dibuka)
const pending = new Map();      // id -> komentar yang menunggu keputusan admin (urut sesuai kedatangan)
let nextId = 1;
const status = { youtube: '-', tiktok: '-' };
const viewers = { YT: null, TT: null }; // jumlah penonton live saat ini (null = belum ada)

function sendTo(set, event, data) {
  if (!set.size) return;
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of set) res.write(payload);
}
const broadcast = (event, data) => sendTo(clients, event, data);
const adminBroadcast = (event, data) => sendTo(adminClients, event, data);
// Status koneksi dan jumlah penonton boleh dilihat kedua halaman
const broadcastAll = (event, data) => { broadcast(event, data); adminBroadcast(event, data); };

function setViewers(src, n) {
  n = Number.isFinite(n) ? n : null;
  if (viewers[src] === n) return;
  viewers[src] = n;
  broadcastAll('viewers', viewers);
}

// Format pesan ringkas: s=sumber, n=nama, t=teks, b=badge, $=super chat
// Komentar baru TIDAK langsung tampil: masuk antrean (pending) menunggu approve/reject dari admin.
function push(s, n, t, b, sc) {
  t = String(t || '').trim();
  if (!t) return;
  if (t.length > MAX_LEN) t = t.slice(0, MAX_LEN) + '…';
  const m = { id: nextId++, ts: Date.now(), s, n: n || 'anonim', t };
  if (b) m.b = b;
  if (sc) m.$ = 1;
  pending.set(m.id, m);
  adminBroadcast('add', m);
  if (pending.size > QUEUE_MAX) { // antrean penuh: buang yang paling lama
    const oldest = pending.keys().next().value;
    pending.delete(oldest);
    adminBroadcast('del', [oldest]);
  }
}

// Kirim komentar yang disetujui ke halaman tampilan
function show(m) {
  const out = { s: m.s, n: m.n, t: m.t };
  if (m.b) out.b = m.b;
  if (m.$) out.$ = 1;
  history.push(out);
  if (history.length > HISTORY) history.shift();
  broadcast('chat', out);
}

// Putuskan nasib beberapa komentar sekaligus. Id yang sudah tidak ada di antrean diabaikan.
// Mengembalikan daftar id yang benar-benar diproses.
function decide(ids, approve) {
  const done = [];
  for (const id of ids) {
    const m = pending.get(id);
    if (!m) continue;
    pending.delete(id);
    done.push(id);
    if (approve) show(m);
  }
  if (done.length) adminBroadcast('del', done);
  return done;
}

function setStatus(key, value, detail) {
  if (status[key] === value && !detail) return;
  status[key] = value;
  console.log('[' + (key === 'youtube' ? 'YT' : 'TT') + '] ' + value + (detail ? ' - ' + detail : ''));
  broadcastAll('status', status);
}

const errMsg = (e) => String(e && e.message ? e.message : e).split('\n')[0];

// Timer coba-ulang: hanya satu timer aktif sekaligus
function retrier(fn) {
  let t = null;
  return () => { if (!t) t = setTimeout(() => { t = null; fn(); }, RETRY_MS); };
}

// ---------- YouTube ----------
// Jumlah penonton: pakai YouTube Data API jika ada apiKey, kalau tidak baca halaman video.
// Cari nilai "originalViewCount" di dalam JSON bersarang
function findViewCount(o) {
  if (!o || typeof o !== 'object') return null;
  if (o.originalViewCount != null) return o.originalViewCount;
  for (const k in o) { const v = findViewCount(o[k]); if (v != null) return v; }
  return null;
}

async function fetchYouTubeViewers(id) {
  const opt = { signal: AbortSignal.timeout(10000) };
  // 1) YouTube Data API resmi (paling akurat, butuh apiKey)
  if (YT_KEY) {
    const r = await fetch('https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=' + id + '&key=' + YT_KEY, opt);
    if (!r.ok && r.status >= 500) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const d = j.items && j.items[0] && j.items[0].liveStreamingDetails;
    if (j.error) throw new Error('API: ' + (j.error.message || j.error.code));
    const n = d && d.concurrentViewers != null && !d.actualEndTime ? Number(d.concurrentViewers) : null;
    return { n, src: 'api' };
  }
  // 2) Endpoint yang dipakai halaman live YouTube untuk memperbarui angka penonton
  try {
    const r = await fetch('https://www.youtube.com/youtubei/v1/updated_metadata?prettyPrint=false', Object.assign({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': 'en-US,en;q=0.9' },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'en', gl: 'US' } }, videoId: id })
    }, opt));
    const j = await r.json();
    const v = findViewCount(j);
    if (v != null && /^\d+$/.test(String(v))) return { n: Number(v), src: 'metadata' };
  } catch (e) { /* lanjut ke cadangan */ }
  // 3) Cadangan: baca halaman video
  const r = await fetch('https://www.youtube.com/watch?v=' + id, Object.assign({
    headers: { 'Accept-Language': 'en-US,en;q=0.9', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' }
  }, opt));
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const html = await r.text();
  if (!/"isLiveNow":true/.test(html)) return { n: null, src: 'halaman (tidak live)' };
  const i = html.indexOf('"videoViewCountRenderer"');
  const m = html.slice(i > -1 ? i : 0).match(/"originalViewCount":"(\d+)"/);
  return { n: m ? Number(m[1]) : null, src: 'halaman' };
}

function startYouTube() {
  if (!ytOpts) return;
  let ytId = ytOpts.liveId || null, vt = null;
  const pollViewers = () => {
    if (!ytId) return;
    fetchYouTubeViewers(ytId).then((r) => {
      if (viewers.YT !== r.n) console.log('[YT] penonton: ' + r.n + ' (sumber: ' + r.src + ')');
      setViewers('YT', r.n);
    }).catch((e) => console.warn('[YT] viewer:', errMsg(e)));
  };
  const stopViewers = () => { clearInterval(vt); vt = null; setViewers('YT', null); };
  const { LiveChat } = require('youtube-chat'); // dimuat hanya jika dipakai
  const live = new LiveChat(ytOpts);
  const retry = retrier(() => {
    setStatus('youtube', 'menghubungkan ulang');
    live.start().then((ok) => { if (!ok) retry(); }).catch(retry);
  });

  live.on('start', (id) => {
    setStatus('youtube', 'terhubung', id);
    ytId = id;
    pollViewers();
    if (!vt) vt = setInterval(pollViewers, VIEWERS_MS);
  });
  let resetting = false; // true saat kita sendiri yang mereset koneksi chat setelah error
  live.on('end', (r) => {
    if (!resetting) stopViewers(); // jika hanya reset karena error, angka penonton jangan dikosongkan
    setStatus('youtube', 'terputus', r || 'live berakhir');
    retry();
  });
  live.on('error', (e) => {
    setStatus('youtube', 'error', errMsg(e));
    // PENTING: youtube-chat tidak berhenti sendiri saat error (mis. HTTP 503) dan start() akan
    // langsung return false selama masih "berjalan". Tanpa stop(), event 'start' tidak pernah
    // muncul lagi sehingga polling penonton tidak pernah dinyalakan ulang.
    resetting = true;
    try { live.stop('error'); } catch (x) { /* abaikan */ }
    resetting = false;
    retry();
  });
  live.on('chat', (it) => {
    const text = (it.message || []).map((p) => ('text' in p ? p.text : p.emojiText || '')).join('');
    const sc = it.superchat ? ' [Super Chat ' + it.superchat.amount + ']' : '';
    push('YT', it.author.name, text + sc,
      it.isOwner ? 'OWNER' : it.isModerator ? 'MOD' : it.isMembership ? 'MEMBER' : '',
      !!it.superchat);
  });

  setStatus('youtube', 'menghubungkan');
  live.start().then((ok) => {
    if (!ok) { setStatus('youtube', 'gagal', 'live tidak ditemukan'); retry(); }
  }).catch((e) => { setStatus('youtube', 'gagal', errMsg(e)); retry(); });
}

// ---------- TikTok ----------
function startTikTok() {
  if (!ttUser) return;
  const { TikTokLiveConnection, WebcastEvent, ControlEvent } = require('tiktok-live-connector');
  let conn = null;
  const retry = retrier(() => { setStatus('tiktok', 'menghubungkan ulang'); connect(); });

  function connect() {
    try { conn && conn.disconnect(); } catch (e) { /* abaikan */ }
    try {
      // Tanpa riwayat awal dan tanpa info hadiah: lebih sedikit data diproses
      conn = new TikTokLiveConnection(ttUser, { processInitialData: false, enableExtendedGiftInfo: false });
    } catch (e) {
      setStatus('tiktok', 'gagal', errMsg(e));
      return retry();
    }
    conn.on(ControlEvent.CONNECTED, (s) => setStatus('tiktok', 'terhubung', s && s.roomId ? 'room ' + s.roomId : ''));
    conn.on(ControlEvent.DISCONNECTED, () => { setViewers('TT', null); setStatus('tiktok', 'terputus'); retry(); });
    conn.on(ControlEvent.ERROR, (e) => console.warn('[TT] error:', errMsg(e)));
    conn.on(WebcastEvent.STREAM_END, () => { setViewers('TT', null); setStatus('tiktok', 'live berakhir'); retry(); });
    conn.on(WebcastEvent.ROOM_USER, (d) => {
      // Skema v3: penonton saat ini = "total" (versi lama: "viewerCount")
      const n = Number(d.viewerCount != null ? d.viewerCount : d.total);
      if (viewers.TT !== n) console.log('[TT] penonton: ' + n);
      setViewers('TT', n);
    });
    conn.on(WebcastEvent.CHAT, (d) => {
      const u = d.user || {};
      push('TT', u.nickname || u.uniqueId, d.content || d.comment);
    });
    conn.connect().catch((e) => { setStatus('tiktok', 'gagal', errMsg(e)); retry(); });
  }

  setStatus('tiktok', 'menghubungkan');
  connect();
}

// ---------- Admin ----------
// Login dengan password -> cookie sesi (HttpOnly, SameSite=Strict). Semua data admin hanya lewat /admin/api/* dan /admin/events.
const SESSION_MS = 12 * 3600 * 1000;
const sessions = new Map(); // token -> waktu kedaluwarsa
const fails = new Map();    // ip -> { n: gagal berturut-turut, until: terkunci sampai }

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const passOk = (s) => crypto.timingSafeEqual(sha(s), sha(ADMIN_PASS)); // perbandingan waktu-konstan

const cookieToken = (req) => { const m = /(?:^|;\s*)adm=([a-f0-9]+)/.exec(req.headers.cookie || ''); return m ? m[1] : ''; };
function authed(req) {
  const t = cookieToken(req), exp = t && sessions.get(t);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(t); return false; }
  return true;
}

// Cegah DNS rebinding: halaman admin hanya melayani Host berupa "localhost" atau alamat IP
function hostOk(req) {
  const h = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  return h === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || /^\[[0-9a-f:]+\]$/.test(h);
}
// Permintaan POST dari situs lain ditolak (tanpa header Origin = bukan dari browser lintas-situs)
function originOk(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch (e) { return false; }
}

function readJson(req, cb) {
  let b = '', big = false;
  req.on('data', (c) => { b += c; if (b.length > 20000) { big = true; req.destroy(); } });
  req.on('end', () => { if (big) return; try { cb(null, JSON.parse(b || '{}')); } catch (e) { cb(e); } });
}

function reply(res, code, obj, headers) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, headers));
  res.end(JSON.stringify(obj));
}

const COOKIE = 'Path=/admin; HttpOnly; SameSite=Strict';

function handleAdmin(req, res, p) {
  if (!hostOk(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Buka lewat http://localhost:' + PORT + '/admin');
  }

  if (p === '/admin' || p === '/admin/') { // halaman statis tanpa data; data baru ada setelah login
    return fs.readFile(path.join(__dirname, 'public', 'admin.html'), (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
      res.end(buf);
    });
  }

  if (p === '/admin/api/login' && req.method === 'POST') {
    if (!originOk(req)) return reply(res, 403, { error: 'Permintaan ditolak' });
    const ip = req.socket.remoteAddress;
    const f = fails.get(ip);
    if (f && f.until > Date.now()) return reply(res, 429, { error: 'Terlalu banyak percobaan. Tunggu 1 menit.' });
    return readJson(req, (err, body) => {
      if (err || !body || typeof body.password !== 'string' || !passOk(body.password)) {
        const n = ((fails.get(ip) || {}).n || 0) + 1;
        fails.set(ip, n >= 5 ? { n: 0, until: Date.now() + 60000 } : { n, until: 0 }); // 5x salah = kunci 1 menit
        return reply(res, 401, { error: 'Password salah' });
      }
      fails.delete(ip);
      for (const [t, exp] of sessions) if (exp < Date.now()) sessions.delete(t);
      const token = crypto.randomBytes(24).toString('hex');
      sessions.set(token, Date.now() + SESSION_MS);
      reply(res, 200, { ok: true }, { 'Set-Cookie': 'adm=' + token + '; ' + COOKIE + '; Max-Age=' + SESSION_MS / 1000 });
    });
  }

  if (!authed(req)) return reply(res, 401, { error: 'login' });

  if (p === '/admin/api/me') return reply(res, 200, { ok: true });

  if (p === '/admin/api/logout' && req.method === 'POST') {
    if (!originOk(req)) return reply(res, 403, { error: 'Permintaan ditolak' });
    sessions.delete(cookieToken(req));
    for (const r of adminClients) r.end(); // putuskan aliran admin; koneksi ulang akan ditolak jika sudah logout
    adminClients.clear();
    return reply(res, 200, { ok: true }, { 'Set-Cookie': 'adm=; ' + COOKIE + '; Max-Age=0' });
  }

  if (p === '/admin/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('event: snapshot\ndata: ' + JSON.stringify({ pending: [...pending.values()], status, viewers, now: Date.now() }) + '\n\n');
    adminClients.add(res);
    req.on('close', () => adminClients.delete(res));
    return;
  }

  if (p === '/admin/api/decide' && req.method === 'POST') { // {action:'approve'|'reject', ids:[...]}
    if (!originOk(req)) return reply(res, 403, { error: 'Permintaan ditolak' });
    return readJson(req, (err, body) => {
      if (err || !body || !Array.isArray(body.ids) || (body.action !== 'approve' && body.action !== 'reject')) {
        return reply(res, 400, { error: 'Permintaan tidak valid' });
      }
      const ids = body.ids.filter(Number.isInteger).sort((a, b) => a - b); // approve massal tetap urut kedatangan
      reply(res, 200, { done: decide(ids, body.action === 'approve') });
    });
  }

  reply(res, 404, { error: 'tidak ditemukan' });
}

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0];

  if (p === '/admin' || p.startsWith('/admin/')) return handleAdmin(req, res, p);

  if (p === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('event: status\ndata: ' + JSON.stringify(status) + '\n\nevent: viewers\ndata: ' + JSON.stringify(viewers) + '\n\nevent: history\ndata: ' + JSON.stringify(history) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (p === '/test') { // /test?src=YT&name=Budi&text=halo
    const q = new URL(req.url, 'http://x').searchParams;
    push(q.get('src') === 'TT' ? 'TT' : 'YT', q.get('name') || 'Penguji', q.get('text') || 'Halo, ini pesan uji');
    res.writeHead(200);
    return res.end('ok');
  }

  if (p === '/cfg') { // pengaturan untuk halaman (URL milestone)
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ milestone: MILESTONE }));
  }

  if (p === '/test-viewers') { // /test-viewers?src=TT&n=250 (tanpa n = kosongkan)
    const q = new URL(req.url, 'http://x').searchParams;
    setViewers(q.get('src') === 'TT' ? 'TT' : 'YT', q.has('n') ? Number(q.get('n')) : null);
    res.writeHead(200);
    return res.end('ok');
  }

  if (p === '/' || p === '/index.html') {
    return fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
  }

  res.writeHead(404);
  res.end();
});

process.on('unhandledRejection', (e) => console.warn('[!] unhandledRejection:', errMsg(e)));
process.on('uncaughtException', (e) => console.warn('[!] uncaughtException:', errMsg(e)));

// Satu ping untuk semua klien agar koneksi SSE tidak putus
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); for (const res of adminClients) res.write(': ping\n\n'); }, 25000);

server.listen(PORT, HOST, () => {
  console.log('Live chat berjalan di http://' + (HOST === '127.0.0.1' ? 'localhost' : HOST) + ':' + PORT);
  console.log('YouTube : ' + (ytOpts ? JSON.stringify(ytOpts) : '(kosong)'));
  console.log('TikTok  : ' + (ttUser ? '@' + ttUser : '(kosong)'));
  console.log('Milestone: ' + (MILESTONE ? 'aktif' : '(kosong)'));
  console.log('Admin   : http://' + (HOST === '127.0.0.1' ? 'localhost' : HOST) + ':' + PORT + '/admin  ' +
    (PASS_GENERATED ? '(password acak kali ini: ' + ADMIN_PASS + ' - isi admin.password di config.json agar tetap)' : '(password dari pengaturan)'));
  startYouTube();
  startTikTok();
});
