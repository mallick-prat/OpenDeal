import "server-only";
import { createHmac, timingSafeEqual } from "crypto";

/**
 * Signed OAuth `state` shared by the Google connect flows. `kind` separates
 * the per-member metadata connection ('metadata'), the shared inbound
 * mailbox ('inbox'), and the per-member personal-inbox sync ('mail'); it is
 * bound into the MAC so the flows can't be swapped.
 */
export type GoogleOauthKind = "metadata" | "inbox" | "mail";

export interface GoogleState {
  email: string;
  kind: GoogleOauthKind;
  exp: number;
}

export function signGoogleState(email: string, kind: GoogleOauthKind): string {
  const exp = Date.now() + 10 * 60 * 1000;
  const payload = Buffer.from(
    JSON.stringify({ email, kind, exp })
  ).toString("base64url");
  const mac = createHmac("sha256", process.env.AUTH_SECRET!)
    .update(`google|${kind}|${email}|${exp}`)
    .digest("hex");
  return `${payload}.${mac}`;
}

export function verifyGoogleState(state: string): GoogleState | null {
  const [payloadB64, mac] = state.split(".");
  if (!payloadB64 || !mac) return null;
  let payload: Partial<GoogleState>;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
  } catch {
    return null;
  }
  const { email, exp } = payload;
  const kind: GoogleOauthKind =
    payload.kind === "inbox"
      ? "inbox"
      : payload.kind === "mail"
        ? "mail"
        : "metadata";
  if (!email || !exp || Date.now() > exp) return null;
  const expected = createHmac("sha256", process.env.AUTH_SECRET!)
    .update(`google|${kind}|${email}|${exp}`)
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(mac);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { email, kind, exp };
}
