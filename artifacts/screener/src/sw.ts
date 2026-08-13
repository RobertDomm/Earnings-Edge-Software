/// <reference lib="webworker" />
import { precache, matchPrecache } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope;

// Precache build assets (static JS/CSS/images) for offline asset serving.
// We intentionally do NOT call precacheAndRoute() — that registers a
// navigation route serving the precached index.html for every navigation,
// including when the user is offline, causing a blank screen instead of the
// offline fallback page.
precache(self.__WB_MANIFEST);

// Navigation handler: always try the live network first (no cache reads).
// Only serve the offline page when the network request throws (device has no
// connectivity). Online users always get a fresh server response.
registerRoute(
  new NavigationRoute(async ({ request }) => {
    try {
      return await fetch(request);
    } catch {
      // Resolve offline.html relative to the SW registration scope so the URL
      // matches the precache key regardless of BASE_PATH at build time.
      // e.g. scope "https://app.example.com/"         → "…/offline.html"
      //      scope "https://app.example.com/screener/" → "…/screener/offline.html"
      // matchPrecache() resolves the revisioned cache key (offline.html?__WB_REVISION__=…)
      // so the lookup succeeds even though precache() stores revisioned URLs.
      const offlineUrl = new URL('offline.html', self.registration.scope).href;
      const cached = await matchPrecache(offlineUrl);
      if (cached) return cached;
      return new Response('You are offline.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
  }),
);
