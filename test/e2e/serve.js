// Starts stampfill on a clean data directory for the end-to-end tests (used by playwright.config.js).
// The admin password is stored in db.json rather than passed through ADMIN_PASSWORD, so the
// "change password" part of the settings page is live, as on a typical installation.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const data = path.resolve(__dirname, '..', '..', 'test-results', 'data');
fs.rmSync(data, { recursive: true, force: true });
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'db.json'), JSON.stringify({ auth: 'e2esalt:' + crypto.scryptSync('test-pass-123', 'e2esalt', 32).toString('hex') }));
Object.assign(process.env, { PORT: '8099', HOST: '127.0.0.1', ADMIN_PASSWORD: '', DATA_DIR: data });
require('../../stampfill.js').start().catch((e) => { console.error(e); process.exit(1); });
