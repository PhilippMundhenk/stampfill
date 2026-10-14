'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stampfill-unit-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
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

test('slugOf makes readable link names', () => {
  assert.equal(app.slugOf('Library card request'), 'library-card-request');
  assert.equal(app.slugOf('  Antrag: Schülerausweis (2026)  '), 'antrag-schulerausweis-2026');
  assert.equal(app.slugOf('???'), '');
  assert.equal(app.slugOf('a'.repeat(100)).length, 60);
});

test('the template cache is bounded and drops the least recently used entry', () => {
  fs.mkdirSync(path.join(tmp, 'pdfs'), { recursive: true });
  app.pdfCache.clear();
  const big = Buffer.alloc(Math.floor(app.PDF_CACHE_MAX / 2) + 1024, 1); // two of these do not fit together
  for (const id of ['c1', 'c2', 'c3']) fs.writeFileSync(path.join(tmp, 'pdfs', id + '.pdf'), big);
  app.readTemplate('c1'); app.readTemplate('c2');
  assert.deepEqual([...app.pdfCache.keys()], ['c2'], 'c1 was evicted to make room');
  app.readTemplate('c2'); app.readTemplate('c3');
  assert.deepEqual([...app.pdfCache.keys()], ['c3']);
  fs.writeFileSync(path.join(tmp, 'pdfs', 'huge.pdf'), Buffer.alloc(app.PDF_CACHE_MAX + 1, 1));
  assert.equal(app.readTemplate('huge').length, app.PDF_CACHE_MAX + 1); assert.ok(!app.pdfCache.has('huge'), 'oversized templates are read but not cached');
  app.pdfCache.clear(); for (const id of ['c1', 'c2', 'c3', 'huge']) fs.rmSync(path.join(tmp, 'pdfs', id + '.pdf'));
});

test('fields keep their order and carry a trimmed group name', () => {
  const out = app.cleanFields([{ label: 'B', group: '  Applicant  ' }, { label: 'A', group: 'x'.repeat(80) }, { label: 'C' }], 1);
  assert.deepEqual(out.map((f) => f.label), ['B', 'A', 'C']);
  assert.equal(out[0].group, 'Applicant'); assert.equal(out[1].group.length, 40); assert.equal(out[2].group, '');
});

test('named groups become contiguous blocks; loose fields keep their place', () => {
  const out = app.cleanFields([{ label: 'A', group: 'G1' }, { label: 'B' }, { label: 'C', group: 'G2' }, { label: 'D', group: 'G1' }, { label: 'E' }, { label: 'F', group: 'G2' }], 1);
  assert.deepEqual(out.map((f) => f.label), ['A', 'D', 'B', 'C', 'F', 'E']);
  assert.deepEqual(app.groupOrder([]), []);
});

test('hidden fields are never required; static fields are never hidden', () => {
  const [a, b] = app.cleanFields([{ label: 'A', hidden: true, required: true }, { label: 'B', type: 'static', hidden: true, value: 'x' }], 1);
  assert.equal(a.hidden, true); assert.equal(a.required, false);
  assert.equal(b.hidden, false);
});

test('cleanRotation gives one clamped angle per page', () => {
  assert.deepEqual(app.cleanRotation([3.26, 'x', 400, -500], 3), [3.3, 0, 180]);
  assert.deepEqual(app.cleanRotation(undefined, 2), [0, 0]);
  assert.deepEqual(app.cleanRotation('nope', 1), [0]);
});

