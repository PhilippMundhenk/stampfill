// Moving saved values between devices: the file format is checked strictly, and an import never
// deletes or overwrites a value that is newer on the receiving device.
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stampfill-saved-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.DATA_DIR = tmp; process.env.ADMIN_PASSWORD = 'saved-pass-123';
const app = require('../../stampfill.js');

const DAY = 86400000, NOW = Date.UTC(2026, 0, 15, 12), TTL = 30 * DAY;
const file = (o) => JSON.stringify({ stampfill: 'saved-values', version: 1, entries: {}, ...o });

test('parseSaved accepts the exported format and keeps entries with their timestamps', () => {
  const out = app.parseSaved(file({ days: 7, entries: { full_name: { v: 'Erika Mustermann', t: NOW }, 'groups:abc': { v: { Applicant: true }, t: NOW - DAY }, legacy: { v: 'x' } } }));
  assert.deepEqual(out, { days: 7, entries: { full_name: { v: 'Erika Mustermann', t: NOW }, 'groups:abc': { v: { Applicant: true }, t: NOW - DAY }, legacy: { v: 'x', t: 0 } } });
});

test('parseSaved rejects anything that is not a saved-values file', () => {
  for (const bad of ['', 'not json', 'null', '[]', '{}', file({ stampfill: 'other' }), file({ version: 2 }), file({ entries: [] }), file({ entries: null }), 42, 'x'.repeat(20e6 + 1)]) {
    assert.throws(() => app.parseSaved(bad), /bad/, String(bad).slice(0, 40));
  }
});

test('parseSaved drops reserved, malformed and oversized entries and bad day counts', () => {
  const out = app.parseSaved(file({ days: 99999, entries: {
    lang: { v: 'de', t: NOW }, remember: { v: '1', t: NOW }, days: { v: '5', t: NOW }, docOpen: { v: '0', t: NOW }, // device settings, not values
    'bad key!': { v: 'x', t: NOW }, ['k'.repeat(121)]: { v: 'x', t: NOW }, empty: { v: '', t: NOW }, num: { v: 5, t: NOW }, arr: { v: ['a'], t: NOW },
    mixed: { v: { a: true, b: 'no' }, t: NOW }, nul: null, str: 'plain', big: { v: 'x'.repeat(5e6 + 1), t: NOW }, neg: { v: 'ok', t: -5 }, inf: { v: 'ok', t: Infinity },
  } }));
  assert.equal(out.days, null);
  assert.deepEqual(out.entries, { neg: { v: 'ok', t: 0 }, inf: { v: 'ok', t: 0 } });
  assert.equal(app.parseSaved(file({ days: '12' })).days, 12);
  assert.equal(app.parseSaved(file({ days: 0 })).days, null);
});

test('mergeSaved adds missing values, updates older ones and keeps newer or equal ones', () => {
  const local = { a: { v: 'mine', t: NOW - 2 * DAY }, b: { v: 'mine, newer', t: NOW }, c: { v: 'same', t: NOW - 5 * DAY }, legacy: { v: 'old format', t: 0 } };
  const incoming = { a: { v: 'theirs', t: NOW - DAY }, b: { v: 'theirs, older', t: NOW - DAY }, c: { v: 'same', t: NOW - DAY }, legacy: { v: 'new', t: NOW - DAY }, d: { v: 'new key', t: NOW - DAY } };
  const r = app.mergeSaved(local, incoming, NOW, TTL);
  assert.deepEqual(r.set, { a: { v: 'theirs', t: NOW - DAY }, legacy: { v: 'new', t: NOW - DAY }, d: { v: 'new key', t: NOW - DAY } });
  assert.deepEqual([r.added, r.updated, r.kept], [1, 2, 2]);
  assert.ok(!('b' in r.set) && !('c' in r.set), 'nothing newer or identical on this device is touched');
});

test('mergeSaved skips expired values and dates undated ones to the import', () => {
  const r = app.mergeSaved({}, { old: { v: 'x', t: NOW - TTL - 1 }, undated: { v: 'y', t: 0 }, groups: { v: { G: false }, t: NOW } }, NOW, TTL);
  assert.deepEqual(r.set, { undated: { v: 'y', t: NOW }, groups: { v: { G: false }, t: NOW } });
  assert.deepEqual([r.added, r.updated, r.kept], [2, 0, 0]);
  const same = app.mergeSaved({ groups: { v: { G: false }, t: 1 } }, { groups: { v: { G: false }, t: NOW } }, NOW, TTL);
  assert.deepEqual([same.added, same.updated, same.kept], [0, 0, 1], 'equal objects count as unchanged');
});

test('the public page carries both functions, the admin page does not', async () => {
  const srv = await app.start({ port: 0, host: '127.0.0.1' }), base = 'http://127.0.0.1:' + srv.address().port;
  try {
    const pub = await (await fetch(base + '/')).text(), adm = await (await fetch(base + '/admin')).text();
    assert.match(pub, /function parseSaved\(text\)/); assert.match(pub, /function mergeSaved\(local, incoming, now, ttl\)/);
    assert.doesNotMatch(adm, /function parseSaved/);
  } finally { app.server.close(); }
});
