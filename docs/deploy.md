# Deployment

The Compose file in the repository root runs stampfill with a named data volume, a health check
and a hardened container (read-only root file system, no capabilities, memory and PID limits).
Settings come from `.env`; `.env.example` documents every variable. This page covers what goes
around it: HTTPS, your own proxy, file permissions, backups and upgrades. Running without Docker
is described in [deploy-without-docker.md](deploy-without-docker.md), printing in
[printing.md](printing.md).

## HTTPS with Caddy

Set `DOMAIN` in `.env` to a hostname that resolves to the server and start with the overlay:

```sh
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
```

Caddy obtains and renews a Let's Encrypt certificate, sends HSTS and proxies to stampfill. Port
8080 is no longer published, and the overlay sets `TRUST_PROXY=1` by itself.

## Behind your own reverse proxy

Point nginx, Traefik or similar at port 8080, forward `X-Forwarded-For` and `X-Forwarded-Proto`,
and set `TRUST_PROXY=1` and `BIND=127.0.0.1` in `.env`. The client address is then taken from the
last `X-Forwarded-For` entry, the one your proxy appends; without `TRUST_PROXY` the headers are
ignored, so that nobody can spoof an address and sidestep the login limiter. Cookies are marked
`Secure` when `X-Forwarded-Proto` says `https` (or always, with `SECURE_COOKIES=1`), and the app
then also sends HSTS.

## File permissions (UID/GID)

The container runs as the unprivileged user `node`, **UID 1000 and GID 1000**, and writes only to
`/data`. Errors like `EACCES: permission denied, open '/data/db.json'` mean that directory is
owned by someone else. Two ways to fix it:

- **Named volume** (the default in `docker-compose.yml`): nothing to do. Docker creates the volume
  with the ownership baked into the image.
- **Bind mount** (`./data:/data`): either give the host folder to UID 1000
  (`sudo chown -R 1000:1000 ./data`), or run the container as the folder's owner. Find your ids
  with `id -u` and `id -g`, put them into `.env` as `PUID` and `PGID`, and Compose passes them
  as `user: "PUID:PGID"`. Without Compose: `docker run --user 1000:1000 …`.

The service refuses to start, with a message naming the UID/GID it runs as, when `/data` is not
writable, so a wrong setting shows up in `docker compose logs` right away.

## Backups

All state is in the data directory (`stampfill-data` in Compose, `DATA_DIR` otherwise):

| Path | Content |
| --- | --- |
| `db.json` | Documents, field layouts, settings, admin password hash, session secret |
| `pdfs/`, `images/` | Uploaded templates and default images |
| `audit.log` | Logins, settings and document changes, print jobs; never form values. Rotates at 10 MB |
| `font.ttf` | Optional TrueType font for stamped text in other scripts |

Nothing else is kept on the server, so backing up that directory is a complete backup. It holds
the signing secret and password hashes, so treat backups as secrets. Values visitors chose to
remember live in their own browsers only, for 30 days.

## Upgrades

Releases are tagged `1.1.0`, `1.1` and `latest`. Set `STAMPFILL_TAG` in `.env` to follow a version
line, then:

```sh
docker compose pull && docker compose up -d
```

Every version migrates the stored data on start and the migration is covered by a test that boots
from a 1.0.0 data directory, so upgrading is always a pull and a restart. Downgrading is not
supported; take a copy of the data directory before upgrading if you want that option.

## Health check

`GET /healthz` returns `{"ok":true}` for everyone and adds the version and document count for a
logged-in admin. The Docker image and the Compose file already use it; point your monitoring at
the same URL.
