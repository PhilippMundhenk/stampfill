// The data of one form travels as a file: the format is checked strictly before anything is filled in.
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stampfill-formdata-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.DATA_DIR = tmp; process.env.ADMIN_PASSWORD = 'formdata-pass-123';
const app = require('../../stampfill.js');

const file = (o) => JSON.stringify({ stampfill: 'form-data', version: 1, form: 'abc123', title: 'Library card', values: {}, ...o });

test('parseFormData accepts the exported format', () => {
  const sig = 'data:image/png;base64,iVBORw0KGgo=';
  assert.deepEqual(app.parseFormData(file({ values: { full_name: 'Erika Mustermann', agree: '1', birthday: '1990-02-01', signature: sig, empty: '' } })),
    { form: 'abc123', title: 'Library card', values: { full_name: 'Erika Mustermann', agree: '1', birthday: '1990-02-01', signature: sig, empty: '' } });
});

test('parseFormData rejects anything that is not a form-data file', () => {
  for (const bad of ['', 'not json', 'null', '[]', '{}', file({ stampfill: 'saved-values' }), file({ version: 2 }), file({ values: [] }), file({ values: null }), file({ values: 'x' }), 42, 'x'.repeat(20e6 + 1)]) {
    assert.throws(() => app.parseFormData(bad), /bad/, String(bad).slice(0, 40));
  }
});

test('parseFormData drops malformed values and trims the header fields', () => {
  const out = app.parseFormData(JSON.stringify({ stampfill: 'form-data', version: 1, form: 'f'.repeat(100), title: 7, values: {
    ok: 'yes', 'bad key!': 'x', ['k'.repeat(81)]: 'x', num: 5, obj: { a: 1 }, nul: null, big: 'x'.repeat(5e6 + 1),
  } }));
  assert.deepEqual(out, { form: 'f'.repeat(80), title: '', values: { ok: 'yes' } });
});

test('the public page carries the function, the admin page does not', async () => {
  const srv = await app.start({ port: 0, host: '127.0.0.1' }), base = 'http://127.0.0.1:' + srv.address().port;
  try {
    const pub = await (await fetch(base + '/')).text(), adm = await (await fetch(base + '/admin')).text();
    assert.match(pub, /function parseFormData\(text\)/); assert.doesNotMatch(adm, /function parseFormData/);
  } finally { app.server.close(); }
});
