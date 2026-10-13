# Security review

Date: 2026-10-13 · Scope: `stampfill.js` (server and both inline page scripts), the Docker image,
the Compose files and overlays, the Caddy configuration, the GitHub workflows, dependencies and
the documented deployments. Method: an independent read-through by a reviewer who had not written
the code, followed by verification of every finding against the source and, where practical, by
tests. `npm audit --omit=dev` reported no known vulnerabilities in the production dependencies
(`pdf-lib`, `pdfjs-dist`, `@pdf-lib/fontkit`).

The service handles personal data: names, addresses, birth dates and signatures travel through
it on their way to paper. The review therefore rates findings against the goal that nothing of
that data leaks, is altered, or is retained anywhere it should not be. Severities use the
GitHub labels `security/critical` … `security/info`; every finding has an issue.

## Threat model

- **Who**: anyone on the network the instance is reachable from (a home LAN, or the internet
  when exposed through a proxy); people sharing a computer with a user of the form; an attacker
  who obtained a backup of the data directory; a compromised or malicious printer or CUPS server.
- **What they want**: the content of filled forms, the templates, the admin account (which gives
  all of the above plus the printer), or simply to take the service down.
- **What the design already gives**: one admin password (scrypt), stateless HMAC cookies, a
  CSRF guard through a custom header, strict input normalisation, no persistence of user values
  on the server, a non-root container that writes only to one volume. Details in
  [design.md](design.md).

## Findings

Status reflects the state of `main` after the hardening commits that followed the review.

| # | Finding | Severity | Issue | Status |
| --- | --- | --- | --- | --- |
| 1 | Brute-force limiter bypass: `TRUST_PROXY=1` by default with port 8080 published, and the client address taken from the wrong end of `X-Forwarded-For` | high | #24 | fixed |
| 2 | PNG decompression bomb through `/render` and `/print` | high | #25 | fixed |
| 3 | CUPS sidecar published port 631 to the network with default credentials | high | #26 | fixed |
| 4 | No rate limit or concurrency cap on public rendering; blocking scrypt; 20 copies per anonymous print | medium | #27 | fixed |
| 5 | Browser prefill kept personal data and signatures indefinitely on shared computers | medium | #28 | fixed |
| 6 | Form passwords could be 4 characters | medium | #29 | fixed |
| 7 | Sessions could not be revoked with `ADMIN_PASSWORD` set; unlock tokens carried no expiry | medium | #30 | fixed |
| 8 | Printer URL requests followed redirects and buffered unbounded answers | low | #31 | fixed |
| 9 | No HSTS; `Secure` cookies depended only on the proxy header | low | #32 | fixed |
| 10 | CSP allowed `'unsafe-inline'` scripts | low | #33 | fixed |
| 11 | `db.json` and uploads were world-readable | low | #34 | fixed |
| 12 | Printer errors revealed internal hostnames to anonymous users | low | #35 | fixed |
| 13 | Hidden fixed-value fields could be overridden through the API | low | #36 | fixed |
| 14 | `/healthz` disclosed version and document count | low | #37 | fixed |
| 15 | Supply chain: actions pinned by tag, base images not digest-pinned, no provenance | low | #38 | fixed |
| 16 | `pdf-lib` and `fontkit` have had no release since 2021 | low | #39 | open (mitigated by #25) |
| 17 | Container defaults: port on all interfaces, no read-only filesystem, no capability drop, no memory limit | low | #40 | fixed |
| 18 | Minor: query-string prefill, directory paths under `/vendor`, prototype keys, request timeouts, `ADMIN_PASSWORD_FILE`, audit log | info | #41 | fixed |

### 1. Rate-limit bypass through proxy headers (high, #24)

The quick-start Compose file set `TRUST_PROXY=1` while publishing port 8080 directly. A client
talking to that port could put any address into `X-Forwarded-For` and the login limiter counted
failures against that address, never against the real one. The code also took the *first*
`X-Forwarded-For` entry; nginx and Traefik append the real address at the *end*, so the bypass
also worked behind those proxies as documented.

Fixed: `TRUST_PROXY` is off unless set (the Caddy overlay sets it), the client address is the
last entry of the header, and a server-wide brake (50 failed password attempts in 5 minutes,
regardless of address) stops guessing that spoofing would otherwise hide. Login and unlock are
additionally limited to 20 requests per minute per address.

### 2. PNG decompression bomb (high, #25)

Image values are data URLs embedded with pdf-lib, which decodes PNGs completely. A file of a few
hundred kilobytes declaring 20 000 × 20 000 pixels would have inflated to gigabytes and blocked
the single thread. Fixed: the declared dimensions are read from the PNG header or the JPEG SOF
marker before anything decodes, images above 16 megapixels or 20 000 pixels on a side are
refused, the data-URL cap dropped from 6 million to 3 million characters, and the container has
a memory limit.

### 3. CUPS sidecar exposed (high, #26)

The CUPS overlay published port 631 on every interface and fell back to `print`/`print`. Whoever
controls the queue receives every printed form. Fixed: the port is no longer published (stampfill
reaches `cups:631` on the Compose network; administration goes through `docker compose exec` or
an SSH tunnel), `CUPSPASSWORD` must be set, and the image is pinned.

