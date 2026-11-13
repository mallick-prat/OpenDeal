import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
    // Tests assert against the DEFAULT config (US Eastern, "Your Fund",
    // example.com). Pin it so your own NEXT_PUBLIC_* settings can't leak in.
    env: {
      NEXT_PUBLIC_TIMEZONE: "America/New_York",
      NEXT_PUBLIC_ORG_NAME: "Your Fund",
      NEXT_PUBLIC_TEAM_DOMAINS: "example.com",
      NEXT_PUBLIC_BRAND_COLOR: "#0f62fe",
      NEXT_PUBLIC_INBOUND_MAILBOX: "",
      INBOUND_MAILBOX: "",
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
