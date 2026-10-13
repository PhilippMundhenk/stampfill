#!/usr/bin/env node
/*
 * stampfill — stamp text onto PDF templates from a web form, then print or download the result.
 *
 *   npm install
 *   ADMIN_PASSWORD=change-me node stampfill.js
 *
 * Environment
 *   PORT            listen port (default 8080)
 *   HOST            listen address (default 0.0.0.0)
 *   DATA_DIR        where db.json and the uploaded PDFs live (default ./data)
 *   ADMIN_PASSWORD  admin password. If unset, a random one is generated on first start,
 *                   printed once, and can be changed in the admin settings.
 *   TRUST_PROXY=1   take the client IP from X-Forwarded-For (login rate limit)
 *   MAX_PDF_MB      upload limit (default 25)
 *
 * Unicode: the built-in Helvetica covers Western European text only. Put a TrueType font at
 * DATA_DIR/font.ttf and install @pdf-lib/fontkit to use that font for all inserted text.
 *
 * Pages:  /            public document list (listed documents, filter by tag)
 *         /d/<link>    form for one document: fill, preview, print, download
 *         /admin       admin interface
 *         /healthz     liveness probe (JSON)
 */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
let fontkit = null; try { fontkit = require('@pdf-lib/fontkit'); } catch (e) { /* optional */ }

const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DATA = path.resolve(process.env.DATA_DIR || './data');
const PDFS = path.join(DATA, 'pdfs');
const DBF = path.join(DATA, 'db.json');
const FONT = path.join(DATA, 'font.ttf');
const MAX_PDF = (+process.env.MAX_PDF_MB || 25) * 1024 * 1024;
const PDFJS = path.dirname(require.resolve('pdfjs-dist/package.json'));
const SESSION_MS = 7 * 24 * 3600 * 1000;
const VERSION = require('./package.json').version;

// ---------------------------------------------------------------- storage
try { fs.mkdirSync(PDFS, { recursive: true }); fs.accessSync(DATA, fs.constants.W_OK); fs.accessSync(PDFS, fs.constants.W_OK); }
catch (e) {
  const who = process.getuid ? 'uid ' + process.getuid() + ' / gid ' + process.getgid() : 'this user';
  console.error('stampfill: the data directory ' + DATA + ' is not writable by ' + who + ' (' + e.code + ').\n' +
    '  Bind mount: make the host folder writable, e.g. "chown 1000:1000 ./data", or run the container with the folder owner\'s ids (PUID/PGID in .env).\n' +
    '  Named volume: keep the default user (1000:1000) or recreate the volume after changing it.');
  process.exit(1);
}
const rid = (n = 9) => crypto.randomBytes(n).toString('base64url');
const DEFAULTS = { siteTitle: 'Forms', printerUrl: '', publicPrint: false };
let db = { secret: rid(32), auth: null, settings: { ...DEFAULTS }, docs: [] };
if (fs.existsSync(DBF)) { const l = JSON.parse(fs.readFileSync(DBF, 'utf8')); db = Object.assign(db, l, { settings: { ...DEFAULTS, ...(l.settings || {}) } }); }
const save = () => { fs.writeFileSync(DBF + '.tmp', JSON.stringify(db, null, 1)); fs.renameSync(DBF + '.tmp', DBF); };
const pdfPath = (id) => path.join(PDFS, id + '.pdf');

// ---------------------------------------------------------------- auth
const hashPw = (pw, salt = rid(16)) => salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
const sameStr = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function checkPw(pw) {
  if (typeof pw !== 'string') return false;
  if (process.env.ADMIN_PASSWORD) return sameStr(hashPw(pw, 'env'), hashPw(process.env.ADMIN_PASSWORD, 'env'));
  return !!db.auth && sameStr(hashPw(pw, db.auth.split(':')[0]), db.auth);
}
if (!process.env.ADMIN_PASSWORD && !db.auth) {
  const pw = rid(12); db.auth = hashPw(pw);
  console.log('\n  Generated admin password: ' + pw + '\n  (change it under /admin > Settings)\n');
}
save();
const sign = (exp) => crypto.createHmac('sha256', db.secret).update('admin.' + exp).digest('base64url');
const newSession = () => { const exp = Date.now() + SESSION_MS; return exp + '.' + sign(exp); };
function isAdmin(req) {
  const m = /(?:^|;\s*)sf_s=(\d+)\.([\w-]+)/.exec(req.headers.cookie || '');
  return !!m && +m[1] > Date.now() && sameStr(m[2], sign(m[1]));
}
const cookie = (req, val, maxAge) => 'sf_s=' + val + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge +
  (req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '');
const fails = new Map(); // ip -> { n, until, at }
function pruneFails() { // keep the map bounded: drop entries whose block expired and that are older than the block window
  if (fails.size < 1000) return;
  const cut = Date.now() - 5 * 60000;
  for (const [ip, f] of fails) if (f.until < Date.now() && f.at < cut) fails.delete(ip);
}
const clientIp = (req) => (process.env.TRUST_PROXY && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;

// ---------------------------------------------------------------- helpers
class HttpErr extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const SEC = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; font-src 'self' data: blob:; worker-src 'self' blob:; frame-src blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};
function send(res, status, body, type, extra) {
  res.writeHead(status, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store' }, SEC, extra)); res.end(body);
}
const json = (res, status, obj, extra) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', extra);
const gzCache = new Map(); // static bodies (pages, pdf.js files) compressed once, served from memory
function sendStatic(req, res, key, body, type, extra) {
  const hdr = Object.assign({ Vary: 'Accept-Encoding' }, extra);
  if (body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    let z = gzCache.get(key); if (!z) { z = zlib.gzipSync(body); gzCache.set(key, z); }
    return send(res, 200, z, type, Object.assign(hdr, { 'Content-Encoding': 'gzip' }));
  }
  send(res, 200, body, type, hdr);
}
function readBody(req, limit) {
  return new Promise((ok, no) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { no(new HttpErr(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks))); req.on('error', no);
  });
}
async function readJson(req, limit = 1e6) {
  try { const o = JSON.parse((await readBody(req, limit)).toString('utf8') || '{}'); if (o && typeof o === 'object') return o; } catch (e) { if (e instanceof HttpErr) throw e; }
  throw new HttpErr(400, 'Invalid JSON');
}
const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
const num = (v, def, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };

// ---------------------------------------------------------------- documents
const TYPES = ['text', 'textarea', 'date', 'checkbox'];
const PREFILL = ['none', 'browser', 'instance', 'url'];
const DATEFMT = ['DD.MM.YYYY', 'YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY'];
const keyOf = (s) => str(s, 60).toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'field';
function cleanFields(list, pages) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).slice(0, 200).map((f) => {
    let key = keyOf(f.key || f.label), base = key, i = 2;
    while (seen.has(key)) key = base + '_' + i++;
    seen.add(key);
    return {
      id: typeof f.id === 'string' && /^[\w-]{4,24}$/.test(f.id) ? f.id : rid(6), key, label: str(f.label, 100) || key,
      type: TYPES.includes(f.type) ? f.type : 'text', required: !!f.required,
      page: Math.round(num(f.page, 1, 1, pages)), x: +num(f.x, 50, -5000, 5000).toFixed(1), y: +num(f.y, 50, -5000, 5000).toFixed(1),
      size: num(f.size, 11, 4, 72), maxWidth: num(f.maxWidth, 0, 0, 5000),
      dateFormat: DATEFMT.includes(f.dateFormat) ? f.dateFormat : DATEFMT[0],
      prefill: PREFILL.includes(f.prefill) ? f.prefill : 'none', value: str(f.value, 2000),
    };
  });
}
const cleanTags = (t) => [...new Set((Array.isArray(t) ? t : []).map((x) => str(x, 30).trim()).filter(Boolean))].slice(0, 20);
const adminDoc = (d) => d;
const publicDoc = (d, req) => ({
  title: d.title, description: d.description, tags: d.tags, siteTitle: db.settings.siteTitle,
  serverPrint: !!db.settings.printerUrl && (db.settings.publicPrint || isAdmin(req)),
  fields: d.fields.map((f) => ({ key: f.key, label: f.label, type: f.type, required: f.required, prefill: f.prefill, value: f.prefill === 'instance' ? f.value : '' })),
});
async function inspectPdf(buf) {
  if (buf.length < 5 || buf.subarray(0, 5).toString() !== '%PDF-') throw new HttpErr(400, 'That file is not a PDF');
  try { return (await PDFDocument.load(buf)).getPageCount(); }
  catch (e) { throw new HttpErr(400, /encrypt/i.test(e.message) ? 'Encrypted PDFs are not supported — remove the password protection first' : 'Could not read that PDF'); }
}

