"use client";

import { signIn as authSignIn, signOut as authSignOut } from "next-auth/react";
import type { AuthUser } from "./types";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function normalizeEmail(emailInput: string): string {
  return emailInput.trim().toLowerCase();
}

function validateEmail(email: string): void {
  if (!EMAIL_PATTERN.test(email)) throw new Error("Enter a valid email address.");
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const response = await fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null) as { user?: AuthUser } | null;
  return body?.user?.id && body.user.email ? body.user : null;
}

export async function signInWithPassword(emailInput: string, password: string, callbackUrl = "/chat"): Promise<void> {
  const email = normalizeEmail(emailInput);
  validateEmail(email);
  if (!password) throw new Error("Enter your password.");
  const result = await authSignIn("credentials", {
    email,
    password,
    redirect: false,
    redirectTo: callbackUrl,
  });
  if (!result || result.error) throw new Error("Invalid email or password.");
}

export async function signOut(): Promise<void> {
  await authSignOut({ redirect: false, redirectTo: "/login" });
}
