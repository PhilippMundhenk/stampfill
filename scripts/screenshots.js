#!/usr/bin/env node
// Generates the README screenshots from a realistic demo instance:
//   npm run screenshots
// Starts stampfill on a temporary data directory, creates a small set of town-hall forms through the
// API (templates are drawn with pdf-lib, no binary fixtures), fills one in with a signature in a real
// browser and writes docs/screenshots/*.png. Needs the Playwright Chromium (npx playwright install chromium).
'use strict';
const { chromium } = require('@playwright/test');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.join(__dirname, '..'), OUT = path.join(ROOT, 'docs', 'screenshots');
const PORT = 8098, BASE = 'http://127.0.0.1:' + PORT, PASSWORD = 'demo-pass-123', H = { 'X-Requested-With': 'stampfill' };
const INK = rgb(0.13, 0.15, 0.2), MUTED = rgb(0.45, 0.48, 0.55), LINE = rgb(0.6, 0.63, 0.7), BAND = rgb(0.91, 0.94, 0.99), ACCENT = rgb(0.18, 0.42, 1);

// ---------------------------------------------------------------- demo templates
async function template({ title, subtitle, rows, boxes = [], note }) {
  const pdf = await PDFDocument.create(), page = pdf.addPage([595, 842]);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold), reg = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawRectangle({ x: 0, y: 742, width: 595, height: 100, color: BAND });
  page.drawRectangle({ x: 0, y: 742, width: 595, height: 3, color: ACCENT });
  page.drawText('MAPLEWOOD TOWN HALL', { x: 60, y: 800, size: 9, font: bold, color: ACCENT });
  page.drawText(title, { x: 60, y: 772, size: 22, font: bold, color: INK });
  page.drawText(subtitle, { x: 60, y: 754, size: 10, font: reg, color: MUTED });
  for (const r of rows) {
    page.drawText(r.label, { x: r.lx || 60, y: r.y, size: 10.5, font: bold, color: INK });
    for (const [x1, x2, dy] of r.lines || [[r.x1, r.x2, 0]]) page.drawLine({ start: { x: x1, y: r.y - 4 - (dy || 0) }, end: { x: x2, y: r.y - 4 - (dy || 0) }, thickness: 0.6, color: LINE });
  }
  for (const b of boxes) {
    page.drawRectangle({ x: b.x, y: b.y, width: b.w, height: b.h, borderColor: LINE, borderWidth: 0.6, borderDashArray: b.dashed ? [3, 3] : undefined });
    page.drawText(b.label, { x: b.x + 6, y: b.y + b.h - 14, size: 8.5, font: bold, color: MUTED });
  }
  if (note) page.drawText(note, { x: 60, y: 60, size: 8.5, font: reg, color: MUTED, maxWidth: 475, lineHeight: 11 });
  page.drawText('Form ' + title.split(' ')[0].toUpperCase().slice(0, 3) + '-01 · Maplewood Town Hall · Main Street 1', { x: 60, y: 36, size: 7.5, font: reg, color: MUTED });
  return Buffer.from(await pdf.save());
}

