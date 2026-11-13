import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans } from "next/font/google";
import "./globals.css";
import { ClientErrorReporter } from "@/components/ClientErrorReporter";
import { ServiceWorkerManager } from "@/components/ServiceWorkerManager";
import { WebVitals } from "@/components/WebVitals";
import { ViewAsBanner } from "@/components/ViewAsBanner";
import { crm } from "@/config/crm.config";
import { brandCss } from "@/lib/brandPure";

const plex = IBM_Plex_Sans({
  variable: "--font-plex",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
});

export const metadata: Metadata = {
  title: `${crm.org.name} — Deal Pipeline`,
  description: `${crm.org.name}'s deal pipeline and inbound review queue.`,
  manifest: "/manifest.webmanifest",
  // Installed/standalone behavior on iOS.
  appleWebApp: { capable: true, statusBarStyle: "default", title: crm.org.name },
};

// Separate viewport export (Next 16): viewport-fit=cover lets the app paint
// under notches/home indicators, and safe-area-inset-* (used in CSS) keeps
// content clear of them. themeColor tints the browser/standalone chrome.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#ffffff",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${plex.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        {/* One brand hex themes the whole app: see src/config/crm.config.ts */}
        <style id="brand" dangerouslySetInnerHTML={{ __html: brandCss(crm.brand.primary) }} />
      </head>
      <body className="flex min-h-[100dvh] flex-col" suppressHydrationWarning>
        <ClientErrorReporter />
        <ServiceWorkerManager />
        <WebVitals />
        {children}
        <ViewAsBanner />
      </body>
    </html>
  );
}
