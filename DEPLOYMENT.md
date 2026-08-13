# Lubuntu deployment

This deployment keeps the application private to the tailnet and keeps the
application-owned HDD separate from the media directory.

```text
private Tailscale HTTPS
          |
          v
host Tailscale Serve -> 127.0.0.1:3000 -> web
                                      |\
                                        | postgres (private Compose network)
                                        | background-worker
                                        | opendataloader-hybrid (private CPU OCR)
                                        | python-worker (private bounded execution)
                                        | self-hosted search and page services (private)
                                        ` discord (optional profile)
```

The Compose stack includes the application services plus private SearXNG,
Miniflux, and Firecrawl services and their databases/queue/browser
dependencies. Wikipedia results are retrieved through SearXNG. Only `web` is
reachable through the host's loopback port; the search
services, databases, queues, and browser service are private to the Compose
network.
The `python-worker` service is private to a separate execution network shared
only with `web` and `background-worker`; it has no host port and receives only
its named workspace volume.
The optional `discord` profile adds the local Discord Gateway process without
adding a host port or a storage mount. PostgreSQL uses the named
`wowzerbowser-postgres` volume and has no host-published port. The web port and
OpenDataLoader port are not published to the host.

## Storage safety

The host layout is:

```text
/srv/storage/
|-- media/                 # owner-managed media; never mounted by the app
`-- wowzerbowser/          # the only application bind mount
    |-- config/searxng/     # generated non-secret SearXNG settings
    `-- files/              # application files
