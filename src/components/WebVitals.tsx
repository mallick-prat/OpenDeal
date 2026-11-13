"use client";

import { useReportWebVitals } from "next/web-vitals";

/**
 * Ships each web-vital once per page load to /api/vitals via sendBeacon
 * (fetch keepalive fallback), so field LCP/INP/CLS exist next to the server
 * timings in perf_events instead of only in lab runs.
 */
export function WebVitals() {
  useReportWebVitals((metric) => {
    if (!["LCP", "INP", "CLS", "FCP", "TTFB"].includes(metric.name)) return;
    const body = JSON.stringify({
      name: metric.name,
      value: metric.value,
      path: window.location.pathname,
    });
    try {
      if (navigator.sendBeacon?.("/api/vitals", new Blob([body], { type: "application/json" }))) return;
    } catch {
      // fall through to fetch
    }
    void fetch("/api/vitals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  });
  return null;
}
