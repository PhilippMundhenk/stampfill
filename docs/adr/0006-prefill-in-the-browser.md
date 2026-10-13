# 0006. Personal prefill values and signatures stay in the user's browser

Date: 2026-10-13 · Status: accepted

## Context

Users fill the same personal details into many forms: name, address, date of birth, signature.
Remembering them is the main convenience of the service, but storing personal data on the server
would make every instance a small personal-data registry with all the duties that brings.

## Decision

"Remember per user" prefill stores the value in the browser's `localStorage` under the field key,
shared across documents of the same instance. Signatures are stored the same way as data URLs. The
server receives values only inside a render, print or download request and never persists them.
The form offers "Forget saved values" to clear them.

## Consequences

- The server holds no user data at rest; a backup of an instance contains templates and layouts,
  not people.
- Values are per browser: a user at a different computer types them again. Links can carry
  non-sensitive values (`#key=value`) for that case; the editor restricts that mode to text fields.
- Shared computers keep the last user's values until "Forget saved values" is used. The form says
  under each remembered field that it is remembered.
- Browser storage is cleared when the user clears site data; that is by design.
