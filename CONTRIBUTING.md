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
`test-results/` plus a mock IPP printer on port 6310. Screenshots land in
`test-results/screenshots/`. To refresh the screenshots in the README run the suite with
`SCREENSHOTS_DIR=docs/screenshots`.

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
