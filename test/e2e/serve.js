// Starts stampfill on a clean data directory for the end-to-end tests (used by playwright.config.js).
'use strict';
const fs = require('fs'), path = require('path');
const data = path.resolve(__dirname, '..', '..', 'test-results', 'data');
fs.rmSync(data, { recursive: true, force: true });
Object.assign(process.env, { PORT: '8099', HOST: '127.0.0.1', ADMIN_PASSWORD: 'test-pass-123', DATA_DIR: data });
require('../../stampfill.js').start().catch((e) => { console.error(e); process.exit(1); });
