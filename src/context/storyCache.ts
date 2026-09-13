// IndexedDB persistence for the story records cache (durable mirror tier).
//
// WHY INDEXEDDB EXISTS (the localStorage-only cache kept failing on mobile):
//   - iOS Safari private mode: localStorage setItem THROWS on every write and
//     the whole cache is wiped when the tab/session closes — the offline
//     dashboard came up empty on every private-mode reload.
//   - Safari ITP 7-day eviction: localStorage keys unused for 7 days are
//     deleted outright; IndexedDB is NOT subject to the same blanket eviction
//     (script-initiated storage that gets regular reads/writes is kept).
//   - Quota: localStorage is ~5MB; IndexedDB is typically hundreds of MB on
//     mobile — the full chapter-revision cache fits without shedding.
//
// DESIGN:
//   - Single object store 'kv', key 'records', value = the same
//     PersistableStoryEntry[] JSON shape the localStorage cache holds.
//   - Mirror tier: every saveRecordsToStorage ALSO fires storyCacheSet
//     (fire-and-forget; IndexedDB failures are logged, never thrown — the
//     synchronous localStorage tier remains the primary path).
//   - Recovery tier: BootstrapLayer calls storyCacheGet on mount; when
//     localStorage came up empty (private-mode wipe, eviction, quota) but
//     IndexedDB still holds records, they are restored into localStorage AND
//     the store — the cache-first render then proceeds unchanged.
//   - SSR / no-IndexedDB environments: every function resolves to its empty
//     fallback (null / false) instead of throwing.
//
// TEST SHIM: vitest runs in jsdom which has NO IndexedDB — tests install
// fake-indexeddb via setupFiles (vitest.config.ts) so the real code paths run
// unmocked. The module itself never imports the shim.

// Database + store constants. A version bump would require an upgrade path —
// the schema is a single key/value pair, so v1 is all we ever need.
const DB_NAME = 'storyGenerator';
const DB_VERSION = 1;
const STORE_NAME = 'kv';
const RECORDS_KEY = 'records';

// Feature test: is a usable IndexedDB present? (jsdom: no; SSR: no; private
// Safari: yes — IndexedDB works there even when localStorage throws, which is
// exactly why this tier exists).
const hasIndexedDB = (): boolean => {
    try {
        return typeof indexedDB !== 'undefined' && indexedDB !== null;
    } catch {
        // Accessing indexedDB itself can throw in hardened privacy modes.
        return false;
    }
};

// Open (and lazily create) the database. Rejects on error/blocked so callers
// can log-and-continue.
const openDatabase = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
        if (!hasIndexedDB()) {
            reject(new Error('IndexedDB unavailable'));
            return;
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        // First-run (or version-bump) schema creation: one key/value store.
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
        request.onblocked = () => reject(new Error('IndexedDB open blocked'));
    });

// Read the persisted records payload. Resolves null when absent/unavailable —
// callers treat null as "nothing cached in this tier".
export const storyCacheGet = (): Promise<PersistableStoryEntryShape[] | null> =>
    openDatabase()
        .then(
            (db) =>
                new Promise<PersistableStoryEntryShape[] | null>((resolve, reject) => {
                    const tx = db.transaction(STORE_NAME, 'readonly');
                    const request = tx.objectStore(STORE_NAME).get(RECORDS_KEY);
                    request.onsuccess = () => {
                        db.close();
                        resolve(request.result ?? null);
                    };
                    request.onerror = () => {
                        db.close();
                        reject(request.error ?? new Error('IndexedDB get failed'));
                    };
                })
        )
        .catch(() => null);

// Write the records payload. Resolves true when durably written, false when
// the tier is unavailable or the write failed (never rejects — fire-and-forget
// callers cannot await-catch meaningfully).
export const storyCacheSet = (records: PersistableStoryEntryShape[]): Promise<boolean> =>
    openDatabase()
        .then(
            (db) =>
                new Promise<boolean>((resolve, reject) => {
                    const tx = db.transaction(STORE_NAME, 'readwrite');
                    tx.objectStore(STORE_NAME).put(records, RECORDS_KEY);
                    tx.oncomplete = () => {
                        db.close();
                        resolve(true);
                    };
                    tx.onerror = () => {
                        db.close();
                        reject(tx.error ?? new Error('IndexedDB put failed'));
                    };
                    tx.onabort = () => {
                        db.close();
                        reject(tx.error ?? new Error('IndexedDB put aborted'));
                    };
                })
        )
        .catch(() => false);

// Purge the mirror (story deletion writes the emptied records array through
// the normal set path, so an explicit delete is only needed for completeness).
export const storyCacheClear = (): Promise<boolean> =>
    openDatabase()
        .then(
            (db) =>
                new Promise<boolean>((resolve, reject) => {
                    const tx = db.transaction(STORE_NAME, 'readwrite');
                    tx.objectStore(STORE_NAME).delete(RECORDS_KEY);
                    tx.oncomplete = () => {
                        db.close();
                        resolve(true);
                    };
                    tx.onerror = () => {
                        db.close();
                        reject(tx.error ?? new Error('IndexedDB delete failed'));
                    };
                })
        )
        .catch(() => false);

// Test isolation: vitest runs every test file in a fresh worker, but MULTIPLE
// tests within one file share the module — and beforeEach only clears
// localStorage. Expose an explicit reset so App.test.tsx's afterEach can wipe
// the fake IndexedDB database between tests (prevents a test's mirrored
// records from "recovering" into the next test's empty-localStorage boot).
// In the browser this is never called; the cache is meant to persist.
export const storyCacheResetForTests = async (): Promise<void> => {
    try {
        const db = await openDatabase();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).clear();
            tx.oncomplete = () => {
                db.close();
                resolve();
            };
            tx.onerror = () => {
                db.close();
                reject(tx.error ?? new Error('IndexedDB clear failed'));
            };
        });
    } catch {
        // No IndexedDB / already closed — nothing to reset.
    }
};

// Structural shape of the persisted record — mirrors PersistableStoryEntry in
// store.tsx. Declared here (not imported) to keep this module dependency-free
// and unit-testable in isolation; the store's type is structurally identical.
export type PersistableStoryEntryShape = {
    id: number;
    storyId: string;
    storyName?: string;
    title: string;
    storyline: string;
    chapterRequested: number;
    chapterCompleted: number;
    createdDate: string;
    lastActionedAt?: string;
    lastUpdatedAt?: string;
    dataStale?: boolean;
    status: 'generating' | 'completed' | 'failed';
    data: {
        chapters: Array<Record<string, unknown>>;
        meta: Record<string, unknown> | null;
    } | null;
    isRemote: boolean;
    missingFromServer?: boolean;
};
