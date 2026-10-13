# 0008. Links are random by default; readable names and passwords are opt-in

Date: 2026-10-13 · Status: accepted

## Context

Documents are shared by link. Readable links (`/d/library-card`) are nicer to print on a notice
board but guessable; random links (`/d/ol1YPeph3npXIQ`) are unguessable but ugly. Some documents
should be reachable by everyone, some only by people who were given the link or a password.

## Decision

A new document gets a random 14-character link. The admin can give it a readable name; the editor
warns that this makes the link guessable. Any document can additionally require a password, which
is checked on every public endpoint, not only in the page. "Random link" restores an unguessable
one at any time. Listing on the public index is a separate switch.

## Consequences

- The default stays safe without the admin reading documentation.
- Three independent knobs (listed, readable name, password) cover the realistic cases: public
  notice-board form, internal form by link, protected form by password.
- Readable names must be unique per instance; the API refuses duplicates instead of renaming
  silently.