// ---------------------------------------------------------------- PDF rendering
function fmtDate(v, fmt) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v); if (!m) return v;
  return fmt.replace('YYYY', m[1]).replace('MM', m[2]).replace('DD', m[3]);
}
async function renderPdf(doc, fields, values) {
  const pdf = await PDFDocument.load(fs.readFileSync(pdfPath(doc.id)));
  let font;
  if (fontkit && fs.existsSync(FONT)) { pdf.registerFontkit(fontkit); font = await pdf.embedFont(fs.readFileSync(FONT), { subset: true }); }
  else font = await pdf.embedFont(StandardFonts.Helvetica);
  const ok = new Map();
  const encodable = (ch) => { if (!ok.has(ch)) { try { font.encodeText(ch); ok.set(ch, true); } catch (e) { ok.set(ch, false); } } return ok.get(ch); };
  const pages = pdf.getPages();
  for (const f of fields) {
    const page = pages[f.page - 1]; if (!page) continue;
    let text = str(values[f.key], 4000);
    if (f.type === 'checkbox') text = text && text !== '0' && text !== 'false' ? 'X' : '';
    else if (f.type === 'date') text = fmtDate(text.trim(), f.dateFormat);
    else if (f.type !== 'textarea') text = text.replace(/\s+/g, ' ');
    text = [...text.replace(/\r/g, '').replace(/\t/g, ' ')].map((ch) => (ch === '\n' || encodable(ch) ? ch : '?')).join('').trim();
    if (!text) continue;
    page.drawText(text, {
      x: f.x, y: f.y, size: f.size, font, color: rgb(0, 0, 0), lineHeight: f.size * 1.2,
      maxWidth: f.maxWidth > 0 ? f.maxWidth : undefined, rotate: degrees(page.getRotation().angle),
    });
  }
  return Buffer.from(await pdf.save());
}
const sampleValues = (fields) => Object.fromEntries(fields.map((f) =>
  [f.key, f.type === 'checkbox' ? '1' : f.type === 'date' ? new Date().toISOString().slice(0, 10) : f.value || f.label]));
function cleanValues(v) {
  const out = {}; if (v && typeof v === 'object') for (const k of Object.keys(v).slice(0, 300)) out[k] = str(v[k], 4000);
  return out;
}

// ---------------------------------------------------------------- printing (IPP Print-Job, RFC 8011)
async function ippPrint(pdfBuf, copies, jobName) {
  const url = db.settings.printerUrl; if (!url) throw new HttpErr(400, 'No printer is configured');
  const attr = (tag, name, value) => {
    const n = Buffer.from(name), v = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    const h = Buffer.alloc(3); h.writeUInt8(tag, 0); h.writeUInt16BE(n.length, 1);
    const l = Buffer.alloc(2); l.writeUInt16BE(v.length, 0);
    return Buffer.concat([h, n, l, v]);
  };
  const int = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n, 0); return b; };
  const body = Buffer.concat([
    Buffer.from([0x02, 0x00, 0x00, 0x02]), int(1), Buffer.from([0x01]),
    attr(0x47, 'attributes-charset', 'utf-8'), attr(0x48, 'attributes-natural-language', 'en'),
    attr(0x45, 'printer-uri', url.replace(/^http/, 'ipp')), attr(0x42, 'requesting-user-name', 'stampfill'),
    attr(0x42, 'job-name', jobName.slice(0, 200)), attr(0x49, 'document-format', 'application/pdf'),
    Buffer.from([0x02]), attr(0x21, 'copies', int(copies)), Buffer.from([0x03]), pdfBuf,
  ]);
  let r, b;
  try {
    r = await fetch(url.replace(/^ipp/, 'http'), { method: 'POST', headers: { 'Content-Type': 'application/ipp' }, body, signal: AbortSignal.timeout(20000) });
    b = Buffer.from(await r.arrayBuffer());
  } catch (e) { throw new HttpErr(502, 'Printer not reachable'); }
  if (!r.ok || b.length < 8) throw new HttpErr(502, 'Printer answered HTTP ' + r.status);
  const status = b.readUInt16BE(2);
  if (status > 0xff) throw new HttpErr(502, 'Printer rejected the job (IPP status 0x' + status.toString(16).padStart(4, '0') + ')');
  const i = b.indexOf(Buffer.from('job-id'));
  return { ok: true, jobId: i > 0 && b.length >= i + 12 ? b.readInt32BE(i + 8) : null };
}

// ---------------------------------------------------------------- static vendor files (pdf.js)
const MIME = { '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream' };
function vendor(req, res, name) {
  let file = null;
  if (name === 'pdf.mjs') file = 'legacy/build/pdf.min.mjs';
  else if (name === 'pdf.worker.mjs') file = 'legacy/build/pdf.worker.min.mjs';
  else if (/^(standard_fonts|cmaps|wasm|iccs)\/[\w.-]+$/.test(name) && !name.includes('..')) file = name;
  const full = file && path.join(PDFJS, file);
  if (!full || !fs.existsSync(full)) return send(res, 404, 'Not found', 'text/plain');
  sendStatic(req, res, full, fs.readFileSync(full), MIME[path.extname(full)] || 'application/octet-stream', { 'Cache-Control': 'public, max-age=604800, immutable' });
}

