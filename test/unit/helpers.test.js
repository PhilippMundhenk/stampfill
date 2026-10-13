'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stampfill-unit-'));
process.env.DATA_DIR = tmp; process.env.ADMIN_PASSWORD = 'unit-pass-123';
const app = require('../../stampfill.js');
const SAMPLE = path.join(__dirname, '..', 'fixtures', 'sample-form.pdf');

test('keyOf normalises labels into safe keys', () => {
  assert.equal(app.keyOf('Full name'), 'full_name');
  assert.equal(app.keyOf('  Straße / Nr.  '), 'stra_e_nr');
  assert.equal(app.keyOf('Ärger-Öl'), 'arger_ol');
  assert.equal(app.keyOf(''), 'field');
  assert.equal(app.keyOf('x'.repeat(100)).length, 40);
});

test('fmtDate reformats ISO dates and leaves other input alone', () => {
  assert.equal(app.fmtDate('2026-10-13', 'DD.MM.YYYY'), '13.10.2026');
  assert.equal(app.fmtDate('2026-10-13', 'MM/DD/YYYY'), '10/13/2026');
  assert.equal(app.fmtDate('2026-10-13', 'YYYY-MM-DD'), '2026-10-13');
  assert.equal(app.fmtDate('13.10.2026', 'YYYY-MM-DD'), '13.10.2026');
  assert.equal(app.fmtDate('', 'YYYY-MM-DD'), '');
});

test('cleanFields sanitises, defaults and de-duplicates keys', () => {
  const out = app.cleanFields([
    { label: 'Name', type: 'text', x: '10.26', y: 20, page: 9, size: 999, required: 'yes' },
    { label: 'Name', type: 'bogus', prefill: 'instance', value: 'fixed', dateFormat: 'nope' },
    { id: 'abcd1234', key: 'CUSTOM Key', label: '', type: 'checkbox', page: 0 },
  ], 2);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((f) => f.key), ['name', 'name_2', 'custom_key']);
  assert.equal(out[0].x, 10.3); assert.equal(out[0].page, 2); assert.equal(out[0].size, 72); assert.equal(out[0].required, true);
  assert.equal(out[1].type, 'text'); assert.equal(out[1].value, 'fixed'); assert.equal(out[1].dateFormat, 'DD.MM.YYYY');
  assert.equal(out[2].id, 'abcd1234'); assert.equal(out[2].label, 'custom_key'); assert.equal(out[2].page, 1);
  assert.match(out[0].id, /^[\w-]{4,24}$/);
  const pre = app.cleanFields([{ label: 'When', type: 'date', prefill: 'today' }, { label: 'Who', type: 'text', prefill: 'today' }], 1);
  assert.equal(pre[0].prefill, 'today', 'today is allowed on date fields'); assert.equal(pre[1].prefill, 'none', 'today is dropped on other types');
  const st = app.cleanFields([{ label: 'Note', type: 'static', value: 'Fixed\ntext', required: true, prefill: 'browser' }], 1)[0];
  assert.equal(st.type, 'static'); assert.equal(st.value, 'Fixed\ntext'); assert.equal(st.required, false); assert.equal(st.prefill, 'none');
  assert.deepEqual(app.cleanFields('not a list', 1), []);
  assert.equal(app.cleanFields(Array.from({ length: 300 }, (_, i) => ({ label: 'f' + i })), 1).length, 200);
});

test('cleanTags trims, de-duplicates and caps', () => {
  assert.deepEqual(app.cleanTags([' a ', 'b', 'a', '', 3]), ['a', 'b', '3']);
  assert.equal(app.cleanTags(Array.from({ length: 50 }, (_, i) => 't' + i)).length, 20);
  assert.deepEqual(app.cleanTags(null), []);
});

test('cleanValues stringifies and bounds submitted values', () => {
  assert.deepEqual(app.cleanValues({ a: 1, b: null, c: 'x'.repeat(5000) }), { a: '1', b: '', c: 'x'.repeat(4000) });
  assert.deepEqual(app.cleanValues('nope'), {});
});

test('checkPw compares against ADMIN_PASSWORD', () => {
  assert.equal(app.checkPw('unit-pass-123'), true);
  assert.equal(app.checkPw('unit-pass-124'), false);
  assert.equal(app.checkPw(undefined), false);
  const h = app.hashPw('secret'); assert.match(h, /^[\w-]+:[0-9a-f]{64}$/);
});

test('inspectPdf rejects non-PDF input and counts pages', async () => {
  await assert.rejects(app.inspectPdf(Buffer.from('hello')), /not a PDF/);
  await assert.rejects(app.inspectPdf(Buffer.from('%PDF-1.4 garbage')), /Could not read/);
  assert.equal(await app.inspectPdf(fs.readFileSync(SAMPLE)), 1);
});

test('renderPdf stamps values onto the template', async (t) => {
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.copyFileSync(SAMPLE, path.join(tmp, 'pdfs', 'doc1.pdf'));
  const fields = app.cleanFields([
    { label: 'Name', x: 100, y: 700 }, { label: 'When', type: 'date', x: 100, y: 680, dateFormat: 'DD.MM.YYYY' },
    { label: 'Agree', type: 'checkbox', x: 100, y: 660 }, { label: 'Notes', type: 'textarea', x: 100, y: 640, maxWidth: 200 },
  ], 1);
  fields.push(...app.cleanFields([{ label: 'Note', type: 'static', value: 'Do not write below', x: 100, y: 600 }], 1));
  const pdf = await app.renderPdf({ id: 'doc1' }, fields, { name: 'Jürgen Müller', when: '2026-10-13', agree: '1', notes: 'line one\nline two', note: 'ignored' });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > fs.statSync(SAMPLE).size, 'output should contain added content');
  const { PDFDocument } = require('pdf-lib');
  assert.equal((await PDFDocument.load(pdf)).getPageCount(), 1);
});
