// End-to-end test: drives the admin UI and the public form in a real browser against a fresh instance
// (started by playwright.config.js together with a mock IPP printer). Runs as one serial story because
// each step builds on the state created by the previous one.
// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs'), path = require('path');

const PDF = path.join(__dirname, '..', 'fixtures', 'sample-form.pdf');
const SHOTS = path.resolve(process.env.SCREENSHOTS_DIR || 'test-results/screenshots');
const IPP_OUT = path.resolve('test-results/ipp');
const PASSWORD = 'test-pass-123';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const TODAY = (() => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); })();

test.describe.configure({ mode: 'serial' });

/** @type {import('@playwright/test').Browser} */ let browser;
/** @type {import('@playwright/test').Page} */ let admin;
/** @type {import('@playwright/test').Page} */ let user;
/** @type {string[]} */ const errors = [];
let link = '', docHash = '';
let dialogAnswer = 'accept'; // what the admin page's confirm() dialogs get; one persistent handler avoids clashing one-shot handlers

const cov = require('./coverage');
const track = (/** @type {import('@playwright/test').Page} */ p, who) => {
  cov.start(p);
  p.on('pageerror', (e) => errors.push(who + ' pageerror: ' + e.message));
  // 400/401/403/404 responses are provoked on purpose by this story (wrong passwords, rotated links)
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource.*status of (400|401|403|404)/.test(m.text())) errors.push(who + ' console: ' + m.text()); });
  return p;
};
const shot = (p, name, full = false) => p.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: full });
// waits for the debounced live preview to re-render after an input change
const settle = async (p, action) => {
  const r = p.waitForResponse((x) => x.url().includes('/render') && x.ok()); await action(); await r;
  await p.waitForLoadState('networkidle'); await expect(p.locator('.preview')).not.toHaveClass(/busy/);
};

test.beforeAll(async ({ browser: b, baseURL }) => {
  browser = b; fs.mkdirSync(SHOTS, { recursive: true });
  admin = track(await (await b.newContext({ baseURL })).newPage(), 'admin');
  admin.on('dialog', (d) => (dialogAnswer === 'accept' ? d.accept() : d.dismiss()));
  user = track(await (await b.newContext({ baseURL })).newPage(), 'user');
});
test.afterAll(async () => { await admin.context().close(); await user.context().close(); });

test('API guards: admin API needs a session, mutations need the CSRF header', async ({ request }) => {
  expect((await request.get('/healthz')).ok()).toBeTruthy();
  expect((await request.get('/api/admin/docs')).status()).toBe(401);
  expect((await request.post('/api/login', { data: { password: 'x' } })).status()).toBe(403);
  expect((await request.post('/api/login', { headers: { 'X-Requested-With': 'stampfill' }, data: { password: 'nope' } })).status()).toBe(401);
});

