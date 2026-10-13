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
 *
 * Field types: text, textarea, date, checkbox, image (PNG/JPEG chosen by the user or a default set by
 * the admin; remembered per browser when prefill is "browser", e.g. for signatures) and static (fixed text).
 */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
let fontkit = null; try { fontkit = require('@pdf-lib/fontkit'); } catch (e) { /* optional */ }

const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DATA = path.resolve(process.env.DATA_DIR || './data');
const PDFS = path.join(DATA, 'pdfs');
const IMAGES = path.join(DATA, 'images'); // default images of image fields (signatures, stamps)
const DBF = path.join(DATA, 'db.json');
const FONT = path.join(DATA, 'font.ttf');
const MAX_PDF = (+process.env.MAX_PDF_MB || 25) * 1024 * 1024;
const PDFJS = path.dirname(require.resolve('pdfjs-dist/package.json'));
const SESSION_MS = 12 * 3600 * 1000; // admin sessions: 12 h, renewed on use
const UNLOCK_MS = 12 * 3600 * 1000; // document unlocks
const readSecretFile = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { console.error('stampfill: cannot read ' + p + ' (' + e.code + ')'); process.exit(1); } };
const ADMIN_PW = process.env.ADMIN_PASSWORD_FILE ? readSecretFile(process.env.ADMIN_PASSWORD_FILE) : process.env.ADMIN_PASSWORD || '';
const VERSION = require('./package.json').version;

// ---------------------------------------------------------------- storage
try {
  fs.mkdirSync(PDFS, { recursive: true, mode: 0o700 }); fs.mkdirSync(IMAGES, { recursive: true, mode: 0o700 });
  fs.accessSync(DATA, fs.constants.W_OK); fs.accessSync(PDFS, fs.constants.W_OK);
  for (const p of [DATA, PDFS, IMAGES]) { try { fs.chmodSync(p, 0o700); } catch (e) { /* not supported here */ } } // the data directory holds secrets and personal templates
}
catch (e) {
  const who = process.getuid ? 'uid ' + process.getuid() + ' / gid ' + process.getgid() : 'this user';
  console.error('stampfill: the data directory ' + DATA + ' is not writable by ' + who + ' (' + e.code + ').\n' +
    '  Bind mount: make the host folder writable, e.g. "chown 1000:1000 ./data", or run the container with the folder owner\'s ids (PUID/PGID in .env).\n' +
    '  Named volume: keep the default user (1000:1000) or recreate the volume after changing it.');
  process.exit(1);
}
const rid = (n = 9) => crypto.randomBytes(n).toString('base64url');
const DEFAULTS = { siteTitle: 'Forms', printerUrl: '', publicPrint: false, printButton: 'Print at home' };
let db = { secret: rid(32), auth: null, settings: { ...DEFAULTS }, docs: [] };
if (fs.existsSync(DBF)) { const l = JSON.parse(fs.readFileSync(DBF, 'utf8')); db = Object.assign(db, l, { settings: { ...DEFAULTS, ...(l.settings || {}) } }); }
const save = () => { fs.writeFileSync(DBF + '.tmp', JSON.stringify(db, null, 1), { mode: 0o600 }); fs.renameSync(DBF + '.tmp', DBF); };
const AUDIT = path.join(DATA, 'audit.log'); // append-only record of admin actions and print jobs; never contains form values
function audit(req, event, detail) {
  try { fs.appendFileSync(AUDIT, JSON.stringify({ t: new Date().toISOString(), ip: req ? clientIp(req) : null, event, ...detail }) + '\n', { mode: 0o600 }); } catch (e) { console.error('audit log: ' + e.message); }
}
const pdfPath = (id) => path.join(PDFS, id + '.pdf');

// ---------------------------------------------------------------- auth
const hashPw = (pw, salt = rid(16)) => salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
const hashPwAsync = (pw, salt = rid(16)) => new Promise((ok, no) => crypto.scrypt(pw, salt, 32, (e, k) => (e ? no(e) : ok(salt + ':' + k.toString('hex')))));
const sameStr = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const ENV_AUTH = ADMIN_PW ? hashPw(ADMIN_PW) : null; // hashed once at startup, never re-derived per attempt
async function checkPw(pw) { // off the event loop: scrypt runs in the thread pool
  if (typeof pw !== 'string') return false;
  const stored = ENV_AUTH || db.auth; if (!stored) return false;
  return sameStr(await hashPwAsync(pw, stored.split(':')[0]), stored);
}
if (!ADMIN_PW && !db.auth) {
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
const secure = (req) => process.env.SECURE_COOKIES === '1' || req.headers['x-forwarded-proto'] === 'https';
const cookie = (req, val, maxAge) => 'sf_s=' + val + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + (secure(req) ? '; Secure' : '');
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((c) => c.length === 2));
// per-form password: the unlock cookie is bound to the document and its current password hash
const docSign = (doc, exp) => crypto.createHmac('sha256', db.secret).update('doc.' + doc.id + '.' + doc.password + '.' + exp).digest('base64url');
function hasAccess(doc, req) {
  if (!doc.password || isAdmin(req)) return true;
  const m = /^(\d+)\.([\w-]+)$/.exec(cookies(req)['sf_u_' + doc.id] || '');
  return !!m && +m[1] > Date.now() && sameStr(m[2], docSign(doc, m[1]));
}
const authFails = []; // timestamps of failed login/unlock attempts from every client: a server-wide brake that address spoofing cannot bypass
function checkFails(req) {
  const now = Date.now(); while (authFails.length && authFails[0] < now - 5 * 60000) authFails.shift();
  if (authFails.length >= 50) throw new HttpErr(429, 'Too many failed attempts on this server — try again in a few minutes');
  const f = fails.get(clientIp(req)); if (f && f.until > now) throw new HttpErr(429, 'Too many attempts — try again in a few minutes');
}
async function noteFail(req) {
  authFails.push(Date.now());
  pruneFails(); const ip = clientIp(req), f = fails.get(ip), n = (f ? f.n : 0) + 1;
  fails.set(ip, { n, until: n >= 5 ? Date.now() + 5 * 60000 : 0, at: Date.now() });
  await new Promise((r) => setTimeout(r, 400));
}
const fails = new Map(); // ip -> { n, until, at }
function pruneFails() { // keep the map bounded: drop entries whose block expired and that are older than the block window
  if (fails.size < 1000) return;
  const cut = Date.now() - 5 * 60000;
  for (const [ip, f] of fails) if (f.until < Date.now() && f.at < cut) fails.delete(ip);
}
// behind one trusted proxy the client is the LAST X-Forwarded-For entry: that is the one the proxy appended; earlier ones are whatever the client sent
const clientIp = (req) => (process.env.TRUST_PROXY === '1' && (req.headers['x-forwarded-for'] || '').split(',').pop().trim()) || req.socket.remoteAddress;
const buckets = new Map(); // "what:ip" -> { n, reset }: simple fixed-window limits for the public endpoints
function rateLimit(req, what, max, windowMs = 60000) {
  const key = what + ':' + clientIp(req), now = Date.now(); let b = buckets.get(key);
  if (!b || b.reset < now) { if (buckets.size > 5000) for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k); b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  if (++b.n > max) throw new HttpErr(429, 'Too many requests — please slow down a little');
}
const render = { n: 0, q: [] }; // at most a few renders at once; a short queue, then 503
async function withRender(fn) {
  if (render.n >= 4) { if (render.q.length >= 16) throw new HttpErr(503, 'The server is busy — please try again in a moment'); await new Promise((ok) => render.q.push(ok)); }
  render.n++;
  try { return await fn(); } finally { render.n--; const next = render.q.shift(); if (next) next(); }
}

