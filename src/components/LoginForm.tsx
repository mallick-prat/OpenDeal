"use client";

import { Callout } from "./Callout";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";

/** Plain-English copy for NextAuth's ?error= codes on bounce-back. */
const AUTH_ERROR_COPY: Record<string, string> = {
  AccessDenied:
    "That account isn't a member here yet. Ask an admin to add your email in Settings → Members, then try again.",
  OAuthAccountNotLinked:
    "That email already signed in a different way. Use the same method as last time.",
  OAuthCallbackError:
    "Google didn't complete the sign-in. Try again, and if it keeps happening tell an admin.",
  Configuration:
    "Something went wrong on the server — usually a brief network blip. Try again in a moment.",
  TemporaryFailure:
    "Couldn't reach the member list just now — a brief network blip. Try again in a moment.",
  MagicLinkInvalid:
    "That sign-in link is invalid or has expired. Ask for a fresh one, or sign in below.",
};

function GoogleGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

export function LoginForm() {
  const router = useRouter();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // A failed Google sign-in bounces back here with ?error=… — show it
  // instead of silently reloading, and prefill ?email=… from invite links.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("error");
    const invited = params.get("email");
    if (!code && !invited) return;
    // Deferred so the state updates land after hydration settles.
    const t = setTimeout(() => {
      if (code) {
        setError(
          AUTH_ERROR_COPY[code] ??
            `Sign-in didn't go through (${code}). Try again.`
        );
        window.history.replaceState(null, "", "/login");
      }
      if (invited) setEmail(invited);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const sendCode = async () => {
    setError("");
    setNotice("");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      setError("Enter a valid email address.");
      return;
    }
    setBusy(true);
    await fetch("/api/send-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim() }),
    }).catch(() => {});
    setBusy(false);
    setStep("code");
    setNotice("If that address is authorized, a 6-digit code is on its way.");
  };

  const verify = async () => {
    setError("");
    if (!/^\d{6}$/.test(code.trim())) {
      setError("Enter the 6-digit code from your email.");
      return;
    }
    setBusy(true);
    const res = await signIn("email-code", {
      email: email.trim(),
      code: code.trim(),
      redirect: false,
    });
    setBusy(false);
    if (res?.ok) router.push("/");
    else if (res?.error === "Configuration")
      setError(AUTH_ERROR_COPY.Configuration);
    else setError("That code is incorrect or expired. Try again.");
  };

  return (
    <div className="w-full max-w-sm">
      <button
        className="flex h-12 w-full items-center justify-center gap-2.5 border border-line bg-bg text-[15px] font-medium text-ink transition-colors hover:border-strong hover:bg-bg-soft"
        onClick={() => signIn("google", { callbackUrl: "/" })}
      >
        <GoogleGlyph />
        Continue with Google
      </button>

      <div className="my-6 flex items-center gap-3 text-[12px] text-faint">
        <span className="h-px flex-1 bg-line" />
        or
        <span className="h-px flex-1 bg-line" />
      </div>

      {step === "email" ? (
        <div className="flex flex-col gap-4">
          <label className="block">
            <span className="mb-1 block text-[12px] font-semibold text-sub">
              Email address
            </span>
            <input
              className="field"
              type="email"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendCode()}
            />
          </label>
          <button
            className="btn-primary h-12 w-full justify-center"
            onClick={sendCode}
            disabled={busy}
          >
            {busy ? "Sending…" : "Email me a 6-digit code"}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <label className="block">
            <span className="mb-1 block text-[12px] font-semibold text-sub">
              6-digit code
            </span>
            <input
              className="field tracking-[8px]"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              autoFocus
              placeholder="000000"
              value={code}
              onChange={(e) =>
                setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
              }
              onKeyDown={(e) => e.key === "Enter" && verify()}
            />
          </label>
          <button
            className="btn-primary h-12 w-full justify-center"
            onClick={verify}
            disabled={busy}
          >
            {busy ? "Verifying…" : "Sign in"}
          </button>
          <button
            className="text-left text-[13px] font-medium text-primary hover:text-primary-pressed"
            onClick={() => {
              setStep("email");
              setCode("");
              setError("");
              setNotice("");
            }}
          >
            ← Use a different email
          </button>
        </div>
      )}

      {notice && <p className="mt-4 text-[13px] text-sub">{notice}</p>}
      {error && (
        <Callout tone="error" className="mt-4 p-3 text-[13px]">{error}</Callout>
      )}
    </div>
  );
}
