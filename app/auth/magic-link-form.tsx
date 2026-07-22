"use client";

import { FormEvent, useState } from "react";
import { isMagicLinkRateLimitError } from "./auth-service";

type MagicLinkFormProps = {
  error?: string | null;
  onSubmit: (email: string) => Promise<void>;
  onPasswordSignIn: (email: string, password: string) => Promise<void>;
  onPasswordSignUp: (email: string, password: string) => Promise<void>;
};

export function MagicLinkForm({
  error: configurationError,
  onSubmit,
  onPasswordSignIn,
  onPasswordSignUp,
}: MagicLinkFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"magic-link" | "password">("magic-link");
  const [passwordMode, setPasswordMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "submitting">("idle");
  const [error, setError] = useState<string | null>(configurationError ?? null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("sending");
    setError(null);

    try {
      await onSubmit(email);
      setStatus("sent");
    } catch (submitError: unknown) {
      if (isMagicLinkRateLimitError(submitError)) {
        setMode("password");
        setError("Magic links are temporarily rate-limited. Use a password to continue.");
      } else {
        setError(submitError instanceof Error ? submitError.message : "Could not send the magic link.");
      }
      setStatus("idle");
    }
  }

  async function handlePasswordSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("submitting");
    setError(null);

    try {
      if (passwordMode === "sign-in") {
        await onPasswordSignIn(email, password);
      } else {
        await onPasswordSignUp(email, password);
      }
    } catch (submitError: unknown) {
      setStatus("idle");
      setError(submitError instanceof Error ? submitError.message : "Password authentication failed.");
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="sign-in-title">
        <div className="spark-mark" aria-hidden="true">✦</div>
        <h1 id="sign-in-title">Sign in to Chat</h1>
        <p>
          {mode === "magic-link"
            ? "Enter your email and we’ll send you a secure magic link."
            : "Use your password to sign in or create your password account."}
        </p>

        {status === "sent" ? (
          <div className="auth-success" role="status">
            Check your inbox for a sign-in link. You can close this tab after opening it.
          </div>
        ) : mode === "magic-link" ? (
          <form className="auth-form" onSubmit={handleSubmit}>
            <label htmlFor="email">Email address</label>
            <input
              id="email"
              name="email"
              type="email"
              value={email}
              autoComplete="email"
              autoFocus
              required
              placeholder="you@example.com"
              onChange={(event) => setEmail(event.target.value)}
            />
            {error && <p className="auth-error" role="alert">{error}</p>}
            <button type="submit" disabled={status === "sending"}>
              {status === "sending" ? "Sending…" : "Email me a magic link"}
            </button>
          </form>
        ) : (
          <form className="auth-form" onSubmit={handlePasswordSubmit}>
            <label htmlFor="password-email">Email address</label>
            <input
              id="password-email"
              name="email"
              type="email"
              value={email}
              autoComplete="email"
              required
              onChange={(event) => setEmail(event.target.value)}
            />
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              value={password}
              autoComplete={passwordMode === "sign-in" ? "current-password" : "new-password"}
              minLength={6}
              required
              onChange={(event) => setPassword(event.target.value)}
            />
            {error && <p className="auth-error" role="alert">{error}</p>}
            <button type="submit" disabled={status === "submitting"}>
              {status === "submitting"
                ? "Working…"
                : passwordMode === "sign-in"
                  ? "Sign in with password"
                  : "Create password account"}
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setPasswordMode((current) => (current === "sign-in" ? "sign-up" : "sign-in"));
                setError(null);
              }}
            >
              {passwordMode === "sign-in" ? "Create a password account" : "I already have an account"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
