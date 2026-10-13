# 0001. One source file, no web framework, no build step

Date: 2026-10-13 · Status: accepted

## Context

stampfill is meant for a school office, a club or a household: one person installs it, nobody
maintains it full time, and it should still run unchanged in five years. Frameworks, bundlers and
transpilers each add a dependency tree that rots faster than the application.

## Decision

The server, the admin page and the public page live in `stampfill.js`. The server uses only
Node's `http`, `fs`, `crypto` and `zlib`. The pages are HTML strings with inline CSS and
JavaScript, written with a small DOM helper; the only client library is pdf.js, served from
`node_modules`. Runtime dependencies are `pdf-lib`, `pdfjs-dist` and the optional fontkit.

## Consequences

- Reading the whole program is possible in one sitting; there is no magic to learn.
- Client code sits inside `String.raw` templates and may not contain backticks or `${`. A unit
  test extracts the served scripts and parses them so syntax errors cannot ship.
- Coverage tools cannot see the client code, which led to [ADR 0009](0009-coverage-of-inline-scripts.md).
- The file is long (around 1 000 lines of server code plus the pages). Sections are separated by
  banner comments; splitting into modules remains possible without changing the deployment.
