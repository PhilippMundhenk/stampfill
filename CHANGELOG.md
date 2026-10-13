# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
