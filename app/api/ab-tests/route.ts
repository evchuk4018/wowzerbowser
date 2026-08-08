import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../auth/owner-auth-service";
import {
  AbTestActiveTrialExistsError,
  ChatModelAuthorizationError,
  createAbTest,
  listAbTests,
} from "../../server/ab-testing/ab-test-service";
import { AbTestValidationError } from "../../../lib/ab-test-protocol";

const unauthorized = () => NextResponse.json({ error: "Unauthorized." }, { status: 401 });

export async function GET(request: Request) {
  const owner = await authorizeOwnerSession(request);
  if (!owner) return unauthorized();
  try {
    return NextResponse.json(await listAbTests(owner.id));
  } catch {
    return NextResponse.json({ error: "A/B testing is unavailable." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const owner = await authorizeOwnerSession(request);
  if (!owner) return unauthorized();
  try {
    return NextResponse.json({ trial: await createAbTest(owner.id, await request.json()) }, { status: 201 });
  } catch (error) {
    if (error instanceof AbTestValidationError || error instanceof ChatModelAuthorizationError || error instanceof SyntaxError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof AbTestActiveTrialExistsError) return NextResponse.json({ error: error.message }, { status: 409 });
    return NextResponse.json({ error: "The A/B trial could not be created." }, { status: 503 });
  }
}