// ---------------------------------------------------------------- helpers
class HttpErr extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const SEC = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': csp("'self' 'wasm-unsafe-eval'"),
};
function csp(scriptSrc) { // pages add the hash of their inline script; nothing else may run inline
  return "default-src 'self'; connect-src 'self' blob:; script-src " + scriptSrc + "; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; font-src 'self' data: blob:; worker-src 'self' blob:; frame-src blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
}
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
    req.on('data', (c) => { n += c.length; if (n > limit) { no(new HttpErr(413, 'Request too large')); req.pause(); /* the 413 goes out first; Node discards the rest of the body */ } else chunks.push(c); });
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
const TYPES = ['text', 'textarea', 'date', 'checkbox', 'image', 'signature', 'static']; // static: fixed text set by the admin, not editable
const IMG = (t) => t === 'image' || t === 'signature'; // both hold a picture; a signature can also be drawn on screen
const PREFILL = ['none', 'browser', 'instance', 'url', 'today']; // today: date fields only; url: not for images
function cleanPrefill(type, p) {
  if (!PREFILL.includes(p) || type === 'static') return 'none';
  if (p === 'today' && type !== 'date') return 'none';
  if (p === 'url' && IMG(type)) return 'none';
  return p;
}
const IMG_NAME = /^[\w-]+\.(png|jpg)$/;
const imgType = (b) => b.length > 4 && b[0] === 0x89 && b[1] === 0x50 ? 'png' : b.length > 3 && b[0] === 0xff && b[1] === 0xd8 ? 'jpg' : null;
function imgDims(b) { // [width, height] from the PNG IHDR or the first JPEG SOF marker, without decoding anything
  if (imgType(b) === 'png') return b.length >= 24 ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null;
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) return null;
    const mk = b[o + 1], len = b.readUInt16BE(o + 2);
    if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return [b.readUInt16BE(o + 7), b.readUInt16BE(o + 5)];
    o += 2 + len;
  }
  return null;
}
const MAX_PIXELS = 16e6;
function checkImage(b) { // a decompression bomb declares huge dimensions in a tiny file; refuse before pdf-lib inflates it
  const d = imgDims(b);
  if (!d || !d[0] || !d[1] || d[0] > 20000 || d[1] > 20000 || d[0] * d[1] > MAX_PIXELS) throw new HttpErr(400, 'Image unreadable or too large (at most 16 megapixels)');
  return b;
}
function imageFromValue(f, v) { // the image sent with the form wins, else the admin's default image
  if (typeof v === 'string' && v.startsWith('data:image/')) { const b = Buffer.from(v.slice(v.indexOf(',') + 1), 'base64'); if (imgType(b)) return checkImage(b); }
  if (f.prefill === 'instance' && f.value && fs.existsSync(path.join(IMAGES, f.value))) return fs.readFileSync(path.join(IMAGES, f.value));
  return null;
}
function pruneImages() { // drop files no field refers to any more
  const used = new Set(db.docs.flatMap((d) => d.fields.filter((f) => IMG(f.type) && f.value).map((f) => f.value)));
  for (const n of fs.readdirSync(IMAGES)) if (!used.has(n)) fs.rmSync(path.join(IMAGES, n), { force: true });
}
const DATEFMT = ['DD.MM.YYYY', 'YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY'];
// accepts YYYY-MM-DD, the field's own display format, and D.M.YYYY / D/M/YYYY variants; returns ISO or the input unchanged
function toIso(v, fmt) {
  v = String(v == null ? '' : v).trim(); if (!v || /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = /^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})$/.exec(v); if (!m) return v;
  let y, mo, d;
  if (m[1].length === 4) { y = m[1]; mo = m[2]; d = m[3]; }
  else if (fmt === 'MM/DD/YYYY') { mo = m[1]; d = m[2]; y = m[3]; }
  else { d = m[1]; mo = m[2]; y = m[3]; }
  if (y.length === 2) y = (+y < 50 ? '20' : '19') + y;
  if (y.length !== 4 || +mo < 1 || +mo > 12 || +d < 1 || +d > 31) return v;
  return y + '-' + mo.padStart(2, '0') + '-' + d.padStart(2, '0');
}
const slugOf = (s) => str(s, 80).toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const keyOf = (s) => str(s, 60).toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'field';
function cleanFields(list, pages) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).filter((f) => f && typeof f === 'object').slice(0, 200).map((f) => {
    let key = keyOf(f.key || f.label), base = key, i = 2;
    while (seen.has(key)) key = base + '_' + i++;
    seen.add(key);
    const type = TYPES.includes(f.type) ? f.type : 'text';
    const prefill = cleanPrefill(type, f.prefill);
    const dateFormat = DATEFMT.includes(f.dateFormat) ? f.dateFormat : DATEFMT[0];
    return {
      id: typeof f.id === 'string' && /^[\w-]{4,24}$/.test(f.id) ? f.id : rid(6), key, label: str(f.label, 100) || key,
      type, hidden: type !== 'static' && !!f.hidden, required: type !== 'static' && !f.hidden && !!f.required,
      page: Math.round(num(f.page, 1, 1, pages)), x: +num(f.x, 50, -5000, 5000).toFixed(1), y: +num(f.y, 50, -5000, 5000).toFixed(1),
      size: num(f.size, 11, 4, 72), maxWidth: IMG(type) ? (num(f.maxWidth, 0, 0, 5000) > 0 ? num(f.maxWidth, 0, 5, 5000) : type === 'signature' ? 160 : 120) : num(f.maxWidth, 0, 0, 5000), // images: always an explicit width, at least 5 pt
      height: num(f.height, 0, 0, 5000), // images only: 0 = follows the image, otherwise the image fits into width x height
      dateFormat, prefill, value: type === 'date' ? toIso(str(f.value, 40), dateFormat) : IMG(type) ? (IMG_NAME.test(f.value) ? f.value : '') : str(f.value, 2000),
    };
  });
}
// per-page rotation in degrees (any angle, e.g. to straighten a skewed scan), applied when rendering
const cleanRotation = (r, pages) => Array.from({ length: pages }, (_, i) => Math.round(num(Array.isArray(r) ? r[i] : 0, 0, -180, 180) * 10) / 10 || 0);
async function applyRotation(pdf, rotation) {
  for (let i = 0; i < pdf.getPageCount(); i++) {
    const angle = rotation[i]; if (!angle) continue;
    const page = pdf.getPage(i), { width: W, height: H } = page.getSize(), total = angle + page.getRotation().angle;
    const swap = Math.abs(((total % 180) + 180) % 180 - 90) < 1e-9, nw = swap ? H : W, nh = swap ? W : H, t = total * Math.PI / 180;
    const emb = await pdf.embedPage(page); // the old page becomes a form XObject drawn rotated around the centre of a fresh page
    const fresh = pdf.insertPage(i, [nw, nh]);
    fresh.drawPage(emb, { x: nw / 2 - (W / 2) * Math.cos(t) + (H / 2) * Math.sin(t), y: nh / 2 - (W / 2) * Math.sin(t) - (H / 2) * Math.cos(t), width: W, height: H, rotate: degrees(total) });
    pdf.removePage(i + 1);
  }
}
const cleanTags = (t) => [...new Set((Array.isArray(t) ? t : []).map((x) => str(x, 30).trim()).filter(Boolean))].slice(0, 20);
const adminDoc = (d) => ({ ...d, password: undefined, protected: !!d.password });
const publicDoc = (d, req) => ({
  title: d.title, description: d.description, tags: d.tags, siteTitle: db.settings.siteTitle,
  serverPrint: !!db.settings.printerUrl && d.serverPrint !== false && (db.settings.publicPrint || isAdmin(req)), printLabel: db.settings.printButton,
  fields: d.fields.filter((f) => f.type !== 'static').map((f) => ({ key: f.key, label: f.label, type: f.type, required: f.required, hidden: f.hidden, prefill: f.prefill, value: f.prefill === 'instance' ? f.value : '' })),
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
async function renderPdf(doc, fields, values, rotation = doc.rotation, preview = false) {
  const pdf = await PDFDocument.load(readTemplate(doc.id));
  if (rotation && rotation.some(Boolean)) await applyRotation(pdf, rotation);
  let font;
  if (fontkit && fs.existsSync(FONT)) { pdf.registerFontkit(fontkit); font = await pdf.embedFont(fs.readFileSync(FONT), { subset: true }); }
  else font = await pdf.embedFont(StandardFonts.Helvetica);
  const ok = new Map();
  const encodable = (ch) => { if (!ok.has(ch)) { try { font.encodeText(ch); ok.set(ch, true); } catch (e) { ok.set(ch, false); } } return ok.get(ch); };
  const pages = pdf.getPages();
  for (const f of fields) {
    const page = pages[f.page - 1]; if (!page) continue;
    if (IMG(f.type)) {
      const w = f.maxWidth > 0 ? f.maxWidth : 120, rot = degrees(page.getRotation().angle);
      const buf = imageFromValue(f, f.hidden && f.prefill === 'instance' ? '' : values[f.key]); // a hidden fixed image cannot be swapped by the request
      if (!buf) { // the editor preview shows where a user-supplied image will land and how large it prints
        if (preview) {
          const ph = f.height > 0 ? f.height : w * 0.5;
          page.drawRectangle({ x: f.x, y: f.y, width: w, height: ph, borderColor: rgb(0.55, 0.55, 0.6), borderWidth: 0.75, borderDashArray: [3, 3], color: rgb(0.94, 0.94, 0.96), rotate: rot });
          page.drawText(f.label, { x: f.x + 3, y: f.y + 3, size: Math.min(8, ph * 0.6), font, color: rgb(0.45, 0.45, 0.5), rotate: rot });
        }
        continue;
      }
      let img; try { img = imgType(buf) === 'png' ? await pdf.embedPng(buf) : await pdf.embedJpg(buf); } catch (e) { throw new HttpErr(400, 'The image for "' + f.label + '" could not be read'); }
      let dw = w, dh = w * img.height / img.width;
      if (f.height > 0 && dh > f.height) { dh = f.height; dw = f.height * img.width / img.height; } // fit inside width x height, keep the aspect ratio
      page.drawImage(img, { x: f.x, y: f.y, width: dw, height: dh, rotate: rot });
      continue;
    }
    let text = f.type === 'static' || (f.hidden && f.prefill === 'instance') ? f.value : str(values[f.key], 4000); // fixed text and hidden fixed values ignore whatever the request sent
    if (f.type === 'checkbox') text = text && text !== '0' && text !== 'false' ? 'X' : '';
    else if (f.type === 'date') text = fmtDate(toIso(text, f.dateFormat), f.dateFormat);
    else if (f.type !== 'textarea' && f.type !== 'static') text = text.replace(/\s+/g, ' ');
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
  [f.key, f.type === 'checkbox' ? '1' : f.type === 'date' ? (f.prefill === 'instance' && f.value) || new Date().toISOString().slice(0, 10) : f.value || (f.type === 'static' ? '' : f.label)]));
function cleanValues(v) {
  const out = Object.create(null); // no prototype: a field key such as "constructor" must not find anything
  if (v && typeof v === 'object') for (const k of Object.keys(v).slice(0, 300)) out[k] = typeof v[k] === 'string' && v[k].startsWith('data:image/') ? v[k].slice(0, 3e6) : str(v[k], 4000);
  return out;
}
const pdfCache = new Map(); // template bytes by document id; invalidated on upload, replace and delete
function readTemplate(id) { let b = pdfCache.get(id); if (!b) { b = fs.readFileSync(pdfPath(id)); pdfCache.set(id, b); } return b; }

// ---------------------------------------------------------------- printing (IPP, RFC 8011)
// A tiny IPP client: Print-Job for documents, Get-Printer-Attributes to diagnose a printer. Printers that
// do not accept application/pdf (many home printers only take raster formats) need a CUPS queue in between.
const IPP_STATUS = {
  0x0400: 'bad request', 0x0401: 'forbidden', 0x0402: 'not authenticated', 0x0403: 'not authorized', 0x0404: 'not possible', 0x0405: 'timeout',
  0x0406: 'not found — check the path of the printer URL', 0x0407: 'gone', 0x0408: 'request too large', 0x0409: 'request value too long',
  0x040a: 'document format not supported — this printer does not accept PDF over IPP; print through a CUPS queue (see README)',
  0x040b: 'attributes or values not supported', 0x040c: 'URI scheme not supported', 0x040d: 'charset not supported', 0x040e: 'conflicting attributes',
  0x0500: 'internal printer error', 0x0501: 'operation not supported', 0x0502: 'service unavailable', 0x0503: 'IPP version not supported',
  0x0504: 'device error', 0x0505: 'temporary error', 0x0506: 'the printer is not accepting jobs', 0x0507: 'the printer is busy', 0x0508: 'job canceled',
};
const ippStatusText = (st) => 'IPP 0x' + st.toString(16).padStart(4, '0') + (IPP_STATUS[st] ? ': ' + IPP_STATUS[st] : '');
function ippAttr(tag, name, value) {
  const n = Buffer.from(name), v = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  const h = Buffer.alloc(3); h.writeUInt8(tag, 0); h.writeUInt16BE(n.length, 1);
  const l = Buffer.alloc(2); l.writeUInt16BE(v.length, 0);
  return Buffer.concat([h, n, l, v]);
}
const ippInt = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n, 0); return b; };
// parses an IPP response into { status, attrs: { name: [values] } }; additional values of a 1setOf attribute carry an empty name
function ippParse(b) {
  const r = { status: b.readUInt16BE(2), attrs: {} }; let o = 8, last = null;
  while (o + 3 <= b.length) {
    const tag = b[o]; if (tag === 0x03) break;
    if (tag < 0x10) { o++; last = null; continue; } // begin-attribute-group tag
    const nl = b.readUInt16BE(o + 1), name = b.toString('utf8', o + 3, o + 3 + nl); o += 3 + nl;
    const vl = b.readUInt16BE(o), v = b.subarray(o + 2, o + 2 + vl); o += 2 + vl;
    const key = name || last; if (!key) continue;
    const val = (tag === 0x21 || tag === 0x23) && vl === 4 ? v.readInt32BE(0) : tag === 0x22 ? !!v[0] : v.toString('utf8');
    (r.attrs[key] = r.attrs[key] || []).push(val); last = key;
  }
  return r;
}
async function ippSend(url, op, opAttrs, jobAttrs, doc) {
  const body = Buffer.concat([
    Buffer.from([0x02, 0x00]), Buffer.from([op >> 8, op & 0xff]), ippInt(1), Buffer.from([0x01]),
    ippAttr(0x47, 'attributes-charset', 'utf-8'), ippAttr(0x48, 'attributes-natural-language', 'en'), ippAttr(0x45, 'printer-uri', url.replace(/^http/, 'ipp')),
    ...opAttrs, ...(jobAttrs.length ? [Buffer.from([0x02]), ...jobAttrs] : []), Buffer.from([0x03]), doc || Buffer.alloc(0),
  ]);
  let r;
  try { r = await fetch(url.replace(/^ipp/, 'http'), { method: 'POST', headers: { 'Content-Type': 'application/ipp' }, body, redirect: 'error', signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw new HttpErr(502, 'Printer not reachable at ' + url.replace(/^ipp/, 'http') + ' — check the address and that port 631 is open'); }
  const chunks = []; let n = 0; // an IPP answer is a few hundred bytes; never buffer whatever a wrong endpoint sends
  if (r.body) for await (const c of r.body) { n += c.length; if (n > 1024 * 1024) throw new HttpErr(502, 'Printer answer too large — is this really an IPP endpoint?'); chunks.push(c); }
  const b = Buffer.concat(chunks);
  if (!r.ok || b.length < 8) throw new HttpErr(502, 'Printer answered HTTP ' + r.status + ' instead of IPP — is this the IPP endpoint (e.g. ipp://printer:631/ipp/print or http://cups:631/printers/NAME)?');
  return ippParse(b);
}
async function ippPrint(pdfBuf, copies, jobName) {
  const url = db.settings.printerUrl; if (!url) throw new HttpErr(400, 'No printer is configured');
  const res = await ippSend(url, 0x0002, [ippAttr(0x42, 'requesting-user-name', 'stampfill'), ippAttr(0x42, 'job-name', jobName.slice(0, 200)), ippAttr(0x49, 'document-format', 'application/pdf')],
    [ippAttr(0x21, 'copies', ippInt(copies))], pdfBuf);
  if (res.status > 0xff) throw new HttpErr(502, 'Printer rejected the job (' + ippStatusText(res.status) + ')');
  const id = res.attrs['job-id'];
  return { ok: true, jobId: id && typeof id[0] === 'number' ? id[0] : null };
}
// Get-Printer-Attributes: what the printer is and which document formats it accepts
async function ippProbe(url) {
  const want = ['printer-name', 'printer-make-and-model', 'printer-state', 'printer-state-reasons', 'document-format-supported'];
  const res = await ippSend(url, 0x000b, [ippAttr(0x44, 'requested-attributes', want[0]), ...want.slice(1).map((w) => ippAttr(0x44, '', w))], [], null);
  if (res.status > 0xff) throw new HttpErr(502, 'Printer refused the query (' + ippStatusText(res.status) + ')');
  const a = res.attrs, first = (k) => (a[k] && a[k][0] != null ? String(a[k][0]) : '');
  const formats = (a['document-format-supported'] || []).map(String), state = { 3: 'idle', 4: 'printing', 5: 'stopped' }[first('printer-state')] || 'unknown';
  return { name: first('printer-name'), model: first('printer-make-and-model'), state, reasons: (a['printer-state-reasons'] || []).map(String).filter((x) => x !== 'none'), formats, pdf: formats.includes('application/pdf') };
}

// ---------------------------------------------------------------- static vendor files (pdf.js)
const MIME = { '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg' };
const sendImage = (res, name) => send(res, 200, fs.readFileSync(path.join(IMAGES, name)), MIME[path.extname(name)], { 'Cache-Control': 'private, max-age=3600' });
function vendor(req, res, name) {
  let file = null;
  if (name === 'pdf.mjs') file = 'legacy/build/pdf.min.mjs';
  else if (name === 'pdf.worker.mjs') file = 'legacy/build/pdf.worker.min.mjs';
  else if (/^(standard_fonts|cmaps|wasm|iccs)\/[\w.-]+$/.test(name) && !name.includes('..')) file = name;
  const full = file && path.join(PDFJS, file);
  if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) return send(res, 404, 'Not found', 'text/plain');
  sendStatic(req, res, full, fs.readFileSync(full), MIME[path.extname(full)] || 'application/octet-stream', { 'Cache-Control': 'public, max-age=604800, immutable' });
}

// ---------------------------------------------------------------- routes
async function route(req, res) {
  const url = new URL(req.url, 'http://x'), p = url.pathname, m = req.method;
  let a;
  if (secure(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (m === 'GET') {
    if (p === '/' || /^\/d\/[\w-]+$/.test(p)) return sendStatic(req, res, 'public', PUBLIC_HTML.html, 'text/html; charset=utf-8', { 'Content-Security-Policy': PUBLIC_HTML.csp });
    if (p === '/admin' || p === '/admin/') return sendStatic(req, res, 'admin', ADMIN_HTML.html, 'text/html; charset=utf-8', { 'Content-Security-Policy': ADMIN_HTML.csp });
    if (p === '/healthz') return json(res, 200, isAdmin(req) ? { ok: true, version: VERSION, docs: db.docs.length } : { ok: true });
    if (p.startsWith('/vendor/')) return vendor(req, res, p.slice(8));
  } else if (req.headers['x-requested-with'] !== 'stampfill') throw new HttpErr(403, 'Forbidden'); // CSRF guard

  // ---- public API
  if (m === 'GET' && p === '/api/docs')
    return json(res, 200, { title: db.settings.siteTitle, docs: db.docs.filter((d) => d.listed).map((d) => ({ slug: d.slug, title: d.title, description: d.description, tags: d.tags, protected: !!d.password })) });
  if (m === 'GET' && (a = /^\/api\/d\/([\w-]+)\/image\/([\w-]+)$/.exec(p))) { // default image of an image field
    const doc = db.docs.find((d) => d.slug === a[1]), f = doc && doc.fields.find((x) => x.key === a[2]);
    if (!f || !IMG(f.type) || f.prefill !== 'instance' || !f.value || !fs.existsSync(path.join(IMAGES, f.value))) throw new HttpErr(404, 'No image');
    if (!hasAccess(doc, req)) throw new HttpErr(401, 'Password required');
    return sendImage(res, f.value);
  }
  if ((a = /^\/api\/d\/([\w-]+)(\/render|\/print|\/unlock)?$/.exec(p))) {
    const doc = db.docs.find((d) => d.slug === a[1]); if (!doc) throw new HttpErr(404, 'Document not found');
    if (a[2] === '/unlock' && m === 'POST') {
      rateLimit(req, 'auth', 20); checkFails(req);
      const body = await readJson(req, 1e4);
      if (!doc.password || typeof body.password !== 'string' || !sameStr(await hashPwAsync(body.password, doc.password.split(':')[0]), doc.password)) { await noteFail(req); audit(req, 'unlock.fail', { doc: doc.id }); throw new HttpErr(401, 'Wrong password'); }
      fails.delete(clientIp(req));
      const exp = Date.now() + UNLOCK_MS;
      return json(res, 200, { ok: true }, { 'Set-Cookie': 'sf_u_' + doc.id + '=' + exp + '.' + docSign(doc, exp) + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + UNLOCK_MS / 1000 + (secure(req) ? '; Secure' : '') });
    }
    if (!hasAccess(doc, req)) throw new HttpErr(401, 'Password required');
    if (m === 'GET' && !a[2]) return json(res, 200, publicDoc(doc, req));
    if (m === 'POST' && a[2]) {
      const admin = isAdmin(req);
      if (!admin) rateLimit(req, a[2] === '/print' ? 'print' : 'render', a[2] === '/print' ? 10 : 120);
      const body = await readJson(req, 4e6), values = cleanValues(body.values); // images travel as data URLs
      const pdf = await withRender(() => renderPdf(doc, doc.fields, values));
      if (a[2] === '/render') return send(res, 200, pdf, 'application/pdf');
      if (!publicDoc(doc, req).serverPrint) throw new HttpErr(403, 'Printing from the server is not enabled');
      const miss = doc.fields.find((f) => f.required && !f.hidden && !values[f.key] && !(IMG(f.type) && f.prefill === 'instance' && f.value)); if (miss) throw new HttpErr(400, 'Missing: ' + miss.label);
      const copies = Math.round(num(body.copies, 1, 1, admin ? 20 : 5));
      try {
        const r = await ippPrint(pdf, copies, doc.title); audit(req, 'print', { doc: doc.id, copies, jobId: r.jobId }); return json(res, 200, r);
      } catch (e) { // the admin sees what the printer said; everyone else gets no internal addresses
        audit(req, 'print.fail', { doc: doc.id, error: e.message }); console.error('print failed: ' + e.message);
        if (!admin && e instanceof HttpErr && e.status === 502) throw new HttpErr(502, 'The printer did not accept the job. Please try again later or ask the office.');
        throw e;
      }
    }
  }

  // ---- login
  if (m === 'POST' && p === '/api/login') {
    rateLimit(req, 'auth', 20); checkFails(req);
    const body = await readJson(req, 1e4);
    if (!(await checkPw(body.password))) { await noteFail(req); audit(req, 'login.fail', {}); throw new HttpErr(401, 'Wrong password'); }
    fails.delete(clientIp(req)); audit(req, 'login.ok', {});
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, newSession(), SESSION_MS / 1000) });
  }
  if (m === 'POST' && p === '/api/logout') return json(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, 'x', 0) });

  // ---- admin API
  if (!p.startsWith('/api/admin/')) throw new HttpErr(404, 'Not found');
  if (!isAdmin(req)) throw new HttpErr(401, 'Login required');
  if (m === 'GET' && p === '/api/admin/me') return json(res, 200, { ok: true, envPassword: !!ENV_AUTH }, { 'Set-Cookie': cookie(req, newSession(), SESSION_MS / 1000) }); // sliding session
  if (m === 'POST' && p === '/api/admin/sessions/revoke') { // "sign out everywhere": a new secret invalidates every session and unlock cookie
    db.secret = rid(32); save(); audit(req, 'sessions.revoke', {});
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, newSession(), SESSION_MS / 1000) });
  }
  if (m === 'POST' && p === '/api/admin/printer/test') { // diagnose a printer URL before saving it
    const u = str((await readJson(req, 1e4)).url, 500).trim();
    if (!/^(https?|ipps?):\/\/[^\s]+$/.test(u)) throw new HttpErr(400, 'Printer URL must start with http://, https://, ipp:// or ipps://');
    return json(res, 200, await ippProbe(u));
  }
  if (p === '/api/admin/settings') {
    if (m === 'PUT') {
      const b = await readJson(req), u = str(b.printerUrl, 500).trim();
      if (u && !/^(https?|ipps?):\/\/[^\s]+$/.test(u)) throw new HttpErr(400, 'Printer URL must start with http://, https://, ipp:// or ipps://');
      db.settings = { siteTitle: str(b.siteTitle, 60).trim() || 'Forms', printerUrl: u, publicPrint: !!b.publicPrint, printButton: str(b.printButton, 40).trim() || DEFAULTS.printButton }; save();
      audit(req, 'settings.update', { printerUrl: u, publicPrint: db.settings.publicPrint });
    }
    if (m === 'GET' || m === 'PUT') return json(res, 200, db.settings);
  }
  if (m === 'POST' && p === '/api/admin/password') {
    if (ENV_AUTH) throw new HttpErr(400, 'The password is set through ADMIN_PASSWORD and cannot be changed here');
    const b = await readJson(req, 1e4);
    if (!(await checkPw(b.current))) throw new HttpErr(403, 'Current password is wrong');
    if (str(b.next, 500).length < 8) throw new HttpErr(400, 'New password needs at least 8 characters');
    db.auth = await hashPwAsync(b.next); db.secret = rid(32); save(); audit(req, 'password.change', {}); // rotating the secret signs out all other sessions
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, newSession(), SESSION_MS / 1000) });
  }
  if (m === 'POST' && p === '/api/admin/images') { // default image for an image field; the field refers to it by name
    const buf = await readBody(req, 5 * 1024 * 1024), t = imgType(buf); if (!t) throw new HttpErr(400, 'Only PNG and JPEG images are supported');
    checkImage(buf);
    const name = rid(8) + '.' + t; fs.writeFileSync(path.join(IMAGES, name), buf, { mode: 0o600 });
    return json(res, 200, { name });
  }
  if (m === 'GET' && (a = /^\/api\/admin\/images\/([\w-]+\.(?:png|jpg))$/.exec(p))) {
    if (!fs.existsSync(path.join(IMAGES, a[1]))) throw new HttpErr(404, 'No image'); return sendImage(res, a[1]);
  }
  if (p === '/api/admin/docs') {
    if (m === 'GET') return json(res, 200, db.docs.map((d) => ({ id: d.id, slug: d.slug, title: d.title, tags: d.tags, listed: d.listed, protected: !!d.password, fields: d.fields.length, updated: d.updated })));
    if (m === 'POST') {
      const buf = await readBody(req, MAX_PDF), pages = await inspectPdf(buf);
      const title = str(url.searchParams.get('title'), 120).trim() || 'Untitled';
      const doc = { id: rid(8), slug: rid(10), title, description: '', tags: [], listed: false, serverPrint: true, password: null, pages, rotation: cleanRotation([], pages), fields: [], created: Date.now(), updated: Date.now() };
      fs.writeFileSync(pdfPath(doc.id), buf, { mode: 0o600 }); db.docs.unshift(doc); save(); audit(req, 'doc.create', { doc: doc.id, title });
      return json(res, 200, adminDoc(doc));
    }
  }
  if ((a = /^\/api\/admin\/docs\/([\w-]+)(\/pdf|\/render|\/link)?$/.exec(p))) {
    const doc = db.docs.find((d) => d.id === a[1]); if (!doc) throw new HttpErr(404, 'Document not found');
    if (!a[2]) {
      if (m === 'GET') return json(res, 200, adminDoc(doc));
      if (m === 'PUT') {
        const b = await readJson(req);
        if (b.slug !== undefined && b.slug !== doc.slug) { // the link name only changes when the admin edits it
          const s = slugOf(b.slug) || rid(10); // an empty name goes back to a random, unguessable link
          if (db.docs.some((x) => x !== doc && x.slug === s)) throw new HttpErr(400, 'That link name is already used by another document');
          doc.slug = s;
        }
        if (b.password !== undefined) { // '' removes the password, a string sets a new one, absent keeps it
          const pw = str(b.password, 200);
          if (pw && pw.length < 8) throw new HttpErr(400, 'The form password needs at least 8 characters');
          doc.password = pw ? await hashPwAsync(pw) : null; audit(req, pw ? 'doc.password.set' : 'doc.password.clear', { doc: doc.id });
        }
        Object.assign(doc, { title: str(b.title, 120).trim() || 'Untitled', description: str(b.description, 500).trim(), tags: cleanTags(b.tags), listed: !!b.listed, serverPrint: b.serverPrint !== false,
          rotation: b.rotation !== undefined ? cleanRotation(b.rotation, doc.pages) : doc.rotation, fields: cleanFields(b.fields, doc.pages), updated: Date.now() });
        save(); return json(res, 200, adminDoc(doc));
      }
      if (m === 'DELETE') {
        db.docs = db.docs.filter((d) => d !== doc); save(); fs.rmSync(pdfPath(doc.id), { force: true }); pdfCache.delete(doc.id); audit(req, 'doc.delete', { doc: doc.id, title: doc.title });
        for (const f of doc.fields) if (IMG(f.type) && f.value) fs.rmSync(path.join(IMAGES, f.value), { force: true });
        return json(res, 200, { ok: true });
      }
    }
    if (a[2] === '/pdf' && m === 'PUT') {
      const buf = await readBody(req, MAX_PDF); doc.pages = await inspectPdf(buf);
      fs.writeFileSync(pdfPath(doc.id), buf, { mode: 0o600 }); pdfCache.delete(doc.id); doc.rotation = cleanRotation([], doc.pages); doc.fields = cleanFields(doc.fields, doc.pages); doc.updated = Date.now(); save();
      return json(res, 200, adminDoc(doc));
    }
    if (a[2] === '/render' && m === 'POST') { // preview of unsaved field layout with sample values
      const b = await readJson(req), fields = cleanFields(b.fields, doc.pages);
      return send(res, 200, await withRender(() => renderPdf(doc, fields, b.values ? cleanValues(b.values) : sampleValues(fields), b.rotation !== undefined ? cleanRotation(b.rotation, doc.pages) : doc.rotation, true)), 'application/pdf');
    }
    if (a[2] === '/link' && m === 'POST') { doc.slug = rid(10); save(); return json(res, 200, adminDoc(doc)); }
  }
  throw new HttpErr(404, 'Not found');
}

