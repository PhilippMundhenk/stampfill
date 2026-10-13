// HTTP API tests against an in-process server and an in-process mock IPP printer (no browser).
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stampfill-api-'));
process.env.DATA_DIR = path.join(tmp, 'data'); process.env.ADMIN_PASSWORD = 'api-pass-123';
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

test('healthz answers', async () => {
  const r = await fetch(base + '/healthz'); assert.equal(r.status, 200);
  const j = await r.json(); assert.equal(j.ok, true); assert.equal(typeof j.version, 'string');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('pages are served with security headers', async () => {
  for (const p of ['/', '/admin', '/d/whatever']) {
    const r = await fetch(base + p); assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  }
  assert.equal((await fetch(base + '/nope')).status, 404);
  assert.equal((await fetch(base + '/vendor/../package.json')).status, 404);
  assert.equal((await fetch(base + '/vendor/pdf.mjs')).status, 200);
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
  const sc = r.headers.get('set-cookie'); assert.match(sc, /^sf_s=\d+\.[\w-]+; Path=\/; HttpOnly; SameSite=Strict/);
  cookie = sc.split(';')[0];
  const me = await (await call('GET', '/api/admin/me')).json(); assert.deepEqual(me, { ok: true, envPassword: true });
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
  assert.equal((await call('GET', '/api/admin/docs/zzz')).status, 404);
});

let imgName;
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
  assert.equal((await call('PUT', '/api/admin/docs/' + doc.id, { ...doc, password: 'abc' })).status, 400, 'too short');
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
  r = await fetch(base + '/api/d/' + doc.slug + '/unlock', { method: 'POST', headers: H, body: JSON.stringify({ password: 'open-sesame' }) }); assert.equal(r.status, 200);
  const uc = r.headers.get('set-cookie'); assert.match(uc, /^sf_u_[\w-]+=[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200$/);
  const ucookie = uc.split(';')[0];
  assert.equal((await fetch(base + '/api/d/' + doc.slug, { headers: { Cookie: ucookie } })).status, 200);
  assert.equal((await fetch(base + '/api/d/' + doc.slug + '/render', { method: 'POST', headers: { ...H, Cookie: ucookie }, body: JSON.stringify({ values: {} }) })).status, 200);
  // changing the password invalidates earlier unlocks; removing it opens the form again
  doc = await (await call('PUT', '/api/admin/docs/' + doc.id, { ...doc, password: 'other-one' })).json();
  assert.equal((await fetch(base + '/api/d/' + doc.slug, { headers: { Cookie: ucookie } })).status, 401);
  doc = await (await call('PUT', '/api/admin/docs/' + doc.id, { ...doc, password: '' })).json(); assert.equal(doc.protected, false);
  assert.equal((await fetch(base + '/api/d/' + doc.slug)).status, 200);
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

test('logout clears the session; repeated failures are rate limited', async () => {
  const r = await call('POST', '/api/logout'); assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
  cookie = ''; assert.equal((await call('GET', '/api/admin/me')).status, 401);
  let last;
  for (let i = 0; i < 6; i++) last = (await call('POST', '/api/login', { password: 'wrong' })).status;
  assert.equal(last, 429);
});
