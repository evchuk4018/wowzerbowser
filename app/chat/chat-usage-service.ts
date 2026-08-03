import type { UsageRange, UsageReport } from "../../lib/usage-protocol";
import { authFetch } from "../auth/auth-fetch";

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `Request failed (${response.status}).`;
}
export async function fetchChatUsage(
  range: UsageRange,
  timeZone: string,
): Promise<UsageReport> {
  const params = new URLSearchParams({ range, timeZone });
  const response = await authFetch(`/api/chat/usage?${params.toString()}`);
  if (!response.ok) throw new Error(await readError(response));
  return await response.json() as UsageReport;
}