// ---------------------------------------------------------------- migration of data written by earlier versions
// Runs once at startup, after every helper above exists. Keep it idempotent: it is the only place
// that upgrades db.json, and test/unit/migrate.test.js boots from a 1.0.0 data directory.
function migrate() {
  db.settings = { ...DEFAULTS, ...db.settings };
  for (const doc of db.docs) {
    doc.description = str(doc.description, 500); doc.tags = cleanTags(doc.tags); doc.listed = !!doc.listed;
    doc.pages = Math.max(1, Math.round(num(doc.pages, 1, 1, 10000)));
    doc.fields = cleanFields(doc.fields, doc.pages); doc.rotation = cleanRotation(doc.rotation, doc.pages);
    if (doc.serverPrint === undefined) doc.serverPrint = true; if (doc.password === undefined) doc.password = null;
  }
  pruneImages(); save();
}
migrate();

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (!(e instanceof HttpErr)) console.error(e);
    if (!res.headersSent) json(res, e.status || 500, { error: e instanceof HttpErr ? e.message : 'Internal error' }); else res.end();
  });
});
function start({ port = PORT, host = HOST } = {}) {
  server.requestTimeout = 60000; server.headersTimeout = 30000; // slow clients must not hold connections for long
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
module.exports = { start, server, db, DATA, IMAGES, IMG, migrate, fails, authFails, pruneFails, imgDims, checkImage, ippParse, ippProbe, ippStatusText, keyOf, slugOf, fmtDate, toIso, cleanPrefill, cleanRotation, imgType, cleanFields, cleanTags, cleanValues, sampleValues, renderPdf, ippPrint, checkPw, hashPw, inspectPdf };

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
.sigdlg{border:1px solid var(--line);border-radius:var(--r);padding:20px;background:var(--card);color:var(--ink);box-shadow:var(--sh2);max-width:calc(100vw - 32px)}
.sigdlg::backdrop{background:rgba(16,18,24,.45)}.sigdlg h2{margin:0 0 10px}
canvas.sig{display:block;background:#fff;border:1px dashed var(--line2);border-radius:8px;touch-action:none;cursor:crosshair;max-width:100%}
.imgbox{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.thumb{max-width:180px;max-height:90px;padding:4px;background:#fff;border:1px solid var(--line2);border-radius:6px}
.actions{margin-top:20px;padding-top:16px;border-top:1px solid var(--line)}
.empty{padding:36px 20px;text-align:center;color:var(--mut);border:1px dashed var(--line2);border-radius:var(--r)}.empty.small{padding:18px 14px}
.login{max-width:360px;margin:8vh auto 0;padding:28px}.login .logo{display:flex;width:46px;height:46px;align-items:center;justify-content:center;border-radius:12px;background:var(--acc-soft);color:var(--acc);margin-bottom:16px}.login .logo svg{width:26px;height:26px}.login h1{margin-bottom:2px}
table{width:100%;border-collapse:separate;border-spacing:0;background:var(--card);border:1px solid var(--line);border-radius:var(--r);overflow:hidden;box-shadow:var(--sh)}
th,td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--line);vertical-align:middle}th{font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);background:var(--bg)}
tr:last-child td{border-bottom:0}tbody tr{transition:background .12s}tbody tr:hover{background:var(--bg)}td a{color:var(--acc);text-decoration:none;font-weight:600}
.editor{display:grid;grid-template-columns:minmax(0,1fr) 380px;grid-template-areas:"stage doc" "stage fields";gap:22px;align-items:start}
.ed-doc{grid-area:doc}.ed-fields{grid-area:fields}.ed-fields>h2{margin-top:0}
.ed-stage{grid-area:stage;position:sticky;top:62px;max-height:calc(100vh - 74px);display:flex;flex-direction:column;min-width:0}.ed-stage>.stage{flex:1;min-height:0}
@media(min-width:1500px){.editor{grid-template-columns:300px minmax(0,1fr) 380px;grid-template-areas:"doc stage fields"}}
details.panel>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);user-select:none}
details.panel>summary::-webkit-details-marker{display:none}
details.panel>summary::before{content:'';width:0;height:0;border:5px solid transparent;border-left-color:var(--mut);margin-left:2px;transition:transform .15s}
details.panel[open]>summary::before{transform:rotate(90deg)}details.panel:not([open]){padding:12px 20px}
.stage{background:var(--paper);border:1px solid var(--line);border-radius:var(--r);padding:16px;overflow:auto}
.wrap{position:relative;margin:0 auto;background:#fff;border-radius:3px;box-shadow:0 2px 12px rgba(16,18,24,.18),0 0 0 1px rgba(16,18,24,.06);touch-action:none}
.wrap canvas{display:block;border-radius:3px}.ov{position:absolute;inset:0;cursor:crosshair}
.mk{position:absolute;border:1.5px dashed #2f6bff;background:rgba(47,107,255,.10);cursor:move;border-radius:3px;min-width:14px;transition:background .12s}.mk:hover{background:rgba(47,107,255,.18)}
.mk.on{border-style:solid;border-color:#e8590c;background:rgba(232,89,12,.14);z-index:2}
.mk span{position:absolute;left:-1.5px;bottom:100%;font-size:10px;font-weight:600;line-height:1.3;padding:1px 5px;background:#2f6bff;color:#fff;white-space:nowrap;border-radius:3px 3px 0 0}
.mk.on span{background:#e8590c}
.rz{position:absolute;right:-7px;width:12px;height:12px;background:#e8590c;border:2px solid #fff;border-radius:3px;box-shadow:0 0 0 1px #e8590c;z-index:3;touch-action:none}
.rz.br{bottom:-7px;cursor:nwse-resize}.rz.tr{top:-7px;cursor:nesw-resize}
.flist{border:1px solid var(--line);border-radius:var(--rs);overflow:hidden;background:var(--card)}
.fitem{display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--line);cursor:pointer;transition:background .12s}.fitem:hover{background:var(--bg)}
.fitem:last-child{border-bottom:0}.fitem.on{background:var(--acc-soft);box-shadow:inset 3px 0 0 var(--acc)}.fitem b{flex:1;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:0 10px}.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:0 8px}
#toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,12px);background:var(--ink);color:var(--bg);padding:10px 18px;border-radius:99px;opacity:0;transition:opacity .2s,transform .2s;pointer-events:none;z-index:9;max-width:90vw;box-shadow:var(--sh2);font-weight:500}
#toast.show{opacity:1;transform:translate(-50%,0)}#toast.bad{background:var(--bad);color:#fff}
#printArea{display:none}
@media(max-width:1000px){.editor{grid-template-columns:1fr;grid-template-areas:"doc" "stage" "fields"}.ed-stage{position:static;max-height:none}}
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
  if (body instanceof Blob) { o.body = body; o.headers['Content-Type'] = body.type || 'application/octet-stream'; }
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

function page(title, body, js) { // the inline script is a constant, so the CSP can name its hash instead of allowing inline scripts
  const script = LIB + js, hash = crypto.createHash('sha256').update(script).digest('base64');
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">' +
    '<link rel="modulepreload" href="/vendor/pdf.mjs"><link rel="preload" href="/vendor/pdf.worker.mjs" as="script" crossorigin>' +
    '<title>' + title + '</title><style>' + CSS + '</style><style id="pageStyle"></style></head><body>' + body +
    '<main id="app"></main><div id="printArea"></div><div id="toast"></div><script type="module">' + script + '</script></body></html>';
  return { html, csp: csp("'self' 'sha256-" + hash + "' 'wasm-unsafe-eval'") };
}

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
    list.replaceChildren(...shown.map(d => h('a', { class: 'card', href: '/d/' + d.slug }, h('b', {}, d.title), h('p', {}, d.description), h('div', {}, d.tags.map(t => h('span', { class: 'tag' }, t)), d.protected && h('span', { class: 'tag', title: 'Needs a password' }, 'password')))));
    if (!shown.length) list.append(h('p', { class: 'empty', style: 'grid-column:1/-1' }, docs.length ? 'No matching documents.' : 'No documents are listed here. Use the direct link you were given.'));
  }
  app.append(h('h1', {}, 'Documents'), h('input', { type: 'search', placeholder: 'Search documents', oninput: e => { q = e.target.value.trim().toLowerCase(); draw(); } }), chips, list);
  draw();
}

// reads an image file, scales it down to at most max px on the longer side and returns a data URL (PNG, or JPEG for JPEG input)
async function imageData(file, max) {
  const url = URL.createObjectURL(file);
  try {
    const im = new Image();
    await new Promise((ok, no) => { im.onload = ok; im.onerror = () => no(new Error('That file is not a PNG or JPEG image')); im.src = url; });
    const s = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight, 1));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(im.naturalWidth * s)); c.height = Math.max(1, Math.round(im.naturalHeight * s));
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    return file.type === 'image/jpeg' ? c.toDataURL('image/jpeg', 0.85) : c.toDataURL('image/png');
  } finally { URL.revokeObjectURL(url); }
}

