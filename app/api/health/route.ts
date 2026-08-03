export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ service: "web", status: "ok" });
}
