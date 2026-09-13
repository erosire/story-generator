// Vitest setup: install fake-indexeddb globals BEFORE any test module loads.
//
// jsdom ships NO IndexedDB implementation, but the story cache mirrors its
// localStorage records into IndexedDB (src/context/storyCache.ts) as the
// durable tier that survives iOS Safari private-mode wipes and ITP 7-day
// eviction. Without a shim every IndexedDB call in tests resolves to the
// module's "unavailable" fallback and the mirror/recovery paths are never
// exercised. fake-indexeddb (devDependency) provides a spec-compliant in-memory
// implementation; the 'auto' entry defines globalThis.indexedDB + the IDB*
// constructors, exactly like a real browser.
//
// The import is dynamic with a graceful fallback so a workspace checkout
// without the devDependency still runs every non-IndexedDB test untouched.

// Make this file a module (top-level await is only valid in modules) — setup
// files have no natural exports.
export {};

try {
    // Resolved from the workspace root's node_modules (fake-indexeddb is a
    // root devDependency — the distribution package has no node_modules of
    // its own for it; see package.json note in store.tsx header).
    // The @ts-ignore covers the library's missing types resolution for the
    // './auto' subpath under package.json "exports" (fake-indexeddb 6.x
    // ships auto.d.ts but does not map it in "exports" — TS1375/TS7016).
    // @ts-ignore
    await import('fake-indexeddb/auto');
} catch {
    // fake-indexeddb not installed — tests that assert IndexedDB behavior
    // will fail with a clear "indexedDB is not defined" signal; everything
    // else keeps working (the cache module degrades to its null fallbacks).
    console.warn('[test setup] fake-indexeddb not available — IndexedDB-dependent tests will fail.');
}