test('admin logs in and uploads a PDF', async () => {
  await admin.goto('/admin');
  await admin.fill('input[type=password]', 'wrong-password'); await admin.click('button.pri');
  await expect(admin.locator('#toast')).toHaveText('Wrong password');
  await admin.fill('input[type=password]', PASSWORD); await shot(admin, '1-login'); await admin.click('button.pri');
  await expect(admin.getByText('No documents yet')).toBeVisible();
  await admin.setInputFiles('input[type=file]', PDF);
  await expect(admin.locator('.wrap canvas')).toBeVisible();
  await expect(admin.locator('.muted', { hasText: 'Page 1 of 1' })).toBeVisible();
  docHash = await admin.evaluate(() => location.hash); expect(docHash).toMatch(/^#doc\/[\w-]+$/);
});

test('admin can rotate a page by quarter turns and by single degrees', async () => {
  const dims = async () => { // the canvas element is swapped on every redraw, so retry if we caught it mid-swap
    for (let i = 0; i < 30; i++) { const b = await admin.locator('.wrap canvas').boundingBox().catch(() => null); if (b) return [Math.round(b.width), Math.round(b.height)]; await admin.waitForTimeout(100); }
    throw new Error('no canvas');
  };
  const [w0, h0] = await dims(); expect(h0).toBeGreaterThan(w0); // portrait
  await admin.click('button[title="Rotate 90° clockwise"]');
  await expect.poll(async () => { const [w, h] = await dims(); return w > h; }).toBe(true); // landscape now
  await expect(admin.locator('#rotIn')).toHaveValue('90');
  await admin.fill('#rotIn', '2.5'); await admin.locator('#rotIn').dispatchEvent('change');
  await expect.poll(async () => { const [w, h] = await dims(); return h > w; }).toBe(true); // small angle: portrait again
  await expect(admin.locator('button.pri')).toHaveText('Save changes');
  await admin.click('button.pri'); await expect(admin.locator('button.pri')).toHaveText('Saved');
  await admin.reload(); await expect(admin.locator('.wrap canvas')).toBeVisible();
  await expect(admin.locator('#rotIn')).toHaveValue('2.5'); // persisted
  await admin.fill('#rotIn', '0'); await admin.locator('#rotIn').dispatchEvent('change');
  await admin.click('button.pri'); await expect(admin.locator('button.pri')).toHaveText('Saved');
});

test('admin places fields by double-click and configures prefill modes', async () => {
  const box = await admin.locator('.ov').boundingBox(); if (!box) throw new Error('no overlay');
  const sc = box.width / 595; // sample form is A4 portrait, 595 x 842 pt
  const defs = [
    ['Full name', 'text', 'browser', 150, 700], ['Date', 'date', 'today', 150, 670], ['Reference', 'text', 'url', 400, 670],
    ['Address', 'textarea', 'browser', 150, 640], ['Birthday', 'date', 'instance', 400, 640], ['Signature', 'signature', 'browser', 400, 520], ['Issued by', 'text', 'instance', 150, 560],
    ['Agree', 'checkbox', 'none', 150, 500],
  ];
  for (const [label, type, pre, x, y] of defs) {
    await admin.evaluate(() => scrollTo(0, 0));
    const b = await admin.locator('.ov').boundingBox(); if (!b) throw new Error('no overlay');
    await admin.mouse.dblclick(b.x + Number(x) * sc, b.y + (842 - Number(y)) * sc);
    await expect(admin.locator('#fp input[type=text]').first()).toBeFocused();
    await admin.fill('#fp input[type=text] >> nth=0', String(label));
    await admin.locator('#fp select').nth(0).selectOption(String(type));
    await admin.locator('#fp select').last().selectOption(String(pre));
    if (pre === 'instance') { if (type === 'date') await admin.fill('#fp input[type=date]', '1990-02-01'); else await admin.fill('#fp input[placeholder=""] >> nth=-1', 'Office Bietigheim'); }
    if (label === 'Full name') await admin.locator('#fp label.chk input').first().check(); // Required
    await expect(admin.locator('.fitem')).toHaveCount(defs.indexOf(defs.find((d) => d[0] === label)) + 1);
  }
  await expect(admin.locator('.mk')).toHaveCount(8);
  // keys are derived from labels
  await expect(admin.locator('#fp input[type=text]').nth(2)).toHaveValue('agree'); // the last field placed
  // "today" is only offered for date fields
  await expect(admin.locator('#fp select').last().locator('option[value=today]')).toHaveCount(0);
  await admin.locator('.fitem', { hasText: 'Date' }).click();
  await expect(admin.locator('#fp select').last().locator('option[value=today]')).toHaveCount(1);
  // fixed text: placed by the admin, printed as is, never shown to users
  await admin.click('text=Add field');
  await admin.fill('#fp input[type=text] >> nth=0', 'Footer');
  await admin.locator('#fp select').nth(0).selectOption('static');
  await expect(admin.locator('#fp select')).toHaveCount(1); // no prefill select for fixed text
  await expect(admin.locator('#fp label.chk')).toHaveCount(0); // neither "required" nor "hide"
  await admin.fill('#fp textarea', 'Office copy - do not hand out');
  await expect(admin.locator('.fitem', { hasText: 'Footer' }).locator('.tag')).toHaveText('fixed text');
  await expect(admin.locator('.mk')).toHaveCount(9);
  // default image for an image field (a stamp), shown to users as a replaceable default
  await admin.click('text=Add field');
  await admin.fill('#fp input[type=text] >> nth=0', 'Stamp');
  await admin.locator('#fp select').nth(0).selectOption('image');
  await admin.locator('#fp select').last().selectOption('instance');
  await admin.locator('#fp label.chk', { hasText: 'Hide on the form' }).locator('input').uncheck();
  await admin.locator('#fp input[type=file]').setInputFiles({ name: 'stamp.png', mimeType: 'image/png', buffer: PNG });
  await expect(admin.locator('#fp .thumb')).toBeVisible();
  await expect(admin.locator('#fp button', { hasText: 'Replace image' })).toBeVisible();
  // images are sized by typing (1 pt steps, never below 5) or by dragging the marker's handle
  const wIn = admin.locator('#fp input[type=number]').nth(3), hIn = admin.locator('#fp input[type=number]').nth(4);
  await expect(wIn).toHaveValue('120'); await expect(wIn).toHaveAttribute('step', '1'); await expect(wIn).toHaveAttribute('min', '5');
  await wIn.fill('40'); await wIn.dispatchEvent('input');
  await expect.poll(async () => { const b = await admin.locator('.mk.on').boundingBox(); return b ? Math.round(b.width) : 0; }).toBeLessThan(70);
  await admin.waitForLoadState('networkidle'); await admin.waitForTimeout(400); // let the debounced preview settle: redraws replace the markers
  await admin.evaluate(() => scrollTo(0, 0)); // editing the inputs scrolled the page; the handle must be in view
  await expect(admin.locator('.mk.on .rz')).toBeVisible();
  let rz = null; for (let i = 0; i < 30 && !rz; i++) { rz = await admin.locator('.mk.on .rz').boundingBox().catch(() => null); if (!rz) await admin.waitForTimeout(100); }
  if (!rz) throw new Error('no resize handle');
  await admin.mouse.move(rz.x + 6, rz.y + 6); await admin.mouse.down(); await admin.mouse.move(rz.x + 6 + 60, rz.y + 6 - 30, { steps: 5 }); await admin.mouse.up();
  await expect.poll(async () => Number(await wIn.inputValue())).toBeGreaterThan(40 + 60 / sc - 3);
  expect(Number(await hIn.inputValue())).toBeGreaterThan(0); // dragging sets an explicit height box
  await hIn.fill('0'); await hIn.dispatchEvent('input'); // back to "follows the image"
  // a throw-away field: key editing and date format, then removal
  await admin.click('text=Add field');
  await admin.locator('#fp select').nth(0).selectOption('date');
  await admin.locator('#fp select').nth(1).selectOption('DD/MM/YYYY');
  await admin.fill('#fp input[type=text] >> nth=2', 'Custom Key'); await admin.keyboard.press('Tab');
  await expect(admin.locator('#fp input[type=text]').nth(2)).toHaveValue('custom_key'); // normalised on blur
  await expect(admin.locator('.mk')).toHaveCount(11);
  await admin.click('text=Remove field');
  await expect(admin.locator('.mk')).toHaveCount(10);
  await admin.click('button:has-text("›")'); await admin.click('button:has-text("‹")'); // single page: no-ops
  // image fields never offer link prefill
  await admin.locator('.fitem', { hasText: 'Signature' }).click();
  await expect(admin.locator('#fp select').last().locator('option[value=url]')).toHaveCount(0);
  // fixed values are hidden on the form by default; hidden fields cannot be required
  await admin.locator('.fitem', { hasText: 'Issued by' }).click();
  await expect(admin.locator('.fitem', { hasText: 'Issued by' }).locator('.tag', { hasText: 'hidden' })).toHaveCount(1);
  await expect(admin.locator('#fp label.chk', { hasText: 'Hide on the form' }).locator('input')).toBeChecked();
  await expect(admin.locator('#fp label.chk', { hasText: 'Required' })).toHaveCount(0);
});

test('admin drags a marker and the coordinates follow', async () => {
  await admin.evaluate(() => scrollTo(0, 0)); // the sticky header must not cover the marker
  const yIn = admin.locator('#fp input[type=number]').nth(2);
  const y0 = Number(await yIn.inputValue());
  const box = await admin.locator('.ov').boundingBox(); if (!box) throw new Error('no overlay');
  const sc = box.width / 595;
  const mk = await admin.locator('.mk.on').boundingBox(); if (!mk) throw new Error('no selected marker');
  await admin.mouse.move(mk.x + 5, mk.y + 5); await admin.mouse.down();
  await admin.mouse.move(mk.x + 5, mk.y + 35, { steps: 4 }); await admin.mouse.up();
  await expect.poll(async () => Number(await yIn.inputValue())).not.toBe(y0);
  const y1 = Number(await yIn.inputValue());
  expect(Math.abs((y0 - y1) - 30 / sc)).toBeLessThan(2); // moved 30 CSS px down = 30/sc points lower on the page
});

test('fields can be grouped and reordered', async () => {
  const setGroup = async (label, group) => { await admin.locator('.fitem', { hasText: label }).click(); await admin.fill('#fp input[placeholder^="e.g. Applicant"]', group); await admin.keyboard.press('Tab'); };
  await setGroup('Full name', 'Applicant'); await setGroup('Address', 'Applicant'); await setGroup('Signature', 'Consent');
  const order = () => admin.locator('.fitem b').allTextContents();
  expect((await order()).slice(0, 4)).toEqual(['Full name', 'Date', 'Reference', 'Address']);
  await admin.locator('.fitem', { hasText: 'Address' }).locator('button[title="Move up"]').click();
  await admin.locator('.fitem', { hasText: 'Address' }).locator('button[title="Move up"]').click();
  expect((await order()).slice(0, 4)).toEqual(['Full name', 'Address', 'Date', 'Reference']);
  await expect(admin.locator('.fitem', { hasText: 'Full name' }).locator('button[title="Move up"]')).toBeDisabled();
  await admin.locator('.fitem', { hasText: 'Date' }).dragTo(admin.locator('.fitem', { hasText: 'Agree' })); // drop before "Agree"
  const o = await order(); expect(o.indexOf('Date')).toBe(o.indexOf('Agree') - 1);
  await expect(admin.locator('.flist .fgroup')).toHaveText(['Applicant', 'Consent']); // adjacent fields share one heading
  await expect(admin.locator('button.pri')).toHaveText('Save changes');
  await admin.click('button.pri'); await expect(admin.locator('button.pri')).toHaveText('Saved');
  await admin.reload(); await expect(admin.locator('.mk')).toHaveCount(10);
  expect((await order()).slice(0, 2)).toEqual(['Full name', 'Address']); // the order is saved
});

test('admin saves metadata and gets a direct link', async () => {
  await admin.fill('input[placeholder^="e.g."]', 'school, demo');
  await admin.locator('label.chk input').first().check(); // listed in the public index
  await admin.locator('.panel textarea').first().fill('Sample request form for testing');
  await expect(admin.locator('button.pri')).toHaveText('Save changes');
  await expect(admin.locator('input[readonly]')).toHaveValue(/\/d\/[\w-]{12,16}$/); // random by default
  await admin.fill('#slugIn', 'Sample Request!');
  await expect(admin.locator('input[readonly]')).toHaveValue('http://127.0.0.1:8099/d/sample-request');
  await admin.click('button.pri');
  await expect(admin.locator('button.pri')).toHaveText('Saved');
  await expect(admin.locator('button.pri')).toBeDisabled();
  await admin.waitForLoadState('networkidle'); await shot(admin, '2-editor', true);
  link = await admin.locator('input[readonly]').inputValue();
  expect(link).toBe('http://127.0.0.1:8099/d/sample-request');
  await expect(admin.locator('a.btn', { hasText: 'Open form' })).toHaveAttribute('href', '/d/sample-request'); // follows the new link name
  await admin.locator('button', { hasText: 'Copy' }).first().click(); await expect(admin.locator('#toast')).toHaveText('Link copied');
  // document settings collapse (remembered) and the three-column layout on wide screens
  await admin.locator('details.ed-doc summary').click(); await expect(admin.locator('#slugIn')).toBeHidden();
  await admin.reload(); await expect(admin.locator('.wrap canvas')).toBeVisible(); await expect(admin.locator('#slugIn')).toBeHidden(); // still collapsed
  await admin.locator('details.ed-doc summary').click(); await expect(admin.locator('#slugIn')).toBeVisible();
  await admin.setViewportSize({ width: 1600, height: 900 });
  await expect.poll(async () => { const d = await admin.locator('.ed-doc').boundingBox(), s = await admin.locator('.ed-stage').boundingBox(); return d && s && d.x < s.x; }).toBe(true); // settings left of the page
  await admin.setViewportSize({ width: 1320, height: 900 });
  await expect.poll(async () => { const d = await admin.locator('.ed-doc').boundingBox(), s = await admin.locator('.ed-stage').boundingBox(); return d && s && d.x > s.x; }).toBe(true); // back to two columns
  // unsaved changes: navigating away asks first
  await admin.fill('input[placeholder^="e.g."]', 'school, demo, extra');
  await expect(admin.locator('button.pri')).toHaveText('Save changes'); // dirty, so navigating away must ask
  dialogAnswer = 'dismiss'; await admin.click('#nav a:has-text("Documents")');
  await expect(admin.locator('.wrap canvas')).toBeVisible(); // stayed
  dialogAnswer = 'accept'; await admin.click('#nav a:has-text("Documents")');
  await expect(admin.locator('table')).toBeVisible(); // left, change discarded
  await admin.goto('/admin' + docHash);
  // data survives a reload
  await admin.reload(); await expect(admin.locator('.mk')).toHaveCount(10);
  await expect(admin.locator('input[placeholder^="e.g."]')).toHaveValue('school, demo');
  // replacing the template keeps the fields; with unsaved changes it asks first
  await admin.locator('input[accept="application/pdf,.pdf"]').last().setInputFiles(PDF);
  await expect(admin.locator('#toast')).toHaveText('PDF replaced');
  await expect(admin.locator('.mk')).toHaveCount(10);
  await admin.fill('input[placeholder^="e.g."]', 'school, demo, dirty');
  dialogAnswer = 'dismiss';
  await admin.locator('input[accept="application/pdf,.pdf"]').last().setInputFiles(PDF);
  await expect(admin.locator('button.pri')).toHaveText('Save changes'); // declined: nothing replaced, still dirty
  dialogAnswer = 'accept';
  await admin.locator('input[accept="application/pdf,.pdf"]').last().setInputFiles(PDF);
  await expect(admin.locator('#toast')).toHaveText('PDF replaced');
  await expect(admin.locator('button.pri')).toHaveText('Saved');
  await admin.reload(); await expect(admin.locator('input[placeholder^="e.g."]')).toHaveValue('school, demo');
});

test('admin configures the network printer', async () => {
  await admin.goto('/admin#settings');
  await admin.fill('input[type=url]', 'http://127.0.0.1:6310/printers/Test');
  await admin.click('text=Test printer');
  await expect(admin.locator('#ptest')).toContainText('Mock IPP printer — idle');
  await expect(admin.locator('#ptest')).toContainText('Takes PDF');
  await admin.fill('input[placeholder="Print at home"]', 'Print at school');
  await admin.locator('label.chk input').check();
  await admin.click('button.pri'); await expect(admin.locator('#toast')).toHaveText('Saved');
  await shot(admin, '3-settings');
  // the admin password is stored in db.json on this instance, so it can be changed here
  await admin.fill('input[autocomplete=current-password]', 'wrong'); await admin.fill('input[autocomplete=new-password]', 'test-pass-456');
  await admin.click('text=Change password'); await expect(admin.locator('#toast')).toHaveText('Current password is wrong');
  await admin.fill('input[autocomplete=current-password]', PASSWORD);
  await admin.click('text=Change password'); await expect(admin.locator('#toast')).toHaveText('Password changed');
  await admin.click('text=Sign out all other sessions'); await expect(admin.locator('#toast')).toHaveText('All other sessions signed out');
  await expect(admin.locator('#nav')).toContainText('Settings'); // this session carries on with a fresh cookie
  await cov.snapshot(admin); // "Log out" reloads the page in place
  await admin.click('text=Log out'); await expect(admin.locator('form.login input[type=password]')).toBeVisible(); // the settings page has password inputs too until the reload lands
  await admin.fill('form.login input[type=password]', 'test-pass-456'); await admin.click('form.login button.pri');
  await expect(admin.locator('#nav')).toContainText('Settings');
  await admin.goto('/admin#'); await admin.reload();
  await expect(admin.locator('table')).toBeVisible();
  await expect(admin.locator('tbody tr')).toHaveCount(1);
  await expect(admin.locator('tbody td').nth(3)).toHaveText('Listed');
  await shot(admin, '4-admin-list');
});

test('public index lists the document and filters by tag', async () => {
  await user.goto('/');
  await expect(user.locator('.card')).toHaveCount(1);
  await expect(user.locator('.card b')).toHaveText('sample-form');
  await shot(user, '5-public-list');
  await user.fill('input[type=search]', 'nothing matches this');
  await expect(user.locator('.card')).toHaveCount(0);
  await expect(user.getByText('No matching documents')).toBeVisible();
  await user.fill('input[type=search]', '');
  await user.click('.chip:has-text("school")'); await expect(user.locator('.card')).toHaveCount(1);
  await expect(user).toHaveURL(/\?tag=school$/);
});

test('form prefills from the link and from fixed values, validates required fields', async () => {
  await user.goto(link + '#reference=REF-4711&birthday=24.12.1985&agree=1'); // link values may use the display notation
  await expect(user.locator('.preview canvas')).toBeVisible();
  await expect(user.locator('#f_reference')).toHaveValue('REF-4711');
  await expect(user.locator('#f_issued_by')).toHaveValue('Office Bietigheim');
  await expect(user.locator('#f_issued_by')).toBeHidden(); // fixed value: carried but not shown
  await expect(user.locator('#f_birthday')).toBeHidden();
  await expect(user.locator('#f_full_name')).toBeVisible();
  await expect(user.locator('#f_date')).toHaveValue(TODAY);
  await expect(user.locator('#f_birthday')).toHaveValue('1985-12-24'); // from the link, normalised for the date input
  await expect(user.locator('#f_footer')).toHaveCount(0); // fixed text has no input
  await expect(user.locator('.panel label')).toHaveCount(10); // 9 fields plus "Remember on this device" of the signature
  await expect(user.locator('.panel h2.fgroup')).toHaveText(['Applicant', 'Consent']); // group headings in field order
  expect(await user.locator('.panel label:not(.chk)').allTextContents()).toEqual(expect.arrayContaining(['Full name *', 'Address']));
  await expect(user.locator('.panel label').first()).toHaveText('Full name *');
  await expect(user.locator('input.remember')).not.toBeChecked(); // pictures are not remembered unless asked
  await expect(user.locator('#f_agree')).toBeChecked(); // checkbox from the link
  await expect(user.locator('.imgbox:has(#f_signature) .thumb')).toBeHidden(); // no signature yet
  await expect(user.locator('.imgbox:has(#f_stamp) .thumb')).toBeVisible(); // the admin's default stamp
  await expect(user.getByText('A default image is provided')).toBeVisible();
  await expect(user.locator('#f_full_name')).toHaveValue('');
  await user.click('button.pri'); // Print with the required field empty
  await expect(user.locator('#toast.bad')).toContainText('Please fill in: Full name');
  await expect(user.locator('#f_full_name')).toBeFocused();
  await settle(user, async () => {
    await user.fill('#f_full_name', 'Jürgen Müller-Weiß'); await user.fill('#f_date', '2026-10-13');
    await user.fill('#f_address', 'Hauptstraße 12\n74321 Bietigheim-Bissingen');
  });
  await user.locator('input.remember').check(); // pictures are only remembered on request (before the modal pad opens)
  // signature pad: cancel, empty, then a real stroke
  await user.click('text=Draw signature'); await expect(user.locator('dialog.sigdlg')).toBeVisible();
  await user.click('dialog.sigdlg >> text=Cancel'); await expect(user.locator('dialog.sigdlg')).toHaveCount(0);
  await user.click('text=Draw signature');
  await user.click('text=Use signature'); await expect(user.locator('#toast.bad')).toHaveText('Nothing drawn yet');
  const cv = await user.locator('canvas.sig').boundingBox(); if (!cv) throw new Error('no pad');
  const stroke = async (dx) => { await user.mouse.move(cv.x + 20 + dx, cv.y + 70); await user.mouse.down(); await user.mouse.move(cv.x + 90 + dx, cv.y + 30, { steps: 6 }); await user.mouse.move(cv.x + 180 + dx, cv.y + 80, { steps: 6 }); await user.mouse.up(); };
  await stroke(0); await user.click('text=Undo'); await stroke(0); await stroke(200); await user.click('text=Clear'); await stroke(40);
  await settle(user, () => user.click('text=Use signature'));
  await expect(user.locator('dialog.sigdlg')).toHaveCount(0);
  await expect(user.locator('.imgbox:has(#f_signature) .thumb')).toBeVisible();
  expect(await user.locator('.imgbox:has(#f_signature) .thumb').evaluate((im) => im.naturalWidth > 100 && im.naturalHeight > 30 && im.naturalHeight < im.naturalWidth)).toBe(true); // trimmed to the ink
  // or upload a picture instead
  await settle(user, () => user.locator('#f_signature').setInputFiles({ name: 'sig.png', mimeType: 'image/png', buffer: PNG }));
  await expect(user.locator('.imgbox:has(#f_signature) .thumb')).toBeVisible();
  await expect(user.locator('.imgbox:has(#f_signature) button', { hasText: 'Replace image' })).toBeVisible();
  await shot(user, '6-form', true);
});

test('server print sends an IPP job with the rendered PDF', async () => {
  fs.rmSync(IPP_OUT, { recursive: true, force: true });
  await user.click('text=Print at school'); // label from settings
  await expect(user.locator('#toast')).toHaveText('Sent to the printer (job 42)');
  const job = JSON.parse(fs.readFileSync(path.join(IPP_OUT, 'job.json'), 'utf8'));
  expect(job.attrs['document-format']).toBe('application/pdf');
  expect(job.attrs['job-name']).toBe('sample-form');
  expect(job.attrs.copies).toBe(1);
  expect(job.docBytes).toBeGreaterThan(1000);
  expect(fs.readFileSync(path.join(IPP_OUT, 'printed.pdf')).subarray(0, 5).toString()).toBe('%PDF-');
});

test('download delivers the filled PDF', async () => {
  const [dl] = await Promise.all([user.waitForEvent('download'), user.click('text=Download PDF')]);
  expect(dl.suggestedFilename()).toBe('sample-form.pdf');
  const bytes = fs.readFileSync(await dl.path());
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
});

test('"Copy link with values" carries only URL-prefill fields', async () => {
  await user.click('text=Copy link with values');
  await expect(user.locator('#toast')).toHaveText('Link copied');
  expect(await user.evaluate(() => navigator.clipboard.readText())).toBe(link + '#reference=REF-4711');
});

test('browser-remembered values survive a reload, link values do not', async () => {
  await user.goto(link);
  await expect(user.locator('.preview canvas')).toBeVisible();
  await expect(user.locator('#f_full_name')).toHaveValue('Jürgen Müller-Weiß');
  await expect(user.locator('#f_address')).toHaveValue(/74321/);
  await expect(user.locator('#f_reference')).toHaveValue('');
  await expect(user.locator('#f_birthday')).toHaveValue('1990-02-01'); // back to the fixed value without the link
  await expect(user.locator('.imgbox:has(#f_signature) .thumb')).toBeVisible(); // the signature is remembered in this browser
  await expect(user.locator('#f_date')).toHaveValue(TODAY); // "today" is recomputed on every open, not remembered
});

test('image print fallback renders pages and calls window.print', async () => {
  // own page: page.pdf() leaves the page with a suspended network stack, which would break later navigations
  const p = track(await user.context().newPage(), 'print');
  await p.goto(link); await expect(p.locator('.preview canvas')).toBeVisible();
  await p.evaluate(() => { window.print = () => { /** @type {any} */ (window).__printed = true; }; });
  await p.fill('#f_date', '2026-10-13');
  await p.evaluate(() => /** @type {any} */ (window).stampfillImagePrint());
  expect(await p.evaluate(() => /** @type {any} */ (window).__printed)).toBe(true);
  await expect(p.locator('#printArea img')).toHaveCount(1);
  // the Print button takes the same route in a browser without an inline PDF viewer (headless Chromium)
  await p.evaluate(() => { /** @type {any} */ (window).__printed = false; });
  await p.click('button.pri');
  await expect.poll(() => p.evaluate(() => /** @type {any} */ (window).__printed)).toBe(true);
  await p.emulateMedia({ media: 'print' });
  await p.pdf({ path: path.join(SHOTS, '..', 'browser-print.pdf'), preferCSSPageSize: true, printBackground: true });
  await p.emulateMedia({ media: 'screen' });
  // desktop Chromium with its PDF viewer prints the vector PDF through a hidden iframe
  await p.addInitScript(() => { Object.defineProperty(navigator, 'pdfViewerEnabled', { get: () => true }); });
  await p.goto(link); await expect(p.locator('.preview canvas')).toBeVisible();
  await p.click('button.pri');
  await expect(p.locator('#pf')).toHaveCount(1, { timeout: 10000 });
  await cov.stop(p); await p.close();
});

test('"Forget saved values" clears browser prefill', async () => {
  await user.click('text=Forget saved values');
  await expect(user.locator('#toast')).toHaveText('Saved values removed from this browser');
  await expect(user.locator('#f_full_name')).toHaveValue('');
  await user.reload(); await expect(user.locator('.preview canvas')).toBeVisible();
  await expect(user.locator('#f_full_name')).toHaveValue('');
  await expect(user.locator('#f_address')).toHaveValue('');
  await expect(user.locator('.imgbox:has(#f_signature) .thumb')).toBeHidden();
  // files that are not images are refused with a message
  await user.locator('#f_signature').setInputFiles({ name: 'sig.png', mimeType: 'image/png', buffer: Buffer.from('this is not an image') });
  await expect(user.locator('#toast.bad')).toHaveText('That file is not a PNG or JPEG image');
  await expect(user.locator('.imgbox:has(#f_signature) .thumb')).toBeHidden();
  // an image can also be removed on its own
  await settle(user, () => user.locator('#f_signature').setInputFiles({ name: 'sig.png', mimeType: 'image/png', buffer: PNG }));
  await expect(user.locator('.imgbox:has(#f_signature) .thumb')).toBeVisible();
  await settle(user, () => user.locator('.imgbox:has(#f_signature) button', { hasText: 'Remove' }).click());
  await expect(user.locator('.imgbox:has(#f_signature) .thumb')).toBeHidden();
});

test('form works on a phone-sized screen', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const mp = track(await ctx.newPage(), 'mobile');
  await mp.goto(link + '#full_name=Mobile+User&reference=M-1');
  await expect(mp.locator('.preview canvas')).toBeVisible();
  await expect(mp.locator('#f_full_name')).toHaveValue('Mobile User');
  await mp.waitForLoadState('networkidle'); await expect(mp.locator('.preview')).not.toHaveClass(/busy/);
  await shot(mp, '7-form-mobile', true);
  await cov.stop(mp); await ctx.close();
});

