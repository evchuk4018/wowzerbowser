# Local Chat UI

A private, single-owner chat workspace built with Next.js and Docker Compose.
The production deployment is reached through the private Tailscale HTTPS origin
`https://homelab.tail861ffd.ts.net`; PostgreSQL and application files stay on
the homelab.

## Recurring automations

Recurring automations, memory work, cleanup, and durable chat/document/image
jobs run in the local `background-worker` against PostgreSQL. No hosted
scheduler, Redis, or second queue is required.

Automation runs default to `qwen/qwen3.7-flash`, require the OpenRouter key, and
have a user-configurable model in Settings → Configurables.

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run dev
npm run build
```

For the single-machine Lubuntu deployment requested by issue #62, use the
Docker Compose setup and storage/Tailscale checks in [DEPLOYMENT.md](./DEPLOYMENT.md).
The deployment wrapper is required for startup because it verifies that the
HDD mount is present before any application container is started.

## Included Shape

- edit site code under `app/`
- Next.js API routes live under `app/api/`
- Docker Compose runs `web`, private PostgreSQL, `background-worker`, the
  private CPU-only `opendataloader-hybrid` PDF backend, SearXNG and Miniflux
  search services, the MediaWiki/Wikipedia reference API, and private
  Firecrawl page retrieval

## Authentication

The app uses Auth.js Credentials authentication for exactly one owner. There is
no signup or email-based login flow. Auth.js stores the encrypted session in an
HttpOnly cookie, while the owner email and Node scrypt
password hash live in local PostgreSQL. Application binaries live in the local
filesystem under `/srv/storage/wowzerbowser/files` and their ownership,
associations, MIME types, sizes, and hashes live in PostgreSQL.

Copy `.env.example` to an ignored `.env` and provide these settings before
starting the app:

```bash
APP_OWNER_EMAIL=the-only-email-allowed-to-sign-in
APP_OWNER_ID=stable-owner-uuid
AUTH_SECRET=at-least-32-random-characters
NEXT_PUBLIC_SITE_URL=https://homelab.tail861ffd.ts.net
```

Keep `AUTH_SECRET` and `APP_OWNER_ID` server-only. On a new installation, create
the one owner with the private CLI after migrations:

```bash
node scripts/bootstrap-owner.mjs --env-file /srv/storage/wowzerbowser/deployment.env
```

To rotate the password and invalidate every existing session, use:

```bash
node scripts/reset-owner-password.mjs --env-file /srv/storage/wowzerbowser/deployment.env
```

For local testing, set `NEXT_PUBLIC_SITE_URL` to `http://localhost:3000`.

## Google Calendar

The built-in calendar tools use per-user Google OAuth and operate on the
connected account's primary calendar.

1. In Google Cloud, create or select a project and enable the **Google Calendar API**.
2. Open **Google Auth Platform**, configure Branding, Audience, and Data Access.
   For an External app in testing, add the app owner as a test user.
3. Create an OAuth 2.0 client with application type **Web application**.
4. Add the applicable authorized redirect URIs:
   - `http://localhost:3000/api/integrations/google-calendar/callback`
   - `https://homelab.tail861ffd.ts.net/api/integrations/google-calendar/callback`
   - `https://homelab.tail861ffd.ts.net/api/connectors/callback`
5. Configure:

   ```dotenv
   GOOGLE_OAUTH_CLIENT_ID=your-web-client-id
   GOOGLE_OAUTH_CLIENT_SECRET=your-web-client-secret
   GOOGLE_OAUTH_STATE_SECRET=at-least-32-random-characters
   GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY=base64-or-hex-encoded-32-byte-key
   ```

   Enable the Gmail API and grant the OAuth client the Gmail read-only scope when
   connecting Gmail from Settings → Connectors.

   Generate the encryption key with
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
   `NEXT_PUBLIC_SITE_URL` must exactly match the origin used in the registered
   callback URI.
6. Apply the local PostgreSQL migrations, deploy or restart the app, then open
   **Settings → Tools → Google Calendar → Connect** and approve access.

The OAuth request uses offline access and the narrow
`https://www.googleapis.com/auth/calendar.events` scope. Refresh tokens are
encrypted at rest and are never sent to the browser or model.

## Discord direct messages

The optional Discord integration turns a private bot DM into the same durable
chat used by the web app. The first ordinary DM creates a conversation, later
DMs continue it, and `/new` (or `/new <prompt>`) starts another.
Answers link back to the persisted `/chat/{conversationId}` page. Images, PDF,
and DOCX attachments use the existing private attachment ingestion paths.

