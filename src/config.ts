// Local environment constants — standalone replacement for the monorepo's
// @config/environment package (config/environment/src/host.ts + src/port.ts),
// which cannot be published to npm. Keep in sync with the monorepo originals;
// the constant names are unchanged so imports are a drop-in swap.

// Standard local area network host name (config/environment/src/host.ts).
export const LOCAL_AREA_NETWORK_HOST_NAME = '192.168.8.128';

// List of ports available (config/environment/src/port.ts).
export const LOCAL_AREA_NETWORK_DATABASE_PORT = 5000;
export const LOCAL_AREA_NETWORK_STORYBOARD_PORT = 5252;
export const LOCAL_AREA_NETWORK_PROVIDER_PORT = 5500;

// ── Runtime API host resolution ──────────────────────────────────────────────
// The storyboard UI used to dial the API at the CONSTANT LAN address
// (http://192.168.8.128:5252) no matter where the UI itself was loaded from.
// When the dashboard runs on the same machine as the server (the common dev
// case: UI served from http://localhost:8000 by vite.config.ts server.port),
// that constant forces the fetches onto the machine's LAN interface — they
// can fail (no route / firewall) even though the server is up at
// localhost:5252. The rule instead: mirror the ORIGIN the UI was loaded from.
// If the UI was loaded via localhost, dial the API via localhost; if it was
// loaded via any other host (LAN IP, another machine), keep the LAN constant.

// Hostnames that mean "the page itself is running on this machine".
// 'localhost' — the standard loopback name; '127.0.0.1' — IPv4 loopback;
// '[::1]' — IPv6 loopback browsers report WITH brackets in location.hostname;
// '::1' — defensive: older/B2G engines report the bare form. '*.localhost'
// (e.g. app.localhost) resolves to loopback in Chromium per RFC 6761 — treat
// the whole suffix as local.
const LOCAL_HOST_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// Pure check: does this host name refer to the local machine (loopback)?
// Exported separately from the window-reading resolver so tests (and future
// callers) can exercise every branch deterministically without mocking
// window.location (jsdom makes location an unforgeable, non-redefinable
// property — see config.test.ts).
export const isLocalHostOrigin = (hostName: string): boolean =>
    LOCAL_HOST_NAMES.has(hostName) || hostName.endsWith('.localhost');

// Resolve the host the storyboard API should be dialled at, based on where
// the UI itself was loaded from (window.location.hostname):
//   - UI at localhost / 127.0.0.1 / ::1        → 'localhost'  (same machine)
//   - UI at any other host or NO window (SSR, Node-side import) → the LAN
//     constant, preserving the previous behavior for remote deployments.
// Called once at StoryStoreProvider module load (DEFAULT_CONFIG.baseUrl); a
// re-read per call would be pointless — the page origin cannot change without
// a full document load, which re-evaluates the module anyway. window access
// is guarded (typeof + try/catch) because this module is also imported under
// test and must never throw in a no-window environment.
export const resolveStoryboardApiHostName = (): string => {
    // No document context: keep the LAN default (previous behavior).
    if (typeof window === 'undefined') return LOCAL_AREA_NETWORK_HOST_NAME;
    try {
        return isLocalHostOrigin(window.location.hostname)
            ? 'localhost'
            : LOCAL_AREA_NETWORK_HOST_NAME;
    } catch {
        // Hardened sandboxes can throw on location access — same fallback.
        return LOCAL_AREA_NETWORK_HOST_NAME;
    }
};
