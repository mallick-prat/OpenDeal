import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {
  // Pin the project root so a stray lockfile in a parent folder can't confuse
  // Turbopack when you run the app from a nested checkout.
  turbopack: { root: dirname(fileURLToPath(import.meta.url)) },
  // Keep the postgres driver out of the bundler: bundling breaks its
  // socket/TLS handling (surfaces as ECONNRESET against hosted poolers).
  serverExternalPackages: ["postgres", "sharp"],
};

export default nextConfig;
