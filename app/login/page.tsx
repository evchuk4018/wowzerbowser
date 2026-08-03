import { LoginForm } from "../auth/login-form";

function safeCallbackUrl(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/chat";
  if (value === "/" || value === "/chat" || value.startsWith("/chat/")) return value;
  return "/chat";
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const callbackUrl = Array.isArray(params.callbackUrl) ? params.callbackUrl[0] : params.callbackUrl;
  return <LoginForm callbackUrl={safeCallbackUrl(callbackUrl)} />;
}