test('renderPdf rotates pages by any angle; quarter turns swap the page size', async () => {
  fs.mkdirSync(path.join(tmp, 'pdfs'), { recursive: true });
  fs.copyFileSync(SAMPLE, path.join(tmp, 'pdfs', 'rot.pdf'));
  const { PDFDocument } = require('pdf-lib');
  const size = async (rotation) => { const p = await PDFDocument.load(await app.renderPdf({ id: 'rot', rotation }, app.cleanFields([{ label: 'A', x: 50, y: 50 }], 1), { a: 'x' })); return [p.getPageCount(), p.getPage(0).getWidth(), p.getPage(0).getHeight()]; };
  assert.deepEqual(await size([0]), [1, 595, 842]);
  assert.deepEqual(await size([2.5]), [1, 595, 842], 'small angles keep the page size');
  assert.deepEqual(await size([90]), [1, 842, 595]);
  assert.deepEqual(await size([-90]), [1, 842, 595]);
  assert.deepEqual(await size([180]), [1, 595, 842]);
  assert.deepEqual(await size(undefined), [1, 595, 842]);
});

test('fmtDate reformats ISO dates and leaves other input alone', () => {
  assert.equal(app.fmtDate('2026-10-13', 'DD.MM.YYYY'), '13.10.2026');
  assert.equal(app.fmtDate('2026-10-13', 'MM/DD/YYYY'), '10/13/2026');
  assert.equal(app.fmtDate('2026-10-13', 'YYYY-MM-DD'), '2026-10-13');
  assert.equal(app.fmtDate('13.10.2026', 'YYYY-MM-DD'), '13.10.2026');
  assert.equal(app.fmtDate('', 'YYYY-MM-DD'), '');
});

test('toIso accepts common date notations', () => {
  assert.equal(app.toIso('2026-10-13', 'DD.MM.YYYY'), '2026-10-13');
  assert.equal(app.toIso('13.10.2026', 'DD.MM.YYYY'), '2026-10-13');
  assert.equal(app.toIso('1.2.1990', 'DD.MM.YYYY'), '1990-02-01');
  assert.equal(app.toIso('13/10/2026', 'DD/MM/YYYY'), '2026-10-13');
  assert.equal(app.toIso('10/13/2026', 'MM/DD/YYYY'), '2026-10-13');
  assert.equal(app.toIso('2026/10/13', 'MM/DD/YYYY'), '2026-10-13');
  assert.equal(app.toIso('13.10.26', 'DD.MM.YYYY'), '2026-10-13');
  assert.equal(app.toIso('32.10.2026', 'DD.MM.YYYY'), '32.10.2026', 'invalid stays as typed');
  assert.equal(app.toIso('next week', 'DD.MM.YYYY'), 'next week');
  assert.equal(app.toIso('', 'DD.MM.YYYY'), '');
});