```

The repository never mounts `/srv/storage` or `/srv/storage/media`. The
startup wrapper requires `/srv/storage` to be a mountpoint with filesystem
label `homelab-storage`, verifies that it is not the root filesystem, checks
both top-level directories, and passes a verified guard into the containers.
The container entrypoint also refuses an unverified start and refuses to start
if `/srv/storage/media` is visible inside the container.

Identify disks and mounts before any administrative change:

```bash
lsblk -o NAME,SIZE,FSTYPE,LABEL,MOUNTPOINTS,MODEL,SERIAL
findmnt -T /srv/storage
findmnt -T /
```

Only an administrator who has independently confirmed that a disk is empty
may format it. Never select a device from an automated script. The deployment
agent does not format disks, mount them, edit `/etc/fstab`, or modify the media
directory.

## I/O priority

The host uses cgroup v2 relative I/O weights so interactive applications and
explicit user work remain responsive while OCR, indexing, torrent metadata,
resolvers, and other bulk work continue in the background. The policy covers
the Wowzer Bowser containers and the separately deployed media, HomeTube, and
other application containers. Unlisted containers receive a conservative
background weight rather than unlimited priority.

Install or refresh the persistent user timer from the guarded deployment
checkout:

```bash
./docker/install-io-priority.sh
```

Inspect the current container weights without changing them:

```bash
./ops/io-priority/apply.sh status
```

Host-native bulk operations should use the idle-I/O wrapper:

```bash
./ops/io-priority/run-bulk.sh rsync -a --delete source/ destination/
```

The application queues remain the first priority boundary: HomeTube manual
downloads outrank podcast and automatic downloads, qBittorrent queueing stays
enabled, and Radarr/Sonarr remain the request path for media acquisition. The
host policy is intentionally weighted rather than an absolute lockout so
background work cannot permanently starve.

## Initial setup

Install Docker Engine with the Compose plugin and confirm the deployment user
can run Docker without `sudo`:

```bash
hostname
id -un
findmnt -T /srv/storage
docker version
docker compose version
```

From the repository checkout, keep deployment secrets under the application
storage directory:

```bash
cp .env.example /srv/storage/wowzerbowser/deployment.env
chmod 600 /srv/storage/wowzerbowser/deployment.env
```

Set `APP_UID` and `APP_GID` from `id -u` and `id -g`. Set a random
`POSTGRES_PASSWORD`, make `DATABASE_URL` use the same password, and set
`APP_OWNER_EMAIL`. Set a random `AUTH_SECRET` and keep
`NEXT_PUBLIC_SITE_URL` on the private Tailscale HTTPS origin. Local binaries
are stored below `/srv/storage/wowzerbowser/files`; do not configure that path
to point at `/srv/storage/media`. Also replace the Miniflux and Firecrawl
database/admin secrets, `SEARXNG_SECRET`, and `FIRECRAWL_BULL_AUTH_KEY`.

After Miniflux is running, create a server-only API token for its owner and set
`MINIFLUX_API_TOKEN`. The versioned feed manifest is synchronized during guarded
updates and can also be synchronized manually with:

```bash
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh run --rm --no-deps -T web node scripts/provision-miniflux-feeds.mjs
```

Generate or verify the stable server-only database owner key:

```bash
node scripts/ensure-app-owner-id.mjs --env-file /srv/storage/wowzerbowser/deployment.env
```

Keep the resulting `APP_OWNER_ID` fixed for the lifetime of this installation.
It is the stable local PostgreSQL owner UUID used by Auth.js and all application
repositories. Never expose it, `AUTH_SECRET`, passwords, or provider
credentials to client code.

Set `NEXT_PUBLIC_SITE_URL` to the private HTTPS hostname reported by Tailscale
Serve after it is configured.

If authenticated reads work but state-changing requests such as conversation
deletion or OAuth connection start return `Unauthorized`, compare this value
with the browser origin exactly. The same-origin guard and provider callback
URLs both use it; changing it does not require rotating the Auth.js session.

Validate the rendered Compose file:

```bash
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh config
```

Apply local PostgreSQL migrations once before starting the application. The
`SKIP_DATABASE_MIGRATION_CHECK` flag is only for this one-shot command:

```bash
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh run --rm -e SKIP_DATABASE_MIGRATION_CHECK=1 web node scripts/migrate.mjs --initialize
```

Start the stack through the guarded wrapper:

```bash
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh up -d --build
```

The web and worker entrypoints refuse to start when a local PostgreSQL
migration is pending.

## Generated SearXNG settings

SearXNG reads the application-owned settings file at
`/srv/storage/wowzerbowser/config/searxng/settings.yml`. The web and background
worker already have this path inside their existing application bind mount, so
the runtime configuration service can write it with an atomic replacement.
SearXNG receives only that file, mounted read-only at
`/etc/searxng/settings.yml`; it never receives the rest of the application tree
or the protected media directory. The Compose service uses
`SEARXNG_SETTINGS_PATH` to select the generated file and adds the configured
`APP_GID` as a supplemental read group for the service's non-root user.

On a guarded `up`, `start`, `restart`, `run`, or `create`,
`docker/compose.sh` verifies that this path is a real application-owned
directory, rejects symlinks, and creates the file from the checked-in
`docker/searxng/settings.yml` baseline only when it is absent. It never replaces
an existing generated file. The baseline preserves the current JSON search
format, disabled limiter, and private-instance defaults. Keep API keys,
passwords, and `SEARXNG_SECRET` out of the generated file; secrets remain in
`deployment.env`.

SearXNG reads settings at process startup. After changing Configurables, use a
guarded restart so the service remounts the new file:

```bash
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh up -d --force-recreate searxng
```

`docker/update.sh` performs this SearXNG recreation automatically. Do not
replace the generated path with a symlink, mount `/srv/storage` or
`/srv/storage/media`, or bypass `docker/compose.sh` for application startup.

Set `PYTHON_WORKER_SECRET` in `/srv/storage/wowzerbowser/deployment.env` to a
new random value of at least 32 characters. The web, durable worker, and local
Python worker must share this value.

Bootstrap the one owner once the migration is applied. The command is
idempotent for the configured owner and never logs the password:

```bash
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh run --rm -e SKIP_DATABASE_MIGRATION_CHECK=1 web node scripts/bootstrap-owner.mjs --env-file /srv/storage/wowzerbowser/deployment.env
```

Rotate the owner password when needed; this increments the session version and
invalidates every existing Auth.js session:

```bash
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh run --rm -e SKIP_DATABASE_MIGRATION_CHECK=1 web node scripts/reset-owner-password.mjs --env-file /srv/storage/wowzerbowser/deployment.env
```

## Database migrations

Migration files live in `database/migrations` and are applied in lexical order.
Each successful file is recorded in `schema_migrations`; applying them again
is safe and does not recreate or remove the named PostgreSQL volume.

```bash
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh run --rm -e SKIP_DATABASE_MIGRATION_CHECK=1 web node scripts/migrate.mjs --status
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh run --rm -e SKIP_DATABASE_MIGRATION_CHECK=1 web node scripts/migrate.mjs --check
```

Do not use `docker compose down -v`. The named PostgreSQL volume is durable
application state and must be preserved during updates.

## Operations

```bash
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh ps
docker inspect --format '{{json .State.Health}}' wowzerbowser-web-1
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh logs --tail=200 web background-worker python-worker searxng miniflux firecrawl
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh down
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh up -d --build
docker volume inspect wowzerbowser-postgres
docker inspect wowzerbowser-web-1 --format '{{json .Mounts}}'
docker inspect wowzerbowser-background-worker-1 --format '{{json .Mounts}}'
docker inspect wowzerbowser-python-worker-1 --format '{{json .Mounts}}'
```

Check readiness directly from the host when diagnosing a restart or failed
healthcheck:

```bash
curl --fail-with-body --silent --show-error http://127.0.0.1:3000/api/health
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh run --rm --no-deps -T web node scripts/migrate.mjs --check
```

The health response is safe to log: it contains statuses and stable failure
codes, not database URLs, passwords, API keys, or migration contents.

Auth.js credentials, structured application state, and binary object metadata
are persisted through the private local PostgreSQL service. Binary contents are
stored atomically below `/srv/storage/wowzerbowser/files` and are served only
through authenticated application routes. The background worker removes
bounded batches of abandoned temporary uploads, stale empty chats, and
incomplete file records. It also runs the automation, memory-summary, and
memory-consolidation sweeps in the same worker process. Automation claims,
leases, attempts, outcomes, next occurrences, and failures are persisted in
PostgreSQL; no external scheduler or per-automation host cron is required.

The scheduler intervals and bounded batch sizes are configured in
`deployment.env` with `AUTOMATION_SCHEDULER_INTERVAL_MS`,
`AUTOMATION_SCHEDULER_BATCH`, `MEMORY_SCHEDULER_INTERVAL_MS`,
`STORAGE_MAINTENANCE_INTERVAL_MS`, `DISCORD_PROCESSING_INTERVAL_MS`, and
`WORKER_MAINTENANCE_LIMIT`. Keep the worker concurrency limits conservative on
this host.

## Optional Discord Gateway

The Discord Gateway worker is local to the Compose network. Its internal API
requests always target `http://web:3000`; `NEXT_PUBLIC_SITE_URL` is used only
for links shown to the Discord user. Add `DISCORD_BOT_TOKEN`,
`DISCORD_ALLOWED_USER_ID`, and a matching random `DISCORD_INTERNAL_SECRET` to
`/srv/storage/wowzerbowser/deployment.env`, then start it with:

