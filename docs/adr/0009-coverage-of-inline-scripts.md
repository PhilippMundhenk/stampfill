# 0009. The browser suite measures coverage of the inline page scripts itself

Date: 2026-10-13 · Status: accepted

## Context

The project requires 95% test coverage. c8 measures `stampfill.js` well, but the client code is a
string inside that file and executes only in the browser, so c8 reports nothing about it. A real
number was needed to keep the browser suite honest.

## Decision

`test/e2e/coverage.js` collects V8 precise coverage through Playwright for every page the suite
opens, merges the byte ranges of the two inline scripts across all pages and navigations, and the
last test fails when a page script falls below 85% executed non-whitespace bytes. Because V8 drops
a document's counters on navigation, coverage is snapshotted before every `goto()`/`reload()` and
before in-page reloads. The largest unexecuted stretches are written to
`test-results/client-coverage.json` so the next test step to write is obvious.

## Consequences

- The browser suite is one serial story rather than isolated tests; retries are off because a
  retry would start mid-story. Flakiness has to be fixed, not retried.
- The metric is bytes, not statements, and it is strict: an unexecuted `&&` branch counts.
- Adding client code without a browser step for it fails CI.