test('fixed dates are stored as ISO and used for the editor preview', () => {
  const [bday, plain] = app.cleanFields([
    { label: 'Birthday', type: 'date', prefill: 'instance', value: '01.02.1990' },
    { label: 'When', type: 'date', prefill: 'today' },
  ], 1);
  assert.equal(bday.value, '1990-02-01');
  const sample = app.sampleValues([bday, plain]);
  assert.equal(sample.birthday, '1990-02-01', 'preview shows the fixed date, not today');
  assert.match(sample.when, /^\d{4}-\d{2}-\d{2}$/);
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// draw sizes of images in a rendered page: the "w 0 0 h x y cm" operators of its content streams
async function drawSizes(pdfBytes) {
  const { PDFDocument } = require('pdf-lib'), zlib = require('zlib');
  const doc = await PDFDocument.load(pdfBytes), page = doc.getPage(0), c = page.node.Contents(), refs = c.asArray ? c.asArray() : [c];
  let text = '';
  for (const ref of refs) { const s = doc.context.lookup(ref); let b = Buffer.from(s.contents); try { b = zlib.inflateSync(b); } catch (e) { /* raw stream */ } text += b.toString('latin1'); }
  return { text, sizes: [...text.matchAll(/([\d.]+) 0 0 ([\d.]+) [\d.]+ [\d.]+ cm/g)].map((m) => [+m[1], +m[2]]).filter(([w]) => w !== 1) };
}

test('image sizes: explicit width, optional height box, placeholder only in previews', async () => {
  fs.mkdirSync(path.join(tmp, 'pdfs'), { recursive: true }); fs.copyFileSync(SAMPLE, path.join(tmp, 'pdfs', 'sz.pdf'));
  const [fit] = app.cleanFields([{ label: 'Sig', type: 'image', x: 100, y: 100, maxWidth: 0 }], 1);
  assert.equal(fit.maxWidth, 120, 'an image never has width 0'); assert.equal(fit.height, 0);
  assert.equal(app.cleanFields([{ label: 'Sig', type: 'image', maxWidth: 2 }], 1)[0].maxWidth, 5, 'lower bound 5 pt');
  const data = 'data:image/png;base64,' + PNG.toString('base64'); // a square image
  const at = async (maxWidth, height, value = data, preview = false) => drawSizes(await app.renderPdf({ id: 'sz' }, app.cleanFields([{ label: 'Sig', type: 'image', x: 100, y: 100, maxWidth, height }], 1), { sig: value }, undefined, preview));
  assert.deepEqual((await at(10, 0)).sizes, [[10, 10]], 'small widths render small');
  assert.deepEqual((await at(300, 0)).sizes, [[300, 300]]);
  assert.deepEqual((await at(80, 30)).sizes, [[30, 30]], 'fits into the height, keeps the aspect ratio');
  assert.deepEqual((await at(20, 50)).sizes, [[20, 20]], 'the width is the limit when the box is tall');
  const pub = await at(60, 0, '', false), prev = await at(60, 0, '', true);
  assert.deepEqual(pub.sizes, [], 'no image: nothing printed for users');
  const tj = (t) => (t.match(/Tj/g) || []).length; // the template itself contains text, so compare counts
  assert.ok(tj(prev.text) > tj(pub.text) && prev.text.includes(' l\n'), 'editor preview shows a placeholder box with the label');
  assert.equal(tj(pub.text), tj((await at(60, 0, data)).text) - 0, 'users never see the placeholder');
});

test('signature fields are image fields with their own defaults', () => {
  assert.equal(app.IMG('image'), true); assert.equal(app.IMG('signature'), true); assert.equal(app.IMG('text'), false);
  const [s, i] = app.cleanFields([{ label: 'Sign', type: 'signature', prefill: 'url', value: 'x.png' }, { label: 'Pic', type: 'image' }], 1);
  assert.equal(s.type, 'signature'); assert.equal(s.maxWidth, 160); assert.equal(s.prefill, 'none', 'no link prefill for pictures'); assert.equal(s.value, 'x.png');
  assert.equal(i.maxWidth, 120);
});

// a PNG header that claims w x h pixels (a decompression bomb needs nothing more to be dangerous)
const pngHeader = (w, hgt) => { const b = Buffer.alloc(33); PNG.copy(b, 0, 0, 16); b.writeUInt32BE(w, 16); b.writeUInt32BE(hgt, 20); return b; };
test('images are checked for their declared size before anything decodes them', async () => {
  assert.deepEqual(app.imgDims(PNG), [1, 1]);
  assert.deepEqual(app.imgDims(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0x00, 0x11, 8, 0x01, 0x2c, 0x02, 0x58, 3])), [600, 300], 'JPEG SOF0 after an APP0 segment');
  assert.equal(app.imgDims(Buffer.from('GIF89a')), null);
  assert.equal(app.checkImage(pngHeader(2000, 2000)).length, 33);
  assert.throws(() => app.checkImage(pngHeader(20000, 20000)), /too large/);
  assert.throws(() => app.checkImage(pngHeader(0, 100)), /unreadable/);
  // chunk games: a second IHDR later in the file, or something before the IHDR, must not slip past the gate
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]); };
  const ihdr = (w, h) => { const d = Buffer.alloc(13); d.writeUInt32BE(w, 0); d.writeUInt32BE(h, 4); d[8] = 8; d[9] = 6; return chunk('IHDR', d); };
  const sig = PNG.subarray(0, 8);
  assert.throws(() => app.checkImage(Buffer.concat([sig, ihdr(10, 10), chunk('tEXt', Buffer.from('x')), ihdr(30000, 30000), chunk('IEND', Buffer.alloc(0))])), /unreadable/, 'two IHDR chunks');
  assert.throws(() => app.checkImage(Buffer.concat([sig, chunk('tEXt', Buffer.from('x')), ihdr(10, 10)])), /unreadable/, 'IHDR not first');
  assert.throws(() => app.checkImage(Buffer.concat([sig, chunk('IHDR', Buffer.alloc(20))])), /unreadable/, 'wrong IHDR length');
  assert.deepEqual(app.imgDims(Buffer.concat([sig, ihdr(640, 480), chunk('IDAT', Buffer.alloc(3)), chunk('IEND', Buffer.alloc(0))])), [640, 480], 'a well-formed file');
  assert.equal(app.imgDims(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), ihdr(1, 1), chunk('IEND', Buffer.alloc(0))])), null, 'broken signature');
  fs.mkdirSync(path.join(tmp, 'pdfs'), { recursive: true }); fs.copyFileSync(SAMPLE, path.join(tmp, 'pdfs', 'bomb.pdf'));
  const f = app.cleanFields([{ label: 'Sig', type: 'image', x: 10, y: 10 }], 1);
  await assert.rejects(app.renderPdf({ id: 'bomb' }, f, { sig: 'data:image/png;base64,' + pngHeader(30000, 30000).toString('base64') }), /too large/);
});