```bash
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh --profile discord up -d --build
```

Check the optional service with `./docker/compose.sh --profile discord ps` and
inspect its JSON readiness logs. Discord attachment URLs are submitted to the
authenticated internal web route; the local background worker downloads and
ingests them through the web service below `/srv/storage/wowzerbowser/files`.
The Gateway container does not receive access to `/srv/storage/media`.

If Discord is not configured, omit the profile. The core stack does not require
Discord credentials or a Discord Gateway connection.

## Download-only Windscribe isolation

Download-related services use a separate Docker network namespace; the host's
default route is unchanged. The implementation lives in
`ops/download-vpn/`. The gateway uses the supplied WireGuard profile and
Gluetun's built-in firewall as a kill switch. Its WireGuard configuration is
deployment-only and must be installed at:

```text
/srv/storage/wowzerbowser/secrets/windscribe-philadelphia.conf
```

Keep that regular file owned by the service user with mode `0600`. Never put its
contents in this checkout, Compose environment variables, GitHub, or logs.
Gluetun requires a numeric peer endpoint; the supervisor resolves the
hostname into a separate runtime-only `windscribe-philadelphia.resolved.conf`
with mode `0600` and leaves the supplied source profile unchanged.

The isolated set is:

* media acquisition: qBittorrent, Prowlarr, Radarr, Sonarr, Jellyseerr, and
  FlareSolverr;