The Discord Gateway connection runs as an optional local Compose service. The
Gateway container calls `http://web:3000` over the private Compose network;
user-facing links still use `NEXT_PUBLIC_SITE_URL`.

1. Apply the local PostgreSQL migrations before starting the worker.
2. In the Discord Developer Portal, create an application and bot. Enable the
   Message Content intent and install the bot for the owner account. The worker
   subscribes only to direct-message and message-content events and ignores
   guild messages.
3. Copy the owner's Discord user ID and generate a random internal secret of at
   least 32 characters.
4. Add the shared values to `/srv/storage/wowzerbowser/deployment.env`:

   ```dotenv
   DISCORD_ALLOWED_USER_ID=the-owner-discord-user-id
   DISCORD_INTERNAL_SECRET=the-shared-random-secret
   ```

5. Add the bot token to the same deployment environment and start the optional
   profile from the repository checkout:

   ```dotenv
   NEXT_PUBLIC_SITE_URL=https://homelab.tail861ffd.ts.net
   DISCORD_BOT_TOKEN=the-private-bot-token
   DISCORD_ALLOWED_USER_ID=the-same-owner-discord-user-id
   DISCORD_INTERNAL_SECRET=the-same-shared-random-secret
   ```

   ```bash
   DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh --profile discord up -d --build
   ```

The bot token belongs only in the private deployment environment. Never prefix
any Discord secret with `NEXT_PUBLIC_`. Internal app routes require the shared
bearer secret, Discord message IDs provide idempotency, and undelivered jobs
are recovered when the Gateway reconnects. Disable the profile to run the core
stack without Discord.

## Python tool

The assistant runs Python in a private local Docker Compose `python-worker`
service on the homelab. The service has a `0.75` CPU limit, `1.5 GiB` memory
limit, a `128` process limit, and allows only one active Python execution at a
time. It is non-root, drops Linux capabilities, uses `no-new-privileges`, has
no host-published port, and is isolated from PostgreSQL and the other
application services by a dedicated Compose network.

Conversation workspaces and installed packages persist in a named Docker
volume owned by the Python worker. Custom tools use temporary workspaces and
receive only their explicitly configured environment values. Python code has
outbound network access for package installation and downloads, but it does
not inherit application credentials. Set `PYTHON_WORKER_SECRET` to at least 32
random characters in the deployment environment.

## Web tools

The web tools use the private search stack configured in `.env.example`. A
single `web_search` call queries SearXNG twice—the original query and the same
query with `reddit` appended—plus MediaWiki/Wikipedia and Miniflux. The second
SearXNG stream keeps Reddit-hosted URLs, and the combined results are then
deduplicated and ranked. Pass `focus=general`, `news`, `community`, or
`reference` to change ranking priorities without excluding any provider.

For freshness, ambiguity, recommendations, or community evidence, normal
`web_search` adds up to two targeted query variants and fuses results with
reciprocal-rank fusion. Every candidate receives lightweight title/snippet
relevance scoring before ranking, alongside freshness, source quality, intent
fit, provider focus, and domain diversity. Pass `freshness=day`, `week`,
`month`, or `year` for time-sensitive searches. Provider requests use the
short-lived cache and bounded reliability settings in `.env.example`, retry one
transient HTTP failure, and open a per-provider circuit after repeated failures
so healthy providers can continue serving results.

`fetch_page` sends only the selected URL to the private Firecrawl service and
returns bounded Markdown. Search is discovery; Firecrawl is page retrieval.
The services have no commercial search or retrieval API-key requirement, and
their Compose ports are not published to the host.

Miniflux feeds are versioned in `config/miniflux-feeds.json`. After creating a
Miniflux API token, synchronize the manifest with:

```bash
DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env ./docker/compose.sh run --rm --no-deps -T web node scripts/provision-miniflux-feeds.mjs
```

Non-secret SearXNG settings are generated by Configurables at
`/srv/storage/wowzerbowser/config/searxng/settings.yml`. The guarded Compose
wrapper seeds that file from `docker/searxng/settings.yml` only on first start;
SearXNG receives only that file read-only. Restart SearXNG through
`./docker/compose.sh` after changing its settings so it reloads the generated
file. Keep `SEARXNG_SECRET` and all other credentials in the deployment
environment, never in the generated YAML.

### Deep Research

When the background todo planner creates a non-empty plan for the current
response, the server also advertises `deep_research_search`, `find_in_page`,
`list_page_links`, and `follow_page_link`. Prior conversation todos do not
unlock these tools. Every research query uses the same SearXNG/MediaWiki/Miniflux
search aggregator, and every selected page is retrieved through Firecrawl.