test('hidden fixed values cannot be changed by the request', async () => {
  fs.mkdirSync(path.join(tmp, 'pdfs'), { recursive: true }); fs.copyFileSync(SAMPLE, path.join(tmp, 'pdfs', 'fixed.pdf'));
  const f = app.cleanFields([{ label: 'Issued by', x: 100, y: 100, prefill: 'instance', value: 'Office', hidden: true }, { label: 'Note', x: 100, y: 80, prefill: 'instance', value: 'Editable' }], 1);
  const text = async (values) => (await drawSizes(await app.renderPdf({ id: 'fixed' }, f, values))).text;
  const t = await text({ issued_by: 'HACKED', note: 'Changed' });
  assert.ok(!/4841434b4544/i.test(t) && !/HACKED/.test(t), 'the hidden fixed value is printed from the document, not from the request');
  assert.ok(/4368616e676564/i.test(t) || /Changed/.test(t), 'a visible fixed value is a default the user may change');
});

test('image fields: prefill rules, value validation, type sniffing', () => {
  assert.equal(app.cleanPrefill('image', 'url'), 'none'); assert.equal(app.cleanPrefill('image', 'browser'), 'browser');
  assert.equal(app.cleanPrefill('image', 'instance'), 'instance'); assert.equal(app.cleanPrefill('text', 'url'), 'url');
  assert.equal(app.cleanPrefill('static', 'browser'), 'none'); assert.equal(app.cleanPrefill('text', 'today'), 'none');
  const [a, b] = app.cleanFields([{ label: 'Sig', type: 'image', value: 'abc_123.png', prefill: 'instance' }, { label: 'Sig2', type: 'image', value: '../etc/passwd' }], 1);
  assert.equal(a.value, 'abc_123.png'); assert.equal(b.value, '');
  assert.equal(app.imgType(PNG), 'png'); assert.equal(app.imgType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpg'); assert.equal(app.imgType(Buffer.from('GIF89a')), null);
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

test('ippParse reads attribute groups and multi-valued attributes', () => {
  const attr = (tag, name, value) => { const n = Buffer.from(name), v = Buffer.isBuffer(value) ? value : Buffer.from(value); const h = Buffer.alloc(3); h[0] = tag; h.writeUInt16BE(n.length, 1); const l = Buffer.alloc(2); l.writeUInt16BE(v.length, 0); return Buffer.concat([h, n, l, v]); };
  const int = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n, 0); return b; };
  const res = app.ippParse(Buffer.concat([
    Buffer.from([2, 0, 0x04, 0x0a]), int(7), Buffer.from([1]), attr(0x47, 'attributes-charset', 'utf-8'),
    Buffer.from([4]), attr(0x42, 'printer-name', 'Office'), attr(0x23, 'printer-state', int(5)), attr(0x22, 'printer-is-accepting-jobs', Buffer.from([1])),
    attr(0x49, 'document-format-supported', 'image/urf'), attr(0x49, '', 'image/pwg-raster'), Buffer.from([3]), Buffer.from('trailing document bytes'),
  ]));
  assert.equal(res.status, 0x040a);
  assert.deepEqual(res.attrs['printer-name'], ['Office']); assert.deepEqual(res.attrs['printer-state'], [5]); assert.deepEqual(res.attrs['printer-is-accepting-jobs'], [true]);
  assert.deepEqual(res.attrs['document-format-supported'], ['image/urf', 'image/pwg-raster']);
  assert.deepEqual(app.ippParse(Buffer.from([2, 0, 0, 0, 0, 0, 0, 1])).attrs, {}, 'empty response');
});

test('cleanTags trims, de-duplicates and caps', () => {
  assert.deepEqual(app.cleanTags([' a ', 'b', 'a', '', 3]), ['a', 'b', '3']);
  assert.equal(app.cleanTags(Array.from({ length: 50 }, (_, i) => 't' + i)).length, 20);
  assert.deepEqual(app.cleanTags(null), []);
});

test('cleanValues stringifies and bounds submitted values', () => {
  assert.deepEqual({ ...app.cleanValues({ a: 1, b: null, c: 'x'.repeat(5000) }) }, { a: '1', b: '', c: 'x'.repeat(4000) });
  assert.deepEqual({ ...app.cleanValues('nope') }, {});
  assert.equal(app.cleanValues({})['constructor'], undefined, 'no prototype properties leak into values');
  assert.equal(app.cleanValues({ img: 'data:image/png;base64,' + 'A'.repeat(4e6) }).img.length, 3e6, 'data URLs are capped');
});

test('checkPw compares against ADMIN_PASSWORD', async () => {
  assert.equal(await app.checkPw('unit-pass-123'), true);
  assert.equal(await app.checkPw('unit-pass-124'), false);
  assert.equal(await app.checkPw(undefined), false);
  const h = app.hashPw('secret'); assert.match(h, /^[\w-]+:[0-9a-f]{64}$/);
});

test('inspectPdf rejects non-PDF input and counts pages', async () => {
  await assert.rejects(app.inspectPdf(Buffer.from('hello')), /not a PDF/);
  await assert.rejects(app.inspectPdf(Buffer.from('%PDF-1.4 garbage')), /Could not read/);
  assert.equal(await app.inspectPdf(fs.readFileSync(SAMPLE)), 1);
});

test('renderPdf stamps values onto the template', async () => {
  fs.copyFileSync(SAMPLE, path.join(tmp, 'pdfs', 'doc1.pdf'));
  const fields = app.cleanFields([
    { label: 'Name', x: 100, y: 700 }, { label: 'When', type: 'date', x: 100, y: 680, dateFormat: 'DD.MM.YYYY' },
    { label: 'Agree', type: 'checkbox', x: 100, y: 660 }, { label: 'Notes', type: 'textarea', x: 100, y: 640, maxWidth: 200 },
  ], 1);
  fields.push(...app.cleanFields([{ label: 'Note', type: 'static', value: 'Do not write below', x: 100, y: 600 }, { label: 'Sig', type: 'image', x: 100, y: 500, maxWidth: 80 }, { label: 'Sig2', type: 'image', x: 300, y: 500 }], 1));
  const pdf = await app.renderPdf({ id: 'doc1' }, fields, { name: 'Jürgen Müller', when: '2026-10-13', agree: '1', notes: 'line one\nline two', note: 'ignored',
    sig: 'data:image/png;base64,' + PNG.toString('base64'), sig2: 'data:image/png;base64,bm90IGFuIGltYWdl' });
  await assert.rejects(app.renderPdf({ id: 'doc1' }, fields, { sig: 'data:image/png;base64,' + PNG.subarray(0, 20).toString('base64') }), /unreadable|could not be read/);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > fs.statSync(SAMPLE).size, 'output should contain added content');
  const { PDFDocument } = require('pdf-lib');
  assert.equal((await PDFDocument.load(pdf)).getPageCount(), 1);
});

