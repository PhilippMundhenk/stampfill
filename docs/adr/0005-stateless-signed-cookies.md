# 0005. Stateless HMAC cookies for the admin session and document unlocks

Date: 2026-10-13 · Status: accepted

## Context

There is one admin and, optionally, a password per document. Sessions must survive restarts
(the service is restarted on every update) without a session store.

## Decision

A session cookie is `expiry.HMAC-SHA256(secret, "admin." + expiry)`. A document unlock cookie is
`HMAC-SHA256(secret, "doc." + id + "." + passwordHash)`, one cookie per document. The secret
lives in `db.json`; it is rotated when the admin password changes, which signs out every other
session. Cookies are `HttpOnly`, `SameSite=Strict`, and `Secure` when the proxy reports HTTPS.
Passwords are hashed with scrypt; comparisons are constant-time; failed attempts are rate limited
per client address.

## Consequences

- No session table, no cleanup, nothing lost on restart.
- A stolen session cookie is valid until its expiry (7 days) unless the secret is rotated. There
  is no "sign out everywhere" button besides changing the password.
- Unlock cookies become invalid the moment a document's password changes, without any bookkeeping.
- `SameSite=Strict` means a link to the admin page from another site opens without the session;
  acceptable for an admin tool.
