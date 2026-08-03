import { NextResponse } from "next/server";
import { configuredOwner } from "../../../../auth/owner-auth-service";
import { claimDueAutomationRuns } from "../../../../server/automations/automation-repository";
import { runClaimedAutomation } from "../../../../server/automations/automation-runner";

export const maxDuration = 300;

export async function POST(request: Request) {
  const secret = process.env.AUTOMATION_DISPATCH_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const owner = await configuredOwner();
    const runs = await claimDueAutomationRuns(owner.id, 1);
    await Promise.allSettled(runs.map((run) => runClaimedAutomation(run)));
    return NextResponse.json({ claimed: runs.length });
  } catch {
    return NextResponse.json({ error: "Automation dispatch failed." }, { status: 503 });
  }
}
