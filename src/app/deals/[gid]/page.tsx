import { crm } from "@/config/crm.config";
import type { Metadata } from "next";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { getPublicDeal } from "@/lib/publicDeal";
import { PublicDealView } from "@/components/PublicDealView";
import { DashboardPage } from "../../DashboardPage";

// A deal is addressable at /deals/[gid]. Signed-in members get the full Deal
// Room with that deal opened as an overlay; anyone else gets a read-only card
// (and the link unfurls a preview — see opengraph-image.tsx). Shareable.
export const maxDuration = 60;
export const revalidate = 900;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ gid: string }>;
}): Promise<Metadata> {
  const { gid } = await params;
  const deal = await getPublicDeal(decodeURIComponent(gid)).catch(() => null);
  if (!deal) return { title: crm.org.name };
  const facts = [
    deal.founder,
    [deal.financing, deal.round].filter(Boolean).join(" · "),
    deal.school,
  ]
    .filter(Boolean)
    .join("  ·  ");
  // Lead with what the company does, then the facts line.
  const desc = [deal.summary, facts].filter(Boolean).join("  —  ");
  return {
    title: `${deal.company} · ${crm.org.name}`,
    description: desc || `Shared from ${crm.org.name}.`,
    openGraph: {
      title: deal.company,
      description: desc || `Shared from ${crm.org.name}.`,
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: deal.company,
      description: desc || `Shared from ${crm.org.name}.`,
    },
  };
}

export default async function DealDeepLink({
  params,
}: {
  params: Promise<{ gid: string }>;
}) {
  const { gid } = await params;
  const deal = decodeURIComponent(gid);
  // Branch on the SESSION only (JWT, no DB): signed-in -> full room (which does
  // its own membership + DB-error handling); logged-out -> public read-only.
  const session = await auth();
  if (session?.user?.email) {
    return <DashboardPage initialView="deals" initialDealGid={deal} />;
  }
  return <PublicDealView gid={deal} />;
}