test("the form speaks the visitor's language and can be switched", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1320, height: 900 }, locale: 'de-DE', baseURL: 'http://127.0.0.1:8099' });
  const dp = track(await ctx.newPage(), 'german');
  await dp.goto(link); await expect(dp.locator('.preview canvas')).toBeVisible();
  await expect(dp.locator('.actions button.pri')).toHaveText('Drucken'); // browser language
  await expect(dp.locator('html')).toHaveAttribute('lang', 'de');
  await dp.selectOption('#langSel', 'ar'); await expect(dp.locator('.preview canvas')).toBeVisible();
  await expect(dp.locator('html')).toHaveAttribute('dir', 'rtl'); await expect(dp.locator('.actions button.pri')).toHaveText('طباعة');
  await dp.selectOption('#langSel', 'en'); await expect(dp.locator('.preview canvas')).toBeVisible();
  await expect(dp.locator('.actions button.pri')).toHaveText('Print'); await expect(dp.locator('html')).toHaveAttribute('dir', 'ltr');
  await dp.goto('/admin'); await expect(dp.locator('form.login h1')).toHaveText('Admin login'); // the choice is remembered
  await dp.selectOption('#langSel', 'de'); await expect(dp.locator('form.login h1')).toHaveText('Admin-Anmeldung'); // the admin page too
  await cov.stop(dp); await ctx.close();
  // the instance default applies to visitors whose browser language is not available
  await admin.goto('/admin#settings'); await admin.selectOption('#defLang', 'de');
  await admin.click('button.pri'); await expect(admin.locator('#toast')).toHaveText('Saved');
  const jctx = await browser.newContext({ viewport: { width: 1320, height: 900 }, locale: 'ja-JP', baseURL: 'http://127.0.0.1:8099' });
  const jp = track(await jctx.newPage(), 'japanese');
  await jp.goto(link); await expect(jp.locator('.preview canvas')).toBeVisible();
  await expect(jp.locator('html')).toHaveAttribute('lang', 'de'); await expect(jp.locator('.actions button.pri')).toHaveText('Drucken');
  await cov.stop(jp); await jctx.close();
  await admin.selectOption('#defLang', 'en'); await admin.click('button.pri'); await expect(admin.locator('#toast')).toHaveText('Saved');
});

