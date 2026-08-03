"use client";

import { FormEvent, useState } from "react";
import { signInWithPassword } from "./auth-service";

export function LoginForm({ callbackUrl = "/chat", error: initialError }: { callbackUrl?: string; error?: string | null }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting">("idle");
  const [error, setError] = useState<string | null>(initialError ?? null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("submitting");
    setError(null);
    try {
      await signInWithPassword(email, password, callbackUrl);
      window.location.assign(callbackUrl);
    } catch (submitError: unknown) {
      setStatus("idle");
      setError(submitError instanceof Error ? submitError.message : "Invalid email or password.");
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="sign-in-title">
        <div className="spark-mark" aria-hidden="true">✦</div>
        <h1 id="sign-in-title">Sign in to Chat</h1>
        <p>Use the owner email and password to continue.</p>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label htmlFor="email">Email address</label>
          <input id="email" name="email" type="email" value={email} autoComplete="email" autoFocus required onChange={(event) => setEmail(event.target.value)} />
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" value={password} autoComplete="current-password" required onChange={(event) => setPassword(event.target.value)} />
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button type="submit" disabled={status === "submitting"}>{status === "submitting" ? "Signing in…" : "Sign in"}</button>
        </form>
      </section>
    </main>
  );
}
