// Two synthetic forms for field detection, built with pdf-lib so the tests need no binary fixtures:
// one with real form fields (AcroForm), one flat with the usual fill-in lines, boxes and check boxes.
'use strict';
const { PDFDocument, PDFString, StandardFonts, rgb } = require('pdf-lib');

async function acroForm() {
  const pdf = await PDFDocument.create(), page = pdf.addPage([595, 842]), font = await pdf.embedFont(StandardFonts.Helvetica), form = pdf.getForm();
  const text = (s, x, y) => page.drawText(s, { x, y, size: 10, font });
  text('Full name', 50, 760); form.createTextField('applicant.fullName').addToPage(page, { x: 150, y: 752, width: 250, height: 20 });
  text('Date of birth', 50, 720); form.createTextField('dob').addToPage(page, { x: 150, y: 712, width: 120, height: 20 });
  text('Remarks', 50, 680); const remarks = form.createTextField('remarks'); remarks.enableMultiline(); remarks.addToPage(page, { x: 150, y: 600, width: 300, height: 90 });
  const agree = form.createCheckBox('agree'); agree.addToPage(page, { x: 150, y: 560, width: 12, height: 12 }); text('I agree', 170, 562);
  const hidden = form.createTextField('internal'); hidden.addToPage(page, { x: 400, y: 100, width: 100, height: 20, hidden: true });
  // pdf-lib cannot create signature fields, so this one is written by hand
  const sig = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('sign'), TU: PDFString.of('Signature of the applicant'), Rect: [150, 480, 350, 530], F: 4, P: page.ref }));
  page.node.addAnnot(sig); form.acroForm.addField(sig);
  return pdf.save();
}

async function flatForm() {
  const pdf = await PDFDocument.create(), page = pdf.addPage([595, 842]), font = await pdf.embedFont(StandardFonts.Helvetica);
  const text = (s, x, y, size = 10) => page.drawText(s, { x, y, size, font });
  text('Application for a library card', 50, 790, 16);
  text('Name: ______________________________', 50, 740); // fill-in line typed as text
  text('Street', 50, 700); page.drawLine({ start: { x: 120, y: 698 }, end: { x: 400, y: 698 }, thickness: 0.8 }); // drawn line with a label to its left
  text('Date', 50, 660); page.drawLine({ start: { x: 120, y: 658 }, end: { x: 260, y: 658 }, thickness: 0.8 });
  page.drawRectangle({ x: 50, y: 560, width: 300, height: 60, borderWidth: 0.8, borderColor: rgb(0, 0, 0) }); text('Reason for the request', 54, 610, 7); // caption inside the top of a box
  page.drawRectangle({ x: 50, y: 520, width: 10, height: 10, borderWidth: 0.8, borderColor: rgb(0, 0, 0) }); text('Send me the newsletter', 66, 521);
  page.drawLine({ start: { x: 300, y: 450 }, end: { x: 500, y: 450 }, thickness: 0.8 }); text('Signature', 300, 438, 8); // signature line, label below
  text('This text is a paragraph and no field at all.', 50, 400);
  return pdf.save();
}

module.exports = { acroForm, flatForm };
