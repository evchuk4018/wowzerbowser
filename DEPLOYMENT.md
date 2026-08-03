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
                                      ` background-worker
```

The Compose stack has exactly three core services: `web`, `postgres`, and
`background-worker`. PostgreSQL uses the named `wowzerbowser-postgres` volume
and has no host-published port. The web port is bound to loopback only.

## Storage safety

The host layout is:

```text
/srv/storage/
|-- media/                 # owner-managed media; never mounted by the app
`-- wowzerbowser/          # the only application bind mount
    `-- files/             # application files
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
`POSTGRES_PASSWORD`, make `DATABASE_URL` use the same password, and set the
existing provider/auth values required by the application, including
`SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `APP_OWNER_EMAIL`.

Generate or verify the stable server-only database owner key:

```bash
node scripts/ensure-app-owner-id.mjs --env-file /srv/storage/wowzerbowser/deployment.env
```

Keep the resulting `APP_OWNER_ID` fixed for the lifetime of this installation.
It is the local PostgreSQL owner key; authenticated Supabase owner IDs remain
available to Auth and Storage adapters. If the email is not found, set
`APP_OWNER_ID` manually to the matching Supabase Auth UUID and rerun the
command. Never expose this value or provider credentials to client code.

Set `NEXT_PUBLIC_SITE_URL` to the private HTTPS hostname reported by Tailscale
Serve after it is configured.

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
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh logs --tail=200 web postgres background-worker
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh down
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh up -d --build
docker volume inspect wowzerbowser-postgres
docker inspect wowzerbowser-web-1 --format '{{json .Mounts}}'
docker inspect wowzerbowser-background-worker-1 --format '{{json .Mounts}}'
```

The application retains Supabase Auth and Supabase Storage, but all structured
application state is persisted in the private local PostgreSQL service.

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

Pull only the intended `main` branch and preserve the deployment environment
file and Docker volume:

```bash
git pull --ff-only
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh up -d --build
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh ps
```

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
docker inspect wowzerbowser-web-1 --format '{{json .Mounts}}'
docker inspect wowzerbowser-background-worker-1 --format '{{json .Mounts}}'
ss -ltnp
```

Expected host listeners are SSH, Tailscale-managed listeners, and the web port
on `127.0.0.1` only. There must be no host listener for PostgreSQL. Container
mount output must contain `/srv/storage/wowzerbowser` only, not `/srv/storage`
or `/srv/storage/media`.

For an isolation check, create temporary harmless files under both host
directories, verify the application container sees only the application file,
and remove only those exact temporary files. Never use recursive cleanup
against `/srv/storage` or `/srv/storage/media`.
