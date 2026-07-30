# Local Chat UI

A private chat workspace built with Next.js and ready for Vercel deployment.

## Recurring automations

Apply `supabase/migrations/20260730100000_recurring_automations.sql`, set a random
`AUTOMATION_DISPATCH_SECRET` in the application environment, and store the same
value plus the production app URL in Supabase Vault. Configure one Supabase Cron
job to use `pg_net` to `POST /api/internal/automations/dispatch` every five
minutes with `Authorization: Bearer <secret>`. The dispatcher atomically leases
due work; do not create one cron job per user automation.

After enabling the Supabase Cron and Vault integrations, the production setup is:

```sql
select vault.create_secret('https://your-app.example', 'automation_app_url');
select vault.create_secret('the-same-random-secret-as-vercel', 'automation_dispatch_secret');

select cron.schedule(
  'dispatch-recurring-automations',
  '*/5 * * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'automation_app_url')
      || '/api/internal/automations/dispatch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' ||
        (select decrypted_secret from vault.decrypted_secrets where name = 'automation_dispatch_secret')
    ),
    body := '{}'::jsonb
  );
  $cron$
);
```

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

## Included Shape

- edit site code under `app/`
- Next.js API routes live under `app/api/`
- Vercel uses the standard Next.js build and start commands

## Authentication

The app uses Supabase email magic-link authentication with a password fallback
when magic-link delivery is rate-limited. Anonymous visitors see an email form;
the browser keeps the resulting Supabase session refreshed. Only
`APP_OWNER_EMAIL` is authorized to access the app.

Copy `.env.example` to an ignored `.env` and provide these settings before
starting the app:

```bash
NEXT_PUBLIC_SUPABASE_URL=your-project-url
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
SUPABASE_URL=your-project-url
SUPABASE_SECRET_KEY=your-server-secret-key
APP_OWNER_EMAIL=the-only-email-allowed-to-sign-in
NEXT_PUBLIC_SITE_URL=https://wowzerbowser.vercel.app
```

Add `https://wowzerbowser.vercel.app` to the allowed redirect URLs in the
Supabase Auth dashboard. For local testing, set `NEXT_PUBLIC_SITE_URL` to
`http://localhost:3000` and add that URL to the dashboard as well. Keep
`SUPABASE_SECRET_KEY` server-only. Provider SDK access stays in the browser and
server Supabase adapters; UI components call the domain-facing auth service and
hook instead. Password account creation uses Supabase browser signup and
requires email confirmation to be disabled in the Supabase Auth settings so the
new account receives a session immediately without email verification.

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
- `npm test`: build the app and verify its rendered shell and auth boundaries

## Learn More

- [Next.js Documentation](https://nextjs.org/docs)
- [Vercel Documentation](https://vercel.com/docs)

### Document attachments
PDF and DOCX documents (up to 25 MiB) upload directly from the browser to the private `chat-documents` Supabase bucket through a signed upload URL. PDF text uses local PDF.js extraction and bounded OCR first, with the free OpenRouter parser as a recovery path and Qwen3.7 Flash as a paid fallback when the free quota is exhausted. DOCX text is extracted locally with Mammoth and divided into bounded logical pages that do not claim to match Word's rendered pages. Embedded DOCX images use the free OpenRouter image analyzer with the same Qwen3.7 Flash quota fallback. Configure `OPENROUTER_API_KEY` for Qwen background text tasks, vision, OCR, PDF parsing, and user-memory dreaming; configure `DEEPSEEK_API_KEY` only when using the built-in foreground DeepSeek chat models. Apply the Supabase migrations. Small documents are included verbatim in context, while large documents are available through gated `search_document` and `read_document_pages` tools.

Durable user memory is stored as a private, audited `User Profile` folder tree. Hidden chat summaries are consolidated after every three completed generations by Qwen3.7 Flash with reasoning disabled; repeated turns from one conversation contribute only its newest summary. The main agent can browse and maintain the same profile through server-side memory tools, and chat-history recall uses the same Qwen model. Dreaming is enabled by default when the schema and provider keys are configured and uses Qwen reasoning; it can be disabled with `USER_MEMORY_DREAMING_ENABLED=false`. Provider or persistence failures are isolated from normal chat delivery.

PDF finalization runs on the Node.js runtime because PDF.js and `@napi-rs/canvas` require native server dependencies. The production build runs `npm run verify:pdf-runtime` before Next.js build output is generated and inspects both emitted function traces afterward; a missing native canvas package must fail the deployment rather than first appearing as a document-upload 500. After changing native dependencies, deploy with a clean dependency install and verify the emitted Vercel function trace contains the Linux canvas package. The configured 300-second duration remains subject to the active Vercel plan's maximum.

The document schema is deployed separately from the application. Apply these migrations to the production Supabase project before enabling document uploads, and refresh the PostgREST schema cache if the API reports stale columns:

- `supabase/migrations/20260726090000_chat_documents.sql`
- `supabase/migrations/20260726120000_docx_documents.sql`
- `supabase/migrations/20260726130000_pdf_page_extraction.sql`
