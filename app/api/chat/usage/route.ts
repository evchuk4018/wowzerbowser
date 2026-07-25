import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../auth/owner-auth-service";
import { USAGE_RANGES, type UsageRange } from "../../../../lib/usage-protocol";
import { assertTimeZone } from "../../../server/usage/usage-time";
import { getUsageReport } from "../../../server/usage/usage-service";

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const user = await authorizeOwnerSession(authorization.slice(7));
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const rangeValue = params.get("range") ?? "week";
  const timeZone = params.get("timeZone") ?? "UTC";
  if (!USAGE_RANGES.includes(rangeValue as UsageRange)) {
    return NextResponse.json({ error: "range must be day, week, month, or all." }, { status: 400 });
  }
  try {
    assertTimeZone(timeZone);
    return NextResponse.json(await getUsageReport(user.id, rangeValue as UsageRange, timeZone));
  } catch (error) {
    if (error instanceof Error && /timezone/i.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Usage data is unavailable." }, { status: 503 });
  }
}
