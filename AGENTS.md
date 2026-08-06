# Project Instructions

## Architecture

* Keep route handlers thin; they should authenticate, validate, call a domain service, and format the response.
* Keep provider-specific behavior inside provider adapters.
* Keep database queries inside repository modules.
* Keep orchestration logic outside repositories and UI components.
* Keep shared protocol schemas independent from both the web app and worker implementation.
* Avoid circular imports between agent, tool, provider, persistence, and UI layers.

## File Organization

* Prefer focused files with one primary responsibility.
* Split files when they mix protocol definitions, persistence, business logic, and presentation.
* Do not create generic `utils.ts` dumping grounds.
* Name shared helpers by domain, such as `run-events.ts` or `worker-leases.ts`.
* Keep tool manifests, executors, and permission policies in separate modules.
* Keep components close to the feature that owns them unless they are genuinely reused.

## Workflow

* Use subagents whenever possible.
* For delegated exploration and implementation, prefer `gpt-5.6-luna` with maximum reasoning effort (`max`). Keep delegated write scopes disjoint and review their changes before integration.
* Never try to verify the UI or functionality with a browser or screenshot.
* Always push to `main` when done.
* Once tests pass, always apply pending database migrations to the local `homelab` server and verify with the migration check before considering the task complete.

## Prompt Cost Accounting

* Every prompt's displayed ending cost must include all linked, non-dreaming model work: foreground generation, reasoning activity titles, chat titles, summaries, context routing, todo planning, chat recall, image analysis and follow-ups, PDF/document image or page analysis, research, automation, and other billable model-backed work.
* Link every billable usage record to its originating owner, conversation, and chat job whenever it belongs to a prompt. Late background work must refresh the persisted prompt cost without delaying the answer.
* Exclude local CPU-only work such as OpenDataLoader, EasyOCR, native PDF parsing, and rendering from USD totals. Record provider-backed analysis that is actually billed.
* Use provider-reported exact costs whenever available. Otherwise calculate only from an authoritative, model-specific pricing snapshot that includes request, cached-input, output, and reasoning charges. Never invent USD or use an unrelated model's fallback price; missing pricing must remain explicit and visible.
* Dreaming usage is intentionally excluded from prompt-level costs, while remaining available in account-wide usage reporting.

## Local Server

Wowzer Bowser is deployed to a single-user Lubuntu server named `homelab`.

* SSH: `evanh@100.98.43.68`
* Private app URL: `https://homelab.tail861ffd.ts.net`
* Deployment environment: `/srv/storage/wowzerbowser/deployment.env`
* Application files: `/srv/storage/wowzerbowser/files`
* Personal media: `/srv/storage/media`

Use the local workspace for code changes, tests, commits, and pushes. Use passwordless SSH for deployment and server inspection:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=10 evanh@100.98.43.68 "<command>"
```

The production stack uses Docker Compose with web, postgres, background-worker,
and the private `opendataloader-hybrid` CPU OCR service, plus an optional
discord profile. PostgreSQL and the OpenDataLoader service are private to the
Compose network, the web service binds only to localhost, and Tailscale Serve
provides private HTTPS access.

The homelab host is x86_64 Ubuntu/Lubuntu 26.04 with 4 CPUs, about 12 GiB RAM,
no GPU, and 512 MiB swap. Keep OpenDataLoader CPU-only and its container capped
at 2 CPUs and 3 GiB RAM. Its model cache is the named
`wowzerbowser-opendataloader-cache` volume; do not publish port 5002.

PDF ingestion uses the Java client in the Node worker with
`opendataloader-pdf[hybrid]==2.5.0` in the private backend. English OCR is
local EasyOCR; OpenRouter is used only for derived-image descriptions and the
optional model-invoked full-page visual inspection tool. There are currently
no existing PDFs to backfill. Re-ingest edited PDF revisions through the same
OpenDataLoader path.
