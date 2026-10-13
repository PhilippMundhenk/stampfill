// Behaviour of stampfill.js as a process: startup checks, generated password, listening, shutdown.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');

const MAIN = path.join(__dirname, '..', '..', 'stampfill.js');
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
function run(env, { wait = /listening on|not writable/, timeout = 15000 } = {}) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [MAIN], { env: { ...process.env, ADMIN_PASSWORD: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const finish = (code) => { if (done) return; done = true; ok({ child, out, err, code }); };
    child.stdout.on('data', (d) => { out += d; if (wait.test(out)) finish(null); });
    child.stderr.on('data', (d) => { err += d; if (wait.test(err)) finish(null); });
    child.on('exit', (code) => finish(code));
    setTimeout(() => finish('timeout'), timeout).unref();
  });
}

test('refuses to start when the data directory is not writable', async () => {
  const file = path.join(os.tmpdir(), 'stampfill-not-a-dir-' + process.pid); fs.writeFileSync(file, 'x');
  const r = await run({ DATA_DIR: file }, { wait: /never/ });
  assert.equal(r.code, 1);
  assert.match(r.err, /data directory .* is not writable by (uid \d+ \/ gid \d+|this user)/);
  assert.match(r.err, /PUID\/PGID/);
  fs.rmSync(file, { force: true });
});

test('generates and prints an admin password on first start, listens, and stops on SIGTERM', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stampfill-proc-')), port = await freePort();
  const r = await run({ DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1' });
  try {
    assert.equal(r.code, null, 'still running: ' + r.err);
    assert.match(r.out, /Generated admin password: [\w-]{12,}/);
    assert.match(r.out, new RegExp('listening on http://127\\.0\\.0\\.1:' + port));
    const db = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
    assert.match(db.auth, /^[\w-]+:[0-9a-f]{64}$/, 'the generated password is stored hashed');
    const h = await (await fetch('http://127.0.0.1:' + port + '/healthz')).json(); assert.equal(h.ok, true);
    const exit = new Promise((ok) => r.child.on('exit', (code, sig) => ok({ code, sig })));
    r.child.kill('SIGTERM');
    const e = await exit;
    if (process.platform !== 'win32') assert.equal(e.code, 0, 'graceful shutdown'); // Windows has no SIGTERM handlers; kill() is forceful
  } finally { if (r.child.exitCode === null) r.child.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('reads the admin password from ADMIN_PASSWORD_FILE', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stampfill-proc-')), port = await freePort(), pwFile = path.join(dir, 'admin.secret');
  fs.writeFileSync(pwFile, 'from-the-file-123\n');
  const r = await run({ DATA_DIR: path.join(dir, 'data'), PORT: String(port), HOST: '127.0.0.1', ADMIN_PASSWORD_FILE: pwFile });
  try {
    assert.equal(r.code, null, r.err);
    const login = (password) => fetch('http://127.0.0.1:' + port + '/api/login', { method: 'POST', headers: { 'X-Requested-With': 'stampfill' }, body: JSON.stringify({ password }) });
    assert.equal((await login('from-the-file-123')).status, 200); assert.equal((await login('nope')).status, 401);
    assert.ok(!r.out.includes('Generated admin password'));
  } finally { if (r.child.exitCode === null) r.child.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
  const bad = await run({ DATA_DIR: path.join(dir, 'data'), PORT: String(port), ADMIN_PASSWORD_FILE: path.join(dir, 'missing') }, { wait: /never/ });
  assert.equal(bad.code, 1); assert.match(bad.err, /cannot read .*missing/);
});

test('exits with the error when the port is taken', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stampfill-proc-'));
  const blocker = net.createServer(); await new Promise((ok) => blocker.listen(0, '127.0.0.1', ok));
  const port = blocker.address().port;
  const r = await run({ DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1' }, { wait: /never/ });
  try {
    assert.equal(r.code, 1);
    assert.match(r.err, /EADDRINUSE/);
  } finally { blocker.close(); if (r.child.exitCode === null) r.child.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});