test('renderPdf replaces characters the font cannot encode and skips unknown pages', async () => {
  const fields = app.cleanFields([{ label: 'Name', x: 100, y: 700 }, { label: 'Far', x: 10, y: 10, page: 1 }], 1);
  fields[1].page = 7; // a field on a page that does not exist is ignored
  const pdf = await app.renderPdf({ id: 'doc1' }, fields, { name: '日本語 and ümlaut', far: 'x' });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});

test('renderPdf uses DATA_DIR/font.ttf when present', async () => {
  const ttf = path.join(__dirname, '..', '..', 'node_modules', 'pdfjs-dist', 'standard_fonts', 'LiberationSans-Bold.ttf');
  fs.copyFileSync(ttf, path.join(tmp, 'font.ttf'));
  try {
    const pdf = await app.renderPdf({ id: 'doc1' }, app.cleanFields([{ label: 'Name', x: 100, y: 700 }], 1), { name: 'Custom font' });
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    const { PDFDocument, PDFDict, PDFName } = require('pdf-lib');
    const doc = await PDFDocument.load(pdf);
    const embedded = doc.context.enumerateIndirectObjects().some(([, o]) => o instanceof PDFDict && o.has(PDFName.of('FontFile2')));
    assert.ok(embedded, 'a TrueType subset is embedded');
  } finally { fs.rmSync(path.join(tmp, 'font.ttf'), { force: true }); }
});

