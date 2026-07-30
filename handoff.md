# Recurring automation structured-result failure handoff

## Current production state

The Supabase/Vercel automation infrastructure is configured and reaches the
application successfully:

- Supabase Vault contains `automation_app_url` and
  `automation_dispatch_secret`.
- `automation_app_url` is `https://wowzerbowser.vercel.app`.
- The active `dispatch-recurring-automations` Cron job runs every five minutes
  and calls `/api/internal/automations/dispatch`.
- Vercel Production contains `AUTOMATION_DISPATCH_SECRET` and
  `OPENROUTER_API_KEY`.
- The first production dispatch at `2026-07-30 16:45:00 UTC` authenticated,
  claimed the due automation, and created an `automation_runs` row. This proves
  the Vercel and Vault dispatch secrets agree.

Supabase `pg_net` recorded a five-second HTTP timeout, but the Vercel request
continued and completed the automation attempt about 24 seconds later. The
timeout did not cause the run failure.

## Reproduced failure

The first production run completed with `status = 'failed'` and:

```text
Unexpected token 'B', "Based on m"... is not valid JSON
```

The automation remains active, has `consecutive_failures = 1`, and was
rescheduled for `2026-07-31 16:45:00 UTC`.

## Likely code path

`app/server/automations/automation-runner.ts` asks the model to call
`complete_automation_run` and captures that call through
`onAutomationResult`. If the model does not make a valid tool call,
`structuredAnswer` remains null and the runner falls back to
`parseAnswer(content)`.

`parseAnswer()` unconditionally runs `JSON.parse()` on the assistant content.
The production model returned ordinary prose beginning with `"Based on m..."`
instead of JSON, so the fallback threw and marked the run failed.

Investigate why the configured automation model did not call
`complete_automation_run`, and make the fallback robust to ordinary prose or
retry structured completion explicitly. Preserve the existing behavior that a
report is always treated as matched, while live checks depend on the structured
`matched` value. Add coverage for a model returning prose without a tool call.
