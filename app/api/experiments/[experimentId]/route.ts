import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../auth/owner-auth-service";
import {
  AbExperimentValidationError,
  removeAbExperiment,
  updateAbExperimentStatus,
} from "../../../server/ab-testing/ab-testing-service";

const idPattern = /^[0-9a-f-]{36}$/i;
const unauthorized = () => NextResponse.json({ error: "Unauthorized." }, { status: 401 });

export async function PATCH(request: Request, context: { params: Promise<{ experimentId: string }> }) {
  const owner = await authorizeOwnerSession(request);
  if (!owner) return unauthorized();
  const { experimentId } = await context.params;
  if (!idPattern.test(experimentId)) return NextResponse.json({ error: "Experiment not found." }, { status: 404 });
  try {
    const body = await request.json() as { status?: unknown };
    await updateAbExperimentStatus(owner.id, experimentId, body.status);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof AbExperimentValidationError || error instanceof SyntaxError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "The experiment could not be updated." }, { status: 503 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ experimentId: string }> }) {
  const owner = await authorizeOwnerSession(request);
  if (!owner) return unauthorized();
  const { experimentId } = await context.params;
  if (!idPattern.test(experimentId)) return NextResponse.json({ error: "Experiment not found." }, { status: 404 });
  try {
    await removeAbExperiment(owner.id, experimentId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof AbExperimentValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "The experiment could not be deleted." }, { status: 503 });
  }
}
