# Design

stampfill turns a PDF template into a web form: an admin places fields on the rendered page, users
fill them in and get the stamped PDF printed, downloaded or sent to a network printer. This
document describes how the service is built and why. The individual decisions are recorded as
[architecture decision records](adr/README.md).

## Shape of the system

```
browser (public form)  ──HTTP──▶  stampfill.js  ──IPP──▶  printer or CUPS queue
browser (admin editor) ──HTTP──▶       │
                                       ▼
                                 DATA_DIR/  db.json · pdfs/ · images/ · font.ttf
```

One Node.js process, one source file, two runtime dependencies (`pdf-lib` for writing PDFs,
`pdfjs-dist` for rendering them in the browser) plus the optional `@pdf-lib/fontkit` for custom
fonts. There is no framework, no database server and no build step: the two web pages are HTML
strings with inline CSS and JavaScript that the server sends from memory, gzip-compressed.

The whole state lives in `DATA_DIR`: `db.json` (settings, documents, field layouts, the admin
password hash, the session secret, per-document password hashes), the uploaded templates in
`pdfs/<id>.pdf`, default images of image fields in `images/<name>`, and an optional `font.ttf`.
Backing up that directory is a complete backup; upgrading is replacing the file and restarting.

## Request handling

`route()` is a hand-written router over `req.method` and `req.url`:

| Area | Routes | Access |
| --- | --- | --- |
| Pages | `/`, `/d/<slug>`, `/admin` | anyone; HTML from memory |
| Assets | `/vendor/...` | pdf.js files from `node_modules`, allow-listed by name |
| Public API | `/api/docs`, `/api/d/<slug>[/render\|/print\|/unlock\|/image/<key>]` | anyone with the link; a document password gates everything but `/unlock` |
| Admin API | `/api/login`, `/api/logout`, `/api/admin/...` | admin session cookie |

Every non-GET request must carry `X-Requested-With: stampfill`. Browsers do not add custom
headers to cross-site form posts or simple requests, so this is the CSRF guard; the same-origin
`fetch` in the pages adds it. All responses carry `Cache-Control: no-store` (except the immutable
vendor files), a strict Content Security Policy, `X-Content-Type-Options`, `Referrer-Policy` and
`frame-ancestors 'none'`.

Errors are thrown as `HttpErr(status, message)` and turned into `{ "error": message }` JSON by
one handler; anything else becomes a generic 500 and is logged.

## Data model

```jsonc
{
  "secret": "…",                 // HMAC key for session and unlock cookies
  "auth": "salt:scrypt-hex",     // admin password, unless ADMIN_PASSWORD is set in the environment
  "settings": { "siteTitle", "printerUrl", "publicPrint", "printButton" },
  "docs": [{
    "id": "…", "slug": "…", "title", "description", "tags": [], "listed": false,
    "serverPrint": true, "password": null | "salt:scrypt-hex",
    "pages": 1, "rotation": [0],  // degrees per page, applied on render
    "fields": [{
      "id", "key", "label", "type": "text|textarea|date|checkbox|image|static",
      "required", "hidden", "page", "x", "y", "size", "maxWidth", "height",
      "dateFormat", "prefill": "none|browser|instance|url|today", "value"
    }]
  }]
}
```

`cleanFields()`, `cleanTags()`, `cleanRotation()` and `cleanValues()` are the only way data gets
into these structures: every property is coerced, bounded and defaulted there, so the rest of the
code can trust the shape. `migrate()` runs the same functions over everything loaded from disk at
startup, which is how older `db.json` files are upgraded (see [ADR 0007](adr/0007-in-process-migrations.md)).

Coordinates are PDF points with the origin at the bottom-left of the page, exactly what pdf-lib
draws with. The editor converts between viewport pixels and points through pdf.js's viewport, so a
field placed at a pixel in the browser lands at the same point in the printed PDF.

## Rendering pipeline

`renderPdf(doc, fields, values, rotation, preview)`:

1. Load the template with pdf-lib.
2. If any page has a rotation, embed that page as a form XObject and draw it rotated around the
   centre of a fresh page of the right size; the original upload is never modified.
