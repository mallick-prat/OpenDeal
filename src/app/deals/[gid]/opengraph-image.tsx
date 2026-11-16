import { crm } from "@/config/crm.config";
import { ImageResponse } from "next/og";
import { getPublicDeal } from "@/lib/publicDeal";
import { orgInitials } from "@/lib/brandPure";

// Reads the DB (postgres.js), so it must run on Node, not the edge.
export const runtime = "nodejs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = `${crm.org.name} deal`;

// The link-unfurl card: company / founder / school-color / financing / date.
export default async function Image({
  params,
}: {
  params: Promise<{ gid: string }>;
}) {
  const { gid } = await params;
  const deal = await getPublicDeal(decodeURIComponent(gid)).catch(() => null);

  const accent = deal?.schoolColor ?? "#101828";
  const company = deal?.company ?? crm.org.name;
  const founder = deal?.founder ?? "";
  const school = deal?.school ?? "";
  const summary = deal?.summary ?? "";
  const meta = deal ? [deal.financing, deal.round].filter(Boolean).join(" · ") : "";
  const date = deal?.created ?? "";

  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          color: "white",
          background: `linear-gradient(135deg, ${accent} 0%, #12100e 92%)`,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ display: "flex" }}>
            {school ? (
              <div
                style={{
                  display: "flex",
                  background: "rgba(255,255,255,0.15)",
                  padding: "10px 24px",
                  borderRadius: 999,
                  fontSize: 30,
                  fontWeight: 600,
                }}
              >
                {school}
              </div>
            ) : null}
          </div>
          <div style={{ display: "flex", fontSize: 40, fontWeight: 700, letterSpacing: -1 }}>{orgInitials(crm.org.name)}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {founder ? (
            <div style={{ display: "flex", fontSize: 34, color: "rgba(255,255,255,0.7)", marginBottom: 10 }}>
              {founder}
            </div>
          ) : null}
          <div style={{ display: "flex", fontSize: 88, fontWeight: 300, lineHeight: 1.05 }}>
            {company}
          </div>
          {summary ? (
            <div
              style={{
                display: "flex",
                fontSize: 30,
                lineHeight: 1.3,
                marginTop: 20,
                color: "rgba(255,255,255,0.75)",
                maxWidth: 900,
              }}
            >
              {summary}
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 18, marginTop: 28, fontSize: 32, color: "rgba(255,255,255,0.85)" }}>
            {meta ? <div style={{ display: "flex", fontWeight: 700, color: "white" }}>{meta}</div> : null}
            {meta && date ? <div style={{ display: "flex", color: "rgba(255,255,255,0.4)" }}>·</div> : null}
            {date ? <div style={{ display: "flex" }}>{date}</div> : null}
          </div>
        </div>
      </div>
    ),
    { ...size }
  );
}