* the HomeTube worker, including its `yt-dlp` process; and
* the music acquisition worker when the optional `spotdl` path is enabled.

Jellyfin, Navidrome, both music and HomeTube databases, HomeTube web, the
Drive project (`app-web`/`app-postgres`), Tailscale, SSH, the host, and the
Wowzer Bowser services remain outside the VPN. The gateway is attached to
existing Docker bridges only for required local service and database traffic;
it does not attach the Drive or media playback traffic to the VPN namespace.

The gateway disables IPv6 inside the shared namespace because Docker's
existing bridges do not provide routed IPv6. Its internal DNS listener uses
protected upstream DNS over the VPN path; VPN-required containers do not use
the host resolver directly.

Install and enable the user-systemd supervisors after the secret is in place
(`loginctl` linger is already enabled for `evanh`):

```bash
/srv/storage/wowzerbowser/ops/download-vpn/install-systemd.sh
systemctl --user status wowzerbowser-download-vpn.service
systemctl --user status wowzerbowser-tailscale-exit.service
```

It waits for Docker and the storage mount, starts the gateway, waits for the
actual Gluetun healthcheck, and then starts the isolated services. If the
tunnel fails, it stops only the VPN-required services; normal services keep
their existing networking. Docker and systemd restart policies recover the
gateway after a container, Docker, or host restart.

The externally managed media, HomeTube, and music Compose files are not
rewritten. The supervisor creates timestamped backups beside them before an
apply. The overlays are `media-compose.vpn.yaml`,
`hometube-compose.vpn.yaml`, and `music-compose.vpn.yaml`.

For a future downloader, add it to the relevant overlay with
`network_mode: "container:download-vpn"`, clear its normal `networks`, and
use `127.0.0.1` as its DNS. Add only its administration port and any required
local bridge CIDR to the gateway. Verify its exit IP and repeat the intentional
gateway-stop test before enabling it.

For rollback, stop and disable `wowzerbowser-download-vpn.service`, stop the
isolated containers, restore the timestamped Compose backups, and start the
original media/HomeTube/music Compose projects with their original commands.
Do not remove persistent volumes or run `docker compose down -v`.

## Tailscale exit node through Windscribe

The host advertises itself as a Tailscale exit node with the installed
Tailscale CLI. The existing host default route remains on the LAN. A dedicated
Docker bridge (`wowzerbowser-download-vpn-exit`, `172.24.0.0/28`) leads only to
the healthy Windscribe gateway. Traffic arriving from `tailscale0` uses host
policy table `51820`; Tailnet-to-Tailnet, LAN, and Docker-local destinations
are explicitly kept direct, while the table's default is a blackhole whenever
the gateway is not healthy. The host firewall drops any other forwarded
traffic from `tailscale0`, and the Gluetun namespace NATs only the Tailnet
source range through `tun0`.