### 4. Public rendering without limits (medium, #27)

Every keystroke on a form renders a PDF on the server, which is the feature, but nothing stopped
a loop of requests from occupying the only thread. Fixed: 120 renders and 10 print jobs per minute
per client, at most four renders at once with a short queue (503 beyond that), cached template
bytes, scrypt moved off the event loop with the environment password hashed once, anonymous print
jobs capped at 5 copies, and request header and body timeouts.

### 5. Personal data in the browser (medium, #28)

"Remember per user" is the convenience the service is built around, and a design decision
([ADR 0006](adr/0006-prefill-in-the-browser.md)) keeps that data out of the server. On a shared
computer it was still handed to the next person. Fixed: pictures and signatures are only
remembered after the user ticks "Remember on this device", everything remembered expires after
30 days, the form says so next to each remembered field, and "Forget saved values" clears it all.

### 6 and 7. Passwords and sessions (medium, #29, #30)

Form passwords need 8 characters. Admin sessions last 12 hours of inactivity instead of a fixed
7 days and slide on use. Unlock cookies carry their expiry inside the signed token. Settings
offers "Sign out all other sessions", which rotates the signing secret and therefore kills every
session and unlock in every browser, also when the password comes from the environment.

### 8 to 14. Low-severity findings (#31 to #37)

Requests to the printer no longer follow redirects and read at most 1 MB. The app sends HSTS
when it sees HTTPS from the proxy, and `SECURE_COOKIES=1` forces the `Secure` flag where a proxy
does not pass the header. The Content Security Policy names the SHA-256 hash of each page's
inline script instead of allowing inline scripts. `db.json`, templates and images are written
with mode 0600 in 0700 directories. Printer failures reach anonymous users as a generic sentence;
admins see the detail. Hidden fixed-value fields are stamped from the document, never from the
request. `/healthz` answers `{"ok":true}` to strangers and adds the version only for admins.

### 15. Supply chain (low, #38)

GitHub Actions are pinned by commit SHA (Dependabot keeps them current), base images by digest,
and the release publishes provenance and an SBOM with the image.

### 16. Dormant dependency (low, #39, open)

`pdf-lib` has had no release since 2021. It only ever sees admin-uploaded PDFs and image bytes
that passed the dimension check, which removes the known dangerous path. Switching to a
maintained fork remains an option and the issue stays open to track it.

### 17 and 18. Deployment defaults and small things (#40, #41)

The container runs read-only with a tmpfs for `/tmp`, drops all capabilities, forbids new
privileges, and has memory and process limits. The bind address is configurable (`BIND` in
`.env`). Prefill from the link works only through the fragment (`#key=value`), which never reaches
a server or a proxy log. `ADMIN_PASSWORD_FILE` reads the password from a file (Docker secrets).
An append-only `audit.log` in the data directory records logins, settings changes, document
creation and deletion, password changes and print jobs with time and client address, never form
values.

## What was found to be sound

- No injection of any kind: the DOM is built with `textContent`, routes are regex-anchored,
  every stored property passes through a cleaning function, `Object.assign` only ever copies an
  allow-list, vendor files are served from an allow-list with a traversal check.
- CSRF: custom header required on every non-GET request, `SameSite=Strict` cookies, no CORS
  headers at all. Clickjacking: `frame-ancestors 'none'` everywhere.
- Secrets: scrypt with random salts, HMAC-SHA256 with a 32-byte secret, constant-time
  comparisons wherever a secret is compared, no plaintext anywhere.
- Privacy: user values are never stored or logged on the server, rendered PDFs are not kept,
  dynamic responses are `no-store`, `Referrer-Policy: no-referrer`, the print job name is the
  template title.
- Operations: non-root container, health checks, allow-list `.dockerignore`, least-privilege
  workflow permissions, lockfile with `npm ci`, Dependabot for npm, actions and Docker.

## Residual risks and advice to operators

- The admin account is a single shared password. Keep it long, prefer `ADMIN_PASSWORD_FILE`,
  and use "Sign out all other sessions" after any suspicion.
- Anyone with a document link can render PDFs with that template and, when public printing is
  on, print them. Treat links as capabilities, use random links or passwords for anything not
  meant for everyone, and keep public printing off outside a trusted network.
- The printer or CUPS queue is part of the data path. Use `ipps://` where the printer supports
  TLS, keep CUPS unreachable from the network, and remember that paper is the least protected
  copy of all.
- The data directory is a secret: it holds the signing secret and password hashes next to the
  templates. Back it up like one.
- `audit.log` grows without bound; rotate it with the host's tools.
- Shared computers: tell users about "Forget saved values", or set the fields they fill to no
  prefill.

## Re-running the review

The checks that back this document live in the test suite: rate limits, the server-wide brake,
the image size gate, hidden fixed values, cookie flags, HSTS, CSP hashes, file modes, the audit
log and the error texts shown to anonymous users are all asserted in `test/unit/api.test.js`,
`test/unit/helpers.test.js` and `test/unit/process.test.js`. A change that weakens one of them
fails CI.
