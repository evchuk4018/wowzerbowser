# Historical recurring-automation failure handoff

Recurring automations now run in the local PostgreSQL-backed
`background-worker`. The production application is private behind the
homelab's Tailscale HTTPS origin; this note preserves the failure analysis from
the pre-local deployment and is not an active hosted-scheduler runbook.

## Historical failure

A pre-migration recurring run completed with `status = 'failed'` and:

```text
Unexpected token 'B', "Based on m..." is not valid JSON
```

The likely code path was `app/server/automations/automation-runner.ts` asking
the model to call `complete_automation_run` and capturing that call through
`onAutomationResult`. If the model did not make a valid tool call,
`structuredAnswer` remained null and the runner fell back to `parseAnswer(content)`.

`parseAnswer()` unconditionally ran `JSON.parse()` on assistant content. The
model returned ordinary prose beginning with `Based on m...` instead of JSON,
so the fallback threw and marked the run failed.

If this path is changed again, make the fallback robust to ordinary prose or
retry structured completion explicitly. Preserve the behavior that a report is
always treated as matched, while live checks depend on the structured
`matched` value, and add coverage for prose without a tool call.
