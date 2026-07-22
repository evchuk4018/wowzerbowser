# vinext-starter

A clean full-stack starter running on
[vinext](https://github.com/cloudflare/vinext), with optional Cloudflare D1 and
Drizzle support.

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run dev
npm run build
```

This starter does not use `wrangler.jsonc`.

## Included Shape

- edit site code under `app/`
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/schema.ts` starts intentionally empty
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Authentication

The app uses Supabase passwordless email authentication. Anonymous visitors see
an email form; Supabase emails a magic link that returns to
`http://localhost:3000`, and the browser keeps the resulting session refreshed.

Copy `.env.example` to an ignored `.env` and provide these settings before
starting the app:

```bash
NEXT_PUBLIC_SUPABASE_URL=your-project-url
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
SUPABASE_URL=your-project-url
SUPABASE_SECRET_KEY=your-server-secret-key
APP_OWNER_EMAIL=the-only-email-allowed-to-sign-in
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

Add `http://localhost:3000` to the allowed redirect URLs in the Supabase Auth
dashboard. Keep `SUPABASE_SECRET_KEY` server-only. Provider SDK access stays in
the browser and server Supabase adapters; UI components call the domain-facing
auth service and hook instead.

## Useful Commands

- `npm run dev`: start local development at `http://localhost:3000`
- `npm run build`: verify the vinext build output
- `npm test`: build the app and verify its rendered shell and auth boundaries
- `npm run db:generate`: generate Drizzle migrations after schema changes

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
