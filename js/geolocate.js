// Geolocation controller: cycles off -> locate -> follow -> off.
// Owns watchPosition and the screen wake lock (held while following).
// Pure logic, no Leaflet: the caller draws the dot and moves the map.

export function createGeolocate({ onUpdate, onModeChange, onError }) {
  let mode = 'off';
  let watchId = null;
  let wakeLock = null;

  async function acquireWakeLock() {
    try {
      const lock = (await navigator.wakeLock?.request('screen')) ?? null;
      // Mode may have left 'follow' while the request was in flight; don't
      // hold a lock nobody will release.
      if (mode !== 'follow') { lock?.release().catch(() => {}); return; }
      wakeLock = lock;
    } catch {
      wakeLock = null; // unsupported / denied (e.g. low battery) — non-fatal
    }
  }

  function releaseWakeLock() {
    wakeLock?.release().catch(() => {});
    wakeLock = null;
  }

  // The lock is auto-released when the page is hidden; re-acquire on return.
  document.addEventListener('visibilitychange', () => {
    if (mode === 'follow' && document.visibilityState === 'visible') acquireWakeLock();
  });

  function setMode(m) {
    if (m === mode) return;
    if (mode === 'follow') releaseWakeLock();
    mode = m;
    if (m === 'follow') acquireWakeLock();
    if (m === 'off' && watchId != null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    onModeChange?.(m);
  }

  function start() {
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude: lat, longitude: lng, accuracy, heading, speed } = pos.coords;
        onUpdate?.({
          lat,
          lng,
          accuracy,
          // A heading is only meaningful when actually moving.
          heading: Number.isFinite(heading) && speed > 0.5 ? heading : null,
        });
      },
      (err) => {
        setMode('off');
        onError?.(new Error(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission denied'
            : `Location unavailable: ${err.message}`,
        ));
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
    );
  }

  return {
    get mode() { return mode; },
    cycle() {
      if (!('geolocation' in navigator)) {
        onError?.(new Error('Geolocation is not supported by this browser'));
        return;
      }
      if (mode === 'off') { setMode('locate'); start(); }
      else if (mode === 'locate') setMode('follow');
      else setMode('off');
    },
    // Manual pan while following drops back to locate (dot stays, no centering).
    userPanned() {
      if (mode === 'follow') setMode('locate');
    },
  };
}
