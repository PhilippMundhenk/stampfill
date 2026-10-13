# Security

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private
vulnerability reporting on this repository ("Security" tab, "Report a vulnerability"),
or contact the maintainer directly. You should get a first response within a week.

## Deployment notes

- Run stampfill behind HTTPS whenever it is reachable from outside a trusted network.
  The admin session cookie is only marked `Secure` when the proxy sends `X-Forwarded-Proto: https`.
- Set `TRUST_PROXY=1` only when a reverse proxy is in front of the service, otherwise clients can
  spoof their IP and bypass the login rate limit.
- Document links are random and unguessable by default. A readable link name makes the link
  guessable; combine it with a form password when the document is not meant for everyone. A form
  password is checked on every public endpoint, not only in the page.
- "Let everyone with a document link use this printer" sends print jobs on behalf of anonymous
  users. Keep it off unless the instance is only reachable on a trusted network.
- The service has no accounts beyond the single admin password. Pick a long one, or let the
  service generate it.