Deep Research uses the limits shown in `.env.example`, stores public extracted
pages in the server-only `research_page_cache` table, and records its cheap
background model calls as `deep_research` usage. Academic, developer, recent,
official, and community intents change the SearXNG/MediaWiki/Miniflux
aggregator's ranking focus; the community stream is still the Reddit-suffixed
SearXNG query rather than a separate provider API.

`check_time` and `check_date` are always available and use the server's
`Intl.DateTimeFormat` implementation, optionally with an IANA time zone.
To enable `check_location`, set `DEPLOYMENT_LOCATION` to a deliberately chosen,
coarse deployment label (for example, `Frankfurt, Germany`). This is explicit
deployment metadata, not browser geolocation: the application does not infer a
user's precise location, make a user-controlled location URL request, or expose
location-provider credentials. Leave it unset to omit the tool; a direct call
then returns a clear "not configured" result.

## Useful Commands

- `npm run dev`: start local development at `http://localhost:3000`
- `npm run build`: verify the Next.js production build
- `npm run audit:local-runtime`: fail if hosted runtime SDKs, URLs, keys, or
  scheduler assumptions re-enter the production source
- `npm run audit:client-bundle`: scan emitted browser assets for server-only
  secrets and hosted-runtime markers
- `npm run test:clean-install`: build a disposable clean-install Compose stack
  and exercise login, durable jobs, storage, schedulers, restart recovery, and
  logout without touching the production volume
- `npm test`: build the app and verify its rendered shell and auth boundaries

## Readiness and recovery

`GET /api/health` is the operational readiness endpoint. It returns `200` only
when the local PostgreSQL connection, ordered migration set, application-owned
filesystem, and required server configuration are all ready; otherwise it
returns `503` with stable check codes and no secret values. The container
entrypoint performs the same configuration, storage, and migration checks before
starting `web` or `background-worker`.

For a new checkout, run `npm run audit:local-runtime`, `npm run build`,
`npm run audit:client-bundle`, and `npm run test:clean-install`. On the
homelab, use `docker/update.sh` for updates. It preserves the PostgreSQL named
volume and application files, applies migrations under the migration lock, and
restarts only after the new image is built. Do not use `docker compose down -v`.

## Learn More

- [Next.js Documentation](https://nextjs.org/docs)

### Document attachments
PDF and DOCX documents (up to 25 MiB) stream from the authenticated browser route into the local application filesystem. PostgreSQL records the UUID object key and document association; finalization reads only through the owner- and conversation-scoped storage service. PDF extraction uses the local OpenDataLoader Java client and its private CPU-only hybrid backend with English EasyOCR; there is no legacy PDF parser fallback. Extracted images are bounded, stored as derived document objects, described automatically through OpenRouter, and included in per-page Markdown with authenticated image URLs. When text and image descriptions are insufficient, the model may invoke `inspect_document_page` to render one PDF page locally and ask OpenRouter a focused visual question. DOCX text remains local Mammoth extraction with bounded logical pages, and embedded DOCX images use the existing OpenRouter analyzer. Configure `OPENROUTER_API_KEY` for vision and Qwen background tasks; configure `DEEPSEEK_API_KEY` only when using the built-in foreground DeepSeek chat models. Apply the local PostgreSQL migrations. Small documents are included in context, while large documents are available through gated `search_document`, `read_document_pages`, and page-visual inspection tools.

Durable user memory is stored as a private, audited `User Profile` folder tree. Hidden chat summaries are consolidated after every three completed generations by Qwen3.7 Flash with reasoning disabled; repeated turns from one conversation contribute only its newest summary. The main agent can browse and maintain the same profile through server-side memory tools, and chat-history recall uses the same Qwen model. Dreaming is enabled by default when the schema and provider keys are configured and uses Qwen reasoning; it can be disabled with `USER_MEMORY_DREAMING_ENABLED=false`. Provider or persistence failures are isolated from normal chat delivery.

PDF finalization runs on the Node.js runtime because PDF.js and `@napi-rs/canvas` require native server dependencies. The production build runs `npm run verify:pdf-runtime` before Next.js build output is generated and inspects the emitted server traces; a missing native canvas package must fail the deployment rather than first appearing as a document-upload 500. The local Docker image includes the native runtime dependencies and the web container keeps the 300-second document-processing limit.

The document and binary-object metadata schema is included in the local
PostgreSQL migrations and is applied by `scripts/migrate.mjs`. The filesystem
adapter validates UUID object keys, rejects traversal and symlink paths, writes
through a temporary file followed by an atomic rename, and never exposes the
files directory as a static web path.
