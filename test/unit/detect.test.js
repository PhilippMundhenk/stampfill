// Field detection: drawn shapes from pdf.js operator lists, data types from labels, proposals from
// form fields and from flat forms, and the server side of it (template route, flattened form fields).
// pdf.js itself needs a newer JavaScript engine than Node 22, so its output is written out here; the
// browser test runs the same functions on real pdf.js output.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stampfill-detect-'));
process.env.DATA_DIR = tmp; process.env.ADMIN_PASSWORD = 'detect-pass-123';
const app = require('../../stampfill.js');
const fx = require('../fixtures/detect-forms.js');
const { PDFDocument } = require('pdf-lib');

const OPS = { save: 10, restore: 11, transform: 12, constructPath: 91, stroke: 20, closeStroke: 21, fill: 22, eoFill: 23, fillStroke: 24, eoFillStroke: 25, closeFillStroke: 26, closeEOFillStroke: 27, endPath: 28, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75 };
const path_ = (...d) => [new Float32Array(d)];
const hline = (x1, x2, y) => path_(0, x1, y, 1, x2, y);
const rect = (x, y, w, h) => path_(0, x, y, 1, x + w, y, 1, x + w, y + h, 1, x, y + h, 4);
const T = (s, x, y, w, size = 10) => ({ s, x, y, w, size });

test('pathShapes finds lines and boxes and follows the transformation matrix', () => {
  const fn = [], args = [];
  const op = (f, a) => { fn.push(f); args.push(a); };
  op(OPS.constructPath, [OPS.stroke, hline(100, 300, 500), null]); // a plain line
  op(OPS.save); op(OPS.transform, [2, 0, 0, 2, 10, 20]); // scaled and moved
  op(OPS.constructPath, [OPS.fill, rect(10, 10, 50, 10), null]);
  op(OPS.restore);
  op(OPS.constructPath, [OPS.stroke, rect(10, 10, 50, 10), null]); // back to the page's matrix
  op(OPS.constructPath, [OPS.endPath, rect(0, 0, 595, 842), null]); // a clipping path paints nothing
  op(OPS.constructPath, [OPS.stroke, [null], null]); // an empty path
  op(OPS.constructPath, [OPS.stroke, path_(0, 10, 10, 2, 20, 20, 30, 30, 40, 40, 1, 50, 50, 0, 60, 60, 3, 70, 70, 80, 80), null]); // curves are not fields
  op(OPS.constructPath, [OPS.stroke, path_(0, 400, 100, 1, 400, 300), null]); // vertical line
  op(OPS.constructPath, [OPS.stroke, path_(0, 0, 0, 1, 100, 0, 1, 100, 50, 1, 50, 80, 1, 0, 50, 1, 0, 0), null]); // a polygon, not a box
  op(OPS.paintFormXObjectBegin, [[1, 0, 0, 1, 0, 100], [0, 0, 100, 100]]); op(OPS.constructPath, [OPS.stroke, hline(0, 50, 0), null]); op(OPS.paintFormXObjectEnd, []);
  op(OPS.paintFormXObjectBegin, [null, [0, 0, 100, 100]]); op(OPS.constructPath, [OPS.stroke, hline(0, 40, 5), null]); op(OPS.paintFormXObjectEnd, []);
  op(OPS.restore); // unbalanced restore keeps the matrix
  op(OPS.constructPath, [OPS.stroke, hline(0, 10, 0), null]); // too short
  assert.deepEqual(app.pathShapes(fn, args, OPS), [
    { kind: 'line', x1: 100, x2: 300, y1: 500, y2: 500 },
    { kind: 'box', x1: 30, x2: 130, y1: 40, y2: 60 },
    { kind: 'box', x1: 10, x2: 60, y1: 10, y2: 20 },
    { kind: 'line', x1: 0, x2: 50, y1: 100, y2: 100 },
    { kind: 'line', x1: 0, x2: 40, y1: 5, y2: 5 },
  ]);
});

