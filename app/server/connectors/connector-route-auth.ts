import { authorizeOwnerSession } from "../../auth/owner-auth-service";

export async function ownerFor(request: Request) {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ") ? authorizeOwnerSession(authorization.slice(7)) : null;
}
