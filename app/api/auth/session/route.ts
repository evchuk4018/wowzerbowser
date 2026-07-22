import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../auth/owner-auth-service";

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const user = await authorizeOwnerSession(authorization.slice(7));
  return user
    ? NextResponse.json({ user })
    : NextResponse.json({ error: "Unauthorized." }, { status: 401 });
}