// ---------------------------------------------------------------- routes
async function route(req, res) {
  const url = new URL(req.url, 'http://x'), p = url.pathname, m = req.method;
  let a;
  if (m === 'GET') {
    if (p === '/' || /^\/d\/[\w-]+$/.test(p)) return sendStatic(req, res, 'public', PUBLIC_HTML, 'text/html; charset=utf-8');
    if (p === '/admin' || p === '/admin/') return sendStatic(req, res, 'admin', ADMIN_HTML, 'text/html; charset=utf-8');
    if (p === '/healthz') return json(res, 200, { ok: true, version: VERSION, docs: db.docs.length });
    if (p.startsWith('/vendor/')) return vendor(req, res, p.slice(8));
  } else if (req.headers['x-requested-with'] !== 'stampfill') throw new HttpErr(403, 'Forbidden'); // CSRF guard

  // ---- public API
  if (m === 'GET' && p === '/api/docs')
    return json(res, 200, { title: db.settings.siteTitle, docs: db.docs.filter((d) => d.listed).map((d) => ({ slug: d.slug, title: d.title, description: d.description, tags: d.tags })) });
  if ((a = /^\/api\/d\/([\w-]+)(\/render|\/print)?$/.exec(p))) {
    const doc = db.docs.find((d) => d.slug === a[1]); if (!doc) throw new HttpErr(404, 'Document not found');
    if (m === 'GET' && !a[2]) return json(res, 200, publicDoc(doc, req));
    if (m === 'POST' && a[2]) {
      const body = await readJson(req, 3e5), values = cleanValues(body.values);
      const pdf = await renderPdf(doc, doc.fields, values);
      if (a[2] === '/render') return send(res, 200, pdf, 'application/pdf');
      if (!publicDoc(doc, req).serverPrint) throw new HttpErr(403, 'Printing from the server is not enabled');
      const miss = doc.fields.find((f) => f.required && !values[f.key]); if (miss) throw new HttpErr(400, 'Missing: ' + miss.label);
      return json(res, 200, await ippPrint(pdf, Math.round(num(body.copies, 1, 1, 20)), doc.title));
    }
  }

  // ---- login
  if (m === 'POST' && p === '/api/login') {
    const ip = clientIp(req), f = fails.get(ip);
    if (f && f.until > Date.now()) throw new HttpErr(429, 'Too many attempts — try again in a few minutes');
    const body = await readJson(req, 1e4);
    if (!checkPw(body.password)) {
      pruneFails();
      const n = (f ? f.n : 0) + 1; fails.set(ip, { n, until: n >= 5 ? Date.now() + 5 * 60000 : 0, at: Date.now() });
      await new Promise((r) => setTimeout(r, 400));
      throw new HttpErr(401, 'Wrong password');
    }
    fails.delete(ip);
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, newSession(), SESSION_MS / 1000) });
  }
  if (m === 'POST' && p === '/api/logout') return json(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, 'x', 0) });

  // ---- admin API
  if (!p.startsWith('/api/admin/')) throw new HttpErr(404, 'Not found');
  if (!isAdmin(req)) throw new HttpErr(401, 'Login required');
  if (m === 'GET' && p === '/api/admin/me') return json(res, 200, { ok: true, envPassword: !!process.env.ADMIN_PASSWORD });
  if (p === '/api/admin/settings') {
    if (m === 'PUT') {
      const b = await readJson(req), u = str(b.printerUrl, 500).trim();
      if (u && !/^(https?|ipps?):\/\/[^\s]+$/.test(u)) throw new HttpErr(400, 'Printer URL must start with http://, https://, ipp:// or ipps://');
      db.settings = { siteTitle: str(b.siteTitle, 60).trim() || 'Forms', printerUrl: u, publicPrint: !!b.publicPrint }; save();
    }
    if (m === 'GET' || m === 'PUT') return json(res, 200, db.settings);
  }
  if (m === 'POST' && p === '/api/admin/password') {
    if (process.env.ADMIN_PASSWORD) throw new HttpErr(400, 'The password is set through ADMIN_PASSWORD and cannot be changed here');
    const b = await readJson(req, 1e4);
    if (!checkPw(b.current)) throw new HttpErr(403, 'Current password is wrong');
    if (str(b.next, 500).length < 8) throw new HttpErr(400, 'New password needs at least 8 characters');
    db.auth = hashPw(b.next); db.secret = rid(32); save(); // rotating the secret signs out all other sessions
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, newSession(), SESSION_MS / 1000) });
  }
  if (p === '/api/admin/docs') {
    if (m === 'GET') return json(res, 200, db.docs.map((d) => ({ id: d.id, slug: d.slug, title: d.title, tags: d.tags, listed: d.listed, fields: d.fields.length, updated: d.updated })));
    if (m === 'POST') {
      const buf = await readBody(req, MAX_PDF), pages = await inspectPdf(buf);
      const doc = { id: rid(8), slug: rid(10), title: str(url.searchParams.get('title'), 120).trim() || 'Untitled', description: '', tags: [], listed: false, pages, fields: [], created: Date.now(), updated: Date.now() };
      fs.writeFileSync(pdfPath(doc.id), buf); db.docs.unshift(doc); save();
      return json(res, 200, adminDoc(doc));
    }
  }
  if ((a = /^\/api\/admin\/docs\/([\w-]+)(\/pdf|\/render|\/link)?$/.exec(p))) {
    const doc = db.docs.find((d) => d.id === a[1]); if (!doc) throw new HttpErr(404, 'Document not found');
    if (!a[2]) {
      if (m === 'GET') return json(res, 200, adminDoc(doc));
      if (m === 'PUT') {
        const b = await readJson(req);
        Object.assign(doc, { title: str(b.title, 120).trim() || 'Untitled', description: str(b.description, 500).trim(), tags: cleanTags(b.tags), listed: !!b.listed, fields: cleanFields(b.fields, doc.pages), updated: Date.now() });
        save(); return json(res, 200, adminDoc(doc));
      }
      if (m === 'DELETE') { db.docs = db.docs.filter((d) => d !== doc); save(); fs.rmSync(pdfPath(doc.id), { force: true }); return json(res, 200, { ok: true }); }
    }
    if (a[2] === '/pdf' && m === 'PUT') {
      const buf = await readBody(req, MAX_PDF); doc.pages = await inspectPdf(buf);
      fs.writeFileSync(pdfPath(doc.id), buf); doc.fields = cleanFields(doc.fields, doc.pages); doc.updated = Date.now(); save();
      return json(res, 200, adminDoc(doc));
    }
    if (a[2] === '/render' && m === 'POST') { // preview of unsaved field layout with sample values
      const b = await readJson(req), fields = cleanFields(b.fields, doc.pages);
      return send(res, 200, await renderPdf(doc, fields, b.values ? cleanValues(b.values) : sampleValues(fields)), 'application/pdf');
    }
    if (a[2] === '/link' && m === 'POST') { doc.slug = rid(10); save(); return json(res, 200, adminDoc(doc)); }
  }
  throw new HttpErr(404, 'Not found');
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (!(e instanceof HttpErr)) console.error(e);
    if (!res.headersSent) json(res, e.status || 500, { error: e instanceof HttpErr ? e.message : 'Internal error' }); else res.end();
  });
});
function start({ port = PORT, host = HOST } = {}) {
  return new Promise((ok, no) => {
    server.once('error', no);
    server.listen(port, host, () => { const a = server.address(); console.log('stampfill ' + VERSION + ' listening on http://' + a.address + ':' + a.port + '  (data: ' + DATA + ')'); ok(server); });
  });
}
function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref(); // keep-alive connections must not hold the process hostage
}
if (require.main === module) {
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  start().catch((e) => { console.error(e.message); process.exit(1); });
}
module.exports = { start, server, db, DATA, keyOf, fmtDate, cleanFields, cleanTags, cleanValues, sampleValues, renderPdf, ippPrint, checkPw, hashPw, inspectPdf };

