import { authorizeOwnerSession } from "../../auth/owner-auth-service";

export async function ownerFor(request: Request) {
  return authorizeOwnerSession(request);
}
