// Translations: every string the pages translate exists in every locale, locales are served, the
// instance default language reaches the page, and non-Latin values still print.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stampfill-i18n-'));
process.env.DATA_DIR = path.join(tmp, 'data'); process.env.ADMIN_PASSWORD = 'i18n-pass-123';
const app = require('../../stampfill.js');
const ROOT = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'stampfill.js'), 'utf8');
const H = { 'X-Requested-With': 'stampfill' };
let base, cookie;
before(async () => {
  base = 'http://127.0.0.1:' + (await app.start({ port: 0, host: '127.0.0.1' })).address().port;
  const r = await fetch(base + '/api/login', { method: 'POST', headers: H, body: JSON.stringify({ password: 'i18n-pass-123' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
});
after(() => { app.server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// keys used by the pages: t('...') and t("...") in the inline scripts, plus server messages the pages show as toasts
function usedKeys() {
  const client = SRC.slice(SRC.indexOf('const LIB = '));
  const keys = new Set();
  for (const m of client.matchAll(/\bt\((?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\)/g)) keys.add(JSON.parse('"' + (m[1] != null ? m[1].replace(/\\'/g, "'").replace(/"/g, '\\"') : m[2]) + '"'));
  for (const m of SRC.matchAll(/new HttpErr\(\d+, '((?:[^'\\]|\\.)*)'\)/g)) if (!m[1].includes("' +")) keys.add(m[1].replace(/\\'/g, "'"));
  return keys;
}

test('every locale translates every string the pages use', () => {
  const used = usedKeys(); assert.ok(used.size > 150, 'found ' + used.size + ' keys');
  const serverOnly = ['Request too large', 'Invalid JSON', 'Not found', 'Forbidden', 'No image', 'That file is not a PDF', 'Could not read that PDF',
    'Encrypted PDFs are not supported — remove the password protection first', 'Printer URL must start with http://, https://, ipp:// or ipps://',
    'The password is set through ADMIN_PASSWORD and cannot be changed here', 'Printer answer too large — is this really an IPP endpoint?', 'Login required',
    'Password required', 'Document not found'];
  for (const lang of app.LANGS.filter((l) => l !== 'en')) {
    const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', lang + '.json'), 'utf8'));
    const missing = [...used].filter((k) => !(k in dict) && !serverOnly.includes(k) && !/' \+|\+ '/.test(k));
    assert.deepEqual(missing, [], lang + ' is missing translations');
    for (const [k, v] of Object.entries(dict)) { assert.equal(typeof v, 'string', lang + ': ' + k); assert.ok(v.length > 0, lang + ': empty ' + k); }
    // placeholders and trailing spaces survive translation
    for (const k of Object.keys(dict)) if (/ $/.test(k)) assert.match(dict[k], / $/, lang + ': "' + k + '" must keep its trailing space');
  }
});

test('locales are served, cached and gzip-able; unknown languages are not', async () => {
  const r = await fetch(base + '/locales/de.json', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /application\/json/); assert.equal(r.headers.get('content-encoding'), 'gzip');
  assert.match(r.headers.get('cache-control'), /max-age=3600/);
  assert.equal((await r.json())['Print'], 'Drucken');
  assert.equal((await fetch(base + '/locales/xx.json')).status, 404);
  assert.equal((await fetch(base + '/locales/en.json')).status, 404, 'English is built in');
});

test('the instance default language is set in Settings and reaches the page', async () => {
  const put = (language) => fetch(base + '/api/admin/settings', { method: 'PUT', headers: { ...H, Cookie: cookie }, body: JSON.stringify({ siteTitle: 'Rathaus', language }) });
  assert.equal((await (await put('de')).json()).language, 'de');
  assert.match(await (await fetch(base + '/')).text(), /<html lang="de"/);
  assert.match(await (await fetch(base + '/admin')).text(), /<html lang="de"/);
  assert.equal((await (await put('klingon')).json()).language, 'en', 'unknown languages fall back to English');
  assert.match(await (await fetch(base + '/')).text(), /<html lang="en"/);
});

test('values in Greek, Cyrillic and accented Latin print with the fallback font', async () => {
  fs.mkdirSync(path.join(app.DATA, 'pdfs'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'sample-form.pdf'), path.join(app.DATA, 'pdfs', 'u.pdf'));
  const f = app.cleanFields([{ label: 'Name', x: 100, y: 700 }, { label: 'City', x: 100, y: 680 }], 1);
  const { PDFDocument, PDFDict, PDFName } = require('pdf-lib');
  const fonts = async (values) => { const doc = await PDFDocument.load(await app.renderPdf({ id: 'u' }, f, values)); return doc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFDict && o.has(PDFName.of('FontFile2'))).length; };
  assert.equal(await fonts({ name: 'Jane', city: 'Maplewood' }), 0, 'plain Latin: built-in Helvetica only');
  assert.equal(await fonts({ name: 'Γιάννης Παπαδόπουλος', city: 'Київ' }), 1, 'one embedded TrueType subset for the non-Latin fields');
  assert.equal(await fonts({ name: 'Łukasz Żółć', city: 'Çağrı Öztürk' }), 1, 'Polish and Turkish letters outside WinAnsi use the fallback too');
});
