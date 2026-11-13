/**
 * ── DocSend parsing, pure ───────────────────────────────────────────────────
 * Link detection, passcode mining from pitch-email text, and verification-
 * link extraction from DocSend's own emails. No IO — everything tests.
 */

/** Every docsend.com/view/... link in a blob of text, deduped, capped. */
export function findDocsendUrls(text: string | null | undefined, max = 3): string[] {
  if (!text) return [];
  const re = /https?:\/\/(?:www\.)?docsend\.com\/(?:view|v)\/[A-Za-z0-9_/-]+/g;
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const url = m[0].replace(/[).,;:!?]+$/, "");
    if (!out.includes(url)) out.push(url);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Mine likely deck passcodes from email text: "password: X", "passcode is X",
 * "pw – X". Founders put these right next to the link. Ordered as found,
 * junk words filtered, capped.
 */
export function minePasscodes(text: string | null | undefined, max = 3): string[] {
  if (!text) return [];
  const out: string[] = [];
  const re = /(?:passcode|password|pass\s?code|pass\s?word|pwd?|pw)\s*(?:is|[:=\-–])\s*["'‘“]?([^\s<>,;"'’”]{3,40})/gi;
  const junk = /^(required|protected|needed|below|attached|the|for|your)$/i;
  for (const m of text.matchAll(re)) {
    // Strip sentence punctuation only — "!" and "?" are common IN passwords.
    const candidate = m[1].replace(/[).,;:]+$/, "");
    if (junk.test(candidate)) continue;
    if (!out.includes(candidate)) out.push(candidate);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The verification link inside a DocSend "verify your email" message.
 * DocSend's links point at docsend.com and carry a verification token path
 * or query; take the first plausible one, never a plain /view/ deck link.
 */
export function extractVerificationLink(emailBody: string | null | undefined): string | null {
  if (!emailBody) return null;
  const links = emailBody.match(/https?:\/\/[^\s<>"')\]]+/g) ?? [];
  for (const raw of links) {
    const url = raw.replace(/[).,;:!?]+$/, "");
    if (!/docsend\.com/i.test(url)) continue;
    if (/\/(?:verif|confirm|access|authenticate|e\/)/i.test(url) || /[?&](?:token|code|verification)/i.test(url)) {
      return url;
    }
  }
  return null;
}