const DOCS = [
  {
    title: 'Library card application', slug: 'library-card', tags: ['library', 'residents'],
    description: 'Apply for a card at the Maplewood Public Library. Bring the printed form to the front desk.',
    pdf: () => template({
      title: 'Library Card Application', subtitle: 'Please print and sign. The card is issued on the spot.',
      rows: [
        { label: 'Full name', y: 660, x1: 170, x2: 535 }, { label: 'Date of birth', y: 620, x1: 170, x2: 320 }, { label: 'Phone', lx: 340, y: 620, x1: 390, x2: 535 },
        { label: 'Address', y: 580, lines: [[170, 535, 0], [170, 535, 26]] }, { label: 'E-mail', y: 505, x1: 170, x2: 535 },
        { label: 'Date', y: 400, x1: 100, x2: 250 }, { label: 'Signature', lx: 300, y: 400, x1: 370, x2: 535 },
      ],
      boxes: [{ x: 400, y: 110, w: 135, h: 110, label: 'OFFICE USE ONLY', dashed: true }],
      note: 'By signing I confirm that the information above is correct and that I accept the library regulations. Cards for children under 14 need a parent\'s signature.',
    }),
    fields: [
      { label: 'Full name', key: 'full_name', x: 174, y: 660, required: true, prefill: 'browser' },
      { label: 'Date of birth', key: 'date_of_birth', type: 'date', dateFormat: 'YYYY-MM-DD', x: 174, y: 620, prefill: 'browser' },
      { label: 'Phone', key: 'phone', x: 394, y: 620, prefill: 'browser' },
      { label: 'Address', key: 'address', type: 'textarea', x: 174, y: 580, maxWidth: 360, prefill: 'browser' },
      { label: 'E-mail', key: 'email', x: 174, y: 505, prefill: 'browser' },
      { label: 'Date', key: 'date', type: 'date', dateFormat: 'YYYY-MM-DD', x: 104, y: 400, prefill: 'today' },
      { label: 'Signature', key: 'signature', type: 'image', x: 372, y: 398, maxWidth: 160, height: 48, prefill: 'browser', required: true },
      { label: 'Issued by', key: 'issued_by', x: 408, y: 118, size: 8, prefill: 'instance', value: 'Front desk, Main Street 1', hidden: true },
      { label: 'Office stamp', key: 'stamp', type: 'image', x: 452, y: 132, maxWidth: 62, prefill: 'instance', stamp: true, hidden: true },
    ],
  },
  {
    title: 'Room booking request', slug: 'room-booking', tags: ['facilities'],
    description: 'Book the community hall or a meeting room for clubs, courses and private events.',
    pdf: () => template({ title: 'Room Booking Request', subtitle: 'Bookings are confirmed within three working days.', rows: [
      { label: 'Organisation', y: 660, x1: 170, x2: 535 }, { label: 'Contact person', y: 620, x1: 170, x2: 535 }, { label: 'Room', y: 580, x1: 170, x2: 320 }, { label: 'Date', lx: 340, y: 580, x1: 380, x2: 535 },
      { label: 'From', y: 540, x1: 170, x2: 250 }, { label: 'To', lx: 270, y: 540, x1: 300, x2: 380 }, { label: 'Purpose', y: 500, lines: [[170, 535, 0], [170, 535, 26]] }] }),
    fields: [{ label: 'Organisation', x: 174, y: 660, prefill: 'browser' }, { label: 'Contact person', x: 174, y: 620, prefill: 'browser' }, { label: 'Room', x: 174, y: 580 }, { label: 'Date', type: 'date', x: 384, y: 580 }],
  },
  {
    title: 'Dog registration', slug: 'dog-registration', tags: ['registration', 'residents'],
    description: 'Register a dog with the town. The tag is sent by post.',
    pdf: () => template({ title: 'Dog Registration', subtitle: 'One form per dog.', rows: [
      { label: 'Owner', y: 660, x1: 170, x2: 535 }, { label: 'Address', y: 620, x1: 170, x2: 535 }, { label: "Dog's name", y: 580, x1: 170, x2: 320 }, { label: 'Breed', lx: 340, y: 580, x1: 380, x2: 535 }, { label: 'Chip number', y: 540, x1: 170, x2: 400 }] }),
    fields: [{ label: 'Owner', x: 174, y: 660, prefill: 'browser' }, { label: 'Address', x: 174, y: 620, prefill: 'browser' }, { label: "Dog's name", x: 174, y: 580 }, { label: 'Chip number', x: 174, y: 540 }],
  },
  {
    title: 'Parental consent for school trips', slug: 'school-trip-consent', tags: ['school'], listed: false,
    description: 'Handed out by the school; reachable by link only.',
    pdf: () => template({ title: 'Parental Consent', subtitle: 'School trips and excursions.', rows: [{ label: 'Pupil', y: 660, x1: 170, x2: 535 }, { label: 'Class', y: 620, x1: 170, x2: 320 }] }),
    fields: [{ label: 'Pupil', x: 174, y: 660 }, { label: 'Class', x: 174, y: 620 }],
  },
];