test('ippPrint needs a configured printer', async () => {
  await assert.rejects(app.ippPrint(Buffer.from('%PDF-'), 1, 'x'), /No printer is configured/);
});

test('the audit log rotates once it grows past its limit', () => {
  fs.rmSync(app.AUDIT, { force: true }); fs.rmSync(app.AUDIT + '.1', { force: true });
  fs.writeFileSync(app.AUDIT, Buffer.alloc(app.AUDIT_MAX + 1, 32));
  app.audit(null, 'test.event', { n: 1 });
  assert.ok(fs.existsSync(app.AUDIT + '.1'), 'the full log was rotated away');
  assert.ok(fs.statSync(app.AUDIT).size < 200, 'the new log holds just the latest line');
  assert.match(fs.readFileSync(app.AUDIT, 'utf8'), /"event":"test.event"/);
  fs.rmSync(app.AUDIT, { force: true }); fs.rmSync(app.AUDIT + '.1', { force: true });
});

test('pruneFails keeps the login rate-limit table bounded', () => {
  app.fails.clear();
  app.fails.set('keep-blocked', { n: 9, until: Date.now() + 60000, at: 0 });
  app.fails.set('keep-recent', { n: 1, until: 0, at: Date.now() });
  app.pruneFails(); assert.equal(app.fails.size, 2, 'small tables are left alone');
  for (let i = 0; i < 1200; i++) app.fails.set('10.0.' + (i >> 8) + '.' + (i & 255), { n: 1, until: 0, at: Date.now() - 10 * 60000 });
  app.pruneFails();
  assert.equal(app.fails.size, 2, 'expired, old entries are dropped');
  assert.ok(app.fails.has('keep-blocked') && app.fails.has('keep-recent'));
  app.fails.clear();
});
