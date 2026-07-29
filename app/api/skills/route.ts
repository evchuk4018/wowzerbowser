import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../auth/owner-auth-service";
import { createOwnerSkill, listOwnerSkills } from "../../server/skills/skill-service";
import { skillRouteError } from "./skill-route-response";

async function ownerFor(request: Request) {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ") ? authorizeOwnerSession(authorization.slice(7)) : null;
}

export async function GET(request: Request) {
  const owner = await ownerFor(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    return NextResponse.json({ skills: await listOwnerSkills(owner.id) });
  } catch (error) {
    return skillRouteError(error, "Skills are unavailable.");
  }
}

export async function POST(request: Request) {
  const owner = await ownerFor(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    return NextResponse.json({ skill: await createOwnerSkill(owner.id, await request.json()) }, { status: 201 });
  } catch (error) {
    return skillRouteError(error, "The skill could not be created.");
  }
}
