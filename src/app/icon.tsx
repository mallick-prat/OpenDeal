import { ImageResponse } from "next/og";
import { crm } from "@/config/crm.config";
import { orgInitials } from "@/lib/brandPure";

// The favicon / app icon: your initials on your brand color.
export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default function Icon() {
  const initials = orgInitials(crm.org.name);
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: crm.brand.primary,
          color: "#ffffff",
          fontSize: initials.length > 1 ? 34 : 40,
          fontWeight: 700,
          letterSpacing: -2,
        }}
      >
        {initials}
      </div>
    ),
    size
  );
}
