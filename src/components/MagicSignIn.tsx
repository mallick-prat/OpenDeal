"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";

/** Exchanges the ?token= from a magic link for a session, then heads home. */
export function MagicSignIn() {
  const router = useRouter();
  const params = useSearchParams();
  const [failed, setFailed] = useState(false);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const token = params.get("token") ?? "";
    if (!token) {
      router.replace("/login?error=MagicLinkInvalid");
      return;
    }
    void (async () => {
      const res = await signIn("magic-link", { token, redirect: false });
      if (res?.ok) {
        window.location.replace("/");
      } else {
        setFailed(true);
        router.replace(
          `/login?error=${res?.error === "Configuration" ? "TemporaryFailure" : "MagicLinkInvalid"}`
        );
      }
    })();
  }, [params, router]);

  return (
    <div className="text-center">
      <span className="inline-flex h-12 w-12 items-center justify-center bg-primary text-[20px] font-bold tracking-[-2px] text-white">
        Xf
      </span>
      <p className="mt-5 text-[15px] text-sub">
        {failed ? "That link didn't work — taking you to sign-in…" : "Signing you in…"}
      </p>
    </div>
  );
}
