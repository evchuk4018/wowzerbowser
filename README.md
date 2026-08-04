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
- Docker Compose runs `web`, private PostgreSQL, `background-worker`, and the
  private CPU-only `opendataloader-hybrid` PDF backend

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
5. Configure:

   ```dotenv
   GOOGLE_OAUTH_CLIENT_ID=your-web-client-id
   GOOGLE_OAUTH_CLIENT_SECRET=your-web-client-secret
   GOOGLE_OAUTH_STATE_SECRET=at-least-32-random-characters
   GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY=base64-or-hex-encoded-32-byte-key
   ```

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

The assistant can run Python in isolated Modal Sandboxes when
`MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, and a separate random
`ARTIFACT_SIGNING_SECRET` are configured. Create a Modal API token in the Modal
dashboard, generate a long random signing secret, and add all three values to
the deployment. The optional `MODAL_APP_NAME` defaults to
`wowzerbowser-python`. Conversation
workspaces and installed packages persist in per-conversation Modal Volumes;
compute is created only while the assistant is running Python. Python code has
outbound TLS access so it can install packages and download data; do not place
credentials or other sensitive files in its conversation workspace.

## Web tools

Configure `BRAVE_API_KEYS` and `EXA_API_KEYS` with comma- or newline-separated
server-only keys to enable web search and page reading respectively. Singular
`BRAVE_API_KEY` and `EXA_API_KEY` remain supported for compatibility. The
assistant uses search for current result snippets and page reading for a
specific URL; results are bounded and retained in the tool replay transcript.
When a provider rejects, limits, or temporarily fails a request, key failover
is handled internally and is never exposed to the assistant or browser.

### Deep Research

When the background todo planner creates a non-empty plan for the current
response, the server also advertises `deep_research_search`, `find_in_page`,
`list_page_links`, and `follow_page_link`. Prior conversation todos do not
unlock these tools. Brave remains the primary search provider; direct
Readability and Jina are attempted before Exa, and a Browserless-compatible
`/content` endpoint is the optional final page-rendering fallback.

Deep Research uses the limits shown in `.env.example`, stores public extracted
pages in the server-only `research_page_cache` table, and records its cheap
background model calls as `deep_research` usage. OpenAlex, Crossref, MediaWiki,
Semantic Scholar, GitHub, Jina, and optional GDELT adapters supplement Brave
for matching query intents. SearXNG is not included in this release.

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
