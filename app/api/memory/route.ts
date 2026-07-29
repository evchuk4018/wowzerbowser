import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../auth/owner-auth-service";
import { getMemoryView } from "../../server/memory/memory-service";

async function ownerFor(request: Request) {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ")
    ? authorizeOwnerSession(authorization.slice(7))
    : null;
}

export async function GET(request: Request) {
  const owner = await ownerFor(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    return NextResponse.json(await getMemoryView(owner.id));
  } catch {
    return NextResponse.json({ error: "Memory is unavailable." }, { status: 503 });
  }
}