// ================================================================ front end
// (client code below must not contain backticks or dollar-brace: it lives inside String.raw templates)
const CSS = String.raw`
:root{color-scheme:light dark;--bg:#f4f5f7;--card:#fff;--ink:#16181d;--mut:#687079;--line:#e4e6ea;--line2:#cdd1d7;--acc:#2f6bff;--acc-2:#1f57e6;--acc-ink:#fff;--acc-soft:rgba(47,107,255,.13);--bad:#d3372c;--bad-soft:rgba(211,55,44,.12);--ok:#1e8a4f;--paper:#e8eaee;--hdr:rgba(255,255,255,.82);--sh:0 1px 2px rgba(16,18,24,.06),0 1px 1px rgba(16,18,24,.03);--sh2:0 10px 28px rgba(16,18,24,.12),0 2px 6px rgba(16,18,24,.06);--r:12px;--rs:9px}
@media(prefers-color-scheme:dark){:root{--bg:#111317;--card:#1a1d23;--ink:#e8eaee;--mut:#99a1ab;--line:#292e36;--line2:#3b414b;--acc:#6f9cff;--acc-2:#8ab0ff;--acc-ink:#0a1430;--acc-soft:rgba(111,156,255,.18);--bad:#ff7b70;--bad-soft:rgba(255,123,112,.16);--ok:#5fd08f;--paper:#0c0e12;--hdr:rgba(26,29,35,.82);--sh:0 1px 2px rgba(0,0,0,.45);--sh2:0 12px 32px rgba(0,0,0,.55)}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;scroll-padding-top:72px}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 Inter,"Segoe UI Variable Text",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
header{position:sticky;top:0;z-index:5;display:flex;gap:16px;align-items:center;padding:10px 20px;border-bottom:1px solid var(--line);background:var(--hdr);backdrop-filter:saturate(180%) blur(14px);-webkit-backdrop-filter:saturate(180%) blur(14px)}
header a{color:var(--ink);text-decoration:none;transition:color .15s}header a:hover{color:var(--acc)}
#home{display:inline-flex;align-items:center;gap:9px;font-weight:650;letter-spacing:-.01em}#home svg{width:22px;height:22px;color:var(--acc);flex:none}
#nav{gap:4px}#nav a{padding:6px 10px;border-radius:7px}#nav a:hover{background:var(--acc-soft)}
.sp{flex:1}
main{max-width:1240px;margin:0 auto;padding:24px 20px 64px;animation:rise .25s ease-out both}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
h1{font-size:26px;font-weight:700;letter-spacing:-.02em;margin:4px 0 16px}
h2{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);margin:22px 0 8px}
.muted{color:var(--mut)}.small{font-size:12.5px}
input,select,textarea,button{font:inherit;color:inherit}
input[type=text],input[type=search],input[type=password],input[type=date],input[type=number],input[type=url],select,textarea{width:100%;padding:9px 11px;border:1px solid var(--line2);border-radius:var(--rs);background:var(--card);transition:border-color .15s,box-shadow .15s}
select{appearance:none;-webkit-appearance:none;padding-right:32px;background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23687079' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 11px center}
input:hover,select:hover,textarea:hover{border-color:var(--mut)}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--acc);box-shadow:0 0 0 3px var(--acc-soft)}
input[readonly]{color:var(--mut);background:var(--bg)}
textarea{resize:vertical;min-height:72px}
label{display:block;font-size:13px;font-weight:500;color:var(--mut);margin:12px 0 5px}
label.chk{display:flex;gap:9px;align-items:center;color:var(--ink);font-size:14px;font-weight:400;cursor:pointer}
input[type=checkbox]{width:17px;height:17px;margin:0;accent-color:var(--acc);cursor:pointer;flex:none}
.bad input,.bad textarea{border-color:var(--bad);box-shadow:0 0 0 3px var(--bad-soft)}
button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 14px;border:1px solid var(--line2);border-radius:var(--rs);background:var(--card);cursor:pointer;text-decoration:none;color:var(--ink);white-space:nowrap;font-weight:500;box-shadow:var(--sh);transition:background .15s,border-color .15s,box-shadow .15s,transform .08s}
button:hover,.btn:hover{border-color:var(--mut)}button:active,.btn:active{transform:translateY(1px);box-shadow:none}
button:focus-visible,.btn:focus-visible,a:focus-visible{outline:none;border-color:var(--acc);box-shadow:0 0 0 3px var(--acc-soft)}
button.pri{background:var(--acc);border-color:var(--acc);color:var(--acc-ink);font-weight:600;box-shadow:0 1px 2px rgba(47,107,255,.35)}button.pri:hover{background:var(--acc-2);border-color:var(--acc-2)}
button.danger{color:var(--bad)}button.danger:hover{border-color:var(--bad);background:var(--bad-soft)}
button:disabled{opacity:.55;cursor:default;transform:none;box-shadow:none}
button.small{padding:6px 11px;font-size:13px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.row>.grow{flex:1;min-width:0}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin:14px 0}.chip{border-radius:99px;padding:5px 13px;font-size:13px;box-shadow:none}.chip.on{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.tag{display:inline-flex;align-items:center;font-size:11.5px;font-weight:500;padding:2px 9px;border-radius:99px;background:var(--acc-soft);color:var(--acc);margin-right:4px;white-space:nowrap}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.card{display:block;padding:16px 18px;background:var(--card);border:1px solid var(--line);border-radius:var(--r);color:var(--ink);text-decoration:none;box-shadow:var(--sh);transition:transform .15s,box-shadow .15s,border-color .15s}
.card:hover{transform:translateY(-2px);box-shadow:var(--sh2);border-color:var(--line2)}.card b{font-size:16px;letter-spacing:-.01em}.card p{margin:5px 0 10px;color:var(--mut);font-size:13.5px}
.split{display:grid;grid-template-columns:minmax(300px,400px) 1fr;gap:24px;align-items:start}
.panel{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:18px 20px;box-shadow:var(--sh)}
.preview{background:var(--paper);border:1px solid var(--line);border-radius:var(--r);padding:16px;min-height:240px;display:flex;flex-direction:column;gap:16px;align-items:center}
.preview canvas{max-width:100%;height:auto!important;background:#fff;border-radius:3px;box-shadow:0 2px 12px rgba(16,18,24,.18),0 0 0 1px rgba(16,18,24,.06);transition:opacity .2s}
.preview.busy canvas{opacity:.55}
.skel{width:min(100%,560px);aspect-ratio:1/1.414;border-radius:3px;background:linear-gradient(100deg,var(--card) 30%,var(--line) 50%,var(--card) 70%);background-size:200% 100%;animation:shimmer 1.2s linear infinite}
@keyframes shimmer{to{background-position:-200% 0}}
.hint{font-size:12px;color:var(--mut);margin-top:4px}
.actions{margin-top:20px;padding-top:16px;border-top:1px solid var(--line)}
.empty{padding:36px 20px;text-align:center;color:var(--mut);border:1px dashed var(--line2);border-radius:var(--r)}.empty.small{padding:18px 14px}
.login{max-width:360px;margin:8vh auto 0;padding:28px}.login .logo{display:flex;width:46px;height:46px;align-items:center;justify-content:center;border-radius:12px;background:var(--acc-soft);color:var(--acc);margin-bottom:16px}.login .logo svg{width:26px;height:26px}.login h1{margin-bottom:2px}
table{width:100%;border-collapse:separate;border-spacing:0;background:var(--card);border:1px solid var(--line);border-radius:var(--r);overflow:hidden;box-shadow:var(--sh)}
th,td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--line);vertical-align:middle}th{font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);background:var(--bg)}
tr:last-child td{border-bottom:0}tbody tr{transition:background .12s}tbody tr:hover{background:var(--bg)}td a{color:var(--acc);text-decoration:none;font-weight:600}
.editor{display:grid;grid-template-columns:1fr 380px;gap:22px;align-items:start}
.stage{background:var(--paper);border:1px solid var(--line);border-radius:var(--r);padding:16px;overflow:auto}
.wrap{position:relative;margin:0 auto;background:#fff;border-radius:3px;box-shadow:0 2px 12px rgba(16,18,24,.18),0 0 0 1px rgba(16,18,24,.06);touch-action:none}
.wrap canvas{display:block;border-radius:3px}.ov{position:absolute;inset:0;cursor:crosshair}
.mk{position:absolute;border:1.5px dashed #2f6bff;background:rgba(47,107,255,.10);cursor:move;border-radius:3px;min-width:14px;transition:background .12s}.mk:hover{background:rgba(47,107,255,.18)}
.mk.on{border-style:solid;border-color:#e8590c;background:rgba(232,89,12,.14);z-index:2}
.mk span{position:absolute;left:-1.5px;bottom:100%;font-size:10px;font-weight:600;line-height:1.3;padding:1px 5px;background:#2f6bff;color:#fff;white-space:nowrap;border-radius:3px 3px 0 0}
.mk.on span{background:#e8590c}
.flist{border:1px solid var(--line);border-radius:var(--rs);overflow:hidden;background:var(--card)}
.fitem{display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--line);cursor:pointer;transition:background .12s}.fitem:hover{background:var(--bg)}
.fitem:last-child{border-bottom:0}.fitem.on{background:var(--acc-soft);box-shadow:inset 3px 0 0 var(--acc)}.fitem b{flex:1;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:0 10px}.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:0 8px}
#toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,12px);background:var(--ink);color:var(--bg);padding:10px 18px;border-radius:99px;opacity:0;transition:opacity .2s,transform .2s;pointer-events:none;z-index:9;max-width:90vw;box-shadow:var(--sh2);font-weight:500}
#toast.show{opacity:1;transform:translate(-50%,0)}#toast.bad{background:var(--bad);color:#fff}
#printArea{display:none}
@media(max-width:1000px){.editor{grid-template-columns:1fr}}
@media(max-width:860px){.split{grid-template-columns:1fr}main{padding:16px 16px 40px}h1{font-size:22px}header{padding:10px 16px}.panel{padding:16px}
.actions{position:sticky;bottom:0;z-index:3;margin:16px -16px -16px;padding:12px 16px;background:var(--hdr);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-radius:0 0 var(--r) var(--r)}
.actions button{flex:1}#toast{bottom:max(16px,env(safe-area-inset-bottom))}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
@media print{header,main,#toast{display:none!important}body{background:#fff}#printArea{display:block}#printArea div{overflow:hidden;break-inside:avoid;break-after:page}#printArea div:last-child{break-after:auto}#printArea img{display:block;width:100%}}
`;