3. Embed the font: `DATA_DIR/font.ttf` through fontkit if present (Unicode), else Helvetica.
   Characters the font cannot encode are replaced by `?` instead of failing the whole render.
4. For each field on an existing page: fixed text uses its stored value; images are decoded from
   the data URL the user sent or the admin's default file and drawn into their width × height box;
   dates are normalised to ISO and reformatted; checkboxes become `X`; everything else is text
   with optional wrapping. In editor previews, image fields without an image draw a placeholder.
5. Save to a buffer.

The same function serves the public preview (values from the user), the public print and download,
and the editor preview (sample values, unsaved fields and rotation).

The browser never renders PDFs itself for the preview: it posts the values, receives the finished
PDF and draws it with pdf.js. That keeps one rendering code path and one source of truth for
"what will print".

## Printing

Server-side printing speaks IPP (RFC 8011) directly over HTTP: a `Print-Job` with
`document-format: application/pdf` to the configured URL (`ipp://` is rewritten to `http://`).
`Get-Printer-Attributes` backs the "Test printer" button in Settings and reports the formats the
printer accepts. Printers that only take raster formats answer `0x040a`; for them the Compose
overlay adds a CUPS sidecar that converts ([ADR 0004](adr/0004-ipp-and-cups.md)).

Browser printing takes the vector PDF route on desktop Chromium (hidden iframe with the PDF
viewer) and falls back to printing high-resolution page images everywhere else, because mobile
browsers and Firefox cannot print an inline PDF reliably.

## Front end

Both pages are built with a 40-line DOM helper (`h()`) and plain `fetch`. The code sits inside
`String.raw` templates in `stampfill.js`, which means it must not contain backticks or `${`; a unit
test extracts both scripts from the served HTML and parses them so a stray parenthesis cannot
ship. There is no bundler and no npm package for the client: the pages load pdf.js from
`/vendor/`, which the server serves from `node_modules` with long cache lifetimes.

Prefill modes decide where a value comes from when the form opens: the link (`#key=value`), the
browser's `localStorage` (per user, never sent to the server until they print), a fixed value from
the admin, or today's date. Image fields follow the same rules; a signature stored with browser
prefill never leaves the user's machine except inside the rendered PDF they asked for.

## Security model

- One admin, one password (environment variable or scrypt hash in `db.json`). Sessions are
  `expiry.HMAC(secret, "admin." + expiry)` cookies: nothing to store server-side, and rotating the
  secret signs everyone out.
- Document passwords use the same scheme per document, bound to the password hash, so changing
  the password invalidates every unlock cookie.
- Login and unlock attempts are rate limited per client address (5 failures, 5 minutes).
- Links are random by default; a readable name is opt-in and the editor says it makes the link
  guessable. Documents can be listed on the index or stay link-only.
- The public API only ever exposes what the form needs: no internal ids, no password hashes, no
  fixed-text fields, no default image files except through the per-document image route.
- The container runs as an unprivileged user with a read-only image and one writable volume.

`docs/security.md` holds the audit of this model and its findings.

## Testing strategy

| Layer | Tool | What it covers |
| --- | --- | --- |
| Helpers and HTTP API | `node:test` under c8, in-process server and in-process mock IPP printer | every route, every error path, printer failures, gzip, proxies, cookies |
| Upgrade path | `node:test` booting from a 1.0.0 data directory | migrations stay backward compatible |
| Process | spawned `stampfill.js` | unwritable data dir, generated password, SIGTERM, port in use |
| Browser | Playwright, one serial story | the whole admin and user journey; V8 coverage of the inline scripts |

Coverage gates are enforced in CI: 95% of server lines and 85% of each inline page script.

## Limitations and non-goals

- One admin account; no per-user permissions. Forms are shared by link or password.
- `db.json` is rewritten on every change: fine for hundreds of documents, not for tens of
  thousands.
- Printing from the server needs a printer that accepts PDF or a CUPS queue in between; there is
  no built-in rasteriser.
- The editor places text at points; it does not fill existing AcroForm fields of a PDF.