test('form follows the dark colour scheme', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1320, height: 900 }, colorScheme: 'dark' });
  const dp = track(await ctx.newPage(), 'dark');
  await dp.goto(link + '#full_name=Dark+Mode&reference=D-1');
  await expect(dp.locator('.preview canvas')).toBeVisible();
  await dp.waitForLoadState('networkidle'); await expect(dp.locator('.preview')).not.toHaveClass(/busy/);
  const bg = await dp.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(17, 19, 23)');
  await shot(dp, '8-form-dark');
  await cov.stop(dp); await ctx.close();
});

test('admin can switch off network printing and protect the form with a password', async () => {
  await admin.goto('/admin' + docHash); await expect(admin.locator('.wrap canvas')).toBeVisible();
  await admin.locator('label.chk', { hasText: 'Allow printing' }).locator('input').uncheck();
  await admin.fill('input[placeholder="No password"]', 'open-sesame');
  await admin.click('button.pri'); await expect(admin.locator('button.pri')).toHaveText('Saved');
  await expect(admin.locator('input[placeholder^="Password set"]')).toBeVisible();
  // a fresh visitor must unlock first
  const ctx = await browser.newContext({ baseURL: 'http://127.0.0.1:8099' });
  const v = track(await ctx.newPage(), 'visitor');
  await v.goto(link); await expect(v.getByText('This form is protected')).toBeVisible();
  await v.fill('input[type=password]', 'wrong'); await v.click('button.pri'); await expect(v.locator('#toast')).toHaveText('Wrong password');
  await v.fill('input[type=password]', 'open-sesame'); await v.click('button.pri');
  await expect(v.locator('.preview canvas')).toBeVisible();
  await expect(v.locator('button', { hasText: 'Print at school' })).toHaveCount(0); // switched off for this form
  await v.reload(); await expect(v.locator('.preview canvas')).toBeVisible(); // stays unlocked in this browser
  await v.goto('/'); await expect(v.locator('.card .tag', { hasText: 'password' })).toHaveCount(1);
  await cov.stop(v); await ctx.close();
  // the existing user context has no unlock cookie yet
  await user.goto(link); await expect(user.getByText('This form is protected')).toBeVisible();
  await user.fill('input[type=password]', 'open-sesame'); await user.click('button.pri'); await expect(user.locator('.preview canvas')).toBeVisible();
  // removing the password opens the form for everyone again
  await admin.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(admin.locator('input[placeholder^="Password will be removed"]')).toBeVisible();
  await admin.click('button.pri'); await expect(admin.locator('button.pri')).toHaveText('Saved');
  await expect(admin.locator('input[placeholder="No password"]')).toBeVisible();
  const ctx2 = await browser.newContext({ baseURL: 'http://127.0.0.1:8099' });
  const v2 = track(await ctx2.newPage(), 'visitor2');
  await v2.goto(link); await expect(v2.locator('.preview canvas')).toBeVisible();
  await cov.stop(v2); await ctx2.close();
});

