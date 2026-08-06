import { redirect } from "next/navigation";
import { getCurrentOwner } from "../auth/owner-auth-service";

export const dynamic = "force-dynamic";

export default async function ProjectsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const owner = await getCurrentOwner().catch(() => null);
  if (!owner) redirect("/login?callbackUrl=/projects");
  return children;
}