test('fieldType reads dates and signatures from labels in every interface language', () => {
  for (const l of ['Date', 'Date of birth', 'Datum', 'Geburtsdatum', 'geb. am', 'Doğum tarihi', 'تاريخ الميلاد', 'Дата рождения', 'Ημερομηνία', 'Data urodzenia', 'DOB']) assert.equal(app.fieldType(l), 'date', l);
  for (const l of ['Signature', 'Unterschrift des Antragstellers', 'İmza', 'توقيع', 'Подпись', 'Підпис', 'Υπογραφή', 'Podpis', 'Please sign here']) assert.equal(app.fieldType(l), 'signature', l);
  for (const l of ['Name', 'Ort, Datum', 'Place and date', 'Datum / Uhrzeit', 'Street', 'Update']) assert.equal(app.fieldType(l), 'text', l);
});

test('proposeFields maps the form fields of a PDF form and sizes them to their boxes', () => {
  const widgets = [
    { fieldType: 'Tx', fieldName: 'person.lastName', rect: [150, 752, 400, 772] },
    { fieldType: 'Tx', fieldName: 'birth', alternativeText: 'Date of birth:', rect: [270, 732, 150, 712] }, // corners in any order
    { fieldType: 'Tx', fieldName: 'remarks', multiLine: true, rect: [150, 600, 450, 690] },
    { fieldType: 'Btn', checkBox: true, fieldName: 'agree', rect: [150, 560, 162, 572] },
    { fieldType: 'Btn', radioButton: true, fieldName: 'colour', buttonValue: 'Red', rect: [150, 540, 160, 550] },
    { fieldType: 'Ch', fieldName: 'country', rect: [150, 500, 300, 520] },
    { fieldType: 'Sig', fieldName: 'sign', rect: [150, 400, 350, 450] },
    { fieldType: 'Btn', pushButton: true, fieldName: 'reset', rect: [400, 400, 450, 420] },
    { fieldType: 'Tx', fieldName: 'internal', hidden: true, rect: [400, 100, 500, 120] },
    { fieldType: 'Tx', fieldName: 'norect' }, { fieldType: 'Xx', fieldName: 'odd', rect: [0, 0, 10, 10] },
  ];
  const text = [T('Remarks', 50, 680, 40), T('I agree', 170, 562, 33), T('Country', 50, 506, 38)];
  const out = app.proposeFields({ page: 2, widgets, text, shapes: [{ kind: 'line', x1: 0, x2: 500, y1: 300, y2: 300 }] });
  assert.deepEqual(out.map((f) => [f.label, f.type, f.source]), [
    ['last Name', 'text', 'form'], ['Date of birth', 'date', 'form'], ['Remarks', 'textarea', 'form'], ['I agree', 'checkbox', 'form'],
    ['colour Red', 'checkbox', 'form'], ['Country', 'text', 'form'], ['sign', 'signature', 'form'],
  ], 'form fields win: drawn shapes are not looked at');
  const [name, , remarks, agree, , , sign] = out;
  assert.deepEqual(name, { label: 'last Name', type: 'text', page: 2, source: 'form', size: 11, x: 153, y: 758.2, maxWidth: 244 });
  assert.deepEqual(remarks, { label: 'Remarks', type: 'textarea', page: 2, source: 'form', size: 10, x: 153, y: 679, maxWidth: 294 });
  assert.deepEqual(agree, { label: 'I agree', type: 'checkbox', page: 2, source: 'form', size: 10, x: 152.7, y: 562.4, maxWidth: 0 });
  assert.deepEqual(sign, { label: 'sign', type: 'signature', page: 2, source: 'form', x: 152, y: 402, maxWidth: 196, height: 46 });
});

