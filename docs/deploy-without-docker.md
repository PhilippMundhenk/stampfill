# Deploying without Docker

stampfill is a single Node.js process with no native dependencies, no database and no build
step. It needs Node.js 22 or newer, a writable data directory and a TCP port. Anything that can run
a Node process and proxy HTTPS to it can host it: a VPS with systemd, a NAS, a shared host such as
Uberspace.

## What the process needs

| Need | Detail |
| --- | --- |
| Node.js | 22 or newer (`node --version`) |
| Files | the repository (or just `stampfill.js`, `package.json`, `package-lock.json`) with production dependencies installed: `npm ci --omit=dev` |
| Data directory | `DATA_DIR` (default `./data`), writable by the user running the process; holds `db.json`, `pdfs/`, `images/`, optional `font.ttf` |
| Port | `PORT` (default 8080) on `HOST` (default `0.0.0.0`) |
| Reverse proxy | anything that terminates HTTPS and forwards `X-Forwarded-For` and `X-Forwarded-Proto`; set `TRUST_PROXY=1` |
| Memory | around 50 MB resident, more while rendering large templates |

The service must be mounted at the root of a hostname (`https://forms.example.org/`), not under a
path prefix: links such as `/d/<name>` and `/api/...` are absolute.

## Uberspace

Uberspace 7 provides Node.js, a supervisord instance per user and HTTPS for every domain, which is
all stampfill needs. Everything below runs as your Uberspace user over SSH.

```sh
# 1. Node.js 22 (or newer; see `uberspace tools version list node`)
uberspace tools version use node 22
node --version

# 2. Code and dependencies
cd ~
git clone https://github.com/PhilippMundhenk/stampfill.git
cd stampfill
npm ci --omit=dev

# 3. Data directory outside the checkout, so updates never touch it
mkdir -p ~/stampfill-data
```

Create the service definition `~/etc/services.d/stampfill.ini`. Pick a free port between 1024 and
65535. Keep the file private because it carries the admin password (`chmod 600`); alternatively
leave `ADMIN_PASSWORD` out, start the service once and read the generated password from
`supervisorctl tail stampfill`, then change it under Settings.

```ini
[program:stampfill]
directory=%(ENV_HOME)s/stampfill
command=node stampfill.js
environment=PORT="8080",HOST="0.0.0.0",DATA_DIR="%(ENV_HOME)s/stampfill-data",TRUST_PROXY="1",ADMIN_PASSWORD="change-me-to-something-long"
autostart=yes
autorestart=yes
startsecs=10
stopsignal=TERM
```

```sh
chmod 600 ~/etc/services.d/stampfill.ini
supervisorctl reread
supervisorctl update
supervisorctl status stampfill        # RUNNING
supervisorctl tail stampfill          # "stampfill 1.0.0 listening on http://0.0.0.0:8080"

# 4. Route a domain to the port (Uberspace terminates HTTPS and forwards X-Forwarded-Proto)
uberspace web backend set / --http --port 8080
# for a dedicated domain added with `uberspace web domain add forms.example.org`:
uberspace web backend set forms.example.org/ --http --port 8080
```

Open `https://<your-domain>/admin`. The proxy sends `X-Forwarded-Proto: https`, so the session
cookie is marked `Secure`, and `TRUST_PROXY=1` makes the login rate limit see real client
addresses.

Updating:

```sh
cd ~/stampfill && git pull && npm ci --omit=dev && supervisorctl restart stampfill
```

Backups: `~/stampfill-data` is the whole state. Uberspace keeps its own daily backups of your
home directory; copying that directory elsewhere now and then is still a good idea.

Printing: the Uberspace host is on the internet, not on your home network, so it cannot reach a
home printer directly. Use the browser's Print and Download buttons there, or leave the printer URL
empty so the server-print button does not appear.

## Any Linux server with systemd

Create a system user and directories:

```sh
sudo useradd --system --home /opt/stampfill --shell /usr/sbin/nologin stampfill
sudo git clone https://github.com/PhilippMundhenk/stampfill.git /opt/stampfill
cd /opt/stampfill && sudo npm ci --omit=dev
sudo mkdir -p /var/lib/stampfill && sudo chown stampfill:stampfill /var/lib/stampfill
sudo install -m 600 -o root -g root deploy/systemd/stampfill.env /etc/stampfill.env   # edit ADMIN_PASSWORD
sudo cp deploy/systemd/stampfill.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now stampfill
sudo systemctl status stampfill
```

The unit in `deploy/systemd/stampfill.service` runs as the `stampfill` user with a read-only
filesystem except the data directory, and restarts on failure. Put nginx, Caddy or Traefik in
front for HTTPS (see the README for the proxy headers) and keep port 8080 bound to localhost by
setting `HOST=127.0.0.1` in `/etc/stampfill.env`.
