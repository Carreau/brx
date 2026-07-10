// Registers the service worker in supported, secure-enough contexts.
// Silent no-op everywhere else (unsupported browser, plain http on a
// non-localhost host, file: pages, etc).
export function registerPWA() {
  if (!("serviceWorker" in navigator)) return;

  const { protocol, hostname } = window.location;
  const isSecure = protocol === "https:";
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1";
  if (!isSecure && !isLocalhost) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("[pwa] service worker registration failed:", err);
    });
  });
}
