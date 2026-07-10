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

// Wires an "install app" button. Chrome/Android expose beforeinstallprompt;
// iOS Safari has no prompt API, so the button shows manual instructions.
export function setupInstall(button) {
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (standalone) return; // already installed

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS

  let deferred = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    button.hidden = false;
  });

  if (isIOS) {
    button.hidden = false;
    button.onclick = () =>
      alert('To install: tap the Share button, then "Add to Home Screen".');
    return;
  }

  button.onclick = async () => {
    if (!deferred) return;
    deferred.prompt();
    const { outcome } = await deferred.userChoice;
    deferred = null;
    if (outcome === "accepted") button.hidden = true;
  };
}
