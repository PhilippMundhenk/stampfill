# Contributing

Thanks for taking the time. Bug reports, fixes and small focused features are welcome.

## Setup

```sh
npm ci
npx playwright install chromium        # once, for the end-to-end tests
ADMIN_PASSWORD=dev-pass-123 npm start  # http://localhost:8080, admin at /admin
```

## Checks

```sh
npm run lint        # ESLint
npm run test:unit   # node:test — helpers and the HTTP API against an in-process server
npm run test:e2e    # Playwright — admin UI and public form in headless Chromium
npm test            # all of the above
```

The end-to-end run starts its own instance on port 8099 with a fresh data directory under
`test-results/` plus a mock IPP printer on port 6310. Screenshots of the test run land in
`test-results/screenshots/`. The README screenshots are different: `npm run screenshots` builds a
demo instance with realistic forms (`scripts/screenshots.js`) and writes `docs/screenshots/`.

## Coverage

`npm run test:unit` runs under c8 and fails below the thresholds in `.c8rc.json` (95% lines,
functions and statements, 85% branches of `stampfill.js`). The report lands in
`test-results/coverage/`; `npm run test:unit:fast` skips it.

The browser code cannot be seen by c8 (it is a string inside `stampfill.js`), so the Playwright
suite measures it itself through Chromium's V8 coverage (`test/e2e/coverage.js`). The last test
prints the executed share of the public and admin page scripts, writes
`test-results/client-coverage.json` with the largest unexecuted stretches, and fails below 85% per
script. If you add client code, add the step that exercises it to `test/e2e/stampfill.spec.js`.

## Stored data and upgrades

Every change to what is stored in `db.json` or `DATA_DIR` needs a step in `migrate()` in
`stampfill.js` and must keep `test/unit/migrate.test.js` green, which boots the service from a
1.0.0 data directory (`test/fixtures/db-v1.json`). Never rename or drop a stored property without
a migration; installations upgrade in place.

## Guidelines

- Keep the single-file layout: server and both pages live in `stampfill.js`. Client code sits in
  `String.raw` templates, so it must not contain backticks or `${`.
- New HTTP behaviour needs a test in `test/unit/api.test.js`; new UI behaviour needs a step in
  `test/e2e/stampfill.spec.js`.
- Run `npm test` before opening a pull request. CI runs the same checks plus a Docker build.
- Note user-visible changes in `CHANGELOG.md` under "Unreleased".

## Releasing

Bump `version` in `package.json`, move the changelog entries under a new heading, commit, then
tag `vX.Y.Z` and push the tag. The release workflow publishes the image to GHCR and creates a
GitHub release.
