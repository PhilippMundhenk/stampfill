# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Coverage gates: c8 on the server (95% lines, 85% branches) and V8 coverage of the inline page
  scripts from the browser suite (85% per page); a process-level test for startup checks and
  shutdown; a mock printer that can simulate failures.
- Page rotation per page in the editor: quarter turns and arbitrary angles (e.g. 2.5°) to
  straighten skewed scans, stored with the document and applied on render.
- Optional readable link name per document (`/d/library-card-request`); links stay random
  unless a name is set.
- Optional password per document, checked on every public endpoint; users unlock once per browser.
- Per-field "Hide on the form" switch; fields with a fixed value are hidden by default.
- The server-print button is called "Print at home", its label is a setting, and each document can
  switch it off.
- Field type "Image": users pick a PNG or JPEG (downscaled in the browser), the admin can set a
  default image, and browser prefill remembers it per user, e.g. for signatures.
- Field type "Fixed text": set by the admin, stamped on every print, not editable or visible as an
  input on the public form.
- Prefill mode "Today's date" for date fields.
- `PUID`/`PGID` in Compose and `.env.example` to run the container as the owner of a bind-mounted
  data folder; README section on file permissions.
- Startup check that refuses to run with an unwritable data directory and prints the UID/GID in use.
- gzip for pages and pdf.js assets with an in-memory cache; `modulepreload` for pdf.js.

### Fixed
- Instances with existing documents crashed at startup after 1.0.0 ("Cannot access 'keyOf' before
  initialization"). Stored data is now upgraded by one idempotent migration step that is tested
  against a 1.0.0 data directory.
- The editor preview showed today's date for every date field; it now shows the fixed value when
  one is set. Fixed values for date fields use a date picker, and dates typed as `13.10.2026`,
  `13/10/2026` or `10/13/2026` (per the field's format) are accepted in fixed values and links.

### Changed
- New date fields default to the YYYY-MM-DD print format in the editor. Stored fields keep their
  format.
- Interface refresh: new light/dark palette, sticky translucent header with logo, hover and focus
  states, skeleton preview while loading, sticky action bar on phones, styled selects and toasts.
- Live preview debounce reduced to 200 ms and the previous page stays visible, dimmed, while the
  next render is in flight.

## [1.0.0] - 2026-10-13

First release under the name stampfill (previously "pdfforms").

### Added
- Admin interface: upload PDF templates, place text, multi-line, date and checkbox fields by
  double-click or drag, tag documents, list them publicly or share by direct link, rotate links.
- Public form per document with live preview, browser print, PDF download and optional
  server-side printing through IPP (CUPS or any IPP printer that accepts PDF).
- Prefill per field: remembered in the user's browser, fixed per instance, or carried in the link.
- `/healthz` endpoint for container health checks.
- Docker image (multi-stage, non-root, health check), Compose file with a named data volume and
  an optional Caddy overlay for automatic HTTPS.
- GitHub Actions: lint, unit, API and end-to-end tests on every push; image publishing to GHCR
  on `main` and on version tags.
- Unit and API tests on `node:test`; end-to-end tests on Playwright.

### Changed
- Renamed from pdfforms to stampfill. The session cookie, CSRF header value and the browser
  storage prefix changed with it, so admins log in again and browser-remembered field values
  from the old name are not carried over.
- Field keys derived from labels now drop diacritics ("Ärger" becomes `arger`) instead of
  replacing them with underscores.
- Settings missing from an older `db.json` fall back to their defaults.
- Graceful shutdown: the server stops accepting connections on SIGTERM/SIGINT before exiting.

### Fixed
- Fields submitted through the API without an `id` received the literal value `undefined`
  instead of a generated id.
- The login rate-limit table could grow without bound; stale entries are now pruned.