// ---------------------------------------------------------------- pictures drawn in the browser (no binaries in the repo)
const signaturePng = () => { // a scribble that reads as a signature
  const c = document.createElement('canvas'); c.width = 640; c.height = 200; const g = c.getContext('2d');
  g.strokeStyle = '#1b2a6b'; g.lineWidth = 6; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(30, 140);
  g.bezierCurveTo(60, 20, 110, 30, 120, 120); g.bezierCurveTo(130, 190, 160, 60, 200, 80); g.bezierCurveTo(240, 100, 230, 160, 280, 120);
  g.bezierCurveTo(320, 90, 330, 150, 380, 110); g.bezierCurveTo(430, 70, 470, 160, 520, 100); g.bezierCurveTo(560, 60, 590, 110, 610, 90);
  g.stroke(); g.lineWidth = 3; g.beginPath(); g.moveTo(40, 160); g.quadraticCurveTo(300, 185, 600, 150); g.stroke();
  return c.toDataURL('image/png');
};
const stampPng = () => { // a round office stamp
  const c = document.createElement('canvas'); c.width = 400; c.height = 400; const g = c.getContext('2d');
  g.strokeStyle = '#1f5fbf'; g.fillStyle = '#1f5fbf'; g.lineWidth = 10; g.beginPath(); g.arc(200, 200, 180, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 4; g.beginPath(); g.arc(200, 200, 150, 0, Math.PI * 2); g.stroke();
  g.font = 'bold 44px sans-serif'; g.textAlign = 'center'; g.fillText('MAPLEWOOD', 200, 185); g.fillText('TOWN HALL', 200, 240);
  g.font = 'bold 22px sans-serif'; g.fillText('RECEIVED', 200, 290);
  return c.toDataURL('image/png');
};
const fromDataUrl = (u) => Buffer.from(u.split(',')[1], 'base64');

// ---------------------------------------------------------------- main
(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'stampfill-shots-'));
  const server = spawn(process.execPath, [path.join(ROOT, 'stampfill.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: data, ADMIN_PASSWORD: PASSWORD }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok) => server.stdout.on('data', (d) => { if (/listening/.test(String(d))) ok(); }));
  const browser = await chromium.launch();
  try {
    // --- set up through the API
    let r = await fetch(BASE + '/api/login', { method: 'POST', headers: H, body: JSON.stringify({ password: PASSWORD }) });
    const cookie = r.headers.get('set-cookie').split(';')[0];
    const api = (method, p, body, type) => fetch(BASE + p, { method, headers: { ...H, Cookie: cookie, ...(type ? { 'Content-Type': type } : {}) }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    await api('PUT', '/api/admin/settings', { siteTitle: 'Maplewood Town Hall', printerUrl: 'http://print.townhall.local:631/printers/FrontDesk', publicPrint: true, printButton: 'Print at the town hall' });
    const drawer = await browser.newPage();
    await drawer.goto(BASE + '/'); // any page: a canvas to draw the pictures on
    const stamp = fromDataUrl(await drawer.evaluate(stampPng)), signature = fromDataUrl(await drawer.evaluate(signaturePng));
    await drawer.close();
    const stampName = (await (await api('POST', '/api/admin/images', stamp, 'image/png')).json()).name;
    let library = null;
    for (const d of [...DOCS].reverse()) { // upload in reverse so the list shows them in the order above
      const doc = await (await api('POST', '/api/admin/docs?title=' + encodeURIComponent(d.title), await d.pdf(), 'application/pdf')).json();
      const fields = d.fields.map((f) => ({ page: 1, size: 11, ...f, value: f.stamp ? stampName : f.value }));
      const saved = await (await api('PUT', '/api/admin/docs/' + doc.id, { ...doc, title: d.title, description: d.description, tags: d.tags, listed: d.listed !== false, slug: d.slug, fields })).json();
      if (d.slug === 'library-card') library = saved;
    }
    fs.mkdirSync(OUT, { recursive: true });
    for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f));
    const shot = (page, name, full = true) => page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: full });
    const settled = async (page) => { // the preview re-renders 200 ms after the last input; wait for that render to finish
      await page.waitForTimeout(350); await page.waitForLoadState('networkidle');
      await page.waitForFunction(() => { const p = document.querySelector('.preview'); return p && !p.classList.contains('busy') && p.querySelector('canvas'); });
      await page.waitForTimeout(300);
    };
    const fill = async (page) => {
      await page.fill('#f_full_name', 'Jane Miller'); await page.fill('#f_date_of_birth', '1985-04-12'); await page.fill('#f_phone', '+1 555 0147');
      await page.fill('#f_address', '12 Oak Lane\nMaplewood, 04103'); await page.fill('#f_email', 'jane.miller@example.com');
      await page.locator('#f_signature').setInputFiles({ name: 'signature.png', mimeType: 'image/png', buffer: signature });
      await settled(page);
    };

    // --- public list
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: BASE });
    const page = await ctx.newPage();
    await page.goto('/'); await page.waitForSelector('.card'); await page.waitForTimeout(300);
    await shot(page, 'list', false);
    // --- the form, filled in
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/d/library-card'); await settled(page); await fill(page);
    await shot(page, 'form');
    // --- dark mode (same browser profile keeps the remembered values and signature)
    await page.emulateMedia({ colorScheme: 'dark' }); await page.reload(); await settled(page);
    await shot(page, 'form-dark', false);
    await ctx.close();
    // --- phone
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, baseURL: BASE });
    const mp = await mctx.newPage(); await mp.goto('/d/library-card'); await settled(mp); await fill(mp);
    await shot(mp, 'form-mobile');
    await mctx.close();
    // --- editor with the signature field selected
    const actx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, baseURL: BASE }); // wide enough for the three-column editor
    const ap = await actx.newPage();
    await ap.goto('/admin'); await ap.fill('input[type=password]', PASSWORD); await ap.click('button.pri'); await ap.waitForSelector('table');
    await shot(ap, 'admin-list', false);
    await ap.goto('/admin#doc/' + library.id); await ap.waitForSelector('.wrap canvas'); await ap.waitForLoadState('networkidle');
    await ap.locator('.fitem', { hasText: 'Signature' }).click(); await ap.waitForTimeout(500);
    await ap.evaluate(() => scrollTo(0, 0));
    await shot(ap, 'editor', false);
    await actx.close();
    console.log('Screenshots written to ' + path.relative(ROOT, OUT) + ': ' + fs.readdirSync(OUT).join(', '));
  } finally {
    await browser.close(); server.kill(); fs.rmSync(data, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