test('proposeFields finds fill-in lines, boxes and check boxes in a flat form', () => {
  const text = [
    T('Application for a library card', 50, 790, 250, 16),
    T('Name: ______________________________', 50, 740, 199), // label and line in one text item
    T('Phone ________ Mobile ________', 50, 720, 160), // two lines in one item
    T('Street', 50, 700, 28), T('Date', 50, 660, 20),
    T('Reason for the request', 54, 610, 75, 7),
    T('Send me the newsletter', 66, 521, 110),
    T('☐', 50, 500, 9), T('Call me back', 62, 500, 55),
    T('Signature', 300, 438, 34, 8),
    T('Office use only', 400, 340, 60), T('This text is a paragraph and no field at all.', 50, 400, 200),
    T('   ', 50, 100, 10), T('nowidth', 50, 90, 0),
  ];
  const shapes = [
    { kind: 'line', x1: 120, x2: 400, y1: 698, y2: 698 }, { kind: 'line', x1: 120, x2: 260, y1: 658, y2: 658 },
    { kind: 'line', x1: 52, x2: 248, y1: 738, y2: 738 }, // drawn under the typed underscores: one field there, not two
    { kind: 'box', x1: 50, x2: 350, y1: 560, y2: 620 }, { kind: 'box', x1: 50, x2: 60, y1: 520, y2: 530 },
    { kind: 'line', x1: 300, x2: 500, y1: 450, y2: 450 },
    { kind: 'box', x1: 390, x2: 560, y1: 300, y2: 360 }, { kind: 'line', x1: 395, x2: 555, y1: 338, y2: 338 }, // a framed area: the frame is no field, the line in it is
    { kind: 'box', x1: 40, x2: 380, y1: 380, y2: 420 }, // a box with a paragraph in it
    { kind: 'box', x1: 20, x2: 25, y1: 20, y2: 60 }, // too narrow
  ];
  const out = app.proposeFields({ page: 1, text, shapes, existing: [] });
  assert.deepEqual(out.map((f) => [f.label, f.type, f.source]), [
    ['Name', 'text', 'text'], ['Phone', 'text', 'text'], ['Mobile', 'text', 'text'], ['Street', 'text', 'line'], ['Date', 'date', 'line'],
    ['Reason for the request', 'textarea', 'box'], ['Send me the newsletter', 'checkbox', 'box'], ['Call me back', 'checkbox', 'glyph'],
    ['Signature', 'signature', 'line'], ['Office use only', 'text', 'line'],
  ]);
  const by = Object.fromEntries(out.map((f) => [f.label, f]));
  assert.deepEqual(by.Street, { label: 'Street', type: 'text', page: 1, source: 'line', size: 10, x: 122, y: 700, maxWidth: 276 });
  assert.deepEqual(by['Reason for the request'], { label: 'Reason for the request', type: 'textarea', page: 1, source: 'box', size: 10, x: 53, y: 596.3, maxWidth: 294 });
  assert.deepEqual(by.Signature, { label: 'Signature', type: 'signature', page: 1, source: 'line', x: 302, y: 451, maxWidth: 196, height: 36 });
  assert.equal(by.Name.size, 10); assert.ok(by.Name.x > 75 && by.Name.x < 90, 'starts after "Name: "'); assert.equal(by.Name.y, 742);
});

test('proposeFields leaves out places where fields already are, and boxes it cannot use', () => {
  const shapes = [{ kind: 'line', x1: 120, x2: 400, y1: 698, y2: 698 }, { kind: 'box', x1: 50, x2: 350, y1: 500, y2: 540 }, { kind: 'box', x1: 50, x2: 350, y1: 400, y2: 440 }];
  const text = [T('Street', 50, 700, 28), T('Caption low in the box', 60, 505, 90), T('Short', 60, 432, 30, 7), T('Box', 40, 418, 15)];
  const existing = [{ page: 1, x: 130, y: 700 }, { page: 2, x: 60, y: 520 }];
  const out = app.proposeFields({ page: 1, text, shapes, existing });
  assert.deepEqual(out.map((f) => [f.label, f.type]), [['Short', 'text']], 'line taken by a field; box with text low in it skipped; a caption inside the box is its label; a field of another page does not count');
  assert.deepEqual([out[0].size, out[0].y], [11, 410.8], 'value centred in the space under the caption');
  assert.deepEqual(app.proposeFields({ page: 1 }), [], 'nothing in, nothing out');
});

test('labels are cleaned and long sentences shortened', () => {
  const long = 'I confirm that all of the information given in this application is correct and complete as of';
  const out = app.proposeFields({ page: 1, text: [T(long, 50, 700, 360), T('*Name*:', 50, 600, 30), T('Sentence one. Then a label', 50, 500, 120)],
    shapes: [{ kind: 'line', x1: 412, x2: 540, y1: 698, y2: 698 }, { kind: 'line', x1: 82, x2: 300, y1: 598, y2: 598 }, { kind: 'line', x1: 172, x2: 300, y1: 498, y2: 498 }] });
  assert.deepEqual(out.slice(1).map((f) => f.label), ['Name', 'Sentence one. Then a label'], 'short labels stay whole');
  assert.ok(out[0].label.length <= 40 && long.endsWith(out[0].label), out[0].label);
});

