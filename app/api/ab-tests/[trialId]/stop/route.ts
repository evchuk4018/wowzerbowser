import { NextResponse } from "next/server";
import { AbTestNotFoundError, stopAbTest } from "../../../../server/ab-testing/ab-test-service";
import { AbTestValidationError } from "../../../../../lib/ab-test-protocol";
import { authorizeOwnerSession } from "../../../../auth/owner-auth-service";

export async function POST(request: Request, { params }: { params: Promise<{ trialId: string }> }) {
  const owner = await authorizeOwnerSession(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const { trialId } = await params;
    return NextResponse.json({ trial: await stopAbTest(owner.id, trialId) });
  } catch (error) {
    if (error instanceof AbTestValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof AbTestNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
    return NextResponse.json({ error: "The A/B trial could not be stopped." }, { status: 503 });
  }
}
