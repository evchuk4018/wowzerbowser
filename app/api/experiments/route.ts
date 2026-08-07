import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../auth/owner-auth-service";
import {
  AbExperimentValidationError,
  createAbExperimentFromInput,
  listAbExperimentResponse,
} from "../../server/ab-testing/ab-testing-service";
import { ensureRuntimeConfigLoaded } from "../../server/config/runtime-config-service";

const unauthorized = () => NextResponse.json({ error: "Unauthorized." }, { status: 401 });

export async function GET(request: Request) {
  const owner = await authorizeOwnerSession(request);
  if (!owner) return unauthorized();
  try {
    await ensureRuntimeConfigLoaded(owner.id);
    return NextResponse.json(await listAbExperimentResponse(owner.id));
  } catch {
    return NextResponse.json({ error: "A/B testing data is unavailable." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const owner = await authorizeOwnerSession(request);
  if (!owner) return unauthorized();
  try {
    await ensureRuntimeConfigLoaded(owner.id);
    const id = await createAbExperimentFromInput(owner.id, await request.json());
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    if (error instanceof AbExperimentValidationError || error instanceof SyntaxError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "The experiment could not be created." }, { status: 503 });
  }
}