test('admin rotates the link and deletes the document', async () => {
  dialogAnswer = 'accept';
  await admin.goto('/admin' + docHash); await expect(admin.locator('.wrap canvas')).toBeVisible();
  await admin.click('text=Random link');
  await expect(admin.locator('#toast')).toHaveText('New link created');
  const fresh = await admin.locator('input[readonly]').inputValue(); expect(fresh).not.toBe(link);
  await user.goto(link); await expect(user.getByText('Document not found')).toBeVisible();
  await user.goto(fresh); await expect(user.locator('.preview canvas')).toBeVisible();
  await admin.click('button.danger:has-text("Delete")');
  await expect(admin.getByText('No documents yet')).toBeVisible();
  await user.goto('/'); await expect(user.getByText('No documents are listed here')).toBeVisible();
  // a template without fields is still printable
  await admin.setInputFiles('input[type=file]', PDF);
  await expect(admin.locator('.wrap canvas')).toBeVisible();
  await expect(admin.getByText('No fields yet')).toBeVisible();
  const bare = await admin.locator('input[readonly]').inputValue();
  await user.goto(bare); await expect(user.locator('.preview canvas')).toBeVisible();
  await expect(user.getByText('This document has no fields to fill in')).toBeVisible();
  await admin.click('button.danger:has-text("Delete")');
  await expect(admin.getByText('No documents yet')).toBeVisible();
});

test('no browser errors were logged', () => {
  expect(errors).toEqual([]);
});

test('the browser tests execute most of the client code', async () => {
  const c = await cov.finish();
  console.log('client coverage: ' + c.scripts.map((s) => s.kind + ' ' + s.pct + '%').join(', ') + ' — total ' + c.total.pct + '%');
  expect(c.scripts.length).toBe(2);
  for (const s of c.scripts) expect(s.pct, s.kind).toBeGreaterThanOrEqual(85);
});