const LOGO_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 22h14"/><path d="M19.27 13.73A2.5 2.5 0 0 0 17.5 13h-11a2.5 2.5 0 0 0-2.5 2.5V17h16v-1.5c0-.66-.26-1.3-.73-1.77Z"/><path d="M14 13V8.5a2 2 0 1 0-4 0V13"/></svg>';
const LIB = 'const LOGO = ' + JSON.stringify(LOGO_SVG) + ';\n' + String.raw`
import * as pdfjs from '/vendor/pdf.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.mjs';
const $ = (s, r) => (r || document).querySelector(s);
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const k in attrs || {}) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false && c !== '') e.append(c.nodeType ? c : String(c));
  return e;
}
async function api(method, url, body, raw) {
  const o = { method, headers: { 'X-Requested-With': 'stampfill' }, credentials: 'same-origin' };
  if (body instanceof Blob) { o.body = body; o.headers['Content-Type'] = 'application/pdf'; }
  else if (body !== undefined) { o.body = JSON.stringify(body); o.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(url, o);
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).error || m; } catch (e) {} const err = new Error(m); err.status = r.status; throw err; }
  return raw ? r.arrayBuffer() : r.json();
}
let toastT;
function toast(msg, bad) { const t = $('#toast'); t.textContent = msg; t.className = 'show' + (bad ? ' bad' : ''); clearTimeout(toastT); toastT = setTimeout(() => t.className = '', bad ? 5000 : 2200); }
const fail = (e) => toast(e.message || String(e), true);
async function copyText(s) { try { await navigator.clipboard.writeText(s); toast('Link copied'); } catch (e) { prompt('Copy this link:', s); } }
function openPdf(buf) { return pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)), standardFontDataUrl: '/vendor/standard_fonts/', cMapUrl: '/vendor/cmaps/', cMapPacked: true, wasmUrl: '/vendor/wasm/', iccUrl: '/vendor/iccs/' }).promise; }
// draws page n at the given CSS width; returns the CSS-pixel viewport (for coordinate conversion) plus the page size in points
async function drawPage(pdf, n, canvas, cssWidth, density) {
  const page = await pdf.getPage(n), base = page.getViewport({ scale: 1 }), scale = cssWidth / base.width;
  const vp = page.getViewport({ scale: scale * (density || Math.min(window.devicePixelRatio || 1, 2)) });
  canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
  canvas.style.width = cssWidth + 'px'; canvas.style.height = Math.round(cssWidth * base.height / base.width) + 'px';
  await page.render({ canvasContext: canvas.getContext('2d'), canvas, viewport: vp }).promise;
  const out = page.getViewport({ scale }); out.pt = [base.width, base.height]; return out;
}
`;

const page = (title, body, js) => '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">' +
  '<link rel="modulepreload" href="/vendor/pdf.mjs"><link rel="preload" href="/vendor/pdf.worker.mjs" as="script" crossorigin>' +
  '<title>' + title + '</title><style>' + CSS + '</style><style id="pageStyle"></style></head><body>' + body +
  '<main id="app"></main><div id="printArea"></div><div id="toast"></div><script type="module">' + LIB + js + '</script></body></html>';

