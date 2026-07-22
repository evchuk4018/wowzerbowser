"use client";

import { FormEvent, useState } from "react";

type MagicLinkFormProps = {
  error?: string | null;
  onSubmit: (email: string) => Promise<void>;
};

export function MagicLinkForm({ error: configurationError, onSubmit }: MagicLinkFormProps) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(configurationError ?? null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("sending");
    setError(null);

    try {
      await onSubmit(email);
      setStatus("sent");
    } catch (submitError: unknown) {
      setStatus("idle");
      setError(submitError instanceof Error ? submitError.message : "Could not send the magic link.");
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="sign-in-title">
        <div className="spark-mark" aria-hidden="true">✦</div>
        <h1 id="sign-in-title">Sign in to Chat</h1>
        <p>Enter your email and we’ll send you a secure magic link.</p>

        {status === "sent" ? (
          <div className="auth-success" role="status">
            Check your inbox for a sign-in link. You can close this tab after opening it.
          </div>
        ) : (
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
        )}
      </section>
    </main>
  );
}
