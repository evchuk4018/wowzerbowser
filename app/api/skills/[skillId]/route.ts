import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../auth/owner-auth-service";
import { deleteOwnerCustomSkill, updateOwnerSkill } from "../../../server/skills/skill-service";
import { skillRouteError } from "../skill-route-response";

type RouteContext = { params: Promise<{ skillId: string }> | { skillId: string } };

async function ownerFor(request: Request) {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ") ? authorizeOwnerSession(authorization.slice(7)) : null;
}

export async function PATCH(request: Request, context: RouteContext) {
  const owner = await ownerFor(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const { skillId } = await context.params;
    return NextResponse.json({ skill: await updateOwnerSkill(owner.id, skillId, await request.json()) });
  } catch (error) {
    return skillRouteError(error, "The skill could not be updated.");
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const owner = await ownerFor(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const { skillId } = await context.params;
    await deleteOwnerCustomSkill(owner.id, skillId);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return skillRouteError(error, "The skill could not be deleted.");
  }
}
