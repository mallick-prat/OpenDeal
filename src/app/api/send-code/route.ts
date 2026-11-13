import { NextResponse } from "next/server";
import { randomInt } from "crypto";
import { sql } from "@/lib/db";
import { makeCodeCookie } from "@/lib/loginCode";
import { withRetry } from "@/lib/retry";
import { crm, emailFrom } from "@/config/crm.config";
import { escapeHtml } from "@/lib/emailHtml";

// A stalled pool retries for ~22s; the platform default (15s) would 504
// first. Explicit ceiling so retries get to finish.
export const maxDuration = 30;


const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Membership check against app_users; fails closed. */
async function isMember(email: string): Promise<boolean> {
  try {
    const rows = await withRetry(
      () => sql<{ email: string }[]>`
        select email from app_users where email = ${email}
      `
    );
    return rows.length > 0;
  } catch (err) {
    console.error("[send-code] membership check failed:", err);
    return false;
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { email?: string };
  const email = String(body.email ?? "").trim().toLowerCase();

  // Always respond the same way so we never reveal who is on the allowlist.
  const neutral = NextResponse.json({ ok: true });
  if (!EMAIL_RE.test(email) || !(await isMember(email))) return neutral;

  const code = String(randomInt(100000, 1000000));
  const cookie = makeCodeCookie(email, code, process.env.AUTH_SECRET!);

  if (process.env.NODE_ENV !== "production") {
    // Local-only aid so the flow is testable without inbox access.
    console.log(`[send-code] ${email} -> ${code}`);
  }

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: emailFrom(),
      to: [email],
      subject: `Your ${crm.org.name} sign-in code: ${code}`,
      html: `<div style="font-family:'IBM Plex Sans',Arial,sans-serif;max-width:440px;margin:0 auto;color:#171717">
        <div style="background:${crm.brand.primary};color:#fff;padding:20px 24px;font-size:20px;font-weight:600">${escapeHtml(crm.org.name)}</div>
        <div style="border:1px solid #e7e4df;border-top:none;padding:24px">
          <p style="font-size:15px;line-height:1.5">Use this code to sign in. It expires in 10 minutes.</p>
          <div style="font-size:34px;font-weight:700;letter-spacing:6px;color:${crm.brand.primary};margin:16px 0">${code}</div>
          <p style="font-size:13px;color:#8a837c">If you didn't request this, you can ignore this email.</p>
        </div>
      </div>`,
    }),
  }).catch(() => {});

  const res = NextResponse.json({ ok: true });
  res.cookies.set("od_code", cookie.value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