test('detectPage reads annotations, horizontal text and drawings from a pdf.js page', async () => {
  const page = {
    pageNumber: 3,
    getAnnotations: async () => [{ subtype: 'Link' }],
    getTextContent: async () => ({ items: [
      { str: 'Street', transform: [10, 0, 0, 10, 50, 700], width: 28, height: 10 },
      { str: 'rotated', transform: [0, 10, -10, 0, 30, 30], width: 30, height: 10 },
      { str: 'mirrored', transform: [-10, 0, 0, 10, 300, 300], width: 30, height: 10 },
      { type: 'beginMarkedContent' },
    ] }),
    getOperatorList: async () => ({ fnArray: [OPS.constructPath], argsArray: [[OPS.stroke, hline(120, 400, 698), null]] }),
  };
  const out = await app.detectPage(page, OPS, []);
  assert.deepEqual(out, [{ label: 'Street', type: 'text', page: 3, source: 'line', size: 10, x: 122, y: 700, maxWidth: 276 }]);
});

let base, cookie;
const H = { 'X-Requested-With': 'stampfill' };
before(async () => {
  base = 'http://127.0.0.1:' + (await app.start({ port: 0, host: '127.0.0.1' })).address().port;
  cookie = (await fetch(base + '/api/login', { method: 'POST', headers: H, body: JSON.stringify({ password: 'detect-pass-123' }) })).headers.get('set-cookie').split(';')[0];
});
after(() => { app.server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('the admin gets the untouched template for detection; nobody else does', async () => {
  const bytes = Buffer.from(await fx.acroForm());
  const doc = await (await fetch(base + '/api/admin/docs?title=Form', { method: 'POST', headers: { ...H, Cookie: cookie }, body: bytes })).json();
  const r = await fetch(base + '/api/admin/docs/' + doc.id + '/pdf', { headers: { Cookie: cookie } });
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(bytes));
  assert.equal((await fetch(base + '/api/admin/docs/' + doc.id + '/pdf')).status, 401);
  assert.equal((await fetch(base + '/api/admin/docs/nope/pdf', { headers: { Cookie: cookie } })).status, 404);
});

test('rendering flattens the form fields of a template, so they cannot cover the stamped values', async () => {
  const doc = await (await fetch(base + '/api/admin/docs?title=Form2', { method: 'POST', headers: { ...H, Cookie: cookie }, body: Buffer.from(await fx.acroForm()) })).json();
  const fields = [{ key: 'name', label: 'Name', type: 'text', page: 1, x: 153, y: 758, size: 11 }];
  const render = async (rotation) => PDFDocument.load(Buffer.from(await (await fetch(base + '/api/admin/docs/' + doc.id + '/render', { method: 'POST', headers: { ...H, Cookie: cookie }, body: JSON.stringify({ fields, values: { name: 'Erika' }, rotation }) })).arrayBuffer()));
  for (const rot of [[0], [90]]) {
    const out = await render(rot);
    assert.equal(out.getForm().getFields().length, 0, 'no interactive fields left at rotation ' + rot);
    assert.equal(out.getPage(0).node.Annots() ? out.getPage(0).node.Annots().size() : 0, 0, 'no widgets left at rotation ' + rot);
  }
  const page = (await render([0])).getPage(0), content = page.node.normalizedEntries().Contents;
  assert.ok(content, 'the field borders are page content now');
  // a broken AcroForm entry does not stop the render
  const broken = await PDFDocument.load(await fx.flatForm()); broken.catalog.set(require('pdf-lib').PDFName.of('AcroForm'), broken.context.obj({ Fields: 'nonsense' }));
  const doc3 = await (await fetch(base + '/api/admin/docs?title=Broken', { method: 'POST', headers: { ...H, Cookie: cookie }, body: Buffer.from(await broken.save()) })).json();
  const r3 = await fetch(base + '/api/admin/docs/' + doc3.id + '/render', { method: 'POST', headers: { ...H, Cookie: cookie }, body: JSON.stringify({ fields, values: { name: 'Erika' } }) });
  assert.equal(r3.status, 200);
});

test('the editor page carries the detection functions, the public page does not', async () => {
  const adm = await (await fetch(base + '/admin')).text(), pub = await (await fetch(base + '/')).text();
  for (const fn of ['pathShapes', 'fieldType', 'proposeFields', 'detectPage']) { assert.match(adm, new RegExp('function ' + fn + '\\(')); assert.doesNotMatch(pub, new RegExp('function ' + fn + '\\(')); }
});
