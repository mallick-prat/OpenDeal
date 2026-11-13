import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe base config shared by the middleware. It contains no providers
 * (those need Node crypto and live in auth.ts) — just the route gate.
 */
export const authConfig = {
  pages: { signIn: "/login" },
  session: { strategy: "jwt" },
  trustHost: true,
  providers: [],
  callbacks: {
    authorized({ auth, request }) {
      const { pathname, searchParams } = request.nextUrl;
      // A SPECIFIC deal (/deals/<id>) is publicly viewable, read-only, so a
      // link can be shared with anyone and unfurl a preview. The board itself
      // (/deals) and everything else stay gated. The page decides what a
      // logged-out viewer sees (just that deal's card, nothing interactive).
      const isPublicDeal = /^\/deals\/[^/]+/.test(pathname);
      // A SPECIFIC deal's tracking (/tracking?deal=<gid>) is a shareable
      // capability URL too — the read-only, single-deal tracking card. Let it
      // through so the page can render that view for logged-out visitors. The
      // tracking board itself (/tracking with no ?deal) stays sign-in only.
      const isPublicTracking =
        pathname === "/tracking" && !!searchParams.get("deal");
      const isPublic =
        isPublicDeal ||
        isPublicTracking ||
        pathname.startsWith("/login") ||
        pathname.startsWith("/magic") ||
        pathname.startsWith("/api/auth") ||
        pathname.startsWith("/api/send-code");
      if (isPublic) return true;
      return !!auth?.user;
    },
  },
} satisfies NextAuthConfig;
