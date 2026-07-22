# Local Chat UI

A private chat workspace built with Next.js and ready for Vercel deployment.

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

The app uses Supabase passwordless email authentication. Anonymous visitors see
an email form; Supabase emails a magic link that returns to
`https://wowzerbowser.vercel.app` in production, and the browser keeps the
resulting session refreshed.

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
hook instead.

## Useful Commands

- `npm run dev`: start local development at `http://localhost:3000`
- `npm run build`: verify the Next.js production build
- `npm test`: build the app and verify its rendered shell and auth boundaries

## Learn More

- [Next.js Documentation](https://nextjs.org/docs)
- [Vercel Documentation](https://vercel.com/docs)
