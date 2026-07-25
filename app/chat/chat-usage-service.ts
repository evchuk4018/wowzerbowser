import type { UsageRange, UsageReport } from "../../lib/usage-protocol";

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `Request failed (${response.status}).`;
}
export async function fetchChatUsage(
  range: UsageRange,
  timeZone: string,
  accessToken: string,
): Promise<UsageReport> {
  const params = new URLSearchParams({ range, timeZone });
  const response = await fetch(`/api/chat/usage?${params.toString()}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(await readError(response));
  return await response.json() as UsageReport;
}
