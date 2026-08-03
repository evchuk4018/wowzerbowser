import "server-only";

import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { advanceOwnerSessionVersion, getOwnerCredentialsById, ownerIdFromEnvironment } from "./app/server/auth/owner-auth-repository.mjs";
import { authenticateOwner, normalizedOwnerEmail } from "./app/server/auth/owner-credential-service";

const SITE_PATHS = ["/", "/chat", "/login"];

function configuredSiteOrigin(): string | null {
  const value = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function allowedRedirectPath(pathname: string): boolean {
  return SITE_PATHS.includes(pathname) || pathname.startsWith("/chat/");
}

function safeRedirect(url: string, baseUrl: string): string {
  const fallback = `${baseUrl.replace(/\/$/u, "")}/chat`;
  try {
    const candidate = new URL(url, baseUrl);
    const expectedOrigin = configuredSiteOrigin() ?? new URL(baseUrl).origin;
    if (candidate.origin !== expectedOrigin || !allowedRedirectPath(candidate.pathname)) return fallback;
    return candidate.toString();
  } catch {
    return fallback;
  }
}

const secureCookies = process.env.NODE_ENV === "production";
const cookiePrefix = secureCookies ? "__Secure-" : "";

export const authConfig: NextAuthConfig = {
  trustHost: true,
  secret: process.env.AUTH_SECRET,
  useSecureCookies: secureCookies,
  session: {
    strategy: "jwt",
    maxAge: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  cookies: {
    sessionToken: {
      name: `${cookiePrefix}wowzerbowser.session-token`,
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: secureCookies },
    },
    callbackUrl: {
      name: `${cookiePrefix}wowzerbowser.callback-url`,
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: secureCookies },
    },
    csrfToken: {
      name: `${secureCookies ? "__Host-" : ""}wowzerbowser.csrf-token`,
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: secureCookies },
    },
  },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      name: "Owner password",
      credentials: {
        email: { label: "Email address", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = typeof credentials?.email === "string" ? credentials.email : "";
        const password = typeof credentials?.password === "string" ? credentials.password : "";
        return authenticateOwner(email, password);
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user?.id) {
        const owner = await getOwnerCredentialsById(user.id);
        if (!owner || owner.ownerId !== ownerIdFromEnvironment() || (user.email && owner.email !== normalizedOwnerEmail(user.email))) return null;
        token.sub = owner.ownerId;
        token.email = owner.email;
        token.sessionVersion = owner.sessionVersion;
      }
      if (typeof token.sub !== "string" || typeof token.email !== "string" || typeof token.sessionVersion !== "number") return null;
      const owner = await getOwnerCredentialsById(token.sub);
      if (!owner || owner.ownerId !== ownerIdFromEnvironment() || owner.email !== normalizedOwnerEmail(token.email) || owner.sessionVersion !== token.sessionVersion) return null;
      return token;
    },
    async session({ session, token }) {
      if (typeof token.sub !== "string" || typeof token.email !== "string") return session;
      return { ...session, user: { ...session.user, id: token.sub, email: token.email } };
    },
    async redirect({ url, baseUrl }) {
      return safeRedirect(url, baseUrl);
    },
  },
  events: {
    async signOut(message) {
      if ("token" in message && typeof message.token?.sub === "string") {
        await advanceOwnerSessionVersion(message.token.sub);
      }
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
