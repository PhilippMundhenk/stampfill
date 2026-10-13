# Security

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private
vulnerability reporting on this repository ("Security" tab, "Report a vulnerability"),
or contact the maintainer directly. You should get a first response within a week.

## Deployment notes

- Run stampfill behind HTTPS whenever it is reachable from outside a trusted network.
  The admin session cookie is only marked `Secure` when the proxy sends `X-Forwarded-Proto: https`.
- Set `TRUST_PROXY=1` only when a reverse proxy you control is in front of the service. Without a
  proxy, leave it off: clients could otherwise spoof their address. A server-wide brake on failed
  password attempts exists regardless, but the per-address limiter is the first line.
- The data directory contains the signing secret and password hashes next to the templates and the
  audit log. Back it up like a secret and keep it at mode 0700 (the service sets that itself).
- The CUPS sidecar is in the data path: every printed form goes through it. Keep it unreachable
  from the network (the overlay does not publish it) and set a real `CUPSPASSWORD`.
- Use "Sign out all other sessions" in Settings after any suspicion; it invalidates every admin
  session and every unlocked form in every browser.
- The full review with findings and their status is in [docs/security.md](docs/security.md).
- Document links are random and unguessable by default. A readable link name makes the link
  guessable; combine it with a form password when the document is not meant for everyone. A form
  password is checked on every public endpoint, not only in the page.
- "Let everyone with a document link use this printer" sends print jobs on behalf of anonymous
  users. Keep it off unless the instance is only reachable on a trusted network.
- The service has no accounts beyond the single admin password. Pick a long one, or let the
  service generate it.
