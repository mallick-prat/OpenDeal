import { crm } from "@/config/crm.config";
import type { MetadataRoute } from "next";

/**
 * Web app manifest → installable / standalone. Served at /manifest.webmanifest.
 * The icon is generated from your org initials and brand color (app/icon.tsx).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${crm.org.name} Pipeline`,
    short_name: crm.org.name,
    description: `The ${crm.org.name} deal pipeline.`,
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    orientation: "any",
    icons: [
      { src: "/icon", sizes: "64x64", type: "image/png", purpose: "any" },
    ],
  };
}