// ---------------------------------------------------------------- public page: list + form
const PUBLIC_HTML = page('Forms', '<header><a href="/" id="home">' + LOGO_SVG + '<span id="homeT">Forms</span></a><span class="sp"></span></header>', String.raw`
const app = $('#app');
const slug = (location.pathname.match(/^\/d\/([\w-]+)$/) || [])[1];
(slug ? formView() : listView()).catch(fail);

async function listView() {
  const data = await api('GET', '/api/docs'), docs = data.docs;
  document.title = data.title; $('#homeT').textContent = data.title;
  let tag = new URLSearchParams(location.search).get('tag') || '', q = '';
  const tags = [...new Set(docs.flatMap(d => d.tags))].sort((a, b) => a.localeCompare(b));
  const list = h('div', { class: 'cards' }), chips = h('div', { class: 'chips' });
  function draw() {
    chips.replaceChildren(...(tags.length ? ['', ...tags] : []).map(t => h('button', { class: 'chip' + (t === tag ? ' on' : ''), onclick: () => { tag = t; history.replaceState(null, '', t ? '?tag=' + encodeURIComponent(t) : '/'); draw(); } }, t || 'All')));
    const shown = docs.filter(d => (!tag || d.tags.includes(tag)) && (!q || (d.title + ' ' + d.description + ' ' + d.tags.join(' ')).toLowerCase().includes(q)));
    list.replaceChildren(...shown.map(d => h('a', { class: 'card', href: '/d/' + d.slug }, h('b', {}, d.title), h('p', {}, d.description), h('div', {}, d.tags.map(t => h('span', { class: 'tag' }, t))))));
    if (!shown.length) list.append(h('p', { class: 'empty', style: 'grid-column:1/-1' }, docs.length ? 'No matching documents.' : 'No documents are listed here. Use the direct link you were given.'));
  }
  app.append(h('h1', {}, 'Documents'), h('input', { type: 'search', placeholder: 'Search documents', oninput: e => { q = e.target.value.trim().toLowerCase(); draw(); } }), chips, list);
  draw();
}

async function formView() {
  let doc;
  try { doc = await api('GET', '/api/d/' + slug); }
  catch (e) { app.append(h('h1', {}, 'Document not found'), h('p', { class: 'muted' }, 'This link is not valid any more.')); return; }
  document.title = doc.title; $('#homeT').textContent = doc.siteTitle;
  // values from the link: #key=value (preferred, never sent to the server) or ?key=value
  const fromUrl = new URLSearchParams(location.search);
  new URLSearchParams(location.hash.slice(1)).forEach((v, k) => fromUrl.set(k, v));
  const LS = 'stampfill:';
  const store = {
    get(k) { try { return localStorage.getItem(LS + k); } catch (e) { return null; } },
    set(k, v) { try { v === '' ? localStorage.removeItem(LS + k) : localStorage.setItem(LS + k, v); } catch (e) {} },
  };
  const inputs = {}, rows = {};
  const get = f => f.type === 'checkbox' ? (inputs[f.key].checked ? '1' : '') : inputs[f.key].value;
  const put = (f, v) => { if (f.type === 'checkbox') inputs[f.key].checked = !!v && v !== '0' && v !== 'false'; else inputs[f.key].value = v; };
  const values = () => Object.fromEntries(doc.fields.map(f => [f.key, get(f)]));
  const HINT = { browser: 'Remembered in this browser', url: 'Can be carried in a link', instance: '' };

  const form = h('div', { class: 'panel' });
  for (const f of doc.fields) {
    const inp = inputs[f.key] = f.type === 'textarea' ? h('textarea', { rows: 3 }) : h('input', { type: f.type === 'checkbox' ? 'checkbox' : f.type === 'date' ? 'date' : 'text' });
    inp.id = 'f_' + f.key;
    const saved = f.prefill === 'browser' ? store.get(f.key) : null;
    put(f, fromUrl.has(f.key) ? fromUrl.get(f.key) : saved != null ? saved : f.prefill === 'instance' ? f.value : '');
    inp.addEventListener('input', () => { if (f.prefill === 'browser') store.set(f.key, get(f)); rows[f.key].classList.remove('bad'); schedule(); });
    const name = f.label + (f.required ? ' *' : '');
    rows[f.key] = f.type === 'checkbox'
      ? h('div', {}, h('label', { class: 'chk', style: 'margin-top:12px' }, inp, name), HINT[f.prefill] && h('div', { class: 'hint' }, HINT[f.prefill]))
      : h('div', {}, h('label', { htmlFor: inp.id }, name), inp, HINT[f.prefill] && h('div', { class: 'hint' }, HINT[f.prefill]));
    form.append(rows[f.key]);
  }
  if (!doc.fields.length) form.append(h('p', { class: 'muted' }, 'This document has no fields to fill in.'));

  const pv = h('div', { class: 'preview' }, h('div', { class: 'skel' }));
  let seq = 0, timer, current = null;
  async function refresh() {
    const my = ++seq; pv.classList.add('busy');
    try {
      const buf = await api('POST', '/api/d/' + slug + '/render', { values: values() }, true);
      if (my !== seq) return current;
      const pdf = await openPdf(buf), w = Math.max(240, Math.min(pv.clientWidth - 34, 860)), out = [];
      for (let i = 1; i <= pdf.numPages; i++) { const c = h('canvas'); await drawPage(pdf, i, c, w); out.push(c); }
      if (my === seq) { pv.replaceChildren(...out); current = buf; }
      return buf;
    } finally { if (my === seq) pv.classList.remove('busy'); }
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(() => refresh().catch(fail), 200); }
  function complete() {
    const miss = doc.fields.filter(f => f.required && !get(f));
    miss.forEach(f => rows[f.key].classList.add('bad'));
    if (miss.length) { toast('Please fill in: ' + miss.map(f => f.label).join(', '), true); inputs[miss[0].key].focus(); }
    return !miss.length;
  }
  const fresh = async () => { clearTimeout(timer); return refresh(); };

  async function browserPrint() {
    if (!complete()) return;
    const buf = await fresh();
    // Chromium desktop prints the PDF itself (vector); everything else prints high-resolution page images
    if (navigator.pdfViewerEnabled && /Chrome\//.test(navigator.userAgent) && !/Android|Mobile/.test(navigator.userAgent)) {
      try {
        await new Promise((ok, no) => {
          const old = $('#pf'); if (old) old.remove();
          const fr = h('iframe', { id: 'pf', style: 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden' });
          fr.onload = () => { try { fr.contentWindow.focus(); fr.contentWindow.print(); ok(); } catch (e) { no(e); } };
          setTimeout(() => no(new Error('timeout')), 5000);
          fr.src = URL.createObjectURL(new Blob([buf], { type: 'application/pdf' })); document.body.append(fr);
        });
        return;
      } catch (e) { /* fall through to image printing */ }
    }
    await imagePrint(buf);
  }
  async function imagePrint(buf) {
    const pdf = await openPdf(buf), area = $('#printArea'); area.replaceChildren();
    let first;
    for (let i = 1; i <= pdf.numPages; i++) {
      const c = document.createElement('canvas'), vp = await drawPage(pdf, i, c, 800, 3);
      first = first || vp.pt;
      const img = h('img', { src: c.toDataURL('image/png') }); await img.decode();
      area.append(h('div', { style: 'width:' + vp.pt[0] + 'pt;height:' + (vp.pt[1] - 0.5) + 'pt' }, img));
    }
    $('#pageStyle').textContent = '@page{size:' + first[0] + 'pt ' + first[1] + 'pt;margin:0}';
    window.print();
  }
  window.stampfillImagePrint = async () => imagePrint(await fresh()); // manual fallback / test hook
  async function download() {
    if (!complete()) return;
    const a = h('a', { href: URL.createObjectURL(new Blob([await fresh()], { type: 'application/pdf' })), download: doc.title.replace(/[^\w.-]+/g, '_') + '.pdf' });
    document.body.append(a); a.click(); a.remove();
  }
  async function serverPrint() {
    if (!complete()) return;
    const r = await api('POST', '/api/d/' + slug + '/print', { values: values(), copies: 1 });
    toast('Sent to the printer' + (r.jobId ? ' (job ' + r.jobId + ')' : ''));
  }
  function shareLink() {
    const p = new URLSearchParams();
    doc.fields.filter(f => f.prefill === 'url' && get(f)).forEach(f => p.set(f.key, get(f)));
    copyText(location.origin + location.pathname + (p.toString() ? '#' + p.toString() : ''));
  }
  function forget() {
    doc.fields.filter(f => f.prefill === 'browser').forEach(f => { store.set(f.key, ''); put(f, ''); });
    schedule(); toast('Saved values removed from this browser');
  }
  const guard = fn => async e => { const b = e.currentTarget; b.disabled = true; try { await fn(); } catch (err) { fail(err); } b.disabled = false; };
  const has = mode => doc.fields.some(f => f.prefill === mode);
  form.append(h('div', { class: 'actions' },
    h('div', { class: 'row' },
      h('button', { class: 'pri', onclick: guard(browserPrint) }, 'Print'),
      doc.serverPrint && h('button', { onclick: guard(serverPrint) }, 'Send to printer'),
      h('button', { onclick: guard(download) }, 'Download PDF')),
    (has('url') || has('browser')) && h('div', { class: 'row', style: 'margin-top:10px' },
      has('url') && h('button', { class: 'small', onclick: shareLink, title: 'Copies a link that opens this form with the marked fields filled in' }, 'Copy link with values'),
      has('browser') && h('button', { class: 'small', onclick: forget }, 'Forget saved values'))));
  app.append(h('h1', {}, doc.title), doc.description && h('p', { class: 'muted', style: 'margin-top:-8px' }, doc.description), h('div', { class: 'split' }, form, pv));
  await refresh();
}
`);

