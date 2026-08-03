export const dynamic = "force-dynamic";

import { getReadinessReport } from "../../server/readiness/readiness";

export async function GET() {
  const report = await getReadinessReport();
  return Response.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
