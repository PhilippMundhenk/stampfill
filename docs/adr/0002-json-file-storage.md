# 0002. A JSON file and the filesystem instead of a database

Date: 2026-10-13 · Status: accepted

## Context

An instance holds a handful to a few hundred documents, each with a few dozen fields, and
changes rarely (an admin edits a layout; users only read). Installations are tiny and often run
by people who do not want to operate a database.

## Decision

All structured state is one object serialised to `DATA_DIR/db.json` (written atomically through a
temporary file and rename). Binary data stays on disk next to it: templates in `pdfs/`, default
images in `images/`, an optional `font.ttf`. The object is kept in memory; reads never touch the
disk, writes rewrite the whole file.

## Consequences

- Backup and restore are copying one directory; moving an instance is the same.
- Every write rewrites the file: fine for this size, wrong for tens of thousands of documents.
  That is a documented limitation, not a planned path.
- There is exactly one process; running two against the same directory would race. Scaling out
  is not a goal.
- The schema is implicit. `cleanFields()` and friends define it in code, and
  [ADR 0007](0007-in-process-migrations.md) keeps old files loadable.
