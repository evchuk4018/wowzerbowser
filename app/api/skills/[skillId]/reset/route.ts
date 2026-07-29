import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../auth/owner-auth-service";
import { resetOwnerBuiltinSkill } from "../../../../server/skills/skill-service";
import { skillRouteError } from "../../skill-route-response";

type RouteContext = { params: Promise<{ skillId: string }> | { skillId: string } };

export async function POST(request: Request, context: RouteContext) {
  const authorization = request.headers.get("authorization");
  const owner = authorization?.startsWith("Bearer ")
    ? await authorizeOwnerSession(authorization.slice(7))
    : null;
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const { skillId } = await context.params;
    return NextResponse.json({ skill: await resetOwnerBuiltinSkill(owner.id, skillId) });
  } catch (error) {
    return skillRouteError(error, "The skill could not be reset.");
  }
}
