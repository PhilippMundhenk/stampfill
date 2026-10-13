# 0007. Stored data is upgraded by one in-process migration step with a fixture test

Date: 2026-10-13 · Status: accepted

## Context

Installations upgrade in place by replacing the image or the file; nobody runs migration
commands. Version 1.0.x once shipped a field migration that ran before its helpers were defined
and crashed every instance that had documents. Tests started from empty data and never noticed.

## Decision

`migrate()` is the only place that upgrades loaded data. It runs at startup after every helper is
defined, re-cleans every stored structure (`cleanFields`, `cleanTags`, `cleanRotation`, settings
defaults, per-document defaults), is idempotent, and writes the result back. New stored properties
get their defaults there. `test/unit/migrate.test.js` boots the service from a copy of a 1.0.0
data directory (`test/fixtures/db-v1.json`) and exercises the API against it; it must stay green.

## Consequences

- No schema version number is needed: cleaning is idempotent and additive.
- Removing or renaming a stored property requires a deliberate migration and a fixture update;
  the contributing guide says so.
- The fixture is also a regression test for the startup order bug that motivated this record.
