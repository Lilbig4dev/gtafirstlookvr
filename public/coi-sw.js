/* Fallback COOP/COEP Service Worker when hosting environment omits Cross-Origin-Isolation headers */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

  event.respondWith((async () => {
    const fetchReq = req.mode === 'navigate'
      ? req
      : new Request(req, { credentials: req.credentials });

    const response = await fetch(fetchReq);
    if (response.status === 0) return response;

    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    if (!headers.has('Cross-Origin-Resource-Policy')) {
      headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  })());
});
