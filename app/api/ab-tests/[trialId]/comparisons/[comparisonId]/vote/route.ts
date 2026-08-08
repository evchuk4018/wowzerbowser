import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../../../auth/owner-auth-service";
import {
  AbTestNotFoundError,
  AbTestVoteConflictError,
  voteOnAbTestComparison,
} from "../../../../../../server/ab-testing/ab-test-service";
import { AbTestValidationError } from "../../../../../../../lib/ab-test-protocol";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ trialId: string; comparisonId: string }> },
) {
  const owner = await authorizeOwnerSession(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const { trialId, comparisonId } = await params;
    return NextResponse.json({ comparison: await voteOnAbTestComparison(owner.id, trialId, comparisonId, await request.json()) });
  } catch (error) {
    if (error instanceof AbTestValidationError || error instanceof SyntaxError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof AbTestNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
    if (error instanceof AbTestVoteConflictError) return NextResponse.json({ error: error.message }, { status: 409 });
    return NextResponse.json({ error: "The A/B comparison could not be recorded." }, { status: 503 });
  }
}
