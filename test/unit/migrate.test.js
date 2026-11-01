// Boots the service on a data directory written by version 1.0.0 and checks that everything
// still works. Every change to the stored format must keep this test green: it is the upgrade path
// of real installations. Runs in its own process because stampfill.js reads DATA_DIR at load time.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stampfill-migrate-'));
const DATA = path.join(tmp, 'data');
fs.mkdirSync(path.join(DATA, 'pdfs'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'db-v1.json'), path.join(DATA, 'db.json'));
fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'sample-form.pdf'), path.join(DATA, 'pdfs', 'legacyDoc1.pdf'));
process.env.DATA_DIR = DATA; delete process.env.ADMIN_PASSWORD; // 1.0.0 installs may rely on the stored password hash

const app = require('../../stampfill.js');
let base;
before(async () => { base = 'http://127.0.0.1:' + (await app.start({ port: 0, host: '127.0.0.1' })).address().port; });
after(() => { app.server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('settings and documents from 1.0.0 are kept and completed with defaults', () => {
  assert.equal(app.db.settings.siteTitle, 'Town hall forms');
  assert.equal(app.db.settings.publicPrint, true);
  assert.equal(app.db.secret, 'v1-secret-not-random', 'sessions survive the upgrade');
  assert.match(app.db.auth, /^legacysalt:/, 'the stored admin password is untouched');
  const d = app.db.docs[0];
  assert.equal(d.slug, 'AbCdEfGhIj', 'links handed out before the upgrade keep working');
  assert.equal(d.fields.length, 4);
  for (const f of d.fields) { assert.ok(f.id); assert.ok(f.key); assert.ok(['none', 'browser', 'instance', 'url', 'today'].includes(f.prefill)); assert.equal(typeof f.hidden, 'boolean'); assert.equal(f.height, 0); }
  assert.equal(d.serverPrint, true, 'server printing stays allowed for old documents'); assert.equal(d.password, null);
  assert.deepEqual(d.rotation, [0]);
  assert.equal(d.fields[2].hidden, false, 'an old fixed-value field stays visible; only new ones are hidden by default');
  assert.equal(d.fields[0].required, true);
  assert.equal(d.fields[2].value, 'Office Musterstadt');
  const saved = JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8'));
  assert.equal(saved.docs[0].fields.length, 4, 'the migrated state is written back');
});

test('public and admin endpoints serve the migrated document', async () => {
  const list = await (await fetch(base + '/api/docs')).json();
  assert.equal(list.title, 'Town hall forms'); assert.equal(list.docs.length, 1); assert.equal(list.docs[0].slug, 'AbCdEfGhIj');
  const d = await (await fetch(base + '/api/d/AbCdEfGhIj')).json();
  assert.equal(d.title, 'Library card request'); assert.equal(d.fields.length, 4);
  assert.equal(d.fields.find((f) => f.key === 'issued_by').value, 'Office Musterstadt');
  const r = await fetch(base + '/api/d/AbCdEfGhIj/render', { method: 'POST', headers: { 'X-Requested-With': 'stampfill' }, body: JSON.stringify({ values: { full_name: 'Old User', date: '2026-10-13', agree: '1' } }) });
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.match((fs.statSync(path.join(DATA, 'db.json')).mode & 0o777).toString(8), /^(600|666)$/, 'db.json is private (Windows reports 666)');
});

test('the stored admin password still logs in and can be changed (no ADMIN_PASSWORD set)', async () => {
  const H = { 'X-Requested-With': 'stampfill' };
  const login = (password, extra = {}) => fetch(base + '/api/login', { method: 'POST', headers: { ...H, ...extra }, body: JSON.stringify({ password }) });
  assert.equal((await login('nope')).status, 401);
  let r = await login('legacy-pass-123', { 'X-Forwarded-Proto': 'https' }); assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /; Secure$/, 'behind an HTTPS proxy the cookie is Secure');
  const old = r.headers.get('set-cookie').split(';')[0];
  const me = await (await fetch(base + '/api/admin/me', { headers: { Cookie: old } })).json(); assert.deepEqual(me, { ok: true, envPassword: false });
  const change = (body, c = old) => fetch(base + '/api/admin/password', { method: 'POST', headers: { ...H, Cookie: c }, body: JSON.stringify(body) });
  assert.equal((await change({ current: 'wrong', next: 'new-pass-456' })).status, 403);
  assert.equal((await change({ current: 'legacy-pass-123', next: 'short' })).status, 400);
  r = await change({ current: 'legacy-pass-123', next: 'new-pass-456' }); assert.equal(r.status, 200);
  const fresh = r.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + '/api/admin/me', { headers: { Cookie: old } })).status, 401, 'other sessions are signed out');
  assert.equal((await fetch(base + '/api/admin/me', { headers: { Cookie: fresh } })).status, 200);
  assert.equal((await login('legacy-pass-123')).status, 401); assert.equal((await login('new-pass-456')).status, 200);
});

test('migration is idempotent', () => {
  const once = JSON.stringify(app.db);
  app.migrate(); app.migrate();
  assert.equal(JSON.stringify(app.db), once);
});

test('documents saved by 1.1.0 with scattered group members are reordered into blocks', () => {
  const doc = app.db.docs[0], was = doc.fields;
  doc.fields = [{ ...was[0], id: 'g1aa', key: 'g1aa', group: 'One' }, { ...was[0], id: 'loose', key: 'loose', group: '' }, { ...was[0], id: 'g1bb', key: 'g1bb', group: 'One' }];
  app.migrate();
  assert.deepEqual(doc.fields.map((f) => f.key), ['g1aa', 'g1bb', 'loose']);
  doc.fields = was; app.migrate();
});

test('older documents get the group folding defaults and the retention default', () => {
  assert.equal(app.db.settings.rememberDays, 30); assert.equal(app.db.settings.rememberDefault, true);
  for (const d of app.db.docs) { assert.deepEqual(d.collapsed, []); assert.equal(d.rememberGroups, true); }
});