function lockView() {
  const pw = h('input', { type: 'password', autocomplete: 'off', autofocus: true });
  app.replaceChildren(h('form', { class: 'panel login', onsubmit: async e => { e.preventDefault(); try { await api('POST', '/api/d/' + slug + '/unlock', { password: pw.value }); app.replaceChildren(); await formView(); } catch (err) { fail(err); pw.select(); } } },
    h('div', { class: 'logo', innerHTML: LOGO }), h('h1', {}, 'This form is protected'), h('p', { class: 'muted small', style: 'margin:0 0 6px' }, 'Enter the password you were given to open it.'),
    h('label', {}, 'Password'), pw, h('div', { style: 'margin-top:16px' }, h('button', { class: 'pri', style: 'width:100%' }, 'Open form'))));
}

async function formView() {
  let doc;
  try { doc = await api('GET', '/api/d/' + slug); }
  catch (e) {
    if (e.status === 401) return lockView();
    app.append(h('h1', {}, 'Document not found'), h('p', { class: 'muted' }, 'This link is not valid any more.')); return;
  }
  document.title = doc.title; $('#homeT').textContent = doc.siteTitle;
  // values from the link: only #key=value, which never leaves the browser (a query string would reach server and proxy logs)
  const fromUrl = new URLSearchParams(location.hash.slice(1));
  const LS = 'stampfill:', TTL = 30 * 86400000; // remembered values expire after 30 days
  const IMG = t => t === 'image' || t === 'signature';
  const store = {
    get(k) {
      try {
        const raw = localStorage.getItem(LS + k); if (raw == null) return null;
        try { const o = JSON.parse(raw); if (o && typeof o === 'object' && 'v' in o) { if (Date.now() - o.t > TTL) { localStorage.removeItem(LS + k); return null; } return o.v; } } catch (e) { /* value from an older version */ }
        return raw;
      } catch (e) { return null; }
    },
    set(k, v) { try { v === '' ? localStorage.removeItem(LS + k) : localStorage.setItem(LS + k, JSON.stringify({ v, t: Date.now() })); } catch (e) {} },
  };
  const inputs = {}, rows = {};
  const get = f => f.type === 'checkbox' ? (inputs[f.key].checked ? '1' : '') : inputs[f.key].value;
  const put = (f, v) => { if (IMG(f.type)) inputs[f.key].set(v); else if (f.type === 'checkbox') inputs[f.key].checked = !!v && v !== '0' && v !== 'false'; else inputs[f.key].value = f.type === 'date' ? toIso(v) : v; };
  const values = () => Object.fromEntries(doc.fields.map(f => [f.key, get(f)]));
  const HINT = { browser: 'Remembered on this device for 30 days', url: 'Can be carried in a link', instance: '', today: "Today's date" };
  const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const toIso = v => { const m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(String(v).trim()); return m ? m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0') : v; };

  const form = h('div', { class: 'panel' });
  for (const f of doc.fields) {
    if (IMG(f.type)) { form.append(rows[f.key] = imageRow(f)); continue; }
    const inp = inputs[f.key] = f.type === 'textarea' ? h('textarea', { rows: 3 }) : h('input', { type: f.type === 'checkbox' ? 'checkbox' : f.type === 'date' ? 'date' : 'text' });
    inp.id = 'f_' + f.key;
    const saved = f.prefill === 'browser' ? store.get(f.key) : null;
    put(f, fromUrl.has(f.key) ? fromUrl.get(f.key) : saved != null ? saved : f.prefill === 'instance' ? f.value : f.prefill === 'today' ? today() : '');
    inp.addEventListener('input', () => { if (f.prefill === 'browser') store.set(f.key, get(f)); rows[f.key].classList.remove('bad'); schedule(); });
    const name = f.label + (f.required ? ' *' : '');
    rows[f.key] = f.type === 'checkbox'
      ? h('div', {}, h('label', { class: 'chk', style: 'margin-top:12px' }, inp, name), HINT[f.prefill] && h('div', { class: 'hint' }, HINT[f.prefill]))
      : h('div', {}, h('label', { htmlFor: inp.id }, name), inp, HINT[f.prefill] && h('div', { class: 'hint' }, HINT[f.prefill]));
    form.append(rows[f.key]);
  }
  for (const f of doc.fields) if (f.hidden && rows[f.key]) rows[f.key].style.display = 'none'; // hidden fields keep their value and are still printed
  if (doc.fields.length && doc.fields.every(f => f.hidden)) form.append(h('p', { class: 'muted' }, 'Nothing to fill in here — just print or download.'));
  if (!doc.fields.length) form.append(h('p', { class: 'muted' }, 'This document has no fields to fill in.'));
  function imageRow(f) { // file picker + thumbnail; the value is a data URL, or '' to fall back to the admin's default image
    const fixedUrl = f.prefill === 'instance' && f.value ? '/api/d/' + slug + '/image/' + f.key : '';
    const st = inputs[f.key] = { value: '' };
    const thumb = h('img', { class: 'thumb', alt: '' }), file = h('input', { type: 'file', accept: 'image/png,image/jpeg', id: 'f_' + f.key, style: 'display:none' });
    const pick = h('button', { class: 'small', onclick: () => file.click() }), clear = h('button', { class: 'small', onclick: () => { st.set(''); changed(); } }, 'Remove');
    const draw = f.type === 'signature' && h('button', { class: 'small', onclick: () => sigPad(v => { st.set(v); changed(); }) }, 'Draw signature');
    const show = () => { const src = st.value || fixedUrl; if (src) thumb.src = src; thumb.style.display = src ? '' : 'none'; clear.style.display = st.value ? '' : 'none'; pick.textContent = src ? 'Replace image' : 'Choose image'; };
    st.set = v => { st.value = v || ''; show(); };
    const saved = f.prefill === 'browser' ? store.get(f.key) : null;
    // pictures and signatures are only remembered when the user says so: shared computers must not hand them to the next person
    const rem = st.rem = f.prefill === 'browser' ? h('input', { type: 'checkbox', class: 'remember', checked: !!saved }) : null;
    const remember = () => { if (rem) store.set(f.key, rem.checked ? st.value : ''); };
    if (rem) rem.addEventListener('change', remember);
    const changed = () => { remember(); rows[f.key].classList.remove('bad'); schedule(); };
    file.addEventListener('change', async () => { const fl = file.files[0]; file.value = ''; if (!fl) return; try { st.set(await imageData(fl, 1200)); changed(); } catch (e) { fail(e); } });
    st.set(saved || '');
    const hint = f.prefill === 'instance' && f.value ? 'A default image is provided; you can replace it' : f.prefill === 'browser' ? '' : HINT[f.prefill];
    return h('div', {}, h('label', { htmlFor: file.id }, f.label + (f.required ? ' *' : '')), h('div', { class: 'imgbox' }, thumb, h('div', { class: 'row' }, draw, pick, clear, file)),
      rem && h('label', { class: 'chk small', style: 'margin-top:6px' }, rem, 'Remember on this device (30 days)'), hint && h('div', { class: 'hint' }, hint));
  }
  // a drawing pad for signatures: pointer and touch, smoothed strokes, trimmed to the ink with a transparent background
  function sigPad(done) {
    const dpr = Math.min(window.devicePixelRatio || 1, 3), W = Math.min(640, window.innerWidth - 72), H = Math.round(W * 0.38);
    const c = h('canvas', { class: 'sig', width: Math.round(W * dpr), height: Math.round(H * dpr), style: 'width:' + W + 'px;height:' + H + 'px' });
    const g = c.getContext('2d'); g.scale(dpr, dpr); g.lineWidth = 2.6; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = g.fillStyle = '#1b2a6b';
    let strokes = [], cur = null;
    const pos = e => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const redraw = () => {
      g.clearRect(0, 0, W, H);
      for (const s of strokes) {
        if (s.length < 3) { g.beginPath(); g.arc(s[0][0], s[0][1], 1.4, 0, 7); g.fill(); continue; }
        g.beginPath(); g.moveTo(s[0][0], s[0][1]);
        for (let i = 1; i < s.length - 1; i++) g.quadraticCurveTo(s[i][0], s[i][1], (s[i][0] + s[i + 1][0]) / 2, (s[i][1] + s[i + 1][1]) / 2);
        g.lineTo(s[s.length - 1][0], s[s.length - 1][1]); g.stroke();
      }
    };
    c.addEventListener('pointerdown', e => { e.preventDefault(); c.setPointerCapture(e.pointerId); cur = [pos(e)]; strokes.push(cur); redraw(); });
    c.addEventListener('pointermove', e => { if (!cur) return; cur.push(pos(e)); redraw(); });
    const end = () => { cur = null; }; c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
    const crop = () => { // bounding box of the ink, plus a margin
      const d = g.getImageData(0, 0, c.width, c.height).data; let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (x1 < 0) return null;
      const pad = Math.round(8 * dpr), o = document.createElement('canvas'); o.width = x1 - x0 + 1 + 2 * pad; o.height = y1 - y0 + 1 + 2 * pad;
      o.getContext('2d').drawImage(c, x0 - pad, y0 - pad, o.width, o.height, 0, 0, o.width, o.height);
      return o.toDataURL('image/png');
    };
    const dlg = h('dialog', { class: 'sigdlg' }, h('h2', {}, 'Sign here'), c,
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', { class: 'small', onclick: () => { strokes = []; redraw(); } }, 'Clear'), h('button', { class: 'small', onclick: () => { strokes.pop(); redraw(); } }, 'Undo'), h('span', { class: 'grow' }),
        h('button', { onclick: () => dlg.close() }, 'Cancel'),
        h('button', { class: 'pri', onclick: () => { const out = crop(); if (!out) { toast('Nothing drawn yet', true); return; } dlg.close(); done(out); } }, 'Use signature')));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg); dlg.showModal();
  }

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
    const miss = doc.fields.filter(f => f.required && !f.hidden && !get(f) && !(IMG(f.type) && f.prefill === 'instance' && f.value));
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
    doc.fields.filter(f => f.prefill === 'browser').forEach(f => { store.set(f.key, ''); put(f, ''); if (inputs[f.key].rem) inputs[f.key].rem.checked = false; });
    schedule(); toast('Saved values removed from this browser');
  }
  const guard = fn => async e => { const b = e.currentTarget; b.disabled = true; try { await fn(); } catch (err) { fail(err); } b.disabled = false; };
  const has = mode => doc.fields.some(f => f.prefill === mode);
  form.append(h('div', { class: 'actions' },
    h('div', { class: 'row' },
      h('button', { class: 'pri', onclick: guard(browserPrint) }, 'Print'),
      doc.serverPrint && h('button', { onclick: guard(serverPrint) }, doc.printLabel || 'Print at home'),
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
const TYPES = { text: 'Text', textarea: 'Multi-line text', date: 'Date', checkbox: 'Checkbox (X)', image: 'Image (upload)', signature: 'Signature (draw or upload)', static: 'Fixed text (not editable)' };
const IMG = t => t === 'image' || t === 'signature';
const PRE = { none: 'No prefill', browser: 'Remember per user (browser)', instance: 'Fixed value (this instance)', url: 'From link (URL)', today: "Today's date" };
const PRE_SHORT = { none: '', browser: 'browser', instance: 'fixed', url: 'link', today: 'today' };
const preFor = type => Object.fromEntries(Object.entries(PRE).filter(([k]) => (k !== 'today' || type === 'date') && (k !== 'url' || !IMG(type))));
const DATEFMT = ['YYYY-MM-DD', 'DD.MM.YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY']; // first entry: default for new fields (the server keeps DD.MM.YYYY for stored fields without a format)
const keyOf = s => String(s).toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'field';
const linkOf = d => location.origin + '/d/' + d.slug;
const docOpen = () => { try { return localStorage.getItem('stampfill:docOpen') !== '0'; } catch (e) { return true; } }; // "Document settings" collapsed?
const setDocOpen = v => { try { localStorage.setItem('stampfill:docOpen', v ? '1' : '0'); } catch (e) {} };
const slugOf = s => String(s).toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

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
      h('td', {}, d.fields), h('td', {}, (d.listed ? 'Listed' : 'Link only') + (d.protected ? ' · password' : '')),
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
  const pub = h('input', { type: 'checkbox', checked: s.publicPrint }), pbtn = h('input', { type: 'text', value: s.printButton, placeholder: 'Print at home', maxLength: 40 });
  const ptest = h('div', { class: 'hint', id: 'ptest' });
  const cur = h('input', { type: 'password', autocomplete: 'current-password' }), nxt = h('input', { type: 'password', autocomplete: 'new-password' });
  app.append(h('h1', {}, 'Settings'), h('div', { class: 'panel', style: 'max-width:560px' },
    h('label', {}, 'Site title'), title,
    h('label', {}, 'Network printer (IPP / CUPS URL, optional)'), h('div', { class: 'row' }, h('div', { class: 'grow' }, purl), h('button', { onclick: async e => {
      const b = e.currentTarget; b.disabled = true; ptest.className = 'hint'; ptest.textContent = 'Asking the printer…';
      try {
        const r = await api('POST', '/api/admin/printer/test', { url: purl.value });
        ptest.replaceChildren(h('b', {}, (r.model || r.name || 'Printer') + ' — ' + r.state + (r.reasons.length ? ' (' + r.reasons.join(', ') + ')' : '')), h('br'),
          'Accepts: ' + (r.formats.join(', ') || 'no formats reported'), h('br'),
          r.pdf ? h('span', { style: 'color:var(--ok)' }, 'Takes PDF — ready to print.') : h('span', { style: 'color:var(--bad)' }, 'Does not take PDF. Print through a CUPS queue instead: see "Printing" in the README (docker-compose.cups.yml).'));
      } catch (err) { ptest.className = 'hint'; ptest.textContent = err.message; ptest.style.color = 'var(--bad)'; return; } finally { b.disabled = false; }
      ptest.style.color = '';
    } }, 'Test printer')), ptest,
    h('div', { class: 'hint' }, 'Adds a button to every form that prints on this printer from the server. The printer must accept PDF; a CUPS queue converts for printers that do not. Each document can switch the button off.'),
    h('label', {}, 'Label of that button'), pbtn,
    h('label', { class: 'chk', style: 'margin-top:12px' }, pub, 'Let everyone with a document link use this printer (otherwise only while logged in as admin)'),
    h('div', { style: 'margin-top:14px' }, h('button', { class: 'pri', onclick: async () => { try { await api('PUT', '/api/admin/settings', { siteTitle: title.value, printerUrl: purl.value, publicPrint: pub.checked, printButton: pbtn.value }); toast('Saved'); } catch (e) { fail(e); } } }, 'Save settings'))),
    h('h2', {}, 'Sessions'),
    h('div', { class: 'panel', style: 'max-width:560px' },
      h('p', { class: 'muted small', style: 'margin:0 0 10px' }, 'Admin sessions last 12 hours of inactivity. Signing out everywhere also closes every unlocked form in every browser.'),
      h('button', { onclick: async () => { try { await api('POST', '/api/admin/sessions/revoke'); toast('All other sessions signed out'); } catch (e) { fail(e); } } }, 'Sign out all other sessions')),
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
  const rotIn = h('input', { type: 'number', id: 'rotIn', step: 0.5, min: -180, max: 180, value: 0, title: 'Rotation of this page in degrees', style: 'width:84px' });
  const setRot = v => { v = Math.max(-180, Math.min(180, Math.round((+v || 0) * 10) / 10)); d.rotation[pageNo - 1] = v; rotIn.value = v; mark(); redraw().catch(fail); };
  rotIn.addEventListener('change', () => setRot(rotIn.value));
  const rotBy = step => { let v = (d.rotation[pageNo - 1] || 0) + step; if (v > 180) v -= 360; if (v < -180) v += 360; setRot(v); };
  const stage = h('div', { class: 'stage' }, wrap);
  async function redraw() {
    const my = ++seq, buf = await api('POST', '/api/admin/docs/' + id + '/render', { fields: d.fields, rotation: d.rotation }, true);
    if (my !== seq) return;
    const pdf = await openPdf(buf), c = h('canvas'), w = Math.max(280, stage.clientWidth - 34);
    pageNo = Math.min(pageNo, pdf.numPages);
    const v = await drawPage(pdf, pageNo, c, w);
    if (my !== seq) return;
    vp = v; wrap.style.width = w + 'px'; canvasBox.replaceChildren(c);
    pageLbl.textContent = 'Page ' + pageNo + ' of ' + pdf.numPages; rotIn.value = d.rotation[pageNo - 1] || 0; markers();
  }
  const later = () => { clearTimeout(timer); timer = setTimeout(() => redraw().catch(fail), 200); };
  const aspects = {}; // default image name -> width/height, so the marker shows the printed shape
  function aspectOf(f) {
    if (!IMG(f.type) || !f.value) return f.type === 'signature' ? 3.2 : 2;
    if (aspects[f.value] === undefined) { aspects[f.value] = 2; const im = new Image(); im.onload = () => { aspects[f.value] = im.naturalWidth / im.naturalHeight; markers(); }; im.src = '/api/admin/images/' + f.value; }
    return aspects[f.value];
  }
  function markers() {
    if (!vp) return;
    ov.replaceChildren(...d.fields.filter(f => f.page === pageNo).map(f => {
      const pt = vp.convertToViewportPoint(f.x, f.y), fh = f.size * vp.scale, img = IMG(f.type);
      const sample = f.type === 'checkbox' ? 'X' : f.type === 'date' ? '0000-00-00' : (f.value || f.label).split('\n')[0];
      const w = img ? (f.maxWidth || 120) * vp.scale : (f.maxWidth > 0 ? f.maxWidth : Math.max(f.size, sample.length * f.size * 0.52)) * vp.scale;
      const hgt = img ? (f.height > 0 ? f.height * vp.scale : w / aspectOf(f)) : fh * 1.1, top = img ? pt[1] - hgt : pt[1] - fh * 0.85; // images grow upwards from (x, y)
      const m = h('div', { class: 'mk' + (f.id === sel ? ' on' : ''), title: 'Drag to move', style: 'left:' + pt[0] + 'px;top:' + top + 'px;width:' + w + 'px;height:' + hgt + 'px' }, h('span', {}, f.label));
      m.addEventListener('pointerdown', e => drag(e, f, m));
      if (f.id === sel && f.type !== 'checkbox') { // resize handle: top-right for images (they grow upwards), bottom-right for text (wrap width)
        const rz = h('div', { class: 'rz ' + (img ? 'tr' : 'br'), title: img ? 'Drag to resize' : 'Drag to set the wrap width' });
        rz.addEventListener('pointerdown', e => resize(e, f, m)); m.append(rz);
      }
      return m;
    }));
  }
  function resize(e, f, m) {
    e.preventDefault(); e.stopPropagation();
    const img = IMG(f.type), sx = e.clientX, sy = e.clientY, s = vp.scale;
    const w0 = f.maxWidth > 0 ? f.maxWidth : parseFloat(m.style.width) / s, h0 = f.height > 0 ? f.height : parseFloat(m.style.height) / s, pt = vp.convertToViewportPoint(f.x, f.y);
    const move = ev => {
      f.maxWidth = Math.max(5, Math.round((w0 + (ev.clientX - sx) / s) * 10) / 10); m.style.width = f.maxWidth * s + 'px';
      if (img) { f.height = Math.max(5, Math.round((h0 + (sy - ev.clientY) / s) * 10) / 10); m.style.height = f.height * s + 'px'; m.style.top = pt[1] - f.height * s + 'px'; }
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); mark(); side(); redraw().catch(fail); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
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
    const f = { id: 'f' + Math.random().toString(36).slice(2, 10), key: keyOf(label), label, type: 'text', required: false, hidden: false, page: pageNo, x: Math.round(x), y: Math.round(y), size: 11, maxWidth: 0, height: 0, dateFormat: DATEFMT[0], prefill: 'none', value: '' };
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
  const readable = s => /^[a-z0-9-]+$/.test(s) ? s : ''; let slugInit = readable(d.slug); // random links are not shown as a name
  const slugIn = h('input', { type: 'text', id: 'slugIn', value: slugInit, spellcheck: false, placeholder: 'empty = random link', oninput: () => { link.value = location.origin + '/d/' + (slugOf(slugIn.value) || '(random)'); mark(); } });
  const allowPrint = h('input', { type: 'checkbox', checked: d.serverPrint !== false, onchange: mark });
  let dropPw = false;
  const pwIn = h('input', { type: 'text', autocomplete: 'off', spellcheck: false, placeholder: d.protected ? 'Password set — type a new one to change it' : 'No password', oninput: () => { dropPw = false; mark(); } });
  const pwDrop = h('button', { class: 'small', style: d.protected ? '' : 'display:none', onclick: () => { dropPw = true; pwIn.value = ''; pwIn.placeholder = 'Password will be removed on save'; mark(); } }, 'Remove');
  const openBtn = h('a', { class: 'btn', target: '_blank', href: '/d/' + d.slug }, 'Open form');
  const afterSave = () => { link.value = linkOf(d); openBtn.href = '/d/' + d.slug; slugInit = readable(d.slug); slugIn.value = slugInit; pwIn.value = ''; dropPw = false; pwIn.placeholder = d.protected ? 'Password set — type a new one to change it' : 'No password'; pwDrop.style.display = d.protected ? '' : 'none'; };
  const fieldsBox = h('div'), propsBox = h('div', { id: 'fp' });
  const repl = h('input', { type: 'file', accept: 'application/pdf,.pdf', style: 'display:none', onchange: async () => {
    const f = repl.files[0]; if (!f) return;
    if (dirty && !confirm('Replacing the PDF discards unsaved changes. Continue?')) { repl.value = ''; return; }
    try { d = await api('PUT', '/api/admin/docs/' + id + '/pdf', f); dirty = false; saveBtn.textContent = 'Saved'; saveBtn.disabled = true; pageNo = 1; side(); await redraw(); toast('PDF replaced'); } catch (e) { fail(e); }
    repl.value = '';
  } });
  async function save() {
    try {
      const body = { title: title.value, description: desc.value, tags: tags.value.split(','), listed: listed.checked, serverPrint: allowPrint.checked, rotation: d.rotation, fields: d.fields };
      if (slugIn.value !== slugInit) body.slug = slugIn.value;
      if (dropPw) body.password = ''; else if (pwIn.value) body.password = pwIn.value;
      d = await api('PUT', '/api/admin/docs/' + id, body);
      dirty = false; saveBtn.textContent = 'Saved'; saveBtn.disabled = true; afterSave(); side(); toast('Saved');
    } catch (e) { fail(e); }
  }
  function flist() {
    fieldsBox.replaceChildren(d.fields.length ? h('div', { class: 'flist' }, d.fields.map(f => h('div', { class: 'fitem' + (f.id === sel ? ' on' : ''), onclick: () => { sel = f.id; if (f.page !== pageNo) { pageNo = f.page; redraw().catch(fail); } side(); markers(); } },
      h('b', {}, f.label), f.type === 'static' ? h('span', { class: 'tag' }, 'fixed text') : PRE_SHORT[f.prefill] && h('span', { class: 'tag' }, PRE_SHORT[f.prefill]), f.hidden && h('span', { class: 'tag' }, 'hidden'), h('span', { class: 'muted small' }, 'p' + f.page))))
      : h('p', { class: 'empty small' }, 'No fields yet. Double-click on the page where the text should go, or use "Add field".'));
  }
  function side() {
    flist();
    const f = field();
    if (!f) { propsBox.replaceChildren(); return; }
    const bind = (el, prop, conv, after) => { el.addEventListener('input', () => { f[prop] = conv ? conv(el) : el.value; mark(); later(); if (after) after(); }); return el; };
    const numIn = (prop, step, min) => bind(h('input', { type: 'number', step, min, value: f[prop] }), prop, el => el.value === '' ? 0 : +el.value, markers);
    const keyIn = bind(h('input', { type: 'text', value: f.key }), 'key', el => keyOf(el.value));
    keyIn.addEventListener('change', () => { keyIn.value = f.key; }); // show the normalised key once editing is done
    const labelIn = h('input', { type: 'text', value: f.label });
    labelIn.addEventListener('input', () => { const auto = f.key === keyOf(f.label); f.label = labelIn.value; if (auto) { f.key = keyOf(f.label); keyIn.value = f.key; } mark(); later(); flist(); });
    const sel2 = (prop, opts) => { const s = h('select', {}, Object.entries(opts).map(([v, t]) => h('option', { value: v, selected: f[prop] === v }, t))); s.addEventListener('change', () => {
      const was = f[prop]; f[prop] = s.value;
      if (prop === 'type' && (IMG(was) || IMG(s.value))) { f.value = ''; f.maxWidth = s.value === 'signature' ? 160 : IMG(s.value) ? 120 : 0; f.height = s.value === 'signature' ? 50 : 0; } // sizes mean different things per type
      if (f.prefill === 'today' && f.type !== 'date') f.prefill = 'none'; if (f.prefill === 'url' && IMG(f.type)) f.prefill = 'none';
      if (prop === 'prefill' && (was === 'instance') !== (s.value === 'instance')) f.hidden = s.value === 'instance'; // fixed values are hidden on the form by default
      if (f.type === 'static') { f.prefill = 'none'; f.required = false; f.hidden = false; }
      if (f.hidden) f.required = false;
      mark(); side(); redraw().catch(fail); }); return s; };
    const fixed = f.type === 'static', isImg = IMG(f.type);
    const imgPick = h('input', { type: 'file', accept: 'image/png,image/jpeg', style: 'display:none', onchange: async () => {
      const fl = imgPick.files[0]; imgPick.value = ''; if (!fl) return;
      try { const r = await api('POST', '/api/admin/images', fl); f.value = r.name; mark(); side(); redraw().catch(fail); } catch (e) { fail(e); }
    } });
    propsBox.replaceChildren(h('h2', {}, 'Selected field'), h('div', { class: 'panel' },
      h('label', { style: 'margin-top:0' }, fixed ? 'Label (only shown in this editor)' : 'Label (shown on the form)'), labelIn,
      h('div', { class: 'g2' }, h('div', {}, h('label', {}, 'Type'), sel2('type', TYPES)), h('div', {}, h('label', {}, 'Key (for links)'), keyIn)),
      f.type === 'date' && h('div', {}, h('label', {}, 'Date format'), sel2('dateFormat', Object.fromEntries(DATEFMT.map(x => [x, x])))),
      h('div', { class: 'g4' }, h('div', {}, h('label', {}, 'Page'), numIn('page', 1, 1)), h('div', {}, h('label', {}, 'X (pt)'), numIn('x', 0.5)), h('div', {}, h('label', {}, 'Y (pt)'), numIn('y', 0.5)), !isImg && h('div', {}, h('label', {}, 'Size'), numIn('size', 0.5, 4))),
      isImg ? h('div', {}, h('div', { class: 'g2' }, h('div', {}, h('label', {}, 'Width (pt)'), numIn('maxWidth', 1, 5)), h('div', {}, h('label', {}, 'Height (pt, 0 = follows the image)'), numIn('height', 1, 0))),
          h('div', { class: 'hint' }, 'Or drag the handle at the top-right corner of the marker. With a height set, the image is scaled to fit inside width × height. It grows upwards from the marked point.'))
        : f.type !== 'checkbox' && h('div', {}, h('label', {}, 'Wrap width in pt (0 = no wrapping)'), numIn('maxWidth', 1, 0), h('div', { class: 'hint' }, 'Or drag the handle at the bottom-right corner of the marker.')),
      fixed && h('div', {}, h('label', {}, 'Text (printed as is, users cannot change it)'), bind(h('textarea', { rows: 3, value: f.value, placeholder: 'e.g. a footer note or an office address' }), 'value', null, flist)),
      !fixed && h('label', {}, 'Prefill'), !fixed && sel2('prefill', preFor(f.type)),
      f.prefill === 'instance' && !isImg && h('div', {}, h('label', {}, 'Fixed value'), f.type === 'textarea' ? bind(h('textarea', { rows: 2, value: f.value }), 'value') : bind(h('input', { type: f.type === 'date' ? 'date' : 'text', value: f.value, placeholder: f.type === 'checkbox' ? '1 = ticked' : '' }), 'value')),
      f.prefill === 'instance' && isImg && h('div', {}, h('label', {}, 'Default image (PNG or JPEG)'),
        h('div', { class: 'imgbox' }, f.value && h('img', { class: 'thumb', alt: '', src: '/api/admin/images/' + f.value }), h('button', { class: 'small', onclick: () => imgPick.click() }, f.value ? 'Replace image' : 'Upload image'), imgPick),
        h('div', { class: 'hint' }, 'Printed unless the user picks another image on the form. For an image nobody should replace, put it into the PDF template itself.')),
      f.prefill === 'browser' && isImg && h('div', { class: 'hint' }, (f.type === 'signature' ? 'Users draw on screen or upload a picture; ' : 'Users pick their image once; ') + 'the browser remembers it for every document that has a field with this key.'),
      f.prefill === 'browser' && !isImg && h('div', { class: 'hint' }, 'Each user types it once; their browser remembers it for every document that has a field with this key.'),
      f.prefill === 'url' && h('div', { class: 'hint' }, 'Filled from the link, e.g. ' + linkOf(d) + '#' + f.key + '=value. Users get a "Copy link with values" button.'),
      f.prefill === 'today' && h('div', { class: 'hint' }, 'Set to the current date when the form opens. The user can still change it.'),
      !fixed && !f.hidden && h('label', { class: 'chk', style: 'margin-top:12px' }, bind(h('input', { type: 'checkbox', checked: f.required }), 'required', el => el.checked), 'Required'),
      !fixed && h('label', { class: 'chk', style: 'margin-top:12px' }, bind(h('input', { type: 'checkbox', checked: f.hidden }), 'hidden', el => el.checked, () => { if (f.hidden) f.required = false; side(); }), 'Hide on the form (still printed)'),
      h('div', { style: 'margin-top:12px' }, h('button', { class: 'danger', onclick: () => { d.fields = d.fields.filter(x => x !== f); sel = null; mark(); side(); redraw().catch(fail); } }, 'Remove field'))));
  }

  app.append(
    h('div', { class: 'row', style: 'margin-bottom:12px' }, h('a', { href: '#', class: 'muted' }, '← Documents'), h('span', { class: 'grow' }),
      openBtn, saveBtn),
    h('div', { class: 'editor' },
      h('div', { class: 'ed-stage' }, h('div', { class: 'row', style: 'margin-bottom:8px' },
        h('button', { onclick: () => { if (pageNo > 1) { pageNo--; redraw().catch(fail); } } }, '‹'), pageLbl, h('button', { onclick: () => { if (pageNo < d.pages) { pageNo++; redraw().catch(fail); } } }, '›'),
        h('span', { class: 'muted small', style: 'margin-left:10px' }, 'Rotate'), h('button', { class: 'small', title: 'Rotate 90° counter-clockwise', onclick: () => rotBy(-90) }, '⟲'), rotIn, h('button', { class: 'small', title: 'Rotate 90° clockwise', onclick: () => rotBy(90) }, '⟳'),
        h('span', { class: 'grow' }), h('span', { class: 'muted small' }, 'Double-click the page to add a field · drag to move'),
        h('button', { onclick: () => { const c = vp ? vp.convertToPdfPoint(vp.width / 2, vp.height / 3) : [72, 700]; addField(c[0], c[1]); } }, 'Add field')), stage),
      h('details', { class: 'panel ed-doc', open: docOpen(), ontoggle: e => setDocOpen(e.target.open) }, h('summary', {}, 'Document settings'),
          h('label', {}, 'Title'), title, h('label', {}, 'Description'), desc, h('label', {}, 'Tags (comma-separated)'), tags,
          h('label', { class: 'chk', style: 'margin-top:12px' }, listed, 'Show in the public document list'),
          h('label', { class: 'chk', style: 'margin-top:8px' }, allowPrint, 'Allow printing on the network printer from this form'),
          h('label', {}, 'Link name (optional)'), slugIn,
          h('div', { class: 'hint' }, 'Letters, digits and dashes give a readable link such as /d/library-card. Leave it empty for a random, unguessable link. Changing it breaks links already handed out.'),
          h('label', {}, 'Direct link'), h('div', { class: 'row' }, h('div', { class: 'grow' }, link), h('button', { onclick: () => copyText(link.value) }, 'Copy')),
          h('label', {}, 'Form password (optional)'), h('div', { class: 'row' }, h('div', { class: 'grow' }, pwIn), pwDrop),
          h('div', { class: 'hint' }, 'Users must enter it once per browser before the form opens. Takes effect on save.'),
          h('div', { class: 'row', style: 'margin-top:12px' },
            h('button', { class: 'small', onclick: () => repl.click() }, 'Replace PDF'), repl,
            h('button', { class: 'small', title: 'Replaces the link name with an unguessable random one', onclick: async () => { if (!confirm('Create a random link? The current link stops working.')) return; try { const r = await api('POST', '/api/admin/docs/' + id + '/link'); d.slug = r.slug; afterSave(); side(); toast('New link created'); } catch (e) { fail(e); } } }, 'Random link'),
            h('button', { class: 'small danger', onclick: async () => { if (!confirm('Delete "' + d.title + '" and its PDF?')) return; try { await api('DELETE', '/api/admin/docs/' + id); dirty = false; location.hash = ''; } catch (e) { fail(e); } } }, 'Delete'))),
      h('div', { class: 'ed-fields' }, h('h2', {}, 'Fields'), fieldsBox, propsBox)));
  side(); await redraw();
  window.addEventListener('resize', later);
}
boot();
`);