IPv4 forwarding is enabled with loose reverse-path filtering. IPv6 forwarding
is enabled only so Tailnet-to-Tailnet traffic can continue; Internet-bound
IPv6 received on `tailscale0` is dropped and the exit table has a blackhole
IPv6 default. Tailscale netfilter is set to `nodivert` so it does not move its
own broad forwarding accept rule ahead of the fail-closed chain.

The supervisor files are:

* `ops/download-vpn/wowzerbowser-download-vpn.service` for the existing
  Windscribe-isolated containers;
* `ops/download-vpn/wowzerbowser-tailscale-exit.service` for the exit-node
  advertisement and host routing/firewall reconciliation.

After the server-side check passes, select `homelab` as the Exit Node in the
Tailscale iPhone app. If the Admin Console marks the advertised exit node as
pending approval, approve it under the device's route settings first.

## Tailscale Serve

Tailscale runs on the host, not in a container. After the web health check is
passing, configure private Serve and never Funnel:

```bash
tailscale serve --bg http://127.0.0.1:3000
tailscale serve status
```

Use the HTTPS hostname shown by `tailscale serve status` as
`NEXT_PUBLIC_SITE_URL`. There is no router port forwarding or public ingress.
Verify that Serve is tailnet-only and that no Funnel configuration exists.

## Updates and reboot recovery

Use the guarded update procedure from the `main` checkout. It refuses tracked
local edits, preserves untracked files, pulls only `main` with fast-forward
semantics, builds the new image, starts PostgreSQL, applies local migrations,
and recreates the application, OCR, and private search services only after the
build and migration steps succeed. The search-stack start also performs
project-scoped Compose orphan cleanup for removed service containers:

```bash
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/update.sh
```

The script never deletes the PostgreSQL volume, application files, or the
owner-managed media directory. It does not run `docker compose down -v`.
If it stops at a guard, configuration, storage, or migration step, inspect the
reported condition and correct it before retrying. If the app is already down,
check `findmnt -T /srv/storage`, `./docker/compose.sh logs --tail=200 web
background-worker searxng miniflux firecrawl`, and the migration status command above; do not
create a fallback `/srv/storage` directory or bypass the startup guard.

For an optional Discord update, set `ENABLE_DISCORD_PROFILE=1` only when the
private Discord credentials are present in `deployment.env`; the update script
then recreates that profile after the core services. A rejected Discord token
does not block the core web, PostgreSQL, or background-worker services.

After a host reboot, verify the mount before inspecting the stack. The
`unless-stopped` policies recover the services and Tailscale retains its host
Serve configuration:

```bash
findmnt -T /srv/storage
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh ps
tailscale status --self
tailscale serve status
```

If the mount check fails, stop. Do not create `/srv/storage` as a normal
directory, start the stack, or repair the disk from the application checkout.

## Verification checklist

```bash
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh config
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh ps
curl --fail-with-body --silent --show-error http://127.0.0.1:3000/api/health
docker inspect wowzerbowser-web-1 --format '{{json .Mounts}}'
docker inspect wowzerbowser-background-worker-1 --format '{{json .Mounts}}'
docker inspect wowzerbowser-opendataloader-hybrid-1 --format '{{json .Mounts}}'
docker inspect wowzerbowser-python-worker-1 --format '{{json .Mounts}}'
ss -ltnp
```

Expected host listeners are SSH, Tailscale-managed listeners, and the web port
on `127.0.0.1` only. There must be no host listener for PostgreSQL,
OpenDataLoader, SearXNG, Miniflux, Firecrawl, or their queue/database
dependencies. The application containers must not see `/srv/storage/media`;
only `web` and `background-worker` receive the `/srv/storage/wowzerbowser`
bind mount, while the hybrid service receives only its named model-cache volume
and `python-worker` receives only its named workspace volume.

For an isolation check, create temporary harmless files under both host
directories, verify the application container sees only the application file,
and remove only those exact temporary files. Never use recursive cleanup
against `/srv/storage` or `/srv/storage/media`.
