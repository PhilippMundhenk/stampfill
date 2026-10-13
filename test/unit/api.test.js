// HTTP API tests against an in-process server and an in-process mock IPP printer (no browser).
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stampfill-api-'));
process.env.DATA_DIR = path.join(tmp, 'data'); process.env.ADMIN_PASSWORD = 'api-pass-123'; process.env.TRUST_PROXY = '1';
const app = require('../../stampfill.js');
const db = () => app.db;
const { createMockIpp } = require('../mock-ipp.js');
const SAMPLE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'sample-form.pdf'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let base, ipp, ippUrl, cookie = '';
const H = { 'X-Requested-With': 'stampfill' };
const call = (method, p, body, headers = {}) => fetch(base + p, {
  method, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  headers: { ...H, Cookie: cookie, ...headers },
});

before(async () => {
  const srv = await app.start({ port: 0, host: '127.0.0.1' }); base = 'http://127.0.0.1:' + srv.address().port;
  ipp = createMockIpp(path.join(tmp, 'ipp'));
  await new Promise((ok) => ipp.listen(0, '127.0.0.1', ok)); ippUrl = 'http://127.0.0.1:' + ipp.address().port + '/printers/Test';
});
after(() => { app.server.close(); ipp.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('healthz answers, without details for strangers', async () => {
  const r = await fetch(base + '/healthz'); assert.equal(r.status, 200);
  const j = await r.json(); assert.deepEqual(j, { ok: true });
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('strict-transport-security'), null, 'no HSTS over plain HTTP');
  const h = await fetch(base + '/healthz', { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(h.headers.get('strict-transport-security'), /max-age=31536000/, 'HSTS once the proxy reports HTTPS');
});

test('the inline page scripts parse (they live inside a string, so node --check cannot see them)', async () => {
  const vm = require('vm');
  for (const p of ['/', '/admin']) {
    const html = await (await fetch(base + p)).text();
    const m = /<script type="module">([\s\S]*?)<\/script>/.exec(html); assert.ok(m, p + ' has a module script');
    const src = m[1].replace(/^import \* as pdfjs from '[^']+';/m, 'const pdfjs = {};');
    assert.doesNotThrow(() => new vm.Script('(async () => {' + src + '\n})', { filename: 'page' + p.replace('/', '-') + '.js' }), p + ' script must parse'); // module with top-level await
    assert.ok(!/`|\$\{/.test(m[1]), p + ' script must not contain backticks or dollar-brace (String.raw template)');
  }
});

test('pages are served with security headers', async () => {
  for (const p of ['/', '/admin', '/d/whatever']) {
    const r = await fetch(base + p); assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self' 'sha256-[A-Za-z0-9+/=]+' 'wasm-unsafe-eval'/, 'inline script allowed by hash only');
    assert.doesNotMatch(r.headers.get('content-security-policy'), /unsafe-inline'[^;]*;[^;]*style|script-src[^;]*unsafe-inline/);
  }
  assert.match((await fetch(base + '/healthz')).headers.get('content-security-policy'), /script-src 'self' 'wasm-unsafe-eval';/, 'no inline scripts anywhere else');
  assert.equal((await fetch(base + '/vendor/cmaps/.')).status, 404, 'directories are not files');
  assert.equal((await fetch(base + '/nope')).status, 404);
  assert.equal((await fetch(base + '/vendor/../package.json')).status, 404);
  assert.equal((await fetch(base + '/vendor/pdf.mjs')).status, 200);
  assert.equal((await fetch(base + '/vendor/pdf.worker.mjs')).status, 200);
  assert.equal((await fetch(base + '/vendor/cmaps/Adobe-Japan1-UCS2.bcmap')).status, 200);
  assert.equal((await fetch(base + '/vendor/cmaps/nope.bcmap')).status, 404);
  assert.equal((await fetch(base + '/vendor/evil.txt')).status, 404);
});

test('static content is gzip-compressed when the client accepts it', async () => {
  const gz = await fetch(base + '/vendor/pdf.mjs', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(gz.headers.get('content-encoding'), 'gzip'); assert.equal(gz.headers.get('vary'), 'Accept-Encoding');
  const plain = await fetch(base + '/vendor/pdf.mjs', { headers: { 'Accept-Encoding': 'identity' } });
  assert.equal(plain.headers.get('content-encoding'), null);
  assert.equal((await fetch(base + '/admin', { headers: { 'Accept-Encoding': 'gzip' } })).headers.get('content-encoding'), 'gzip');
  assert.equal((await fetch(base + '/healthz', { headers: { 'Accept-Encoding': 'gzip' } })).headers.get('content-encoding'), null, 'small JSON stays plain');
});

test('oversized bodies and unknown admin paths are rejected', async () => {
  assert.equal((await call('POST', '/api/login', Buffer.alloc(20000, 32))).status, 413);
  await call('POST', '/api/login', { password: 'api-pass-123' }).then((r) => { cookie = r.headers.get('set-cookie').split(';')[0]; });
  assert.equal((await call('GET', '/api/admin/nothing')).status, 404);
  assert.equal((await call('GET', '/api/admin/images/zzzzzzzz.png')).status, 404);
  assert.equal((await call('PATCH', '/api/admin/settings')).status, 404);
  cookie = '';
});

test('non-GET requests need the CSRF header; admin API needs a session', async () => {
  assert.equal((await fetch(base + '/api/login', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await call('GET', '/api/admin/docs')).status, 401);
  assert.equal((await call('PUT', '/api/admin/settings', {})).status, 401);
  const r = await call('POST', '/api/login', { password: 'wrong' }); assert.equal(r.status, 401);
  assert.equal((await call('POST', '/api/login', Buffer.from('not json'))).status, 400);
});

test('login sets a cookie and unlocks the admin API', async () => {
  const r = await call('POST', '/api/login', { password: 'api-pass-123' }); assert.equal(r.status, 200);
  const sc = r.headers.get('set-cookie'); assert.match(sc, /^sf_s=\d+\.[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200$/);
  cookie = sc.split(';')[0];
  const meR = await call('GET', '/api/admin/me'); const me = await meR.json(); assert.deepEqual(me, { ok: true, envPassword: true });
  assert.match(meR.headers.get('set-cookie'), /^sf_s=\d+\./, 'sessions slide on use');
  const h = await (await fetch(base + '/healthz', { headers: { Cookie: cookie } })).json(); assert.equal(h.version, require('../../package.json').version, 'admins see the version');
  process.env.SECURE_COOKIES = '1';
  const sec = await call('POST', '/api/login', { password: 'api-pass-123' }); assert.match(sec.headers.get('set-cookie'), /; Secure$/, 'SECURE_COOKIES forces the flag');
  delete process.env.SECURE_COOKIES;
  assert.equal((await call('POST', '/api/admin/password', { current: 'api-pass-123', next: 'something-else' })).status, 400);
  // tampered signature is rejected
  const bad = await fetch(base + '/api/admin/me', { headers: { Cookie: cookie.slice(0, -2) + 'xx' } }); assert.equal(bad.status, 401);
});

let doc;
test('upload, edit and render a document', async () => {
  assert.equal((await call('POST', '/api/admin/docs?title=Nope', Buffer.from('not a pdf'))).status, 400);
  let r = await call('POST', '/api/admin/docs?title=Sample%20form', SAMPLE); assert.equal(r.status, 200);
  doc = await r.json(); assert.equal(doc.title, 'Sample form'); assert.equal(doc.pages, 1); assert.deepEqual(doc.fields, []);
  assert.match(doc.slug, /^[\w-]{12,16}$/, 'links are random unless a name is set'); assert.equal(doc.password, undefined); assert.equal(doc.protected, false);
  const twin = await (await call('POST', '/api/admin/docs?title=Sample%20form', SAMPLE)).json();
  let renamed = await (await call('PUT', '/api/admin/docs/' + twin.id, { ...twin, slug: 'Second Copy!' })).json(); assert.equal(renamed.slug, 'second-copy', 'a readable link name');
  doc = await (await call('PUT', '/api/admin/docs/' + doc.id, { ...doc, slug: 'sample-form' })).json(); assert.equal(doc.slug, 'sample-form');
  assert.equal((await call('PUT', '/api/admin/docs/' + twin.id, { ...renamed, slug: 'sample-form' })).status, 400, 'link names are unique');
  renamed = await (await call('PUT', '/api/admin/docs/' + twin.id, { ...renamed, slug: '' })).json(); assert.match(renamed.slug, /^[\w-]{12,16}$/, 'empty name: random again');
  assert.equal((await call('DELETE', '/api/admin/docs/' + twin.id)).status, 200);
  r = await call('PUT', '/api/admin/docs/' + doc.id, {
    title: 'Sample form', description: 'desc', tags: ['demo', 'demo', ' x '], listed: true,
    fields: [{ label: 'Full name', x: 150, y: 700, required: true, prefill: 'browser' }, { label: 'Issued by', x: 150, y: 560, prefill: 'instance', value: 'Office' },
      { label: 'Footer', type: 'static', value: 'Office copy', x: 100, y: 100 }],
  });
  doc = await r.json(); assert.deepEqual(doc.tags, ['demo', 'x']); assert.equal(doc.fields.length, 3); assert.equal(doc.listed, true);
  const list = await (await call('GET', '/api/admin/docs')).json(); assert.equal(list.length, 1); assert.equal(list[0].fields, 3);
  assert.equal(doc.slug, 'sample-form', 'saving without touching the link name keeps it');
  r = await call('POST', '/api/admin/docs/' + doc.id + '/render', { fields: doc.fields }); assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.equal((await call('POST', '/api/admin/docs/' + doc.id + '/render', { fields: doc.fields, values: { full_name: 'Preview' } })).status, 200, 'preview with explicit values');
  assert.equal((await call('GET', '/api/admin/docs/zzz')).status, 404);
  const untitled = await (await call('PUT', '/api/admin/docs/' + doc.id, { ...doc, title: '   ' })).json(); assert.equal(untitled.title, 'Untitled');
  doc = await (await call('PUT', '/api/admin/docs/' + doc.id, { ...doc, title: 'Sample form' })).json();
});

let imgName;
test('page rotation is stored per page, previewable unsaved, and reset when the PDF is replaced', async () => {
  const { PDFDocument } = require('pdf-lib');
  let r = await call('POST', '/api/admin/docs/' + doc.id + '/render', { fields: doc.fields, rotation: [90] }); assert.equal(r.status, 200);
  let p = await PDFDocument.load(Buffer.from(await r.arrayBuffer())); assert.equal(p.getPage(0).getWidth(), 842, 'unsaved rotation applies to the preview');
  doc = await (await call('PUT', '/api/admin/docs/' + doc.id, { ...doc, rotation: [90] })).json(); assert.deepEqual(doc.rotation, [90]);
  r = await fetch(base + '/api/d/' + doc.slug + '/render', { method: 'POST', headers: H, body: JSON.stringify({ values: {} }) });
  p = await PDFDocument.load(Buffer.from(await r.arrayBuffer())); assert.equal(p.getPage(0).getWidth(), 842, 'the public form renders the rotated page');
  doc = await (await call('PUT', '/api/admin/docs/' + doc.id + '/pdf', SAMPLE)).json(); assert.deepEqual(doc.rotation, [0], 'a new PDF starts unrotated');
});

test('image fields: default image upload, public delivery, render with a data URL', async () => {
  assert.equal((await call('POST', '/api/admin/images', Buffer.from('GIF89a nope'))).status, 400);
  let r = await call('POST', '/api/admin/images', PNG, { 'Content-Type': 'image/png' }); assert.equal(r.status, 200);
  imgName = (await r.json()).name; assert.match(imgName, /^[\w-]+\.png$/);
  r = await call('GET', '/api/admin/images/' + imgName); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png');
  r = await call('PUT', '/api/admin/docs/' + doc.id, { ...doc, fields: [...doc.fields, { label: 'Stamp', type: 'image', prefill: 'instance', value: imgName, x: 400, y: 100, maxWidth: 60 }, { label: 'Sig', type: 'image', prefill: 'browser', x: 100, y: 100 }] });
  doc = await r.json(); assert.equal(doc.fields.length, 5);
  const pub = await (await fetch(base + '/api/d/' + doc.slug)).json();
  assert.equal(pub.fields.find((f) => f.key === 'stamp').value, imgName); assert.equal(pub.fields.find((f) => f.key === 'sig').value, '');
  r = await fetch(base + '/api/d/' + doc.slug + '/image/stamp'); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(base + '/api/d/' + doc.slug + '/image/sig')).status, 404, 'only default images are served');
  assert.equal((await fetch(base + '/api/d/' + doc.slug + '/image/full_name')).status, 404, 'text fields have no image');
  assert.equal((await fetch(base + '/api/d/nope/image/stamp')).status, 404);
  r = await fetch(base + '/api/d/' + doc.slug + '/render', { method: 'POST', headers: H, body: JSON.stringify({ values: { full_name: 'T', sig: 'data:image/png;base64,' + PNG.toString('base64') } }) });
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.ok(fs.existsSync(path.join(app.IMAGES, imgName)));
});

test('public API exposes listed documents and renders with values', async () => {
  const pub = await (await fetch(base + '/api/docs')).json();
  assert.equal(pub.title, 'Forms'); assert.equal(pub.docs.length, 1); assert.equal(pub.docs[0].slug, doc.slug);
  assert.equal(pub.docs[0].id, undefined, 'internal id must not leak');
  const d = await (await fetch(base + '/api/d/' + doc.slug)).json();
  assert.equal(d.serverPrint, false); assert.equal(d.fields[1].value, 'Office'); assert.equal(d.fields[0].value, '');
  assert.equal(d.fields.length, 4, 'fixed-text fields are not part of the public form');
  const r = await fetch(base + '/api/d/' + doc.slug + '/render', { method: 'POST', headers: H, body: JSON.stringify({ values: { full_name: 'Test' } }) });
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.equal((await fetch(base + '/api/d/nope')).status, 404);
  assert.equal((await fetch(base + '/api/d/' + doc.slug + '/print', { method: 'POST', headers: H, body: '{}' })).status, 403, 'printing is off by default');
});

test('server print goes through IPP once a printer is configured', async () => {
  let r = await call('PUT', '/api/admin/settings', { siteTitle: 'My forms', printerUrl: 'ftp://nope', publicPrint: true }); assert.equal(r.status, 400);
  r = await call('PUT', '/api/admin/settings', { siteTitle: 'My forms', printerUrl: ippUrl, publicPrint: true, printButton: 'Print at school' }); assert.equal(r.status, 200);
  assert.equal((await r.json()).printButton, 'Print at school');
  assert.equal((await (await fetch(base + '/api/docs')).json()).title, 'My forms');
  let d = await (await fetch(base + '/api/d/' + doc.slug)).json(); assert.equal(d.serverPrint, true); assert.equal(d.printLabel, 'Print at school');
  // switched off per document
  doc = await (await call('PUT', '/api/admin/docs/' + doc.id, { ...doc, serverPrint: false })).json(); assert.equal(doc.serverPrint, false);
  d = await (await fetch(base + '/api/d/' + doc.slug)).json(); assert.equal(d.serverPrint, false);
  assert.equal((await fetch(base + '/api/d/' + doc.slug + '/print', { method: 'POST', headers: H, body: JSON.stringify({ values: { full_name: 'Jane' } }) })).status, 403);
  doc = await (await call('PUT', '/api/admin/docs/' + doc.id, { ...doc, serverPrint: true })).json();
  const miss = await fetch(base + '/api/d/' + doc.slug + '/print', { method: 'POST', headers: H, body: JSON.stringify({ values: {} }) });
  assert.equal(miss.status, 400); assert.match((await miss.json()).error, /Full name/);
  r = await fetch(base + '/api/d/' + doc.slug + '/print', { method: 'POST', headers: H, body: JSON.stringify({ values: { full_name: 'Jane' }, copies: 2 }) });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, jobId: 42 });
  const job = JSON.parse(fs.readFileSync(path.join(tmp, 'ipp', 'job.json'), 'utf8'));
  assert.equal(job.op, 2); assert.equal(job.attrs['document-format'], 'application/pdf'); assert.equal(job.attrs['job-name'], 'Sample form');
  assert.equal(job.attrs.copies, 2); assert.equal(job.attrs['printer-uri'], ippUrl.replace('http', 'ipp'));
  assert.equal(fs.readFileSync(path.join(tmp, 'ipp', 'printed.pdf')).subarray(0, 5).toString(), '%PDF-');
  // unreachable printer -> 502
  await call('PUT', '/api/admin/settings', { siteTitle: 'My forms', printerUrl: 'http://127.0.0.1:1/printers/x', publicPrint: true });
  r = await fetch(base + '/api/d/' + doc.slug + '/print', { method: 'POST', headers: H, body: JSON.stringify({ values: { full_name: 'Jane' } }) });
  assert.equal(r.status, 502);
});

test('a form password locks the public endpoints until unlocked', async () => {
  assert.equal((await call('PUT', '/api/admin/docs/' + doc.id, { ...doc, password: 'abcdefg' })).status, 400, 'too short: 8 characters minimum');
  doc = await (await call('PUT', '/api/admin/docs/' + doc.id, { ...doc, password: 'open-sesame' })).json();
  assert.equal(doc.protected, true); assert.equal(doc.password, undefined, 'the hash never leaves the server');
  assert.equal(db().docs[0].password.includes('open-sesame'), false);
  const pubList = await (await fetch(base + '/api/docs')).json(); assert.equal(pubList.docs[0].protected, true);
  for (const p of ['', '/render', '/image/stamp']) {
    const r = await fetch(base + '/api/d/' + doc.slug + p, p === '/render' ? { method: 'POST', headers: H, body: '{}' } : {});
    assert.equal(r.status, 401, p + ' is locked');
  }
  assert.equal((await call('GET', '/api/d/' + doc.slug)).status, 200, 'admins are never locked out');
  let r = await fetch(base + '/api/d/' + doc.slug + '/unlock', { method: 'POST', headers: H, body: JSON.stringify({ password: 'nope' }) }); assert.equal(r.status, 401);
  const sec = await fetch(base + '/api/d/' + doc.slug + '/unlock', { method: 'POST', headers: { ...H, 'X-Forwarded-Proto': 'https' }, body: JSON.stringify({ password: 'open-sesame' }) });
  assert.match(sec.headers.get('set-cookie'), /; Secure$/, 'behind an HTTPS proxy the unlock cookie is Secure');
  r = await fetch(base + '/api/d/' + doc.slug + '/unlock', { method: 'POST', headers: H, body: JSON.stringify({ password: 'open-sesame' }) }); assert.equal(r.status, 200);
  const uc = r.headers.get('set-cookie'); assert.match(uc, /^sf_u_[\w-]+=\d+\.[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200$/, 'unlock tokens carry their expiry');
  assert.equal((await fetch(base + '/api/d/' + doc.slug, { headers: { Cookie: uc.split(';')[0].replace(/=\d+\./, '=1.') } })).status, 401, 'an expired unlock token is refused');
  const ucookie = uc.split(';')[0];
  assert.equal((await fetch(base + '/api/d/' + doc.slug, { headers: { Cookie: ucookie } })).status, 200);
  assert.equal((await fetch(base + '/api/d/' + doc.slug + '/render', { method: 'POST', headers: { ...H, Cookie: ucookie }, body: JSON.stringify({ values: {} }) })).status, 200);
  // changing the password invalidates earlier unlocks; removing it opens the form again
  doc = await (await call('PUT', '/api/admin/docs/' + doc.id, { ...doc, password: 'other-one' })).json();
  assert.equal((await fetch(base + '/api/d/' + doc.slug, { headers: { Cookie: ucookie } })).status, 401);
  doc = await (await call('PUT', '/api/admin/docs/' + doc.id, { ...doc, password: '' })).json(); assert.equal(doc.protected, false);
  assert.equal((await fetch(base + '/api/d/' + doc.slug)).status, 200);
});

test('"sign out everywhere" rotates the secret: old sessions and unlock cookies die', async () => {
  const old = cookie;
  const r = await call('POST', '/api/admin/sessions/revoke'); assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + '/api/admin/me', { headers: { Cookie: old } })).status, 401);
  assert.equal((await call('GET', '/api/admin/me')).status, 200);
});

test('new link invalidates the old one; delete removes the PDF', async () => {
  const old = doc.slug;
  doc = await (await call('POST', '/api/admin/docs/' + doc.id + '/link')).json(); assert.notEqual(doc.slug, old);
  assert.equal((await fetch(base + '/api/d/' + old)).status, 404);
  assert.equal((await fetch(base + '/api/d/' + doc.slug)).status, 200);
  const pdfFile = path.join(process.env.DATA_DIR, 'pdfs', doc.id + '.pdf'); assert.ok(fs.existsSync(pdfFile));
  assert.equal((await call('DELETE', '/api/admin/docs/' + doc.id)).status, 200);
  assert.ok(!fs.existsSync(pdfFile)); assert.equal((await call('GET', '/api/admin/docs/' + doc.id)).status, 404);
  assert.ok(!fs.existsSync(path.join(app.IMAGES, imgName)), 'default images go with the document');
});

test('the printer can be probed before saving its URL', async () => {
  assert.equal((await call('POST', '/api/admin/printer/test', { url: 'ftp://nope' })).status, 400);
  assert.equal((await call('POST', '/api/admin/printer/test', { url: 'http://127.0.0.1:1/printers/x' })).status, 502);
  let r = await call('POST', '/api/admin/printer/test', { url: ippUrl }); assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.name, 'Test'); assert.equal(d.model, 'Mock IPP printer'); assert.equal(d.state, 'idle'); assert.deepEqual(d.reasons, []);
  assert.deepEqual(d.formats, ['application/pdf', 'image/pwg-raster', 'image/urf']); assert.equal(d.pdf, true);
  // a raster-only printer, like many home printers over IPP
  const raster = createMockIpp(path.join(tmp, 'ipp2'), { pdf: false }); await new Promise((ok) => raster.listen(0, '127.0.0.1', ok));
  try {
    const rasterUrl = 'http://127.0.0.1:' + raster.address().port + '/ipp/print';
    r = await call('POST', '/api/admin/printer/test', { url: rasterUrl }); const d2 = await r.json();
    assert.equal(d2.pdf, false); assert.deepEqual(d2.formats, ['image/urf', 'image/pwg-raster']);
    await call('PUT', '/api/admin/settings', { siteTitle: 'My forms', printerUrl: rasterUrl, publicPrint: true });
    const tmpDoc = await (await call('POST', '/api/admin/docs?title=raster-test', SAMPLE)).json(); // the main document is gone by now
    r = await call('POST', '/api/d/' + tmpDoc.slug + '/print', { values: {} }); // as admin: the detailed reason
    assert.equal(r.status, 502); assert.match((await r.json()).error, /0x040a: document format not supported .* CUPS/);
    await call('DELETE', '/api/admin/docs/' + tmpDoc.id);
  } finally { raster.closeAllConnections(); raster.close(); }
  assert.equal(app.ippStatusText(0x0406), 'IPP 0x0406: not found — check the path of the printer URL');
  assert.equal(app.ippStatusText(0x0999), 'IPP 0x0999');
});

test('printer failures are reported to admins and hidden from strangers', async () => {
  await call('PUT', '/api/admin/settings', { siteTitle: 'My forms', printerUrl: ippUrl, publicPrint: true });
  const expect = { 'http-error': [502, /HTTP 500/], 'short-answer': [502, /HTTP 200/], 'reject-me': [502, /rejected .*0x040a: document format not supported/], 'no-job-id': [200, null],
    redirect: [502, /not reachable/], huge: [502, /too large/] };
  let n = 0;
  for (const [title, [status, msg]] of Object.entries(expect)) {
    const d = await (await call('POST', '/api/admin/docs?title=' + title, SAMPLE)).json();
    const r = await call('POST', '/api/d/' + d.slug + '/print', { values: {} }); // as admin: full detail
    assert.equal(r.status, status, title);
    const j = await r.json(); if (msg) assert.match(j.error, msg); else assert.deepEqual(j, { ok: true, jobId: null });
    if (status === 502) { // anonymous: no addresses, no protocol details (each from its own address, the print limit is 10/min)
      const a = await fetch(base + '/api/d/' + d.slug + '/print', { method: 'POST', headers: { ...H, 'X-Forwarded-For': '192.0.2.' + ++n }, body: JSON.stringify({ values: {} }) });
      assert.equal(a.status, 502); assert.equal((await a.json()).error, 'The printer did not accept the job. Please try again later or ask the office.');
    }
    await call('DELETE', '/api/admin/docs/' + d.id);
  }
});

test('public printing is limited: 5 copies, 10 jobs per minute per client', async () => {
  const d = await (await call('POST', '/api/admin/docs?title=limits', SAMPLE)).json();
  const xff = { 'X-Forwarded-For': '198.51.100.7' };
  let r = await fetch(base + '/api/d/' + d.slug + '/print', { method: 'POST', headers: { ...H, ...xff }, body: JSON.stringify({ values: {}, copies: 20 }) });
  assert.equal(r.status, 200); assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'ipp', 'job.json'), 'utf8')).attrs.copies, 5, 'copies capped for anonymous users');
  let last = 200;
  for (let i = 0; i < 10 && last === 200; i++) last = (await fetch(base + '/api/d/' + d.slug + '/print', { method: 'POST', headers: { ...H, ...xff }, body: JSON.stringify({ values: {} }) })).status;
  assert.equal(last, 429);
  assert.equal((await call('POST', '/api/d/' + d.slug + '/print', { values: {}, copies: 20 })).status, 200, 'admins are not limited');
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'ipp', 'job.json'), 'utf8')).attrs.copies, 20);
  await call('DELETE', '/api/admin/docs/' + d.id);
});

test('a server-wide brake stops password guessing even from many addresses, per purpose', async () => {
  const now = Date.now(); app.authFails.set('login', Array.from({ length: 50 }, () => now));
  const r = await call('POST', '/api/login', { password: 'api-pass-123' }, { 'X-Forwarded-For': '203.0.113.' + Math.floor(Math.random() * 200) });
  assert.equal(r.status, 429); assert.match((await r.json()).error, /on this server/);
  // guessing a form password does not touch the admin login brake and vice versa
  const locked = await (await call('POST', '/api/admin/docs?title=brake', SAMPLE)).json();
  await call('PUT', '/api/admin/docs/' + locked.id, { ...locked, password: 'open-sesame' });
  const u = await fetch(base + '/api/d/' + locked.slug + '/unlock', { method: 'POST', headers: H, body: JSON.stringify({ password: 'open-sesame' }) });
  assert.equal(u.status, 200, 'unlocking still works while the login brake is on');
  app.authFails.clear();
  assert.equal((await call('POST', '/api/login', { password: 'api-pass-123' })).status, 200);
  await call('DELETE', '/api/admin/docs/' + locked.id);
});

test('a server-wide render budget answers 429 once everyone together renders too much', async () => {
  process.env.RENDER_LIMIT_GLOBAL = '3';
  const d = await (await call('POST', '/api/admin/docs?title=budget', SAMPLE)).json();
  let last = 200;
  for (let i = 0; i < 6 && last === 200; i++) last = (await fetch(base + '/api/d/' + d.slug + '/render', { method: 'POST', headers: { ...H, 'X-Forwarded-For': '198.18.0.' + i }, body: JSON.stringify({ values: {} }) })).status;
  assert.equal(last, 429, 'different addresses share the global budget');
  assert.equal((await call('POST', '/api/d/' + d.slug + '/render', { values: {} })).status, 200, 'admins are not budgeted');
  delete process.env.RENDER_LIMIT_GLOBAL;
  await call('DELETE', '/api/admin/docs/' + d.id);
});

test('the audit log records admin actions and print jobs without form values', async () => {
  const log = fs.readFileSync(path.join(app.DATA, 'audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const ev of ['login.ok', 'login.fail', 'settings.update', 'doc.create', 'doc.delete', 'print', 'print.fail', 'sessions.revoke', 'doc.password.set']) assert.ok(log.some((e) => e.event === ev), ev + ' is logged');
  assert.ok(!JSON.stringify(log).includes('Jane'), 'no form values');
  assert.ok(log.every((e) => e.t && e.ip));
});

test('logout clears the session; repeated failures are rate limited per client IP', async () => {
  const r = await call('POST', '/api/logout'); assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
  cookie = ''; assert.equal((await call('GET', '/api/admin/me')).status, 401);
  const xff = { 'X-Forwarded-For': '203.0.113.9, 10.0.0.1' }; // TRUST_PROXY=1: the last entry is what the trusted proxy appended, i.e. the client
  let last;
  for (let i = 0; i < 6; i++) last = (await call('POST', '/api/login', { password: 'wrong' }, xff)).status;
  assert.equal(last, 429);
  assert.equal((await call('POST', '/api/login', { password: 'wrong' })).status, 401, 'other clients are not blocked');
  assert.equal((await call('POST', '/api/login', { password: 'api-pass-123' }, xff)).status, 429, 'blocked even with the right password');
});
