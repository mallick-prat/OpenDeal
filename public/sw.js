/* Service worker (hand-rolled, conservative).
 *
 * A live deal pipeline must NEVER serve stale data, so this is deliberately
 * network-first: navigations and APIs always hit the network. The only things
 * cached are the immutable content-hashed build assets (for fast repeat loads)
 * and a small offline fallback page (so a dropped connection shows a branded
 * screen instead of the browser's error). Updates are opt-in: the SW waits and
 * the app offers a "Reload" — it never reloads out from under active work.
 */
const VERSION = "v1";
const STATIC_CACHE = `xf-static-${VERSION}`;
const SHELL_CACHE = `xf-shell-${VERSION}`;
const OFFLINE_URL = "/offline";
const PRECACHE = [OFFLINE_URL, "/icon.svg"];

self.addEventListener("install", (event) => {
  // Precache the offline page; do NOT skipWaiting (the app prompts to reload).
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll(PRECACHE))
      .catch(() => {})
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== STATIC_CACHE && k !== SHELL_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return; // never touch cross-origin

  // Navigations: network-first, fall back to the cached offline page.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(req);
        } catch {
          const cached = await caches.match(OFFLINE_URL);
          return (
            cached ||
            new Response("You are offline.", {
              status: 503,
              headers: { "Content-Type": "text/plain" },
            })
          );
        }
      })()
    );
    return;
  }

  // Immutable build assets: cache-first (URLs are content-hashed, so a new
  // deploy fetches new URLs and the HTML is always fresh — no stale mismatch).
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches
              .open(STATIC_CACHE)
              .then((c) => c.put(req, copy))
              .catch(() => {});
            return res;
          })
      )
    );
    return;
  }

  // Everything else (APIs, dynamic pages, data): passthrough, never cached.
});
