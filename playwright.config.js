// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'test/e2e',
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0, // the suite is one serial story on shared state; a retry would start mid-story
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:8099',
    viewport: { width: 1320, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
    trace: 'retain-on-failure',
  },
  webServer: [
    { command: 'node test/mock-ipp.js', url: 'http://127.0.0.1:6310/', env: { MOCK_IPP_OUT: 'test-results/ipp' }, reuseExistingServer: false },
    { command: 'node test/e2e/serve.js', url: 'http://127.0.0.1:8099/healthz', reuseExistingServer: false },
  ],
});
