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
- Anyone who knows a document link can render PDFs with that template. Treat links as
  capability URLs and rotate them from the admin interface ("New link") if they leak.
- "Let everyone with a document link use this printer" sends print jobs on behalf of anonymous
  users. Keep it off unless the instance is only reachable on a trusted network.
- The service has no accounts beyond the single admin password. Pick a long one, or let the
  service generate it.
