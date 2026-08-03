# Lubuntu deployment

This is the issue #62 deployment foundation for one Lubuntu host. The intended
topology is:

```text
private Tailscale HTTPS
          |
          v
host Tailscale Serve -> 127.0.0.1:3000 -> web
                                      |\
                                      | postgres (private Compose network)
                                      ` background-worker
```

The Compose stack has exactly three core services: `web`, `postgres`, and
`background-worker`. PostgreSQL uses the named `wowzerbowser-postgres` volume,
which is stored under Docker's data root on the Lubuntu SSD. PostgreSQL has no
host-published port. The web port is bound to loopback only.

## Storage safety

The application-owned HDD layout is:

```text
/srv/storage/
├── media/                 # owner-managed media; never mounted by the app
└── wowzerbowser/          # only application bind mount
    └── files/             # binary storage used by the later local-storage work
```

The repository never mounts `/srv/storage` or `/srv/storage/media`. The
startup wrapper requires `/srv/storage` to be a mountpoint with filesystem
label `homelab-storage`, verifies that it is not the root filesystem, checks
both top-level directories, and then passes a verified guard into the app
containers. The container entrypoint also refuses an unverified start and
refuses to start if `/srv/storage/media` is visible inside the container.

Identify disks and mounts before any administrative change:

```bash
lsblk -o NAME,SIZE,FSTYPE,LABEL,MOUNTPOINTS,MODEL,SERIAL
findmnt -T /srv/storage
findmnt -T /
```

Only an administrator who has independently confirmed that a disk is empty
may format it. Never select a device from an automated script. If the intended
device is confirmed empty, the one-time administrative procedure is to create
an ext4 filesystem labelled `homelab-storage`, mount it at `/srv/storage`,
create the two directories, and persist the mount using the filesystem UUID.
For example, the commands below are documentation only and were not run by
the deployment agent:

```bash
# Replace /dev/sdX1 only after the device identity and empty state are confirmed.
sudo mkfs.ext4 -L homelab-storage /dev/sdX1
sudo mkdir -p /srv/storage
sudo mount /dev/disk/by-label/homelab-storage /srv/storage
sudo mkdir -p /srv/storage/wowzerbowser/files /srv/storage/media
sudo chown -R "$USER:$USER" /srv/storage/wowzerbowser
```

Persist the UUID discovered with `blkid` in `/etc/fstab` only after reviewing
the exact UUID and mountpoint. Do not use a guessed device name, and do not
allow the application to start until `findmnt -T /srv/storage` shows the
expected filesystem. The repository's guard does not format, mount, or edit
`fstab`.

## Initial setup

Install Docker Engine with the Compose plugin and confirm the deployment user
can run Docker without `sudo`. Confirm the mount and directories first:

```bash
hostname
id -un
findmnt -T /srv/storage
docker version
docker compose version
```

From the repository checkout on the SSD, keep the deployment environment file
under the application-owned storage directory so the repository checkout
contains no deployment secrets:

```bash
cp .env.example /srv/storage/wowzerbowser/deployment.env
chmod 600 /srv/storage/wowzerbowser/deployment.env
```

Set `APP_UID` and `APP_GID` in `.env` to the deployment user's values from
`id -u` and `id -g`; the web and worker containers run with that identity so
the application bind mount remains writable without changing permissions
outside `/srv/storage/wowzerbowser`.

Set a new random `POSTGRES_PASSWORD`, update `DATABASE_URL` to match it, and
set the existing provider/auth values required by the current application.
For the private installation, set `NEXT_PUBLIC_SITE_URL` to the HTTPS URL
reported by Tailscale Serve below. Do not put provider credentials in the
repository, image, client-side variables, or issue comments.

Validate the rendered Compose file:

```bash
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh config
```

`config` is read-only and does not require the storage guard. Startup commands
must use the wrapper:

```bash
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh up -d --build
```

Running `docker compose up` directly leaves the guard unverified; the web and
worker entrypoints deliberately refuse that startup.

## Operations

```bash
# Status and health
./docker/compose.sh ps
docker inspect --format '{{json .State.Health}}' wowzerbowser-web-1

# Logs
./docker/compose.sh logs --tail=200 web postgres background-worker
./docker/compose.sh logs -f web

# Stop without touching persistent data
./docker/compose.sh down

# Rebuild and restart after a code update
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh up -d --build

# Inspect the PostgreSQL volume and container mounts
docker volume inspect wowzerbowser-postgres
docker inspect wowzerbowser-web-1 --format '{{json .Mounts}}'
docker inspect wowzerbowser-background-worker-1 --format '{{json .Mounts}}'
```

Do not use `docker compose down -v`; the named PostgreSQL volume is the
persistent database and must not be removed during normal updates.

The current application still uses Supabase Auth, PostgREST, and Supabase
Storage. The local PostgreSQL service is intentionally a persistent private
foundation until issues #63 and #65 replace those providers. The current web
process still owns durable chat execution; the `background-worker` service is
an explicit heartbeat placeholder until issues #63–#67 implement the local
database, storage, and worker migrations. This deployment does not claim those
later issues are complete.

## Tailscale Serve

Tailscale is installed on the host, not in a container. After the web health
check is passing, configure private Serve (never Funnel):

```bash
tailscale serve --bg http://127.0.0.1:3000
tailscale serve status
```

Use the HTTPS hostname shown by `tailscale serve status` as
`NEXT_PUBLIC_SITE_URL`, then restart the web service with the guarded wrapper.
The expected form is:

```text
https://<machine>.<tailnet>.ts.net
```

Verify that `tailscale serve status` shows a Serve proxy and that no
`tailscale funnel` configuration exists. Remove Serve only with an explicit
operator action:

```bash
tailscale serve reset
```

No router port forwarding or public ingress is part of this deployment.

## Updates and reboot recovery

Pull only the intended `main` branch, inspect the diff, and preserve the
deployment environment file and Docker volume:

```bash
git pull --ff-only
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh up -d --build
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh ps
```

After a host reboot, verify the mount before inspecting the stack. Docker's
`unless-stopped` policies recover the three services, and Tailscale Serve
retains its host configuration:

```bash
findmnt -T /srv/storage
./docker/compose.sh ps
tailscale status --self
tailscale serve status
```

If the mount check fails, stop there. Do not create `/srv/storage` as a normal
directory, do not start the stack, and do not attempt to repair the disk from
the application checkout.

## Verification checklist

```bash
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh config
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh ps
docker inspect wowzerbowser-web-1 --format '{{json .Mounts}}'
docker inspect wowzerbowser-background-worker-1 --format '{{json .Mounts}}'
ss -ltnp
```

The expected host listeners are SSH, Tailscale-managed listeners, and the web
port on `127.0.0.1` only. There must be no host listener for PostgreSQL. The
container mount output must contain `/srv/storage/wowzerbowser` only and must
not contain `/srv/storage` or `/srv/storage/media`.

For an end-to-end isolation check, create temporary harmless files under both
directories on the host, verify the intended application container can see
only the application file, and remove only those temporary files. Never use a
recursive cleanup command against `/srv/storage` or `/srv/storage/media`.