// ---------------------------------------------------------------- admin page
const ADMIN_HTML = page('Forms admin', '<header><a href="/admin" id="home">' + LOGO_SVG + '<span id="homeT">Forms admin</span></a><span class="sp"></span><span id="nav" class="row"></span></header>', String.raw`
const app = $('#app');
let me = null, dirty = false, lastHash = location.hash;
const TYPES = { text: 'Text', textarea: 'Multi-line text', date: 'Date', checkbox: 'Checkbox (X)' };
const PRE = { none: 'No prefill', browser: 'Remember per user (browser)', instance: 'Fixed value (this instance)', url: 'From link (URL)' };
const PRE_SHORT = { none: '', browser: 'browser', instance: 'fixed', url: 'link' };
const DATEFMT = ['DD.MM.YYYY', 'YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY'];
const keyOf = s => String(s).toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'field';
const linkOf = d => location.origin + '/d/' + d.slug;

async function boot() {
  try { me = await api('GET', '/api/admin/me'); } catch (e) { return loginView(); }
  $('#nav').replaceChildren(h('a', { href: '#' }, 'Documents'), h('a', { href: '#settings' }, 'Settings'), h('a', { href: '/', target: '_blank' }, 'Public list'),
    h('button', { onclick: async () => { await api('POST', '/api/logout'); location.reload(); } }, 'Log out'));
  go();
}
window.addEventListener('hashchange', () => {
  if (!me) return;
  if (dirty && !confirm('Discard unsaved changes?')) { history.replaceState(null, '', lastHash || '#'); return; }
  go();
});
window.addEventListener('beforeunload', e => { if (dirty) e.preventDefault(); });
function go() {
  dirty = false; lastHash = location.hash; app.replaceChildren();
  const r = location.hash.slice(1);
  (r.startsWith('doc/') ? editView(r.slice(4)) : r === 'settings' ? settingsView() : listView()).catch(fail);
}

function loginView() {
  const pw = h('input', { type: 'password', autocomplete: 'current-password', autofocus: true });
  app.replaceChildren(h('form', { class: 'panel login', onsubmit: async e => { e.preventDefault(); try { await api('POST', '/api/login', { password: pw.value }); boot(); } catch (err) { fail(err); pw.select(); } } },
    h('div', { class: 'logo', innerHTML: LOGO }), h('h1', {}, 'Admin login'), h('p', { class: 'muted small', style: 'margin:0 0 6px' }, 'Manage templates, fields and printing.'),
    h('label', {}, 'Password'), pw, h('div', { style: 'margin-top:16px' }, h('button', { class: 'pri', style: 'width:100%' }, 'Log in'))));
}

async function listView() {
  const docs = await api('GET', '/api/admin/docs');
  let tag = '';
  const tags = [...new Set(docs.flatMap(d => d.tags))].sort((a, b) => a.localeCompare(b));
  const chips = h('div', { class: 'chips' }), body = h('tbody');
  const file = h('input', { type: 'file', accept: 'application/pdf,.pdf', style: 'display:none', onchange: async () => {
    const f = file.files[0]; if (!f) return;
    try { const d = await api('POST', '/api/admin/docs?title=' + encodeURIComponent(f.name.replace(/\.pdf$/i, '')), f); location.hash = 'doc/' + d.id; } catch (e) { fail(e); }
    file.value = '';
  } });
  function draw() {
    chips.replaceChildren(...(tags.length ? ['', ...tags] : []).map(t => h('button', { class: 'chip' + (t === tag ? ' on' : ''), onclick: () => { tag = t; draw(); } }, t || 'All')));
    body.replaceChildren(...docs.filter(d => !tag || d.tags.includes(tag)).map(d => h('tr', {},
      h('td', {}, h('a', { href: '#doc/' + d.id }, d.title)), h('td', {}, d.tags.map(t => h('span', { class: 'tag' }, t))),
      h('td', {}, d.fields), h('td', {}, d.listed ? 'Listed' : 'Link only'),
      h('td', {}, h('div', { class: 'row' }, h('button', { onclick: () => copyText(linkOf(d)) }, 'Copy link'), h('a', { class: 'btn', href: '/d/' + d.slug, target: '_blank' }, 'Open'))))));
  }
  app.append(h('div', { class: 'row' }, h('h1', { class: 'grow' }, 'Documents'), h('button', { class: 'pri', onclick: () => file.click() }, 'Upload PDF'), file), chips,
    docs.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Title', 'Tags', 'Fields', 'Visibility', ''].map(t => h('th', {}, t)))), body)
      : h('p', { class: 'empty' }, 'No documents yet. Upload a PDF to create the first one.'));
  draw();
}

async function settingsView() {
  const s = await api('GET', '/api/admin/settings');
  const title = h('input', { type: 'text', value: s.siteTitle }), purl = h('input', { type: 'url', value: s.printerUrl, placeholder: 'http://cups-host:631/printers/NAME' });
  const pub = h('input', { type: 'checkbox', checked: s.publicPrint });
  const cur = h('input', { type: 'password', autocomplete: 'current-password' }), nxt = h('input', { type: 'password', autocomplete: 'new-password' });
  app.append(h('h1', {}, 'Settings'), h('div', { class: 'panel', style: 'max-width:560px' },
    h('label', {}, 'Site title'), title,
    h('label', {}, 'Network printer (IPP / CUPS URL, optional)'), purl,
    h('div', { class: 'hint' }, 'Adds a "Send to printer" button that prints on this printer from the server. The printer must accept PDF.'),
    h('label', { class: 'chk', style: 'margin-top:12px' }, pub, 'Let everyone with a document link use this printer (otherwise only while logged in as admin)'),
    h('div', { style: 'margin-top:14px' }, h('button', { class: 'pri', onclick: async () => { try { await api('PUT', '/api/admin/settings', { siteTitle: title.value, printerUrl: purl.value, publicPrint: pub.checked }); toast('Saved'); } catch (e) { fail(e); } } }, 'Save settings'))),
    h('h2', {}, 'Password'),
    me.envPassword ? h('p', { class: 'muted' }, 'The admin password is set through the ADMIN_PASSWORD environment variable.')
      : h('div', { class: 'panel', style: 'max-width:560px' }, h('label', {}, 'Current password'), cur, h('label', {}, 'New password (at least 8 characters)'), nxt,
        h('div', { style: 'margin-top:14px' }, h('button', { onclick: async () => { try { await api('POST', '/api/admin/password', { current: cur.value, next: nxt.value }); cur.value = nxt.value = ''; toast('Password changed'); } catch (e) { fail(e); } } }, 'Change password'))));
}

async function editView(id) {
  let d = await api('GET', '/api/admin/docs/' + id);
  let sel = null, pageNo = 1, vp = null, seq = 0, timer;
  const mark = () => { dirty = true; saveBtn.textContent = 'Save changes'; saveBtn.disabled = false; };
  const field = () => d.fields.find(f => f.id === sel);

  // ---- stage: live PDF preview with draggable field markers
  const canvasBox = h('div'), ov = h('div', { class: 'ov' }), wrap = h('div', { class: 'wrap' }, canvasBox, ov);
  const pageLbl = h('span', { class: 'muted' });
  const stage = h('div', { class: 'stage' }, wrap);
  async function redraw() {
    const my = ++seq, buf = await api('POST', '/api/admin/docs/' + id + '/render', { fields: d.fields }, true);
    if (my !== seq) return;
    const pdf = await openPdf(buf), c = h('canvas'), w = Math.max(280, stage.clientWidth - 34);
    pageNo = Math.min(pageNo, pdf.numPages);
    const v = await drawPage(pdf, pageNo, c, w);
    if (my !== seq) return;
    vp = v; wrap.style.width = w + 'px'; canvasBox.replaceChildren(c);
    pageLbl.textContent = 'Page ' + pageNo + ' of ' + pdf.numPages; markers();
  }
  const later = () => { clearTimeout(timer); timer = setTimeout(() => redraw().catch(fail), 200); };
  function markers() {
    if (!vp) return;
    ov.replaceChildren(...d.fields.filter(f => f.page === pageNo).map(f => {
      const pt = vp.convertToViewportPoint(f.x, f.y), fh = f.size * vp.scale;
      const sample = f.type === 'checkbox' ? 'X' : f.type === 'date' ? '00.00.0000' : (f.value || f.label);
      const w = (f.maxWidth > 0 ? f.maxWidth : Math.max(f.size, sample.length * f.size * 0.52)) * vp.scale;
      const m = h('div', { class: 'mk' + (f.id === sel ? ' on' : ''), title: 'Drag to move', style: 'left:' + pt[0] + 'px;top:' + (pt[1] - fh * 0.85) + 'px;width:' + w + 'px;height:' + fh * 1.1 + 'px' }, h('span', {}, f.label));
      m.addEventListener('pointerdown', e => drag(e, f, m));
      return m;
    }));
  }
  function drag(e, f, m) {
    e.preventDefault(); sel = f.id; side(); markers();
    const live = [...ov.children].find(x => x.classList.contains('on')) || m;
    const sx = e.clientX, sy = e.clientY, l0 = parseFloat(live.style.left), t0 = parseFloat(live.style.top), p0 = vp.convertToViewportPoint(f.x, f.y);
    let moved = false;
    const move = ev => { moved = true; live.style.left = l0 + ev.clientX - sx + 'px'; live.style.top = t0 + ev.clientY - sy + 'px'; };
    const up = ev => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (!moved) return;
      const p = vp.convertToPdfPoint(p0[0] + ev.clientX - sx, p0[1] + ev.clientY - sy);
      f.x = Math.round(p[0] * 10) / 10; f.y = Math.round(p[1] * 10) / 10; mark(); side(); redraw().catch(fail);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }
  function addField(x, y) {
    let n = d.fields.length + 1, label = 'Field ' + n;
    while (d.fields.some(f => f.key === keyOf(label))) label = 'Field ' + (++n);
    const f = { id: 'f' + Math.random().toString(36).slice(2, 10), key: keyOf(label), label, type: 'text', required: false, page: pageNo, x: Math.round(x), y: Math.round(y), size: 11, maxWidth: 0, dateFormat: DATEFMT[0], prefill: 'none', value: '' };
    d.fields.push(f); sel = f.id; mark(); side(); redraw().catch(fail);
    const first = $('#fp input'); if (first) { first.focus(); first.select(); }
  }
  ov.addEventListener('dblclick', e => { if (e.target !== ov || !vp) return; const r = ov.getBoundingClientRect(), p = vp.convertToPdfPoint(e.clientX - r.left, e.clientY - r.top); addField(p[0], p[1]); });
  ov.addEventListener('pointerdown', e => { if (e.target === ov && sel) { sel = null; side(); markers(); } });

  // ---- side panel
  const saveBtn = h('button', { class: 'pri', disabled: true, onclick: save }, 'Saved');
  const title = h('input', { type: 'text', value: d.title, oninput: mark }), desc = h('textarea', { rows: 2, value: d.description, oninput: mark });
  const tags = h('input', { type: 'text', value: d.tags.join(', '), placeholder: 'e.g. school, tax, club', oninput: mark }), listed = h('input', { type: 'checkbox', checked: d.listed, onchange: mark });
  const link = h('input', { type: 'text', readOnly: true, value: linkOf(d), onfocus: e => e.target.select() });
  const fieldsBox = h('div'), propsBox = h('div', { id: 'fp' });
  const repl = h('input', { type: 'file', accept: 'application/pdf,.pdf', style: 'display:none', onchange: async () => {
    const f = repl.files[0]; if (!f) return;
    if (dirty && !confirm('Replacing the PDF discards unsaved changes. Continue?')) { repl.value = ''; return; }
    try { d = await api('PUT', '/api/admin/docs/' + id + '/pdf', f); dirty = false; saveBtn.textContent = 'Saved'; saveBtn.disabled = true; side(); await redraw(); toast('PDF replaced'); } catch (e) { fail(e); }
    repl.value = '';
  } });
  async function save() {
    try {
      d = await api('PUT', '/api/admin/docs/' + id, { title: title.value, description: desc.value, tags: tags.value.split(','), listed: listed.checked, fields: d.fields });
      dirty = false; saveBtn.textContent = 'Saved'; saveBtn.disabled = true; side(); toast('Saved');
    } catch (e) { fail(e); }
  }
  function flist() {
    fieldsBox.replaceChildren(d.fields.length ? h('div', { class: 'flist' }, d.fields.map(f => h('div', { class: 'fitem' + (f.id === sel ? ' on' : ''), onclick: () => { sel = f.id; if (f.page !== pageNo) { pageNo = f.page; redraw().catch(fail); } side(); markers(); } },
      h('b', {}, f.label), PRE_SHORT[f.prefill] && h('span', { class: 'tag' }, PRE_SHORT[f.prefill]), h('span', { class: 'muted small' }, 'p' + f.page))))
      : h('p', { class: 'empty small' }, 'No fields yet. Double-click on the page where the text should go, or use "Add field".'));
  }
  function side() {
    flist();
    const f = field();
    if (!f) { propsBox.replaceChildren(); return; }
    const bind = (el, prop, conv, after) => { el.addEventListener('input', () => { f[prop] = conv ? conv(el) : el.value; mark(); later(); if (after) after(); }); return el; };
    const numIn = (prop, step, min) => bind(h('input', { type: 'number', step, min, value: f[prop] }), prop, el => el.value === '' ? 0 : +el.value, markers);
    const keyIn = bind(h('input', { type: 'text', value: f.key }), 'key', el => keyOf(el.value));
    const labelIn = h('input', { type: 'text', value: f.label });
    labelIn.addEventListener('input', () => { const auto = f.key === keyOf(f.label); f.label = labelIn.value; if (auto) { f.key = keyOf(f.label); keyIn.value = f.key; } mark(); later(); flist(); });
    const sel2 = (prop, opts) => { const s = h('select', {}, Object.entries(opts).map(([v, t]) => h('option', { value: v, selected: f[prop] === v }, t))); s.addEventListener('change', () => { f[prop] = s.value; mark(); side(); redraw().catch(fail); }); return s; };
    propsBox.replaceChildren(h('h2', {}, 'Selected field'), h('div', { class: 'panel' },
      h('label', { style: 'margin-top:0' }, 'Label (shown on the form)'), labelIn,
      h('div', { class: 'g2' }, h('div', {}, h('label', {}, 'Type'), sel2('type', TYPES)), h('div', {}, h('label', {}, 'Key (for links)'), keyIn)),
      f.type === 'date' && h('div', {}, h('label', {}, 'Date format'), sel2('dateFormat', Object.fromEntries(DATEFMT.map(x => [x, x])))),
      h('div', { class: 'g4' }, h('div', {}, h('label', {}, 'Page'), numIn('page', 1, 1)), h('div', {}, h('label', {}, 'X (pt)'), numIn('x', 0.5)), h('div', {}, h('label', {}, 'Y (pt)'), numIn('y', 0.5)), h('div', {}, h('label', {}, 'Size'), numIn('size', 0.5, 4))),
      f.type !== 'checkbox' && h('div', {}, h('label', {}, 'Wrap width in pt (0 = no wrapping)'), numIn('maxWidth', 5, 0)),
      h('label', {}, 'Prefill'), sel2('prefill', PRE),
      f.prefill === 'instance' && h('div', {}, h('label', {}, 'Fixed value'), f.type === 'textarea' ? bind(h('textarea', { rows: 2, value: f.value }), 'value') : bind(h('input', { type: 'text', value: f.value, placeholder: f.type === 'date' ? 'YYYY-MM-DD' : f.type === 'checkbox' ? '1 = ticked' : '' }), 'value')),
      f.prefill === 'browser' && h('div', { class: 'hint' }, 'Each user types it once; their browser remembers it for every document that has a field with this key.'),
      f.prefill === 'url' && h('div', { class: 'hint' }, 'Filled from the link, e.g. ' + linkOf(d) + '#' + f.key + '=value. Users get a "Copy link with values" button.'),
      h('label', { class: 'chk', style: 'margin-top:12px' }, bind(h('input', { type: 'checkbox', checked: f.required }), 'required', el => el.checked), 'Required'),
      h('div', { style: 'margin-top:12px' }, h('button', { class: 'danger', onclick: () => { d.fields = d.fields.filter(x => x !== f); sel = null; mark(); side(); redraw().catch(fail); } }, 'Remove field'))));
  }

  app.append(
    h('div', { class: 'row', style: 'margin-bottom:12px' }, h('a', { href: '#', class: 'muted' }, '← Documents'), h('span', { class: 'grow' }),
      h('a', { class: 'btn', target: '_blank', href: '/d/' + d.slug }, 'Open form'), saveBtn),
    h('div', { class: 'editor' },
      h('div', {}, h('div', { class: 'row', style: 'margin-bottom:8px' },
        h('button', { onclick: () => { if (pageNo > 1) { pageNo--; redraw().catch(fail); } } }, '‹'), pageLbl, h('button', { onclick: () => { if (pageNo < d.pages) { pageNo++; redraw().catch(fail); } } }, '›'),
        h('span', { class: 'grow' }), h('span', { class: 'muted small' }, 'Double-click the page to add a field · drag to move'),
        h('button', { onclick: () => { const c = vp ? vp.convertToPdfPoint(vp.width / 2, vp.height / 3) : [72, 700]; addField(c[0], c[1]); } }, 'Add field')), stage),
      h('div', {},
        h('div', { class: 'panel' }, h('label', { style: 'margin-top:0' }, 'Title'), title, h('label', {}, 'Description'), desc, h('label', {}, 'Tags (comma-separated)'), tags,
          h('label', { class: 'chk', style: 'margin-top:12px' }, listed, 'Show in the public document list'),
          h('label', {}, 'Direct link'), h('div', { class: 'row' }, h('div', { class: 'grow' }, link), h('button', { onclick: () => copyText(link.value) }, 'Copy')),
          h('div', { class: 'row', style: 'margin-top:12px' },
            h('button', { class: 'small', onclick: () => repl.click() }, 'Replace PDF'), repl,
            h('button', { class: 'small', onclick: async () => { if (!confirm('Create a new link? The current link stops working.')) return; try { const r = await api('POST', '/api/admin/docs/' + id + '/link'); d.slug = r.slug; link.value = linkOf(d); side(); toast('New link created'); } catch (e) { fail(e); } } }, 'New link'),
            h('button', { class: 'small danger', onclick: async () => { if (!confirm('Delete "' + d.title + '" and its PDF?')) return; try { await api('DELETE', '/api/admin/docs/' + id); dirty = false; location.hash = ''; } catch (e) { fail(e); } } }, 'Delete'))),
        h('h2', {}, 'Fields'), fieldsBox, propsBox)));
  side(); await redraw();
  window.addEventListener('resize', later);
}
boot();
`);
