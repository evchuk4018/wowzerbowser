import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../auth/owner-auth-service";
import {
  ensureRuntimeConfigLoaded,
  refreshRuntimeConfig,
  runtimeConfigResponse,
  RuntimeConfigValidationError,
  saveRuntimeConfig,
} from "../../server/config/runtime-config-service";

const unauthorized = () => NextResponse.json({ error: "Unauthorized." }, { status: 401 });

export async function GET(request: Request) {
  const owner = await authorizeOwnerSession(request);
  if (!owner) return unauthorized();
  try {
    await refreshRuntimeConfig(owner.id, true);
    return NextResponse.json(runtimeConfigResponse());
  } catch {
    return NextResponse.json({ error: "Runtime configuration is unavailable." }, { status: 503 });
  }
}

export async function PATCH(request: Request) {
  const owner = await authorizeOwnerSession(request);
  if (!owner) return unauthorized();
  try {
    await ensureRuntimeConfigLoaded(owner.id);
    const body = await request.json() as { values?: unknown };
    return NextResponse.json(await saveRuntimeConfig(owner.id, body.values));
  } catch (error) {
    if (error instanceof RuntimeConfigValidationError || error instanceof SyntaxError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "Runtime configuration could not be saved." }, { status: 503 });
  }
}
