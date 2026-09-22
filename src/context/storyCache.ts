// IndexedDB persistence for the story records cache (durable mirror tier).
//
// WHY INDEXEDDB EXISTS (the localStorage-only cache kept failing on mobile):
//   - iOS Safari private mode: localStorage setItem THROWS on every write and
//     the whole cache is wiped when the tab/session closes — the offline
//     dashboard came up empty on every private-mode reload.
//   - Safari ITP 7-day eviction: after ~7 days without interacting with the
//     site, Safari's Intelligent Tracking Prevention can delete ALL
//     script-writable storage for the origin — localStorage AND this
//     IndexedDB mirror alike (IndexedDB is NOT exempt; only the removal of
//     the interactive-use requirement after the 7-day window differs). The
//     mitigation is navigator.storage.persist(): BootstrapLayer requests
//     persistent storage at boot (requestPersistentStorage below) so a
//     granted origin is opted out of the eviction window. Best-effort only —
//     the browser may decline (or predate the API), in which case the 7-day
//     cap stands and the cache is only as durable as the last interaction.
//   - Quota: localStorage is ~5MB; IndexedDB is typically hundreds of MB on
//     mobile — the full chapter-revision cache fits without shedding.
//
// DESIGN:
//   - Single object store 'kv', ONE KEY PER STORY ('story:<storyId>'), value =
//     that story's PersistableStoryEntry (the same JSON shape the localStorage
//     cache holds per story). PER-STORY KEYING is deliberate: a story's
//     background job (plotline generation / chapter expansion) rewrites its
//     cache entry every poll tick — with the old single-blob layout EVERY
//     story's mirror payload was rewritten (and any write failure / quota
//     shed wiped the WHOLE cache). With one key per storyId, one story's
//     progress can never touch another story's cached data.
//   - Mirror tier: every saveRecordsToStorage ALSO fires storyCacheSet
//     (fire-and-forget; IndexedDB failures are logged, never thrown — the
//     synchronous localStorage tier remains the primary path). storyCacheSet
//     receives the COMPLETE records array and syncs the key set to it:
//     unchanged stories are skipped (signature comparison + key existence),
//     stories no longer in the array have their keys deleted.
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
//
// WRITE QUEUE: all mutating operations (set/clear/reset) are serialized
// through a single promise chain (writeQueue) so IndexedDB transactions land
// strictly in call order. The queue can STALL for seconds under vitest's
// fake-timer/act conditions (observed in App.test.tsx's fake-timer tests) —
// storyCacheResetForTests therefore never trusts a queued clear to have run:
// it always finishes with a DIRECT (out-of-queue) clear + verify pass, and
// every queued op carries a generation stamp so ops enqueued before a reset
// are skipped whenever they eventually run.
//
// OPEN-HOISTING INVARIANT: storyCacheSet/storyCacheClear issue their
// openDatabase() call SYNCHRONOUSLY (outside the queue) and only the
// transaction runs inside the queued op. Recovery reads (storyCacheGet) are
// deliberately NOT queued; the sync open keeps a put's open() request ordered
// before a get issued right after it, so fake-indexeddb runs the put's
// transaction first and the read observes the write (this ordering is what
// the "save then immediately recover" tests rely on).
//
// Diagnostic trace helper: appends to a fixed temp file when STORY_CACHE_TRACE
// is enabled. Written SYNCHRONOUSLY (fs.appendFileSync) so the output survives
// vitest's per-test stdout buffering — console output printed between tests
// (afterEach) gets attributed to the wrong test block, which made a cross-test
// mirror leak impossible to attribute. Only active when STORY_CACHE_TRACE=1.
//
// BROWSER GUARD: `process` is a Node global. Vite does NOT polyfill it in the
// browser bundle, so an unguarded `process.env` read here threw `ReferenceError:
// process is not defined` inside the store's save effect (saveRecordsToStorage
// → storyCacheSet → traceLog) and crashed <StoryStoreProvider> on load. Tracing
// is a vitest/Node-only diagnostic: resolve to "disabled" whenever `process` is
// absent (browser, SSR sandbox). Cross-reference: store.tsx saveRecordsToStorage
// (~line 694) and App.tsx <StoryStoreProvider> are the browser call sites.
const traceLog = (message: string): void => {
    // `typeof process` is safe in every environment; only the bare `process`
    // reference throws. Optional-chained env access covers exotic Node builds
    // where `process.env` itself is undefined.
    const tracingEnabled = typeof process !== 'undefined' && process.env?.STORY_CACHE_TRACE === '1';
    if (!tracingEnabled) return;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('node:fs') as typeof import('node:fs');
        fs.appendFileSync('story-cache-trace.log', `${Date.now()} ${message}\n`);
    } catch {
        // Tracing must never break the cache.
    }
};

// Database + store constants. A version bump would require an upgrade path —
// the schema is a flat key/value store, so v1 is all we ever need.
const DB_NAME = 'storyGenerator';
const DB_VERSION = 1;
const STORE_NAME = 'kv';
// Per-story key layout: 'story:<storyId>'. The old single-blob key
// ('records' → the entire PersistableStoryEntry[] payload) is kept ONLY for
// the legacy fallback read in storyCacheGet and is deleted by the first
// storyCacheSet sync after the layout switch.
const STORY_KEY_PREFIX = 'story:';
// Upper bound for the 'story:*' key range ('\uffff' sorts after every ASCII
// character, so the range covers every per-story key and nothing else).
const STORY_KEY_UPPER = '\uffff';
const LEGACY_RECORDS_KEY = 'records';

// Pending-write serialization: IndexedDB transactions from rapid successive
// saves could otherwise land OUT OF ORDER (put A → put B → clear could become
// clear → put A → put B if the puts were queued first). Every mutating
// operation is chained through this promise so operations execute strictly in
// call order.
let writeQueue: Promise<unknown> = Promise.resolve();
const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = writeQueue.then(operation, operation);
    writeQueue = run.catch(() => undefined);
    return run;
};

// Generation counter for test resets: every storyCacheResetForTests bumps it
// and enqueued writes captured a generation at enqueue time — a put whose
// generation is stale (reset happened after it was enqueued) is SKIPPED, so a
// late-landing put can never resurrect wiped records into the next test.
let queueGeneration = 0;

// REAL timers captured at MODULE LOAD. vitest's useFakeTimers() replaces
// globalThis.setTimeout/clearTimeout mid-test — a watchdog armed with the
// (faked) globals would itself be swallowed by the fake clock and die in the
// useRealTimers() teardown, exactly when it needs to fire (see the
// transaction watchdog below). The module-load capture is immune.
const moduleSetTimeout: typeof globalThis.setTimeout = globalThis.setTimeout.bind(globalThis);
const moduleClearTimeout: typeof globalThis.clearTimeout = globalThis.clearTimeout.bind(globalThis);

// Transaction watchdog: fake-indexeddb schedules EVERY IndexedDB event
// (transaction start, request success, transaction commit) through
// setImmediate. vitest's useFakeTimers() replaces setImmediate with the fake
// clock, and useRealTimers() DISCARDS still-pending fake-immediate callbacks.
// A transaction whose start/commit task is pending across that switch is
// therefore never started and never finished: it stays "active" forever and —
// because transactions serialize on the database — every later transaction
// with an overlapping scope stalls behind it, deadlocking the whole mirror
// tier until the process restarts (observed as the App.test.tsx
// "Hook timed out" afterEach flakes around fake-timer tests).
//
// The watchdog aborts such zombie transactions after STALL_WATCHDOG_MS of
// REAL time (module-captured timer, immune to the fake clock) and settles
// the surrounding promise, unblocking the database's transaction queue. The
// aborted tx made NO changes (abort rolls back), so settling as "not
// written / not read" is accurate; resolve/reject are first-call-wins, so a
// tx that completes normally after an abort attempt cannot double-settle.
//
// 2000ms (not lower): structured-clone puts of multi-MB chapter payloads are
// legitimate on slow mobile disks — a watchdog this size never fires on a
// healthy (even slow) write, only on the never-completing zombie case.
const STALL_WATCHDOG_MS = 2000;

const armTxWatchdog = (tx: IDBTransaction, settle: () => void): (() => void) => {
    const handle = moduleSetTimeout(() => {
        try {
            // Marks the tx finished synchronously inside fake-indexeddb —
            // this is what releases the database's transaction queue.
            tx.abort();
        } catch {
            // Already committing/finished — the tx was healthy after all.
        }
        settle();
    }, STALL_WATCHDOG_MS);
    return () => moduleClearTimeout(handle);
};

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

// ── Storage-health helpers (mobile diagnosis) ───────────────────────────────
// The mirror tier exists for the storage-hostile mobile environments above,
// but until now the app never MEASURED them: Safari ITP could silently evict
// everything (no persist() was ever requested), and iOS private mode /
// storage-disabled WebViews kept failing writes with only a hedged
// "may still be available" message. These helpers give BootstrapLayer the
// two signals it needs at boot: can localStorage accept a write at all, and
// can the browser be asked to keep this origin's storage persistent.

// Ask the browser to mark this origin's storage as persistent. This is the
// Safari ITP 7-day-eviction mitigation (see the header comment): a granted
// persist() request opts the origin out of the capricious-eviction window,
// keeping BOTH the localStorage quick-cache and the IndexedDB mirror. Strictly
// best-effort: returns false (never throws) when the StorageManager API is
// missing (older Safari, jsdom, SSR) or the request rejects. When the request
// is declined, navigator.storage.estimate() is read for a console diagnostic
// (usage/quota context) — never surfaced to state, never thrown.
export const requestPersistentStorage = async (): Promise<boolean> => {
    try {
        const manager =
            typeof navigator !== 'undefined' ? (navigator as Navigator).storage : undefined;
        if (!manager || typeof manager.persist !== 'function') return false;
        const persisted = await manager.persist();
        if (!persisted) {
            try {
                if (typeof manager.estimate === 'function') {
                    const { usage, quota } = await manager.estimate();
                    console.info(
                        `[storyCache] persistent storage not granted (origin usage ${usage ?? 0} of quota ${quota ?? 0})`
                    );
                }
            } catch {
                // Diagnostics must never break the request path.
            }
        }
        return persisted;
    } catch {
        // A rejecting persist()/hardened sandbox must never surface.
        return false;
    }
};

// Write-probe: what state is localStorage in RIGHT NOW? A tiny
// setItem/removeItem pair on a probe key distinguishes THREE shapes from a
// merely empty cache. Reads can still work in several of these shapes, so a
// successful boot hydration does NOT prove writability:
//   - 'writable'     — the probe write succeeded.
//   - 'quota-full'    — the probe write threw QuotaExceededError: storage is
//                       ENABLED but the ORIGIN'S BUDGET is exhausted (the
//                       reported mobile shape — ~5MB of old cached stories).
//                       Every key write fails, but the durable mirror tier
//                       still accepts payloads, so the accurate user-facing
//                       cause is "storage is full", NOT "private mode".
//   - 'unavailable'   — any other throw (SecurityError — private/incognito
//                       mode / storage disabled), or `window.localStorage`
//                       itself is null (storage-dead WebViews).
const probeLocalStorageHealth = (): 'writable' | 'quota-full' | 'unavailable' => {
    try {
        if (typeof localStorage === 'undefined' || localStorage === null) return 'unavailable';
        localStorage.setItem('storyGenerator:storage-probe', '1');
        localStorage.removeItem('storyGenerator:storage-probe');
        return 'writable';
    } catch (error) {
        // QuotaExceededError is the one exception whose NAME identifies the
        // cause (browsers throw it verbatim); anything else (SecurityError,
        // hardened-sandbox TypeErrors) is classified as storage-unavailable —
        // the previous boolean probe conflated the two and the sidebar told
        // quota-full users they were "in private mode", masking the real fix.
        return (error as { name?: string } | null)?.name === 'QuotaExceededError'
            ? 'quota-full'
            : 'unavailable';
    }
};

// Boot-time tier classification used by BootstrapLayer:
//   - localStorageWritable: the quick-cache tier can accept writes.
//   - localStorageQuotaFull: the probe failed with QuotaExceededError —
//     storage is enabled but the origin's budget is exhausted (only
//     meaningful when localStorageWritable is false; drives the distinct
//     "storage is full" copy instead of the private/incognito copy).
//   - indexedDbAvailable: the durable mirror tier exists at all.
// storage-writable = first true; localStorage-dead = first false (iOS private
// mode / storage-disabled WebView — the mirror is then the only durable tier);
// everything-dead = both false (recovery is impossible — nothing ever boots).
export type StorageTierClassification = {
    localStorageWritable: boolean;
    localStorageQuotaFull: boolean;
    indexedDbAvailable: boolean;
};

export const classifyStorageTiers = (): StorageTierClassification => {
    const health = probeLocalStorageHealth();
    return {
        localStorageWritable: health === 'writable',
        localStorageQuotaFull: health === 'quota-full',
        indexedDbAvailable: hasIndexedDB()
    };
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
        // Release the connection when another context (or a later open with a
        // new version) requests an upgrade — without this a stale open
        // connection blocks the new open (onblocked) and hangs the caller.
        // (onversionchange is missing from some older TS DOM lib versions —
        // the event handler exists at runtime in every browser and in
        // fake-indexeddb, so the assignment is cast defensively.)
        (request as IDBOpenDBRequest & {
            onversionchange: ((this: IDBOpenDBRequest, ev: IDBVersionChangeEvent) => unknown) | null;
        }).onversionchange = () => {
            request.result?.close();
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
        request.onblocked = () => reject(new Error('IndexedDB open blocked'));
    });

// Key range covering every per-story key ('story:*') and nothing else.
const storyKeyRange = (): IDBKeyRange => IDBKeyRange.bound(STORY_KEY_PREFIX, STORY_KEY_PREFIX + STORY_KEY_UPPER);

// Structural shape the fingerprint reads — deliberately loose (structural
// only, no type imports): both the store's PersistableStoryEntry and this
// module's PersistableStoryEntryShape satisfy it.
export type StoryFingerprintShape = {
    storyId: string;
    storyName?: string;
    title: string;
    storyline: string;
    chapterRequested: number;
    chapterCompleted: number;
    lastActionedAt?: string;
    lastUpdatedAt?: string;
    dataStale?: boolean;
    status: string;
    isRemote: boolean;
    missingFromServer?: boolean;
    data: {
        chapters?: Array<{
            chapterIndex?: number;
            expanded?: boolean;
            revisions?: unknown[];
        }>;
    } | null;
};

// Cheap structural fingerprint of a story's cache-worthy state. The skip
// signal for BOTH cache tiers: an equal fingerprint means "already cached
// and the updated timestamp (and everything else persisted) is unchanged —
// do not write again". Equal fingerprints imply equal payloads because:
//   - every SERVER write bumps the story's lastUpdatedAt (the plotpoint.json
//     mtime the cached payload reflects), and the client only ever stores
//     server payloads — equal timestamps ⇒ equal chapter content;
//   - revision content is never mutated in place: revisions are only added
//     (expand/rewrite) or removed (delete), which changes the per-chapter
//     revision counts captured in `structure`;
//   - everything else persisted is either tiny (carried in the head fields)
//     or server-derived (status, chapterRequested/Completed).
// Stringifying this compact tuple is O(entry metadata), never O(chapter
// bytes) — the multi-MB serialization is exactly what the fingerprint lets
// both tiers skip on a no-change poll tick.
export const storyCacheFingerprint = (entry: StoryFingerprintShape): string => {
    const chapters = entry.data?.chapters ?? [];
    const structure = chapters
        .map((ch) => `${ch.chapterIndex ?? ''}:${ch.expanded ? 1 : 0}:${ch.revisions?.length ?? 0}`)
        .join(',');
    return [
        entry.lastUpdatedAt ?? '',
        entry.lastActionedAt ?? '',
        entry.dataStale ? 1 : 0,
        entry.status ?? '',
        entry.chapterRequested ?? 0,
        entry.chapterCompleted ?? 0,
        entry.storyline ?? '',
        entry.title ?? '',
        entry.storyName ?? '',
        entry.missingFromServer ? 1 : 0,
        entry.isRemote ? 1 : 0,
        entry.data ? 1 : 0,
        chapters.length,
        structure
    ].join('|');
};

// Last-mirrored fingerprint per storyId — the change detector that lets
// storyCacheSet skip re-putting stories whose data did not change (a poll
// tick for ONE story must not rewrite the other stories' mirror entries, and
// an unchanged story must not pay the multi-MB structured-clone at all).
// Committed ONLY after the sync transaction completes (a failed/aborted put
// must not poison the fingerprint — the next sync would wrongly skip it).
// Paired with the ACTUAL key listing from getAllKeys: a fingerprint match
// only skips the put when the key still exists in IndexedDB, so a wiped
// mirror self-heals on the next sync.
const mirrorSignatures = new Map<string, string>();

// Read the persisted records payload — ALL per-story entries, ordered
// lexicographically by their storage key (stable, deterministic order).
// Resolves null when nothing is cached in this tier.
//
// LEGACY FALLBACK: payloads persisted before the per-story layout live under
// the old single-blob key ('records'). When no per-story keys exist, that blob
// is returned so the recovery path (loadRecordsFromIdbMirror) can rehydrate —
// the next storyCacheSet sync then re-keys the payload per story and deletes
// the legacy blob.
export const storyCacheGet = (): Promise<PersistableStoryEntryShape[] | null> =>
    openDatabase()
        .then(
            (db) =>
                new Promise<PersistableStoryEntryShape[] | null>((resolve, reject) => {
                    const tx = db.transaction(STORE_NAME, 'readonly');
                    // Zombie-tx watchdog (see armTxWatchdog): a readonly tx
                    // stranded by the fake-timer teardown would block every
                    // later overlapping tx — settle as "nothing cached"
                    // (equivalent to the tier's unavailable fallback).
                    const cancelWatchdog = armTxWatchdog(tx, () => resolve(null));
                    const done = (value: PersistableStoryEntryShape[] | null) => {
                        cancelWatchdog();
                        db.close();
                        resolve(value);
                    };
                    const fail = (error: unknown) => {
                        cancelWatchdog();
                        db.close();
                        reject(error);
                    };
                    const store = tx.objectStore(STORE_NAME);
                    const keysRequest = store.getAllKeys(storyKeyRange());
                    keysRequest.onsuccess = () => {
                        const keys = keysRequest.result as IDBValidKey[];
                        if (keys.length === 0) {
                            // No per-story keys → try the legacy single-blob key.
                            const legacy = store.get(LEGACY_RECORDS_KEY);
                            legacy.onsuccess = () => done(legacy.result ?? null);
                            legacy.onerror = () => fail(legacy.error ?? new Error('IndexedDB legacy get failed'));
                            return;
                        }
                        // Read every per-story entry, preserving the key order
                        // (results are written back by index — completion order
                        // of the parallel gets must not shuffle the array).
                        const results: PersistableStoryEntryShape[] = new Array(keys.length);
                        let pending = keys.length;
                        keys.forEach((key, index) => {
                            const get = store.get(key);
                            get.onsuccess = () => {
                                results[index] = get.result;
                                pending--;
                                if (pending === 0) done(results);
                            };
                            get.onerror = () => fail(get.error ?? new Error('IndexedDB get failed'));
                        });
                    };
                    keysRequest.onerror = () => fail(keysRequest.error ?? new Error('IndexedDB getAllKeys failed'));
                })
        )
        .catch(() => null);

// Write/sync the records payload — PER STORY. The caller (saveRecordsToStorage)
// always passes the COMPLETE records array, so this is a full-set sync:
//   - each entry is put under its own 'story:<storyId>' key,
//   - entries whose cheap FINGERPRINT (storyCacheFingerprint — updated
//     timestamp + structure, never the multi-MB bytes) did not change AND
//     whose key still exists in IndexedDB are SKIPPED entirely (no
//     structured-clone, no write — a poll tick for one story must not
//     rewrite the other stories' mirror entries, and an unchanged story must
//     not pay the clone cost at all),
//   - entries whose IN-MEMORY signature cannot prove them unchanged are
//     read back from the store first and can STILL be skipped:
//       (a) stored fingerprint === incoming fingerprint → cross-load
//           change detection. The in-memory mirrorSignatures map is empty
//           on every fresh page load, so without this check the FIRST sync
//           after boot re-put EVERY story as a multi-MB structured-clone
//           burst — and on a slow phone a tx that misses the watchdog
//           window got aborted, silently rolling back the new story's
//           first full put (fire-and-forget, returns false).
//       (b) RICHER-WINS never-downgrade: incoming entry has data == null
//           while the stored entry has non-null data → skip the put. The
//           boot-time persist effect saves the HYDRATED records; when
//           localStorage shed a story to metadata-only (quota ladder rung
//           2), that save carried data:null and the boot re-put used to
//           overwrite the mirror's full copy — the only tier that still
//           had it. Only the data==null case is treated as unambiguously
//           poorer; a non-null payload with fewer revisions is a LEGITIMATE
//           user delete that must reach the mirror.
//   - previously-mirrored story keys ABSENT from the array are DELETED
//     (the story was removed — e.g. deleteStory — so it must not resurrect),
//   - the legacy single-blob 'records' key is deleted (superseded layout).
// Resolves true when the sync completed, false when the tier is unavailable
// or the write failed (never rejects — fire-and-forget callers cannot
// await-catch meaningfully). Serialized through the write queue so a rapid
// save→save→reset sequence cannot reorder puts after a clear; a
// stale-generation sync (enqueued before a reset) is skipped entirely.
//
// READ-TRADEOFF: the stored-value reads are per-key gets issued ONLY for
// keys about to be written (never getAll): a deserialize replaces what was
// previously a multi-MB structured-clone PUT for every story on the first
// sync per page load, and each matching read immediately re-primes
// mirrorSignatures (committed on tx.oncomplete) so every later sync of the
// same payload takes the signature fast path with NO read and NO put. On a
// genuinely full origin the reads also cost nothing — the tx only reads the
// keys the sync would have rewritten anyway.
//
// OPEN HOISTED OUT OF THE QUEUE: openDatabase() is issued SYNCHRONOUSLY at
// call time and the queued op only awaits the ready connection. This keeps
// the sync's IndexedDB open() request ordered BEFORE any concurrent
// storyCacheGet() (recovery reads are NOT queued), so fake-indexeddb creates
// the sync's transaction first and the read observes the write. Queueing the
// open inside the op reversed that ordering and broke the store.test.ts
// "recover right after save" tests (the read raced ahead of the queued put).
export const storyCacheSet = (records: PersistableStoryEntryShape[]): Promise<boolean> => {
    const generation = queueGeneration;
    traceLog(`set enqueue gen=${generation} ids=${records.map((r) => r.storyId).join(',')}`);
    // Issue the open() synchronously; a failed open becomes a null db and the
    // queued op resolves false (same as the old catch path).
    const dbPromise = openDatabase().catch(() => null);
    return enqueue(() => {
        if (generation !== queueGeneration) {
            // A reset happened after this sync was enqueued — discard it.
            traceLog(`set SKIPPED gen=${generation} (current ${queueGeneration})`);
            return Promise.resolve(false);
        }
        return dbPromise.then((db) => {
            if (!db) return Promise.resolve(false);
            return new Promise<boolean>((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                // Zombie-tx watchdog (see armTxWatchdog): settle as "not
                // written" and abort the tx so the database's transaction
                // queue cannot deadlock behind it.
                const cancelWatchdog = armTxWatchdog(tx, () => resolve(false));
                const store = tx.objectStore(STORE_NAME);
                // First list the EXISTING per-story keys (source of
                // truth for both the skip check and orphan cleanup);
                // the read-modify-write decisions below are issued from
                // its onsuccess, inside the same transaction.
                const keysRequest = store.getAllKeys(storyKeyRange());
                keysRequest.onsuccess = () => {
                    const existingKeys = new Set((keysRequest.result as IDBValidKey[]).map((k) => String(k)));
                    const incomingKeys = new Set<string>();
                    // Fingerprints committed to mirrorSignatures on
                    // tx.oncomplete — for every entry this sync PUTS or
                    // skips after a stored-value comparison (identical
                    // payload ⇒ identical outcome, so the next sync takes
                    // the signature fast path with no read at all). A
                    // failed/aborted tx must not poison the skip cache.
                    const putFingerprints = new Map<string, string>();
                    const deleteIds: string[] = [];

                    // ── Phase 1: classify every incoming entry ──────────────
                    // Signature match + key exists → skip outright (the
                    // same-page fast path). Everything else is a PUT
                    // CANDIDATE and can still be skipped after reading the
                    // stored value (see the (a)/(b) notes in the header).
                    type PutCandidate = {
                        entry: PersistableStoryEntryShape;
                        fingerprint: string;
                        stored?: PersistableStoryEntryShape;
                    };
                    const putCandidates: PutCandidate[] = [];
                    records.forEach((entry) => {
                        const key = STORY_KEY_PREFIX + entry.storyId;
                        incomingKeys.add(key);
                        const fingerprint = storyCacheFingerprint(entry);
                        const unchanged =
                            existingKeys.has(key) && mirrorSignatures.get(entry.storyId) === fingerprint;
                        if (unchanged) return;
                        putCandidates.push({ entry, fingerprint });
                    });

                    // ── Phase 2: read the stored values the puts would overwrite ──
                    // Only keys that already exist are worth reading (a new
                    // key has nothing to compare); when every candidate is a
                    // new key — or there are no candidates at all — the
                    // writes issue immediately.
                    const issueWrites = () => {
                        putCandidates.forEach((candidate) => {
                            const key = STORY_KEY_PREFIX + candidate.entry.storyId;
                            const stored = candidate.stored;
                            if (stored) {
                                // (a) Cross-load change detection: the stored
                                // payload is provably identical → nothing to
                                // write, but DO commit the fingerprint so
                                // later syncs of the same payload skip
                                // without re-reading.
                                if (storyCacheFingerprint(stored) === candidate.fingerprint) {
                                    putFingerprints.set(candidate.entry.storyId, candidate.fingerprint);
                                    return;
                                }
                                // (b) Richer-wins never-downgrade: the incoming
                                // copy is metadata-only while the mirror
                                // holds chapters — keep the richer stored
                                // payload (the boot re-put used to destroy
                                // the only full copy).
                                if (candidate.entry.data == null && stored.data != null) {
                                    putFingerprints.set(candidate.entry.storyId, candidate.fingerprint);
                                    return;
                                }
                            }
                            putFingerprints.set(candidate.entry.storyId, candidate.fingerprint);
                            store.put(candidate.entry, key);
                        });
                        // Orphan cleanup: mirrored keys not present in the
                        // incoming full set belong to deleted stories.
                        existingKeys.forEach((key) => {
                            if (incomingKeys.has(key)) return;
                            deleteIds.push(key.slice(STORY_KEY_PREFIX.length));
                            store.delete(key);
                        });
                        // The pre-per-story blob is dead weight once the
                        // per-story keys exist — remove it on every sync.
                        store.delete(LEGACY_RECORDS_KEY);
                    };

                    const candidatesNeedingRead = putCandidates.filter((candidate) =>
                        existingKeys.has(STORY_KEY_PREFIX + candidate.entry.storyId)
                    );
                    if (candidatesNeedingRead.length === 0) {
                        issueWrites();
                    } else {
                        let pendingReads = candidatesNeedingRead.length;
                        candidatesNeedingRead.forEach((candidate) => {
                            const get = store.get(STORY_KEY_PREFIX + candidate.entry.storyId);
                            get.onsuccess = () => {
                                if (get.result) candidate.stored = get.result as PersistableStoryEntryShape;
                                pendingReads--;
                                if (pendingReads === 0) issueWrites();
                            };
                            get.onerror = () => {
                                cancelWatchdog();
                                reject(get.error ?? new Error('IndexedDB get failed'));
                            };
                        });
                    }
                    tx.oncomplete = () => {
                        // Commit the fingerprint changes only now — the tx
                        // provably landed.
                        putFingerprints.forEach((fingerprint, storyId) => mirrorSignatures.set(storyId, fingerprint));
                        deleteIds.forEach((storyId) => mirrorSignatures.delete(storyId));
                        cancelWatchdog();
                        db.close();
                        resolve(true);
                    };
                };
                keysRequest.onerror = () => {
                    cancelWatchdog();
                    reject(keysRequest.error ?? new Error('IndexedDB getAllKeys failed'));
                };
                tx.onerror = () => {
                    cancelWatchdog();
                    db.close();
                    reject(tx.error ?? new Error('IndexedDB put failed'));
                };
                tx.onabort = () => {
                    cancelWatchdog();
                    db.close();
                    reject(tx.error ?? new Error('IndexedDB put aborted'));
                };
            });
        });
        // Never rejects (documented contract): a rejected op would surface as
        // an unhandled rejection in the fire-and-forget mirror caller.
    }).catch(() => false);
};

// Purge the mirror (story deletion writes the emptied records array through
// the normal set path — its orphan cleanup deletes the story's key — so an
// explicit per-story delete is only needed for completeness).
// Same open-hoisting rationale as storyCacheSet above.
export const storyCacheClear = (): Promise<boolean> => {
    const dbPromise = openDatabase().catch(() => null);
    return enqueue(() =>
        dbPromise.then((db) => {
            if (!db) return Promise.resolve(false);
            return new Promise<boolean>((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                // Zombie-tx watchdog (see armTxWatchdog) — settle as "not
                // cleared" and abort so the tx queue cannot deadlock.
                const cancelWatchdog = armTxWatchdog(tx, () => resolve(false));
                const store = tx.objectStore(STORE_NAME);
                // Remove every per-story key AND the legacy blob key.
                store.delete(storyKeyRange());
                store.delete(LEGACY_RECORDS_KEY);
                tx.oncomplete = () => {
                    cancelWatchdog();
                    db.close();
                    resolve(true);
                };
                tx.onerror = () => {
                    cancelWatchdog();
                    db.close();
                    reject(tx.error ?? new Error('IndexedDB delete failed'));
                };
            });
        })
        // Never rejects (same contract as storyCacheSet).
    ).catch(() => false);
};

// Test isolation: vitest runs every test file in a fresh worker, but MULTIPLE
// tests within one file share the module — and beforeEach only clears
// localStorage. Expose an explicit reset so App.test.tsx's afterEach can wipe
// the fake IndexedDB database between tests (prevents a test's mirrored
// records from "recovering" into the next test's empty-localStorage boot).
// In the browser this is never called; the cache is meant to persist.
//
// HANG GUARD: the reset races the writeQueue with a timeout. A queued op
// stranded by a fake-timer teardown (vitest useFakeTimers/useRealTimers
// transitions — see the transaction watchdog above) would otherwise block
// the queue forever and time out the afterEach hook. With the watchdog the
// stranded op self-heals in ~STALL_WATCHDOG_MS (the tx is aborted and the
// queue unblocks), so the races below rarely engage; they remain as a
// backstop with generous margins.
export const storyCacheResetForTests = async (): Promise<void> => {
    // Bump the generation FIRST: every put enqueued before this point becomes
    // stale and is skipped when its turn in the queue arrives. This is the
    // PRIMARY protection — a pre-reset put can never write, no matter when
    // its queued op eventually runs (even minutes later after a queue stall).
    queueGeneration++;
    // Drop the mirror-signature cache: after a reset the store is empty, so
    // the next sync must re-put EVERY story even if its payload signature
    // matches a pre-reset mirror write (the keys no longer exist — the
    // existence half of the skip check covers this, but clearing keeps the
    // two structures in lockstep).
    mirrorSignatures.clear();
    traceLog(`reset begin gen=${queueGeneration}`);
    // Drain: wait for the current queue tail so the clear below runs after
    // every pending op. The writeQueue can STALL under fake-timer/act
    // conditions (the transaction watchdog above now aborts such stalls in
    // ~500ms, but a bail-out is kept as a backstop) — bailing here must NOT
    // be treated as "the queue is empty", only "stop waiting". The
    // direct-clear pass at the end handles whatever the queued clear missed.
    const drained = await Promise.race([
        writeQueue.catch(() => undefined).then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500))
    ]);
    traceLog(drained ? 'reset drain done (settled)' : 'reset drain BAILED (queue stalled)');
    // Clear + verify via the queue (in-order with any remaining ops).
    // GENERATION GUARD: the clear captures the post-bump generation. If a
    // LATER reset supersedes this one before the op runs (queue stall — the
    // drain bailed and this op is still parked in the old chain), the clear
    // must SKIP: an un-guarded late clear would wipe the NEXT test's mirror
    // writes (observed: store.test.ts recovery tests got null because the
    // previous test's stalled queued clear landed after their put). The
    // direct wipe below still guarantees emptiness for THIS reset.
    const clearGeneration = queueGeneration;
    const cleared = await Promise.race([
        enqueue(async () => {
            if (clearGeneration !== queueGeneration) {
                traceLog(`reset queued clear SKIPPED (gen ${clearGeneration} vs ${queueGeneration})`);
                return false;
            }
            try {
                for (let pass = 0; pass < 3; pass++) {
                    const db = await openDatabase();
                    await new Promise<void>((resolve, reject) => {
                        const tx = db.transaction(STORE_NAME, 'readwrite');
                        // Zombie-tx watchdog (see armTxWatchdog) — settle as
                        // done; the verification read below re-checks and
                        // re-clears on the next pass if the tx was aborted.
                        const cancelWatchdog = armTxWatchdog(tx, () => resolve());
                        tx.objectStore(STORE_NAME).clear();
                        tx.oncomplete = () => {
                            cancelWatchdog();
                            db.close();
                            resolve();
                        };
                        tx.onerror = () => {
                            cancelWatchdog();
                            db.close();
                            reject(tx.error ?? new Error('IndexedDB clear failed'));
                        };
                    });
                    // Let any straggler put microtask settle, then re-check.
                    await new Promise<void>((resolve) => setTimeout(resolve, 25));
                    const check = await storyCacheGet();
                    traceLog(
                        `reset pass ${pass}: ${check ? check.map((r) => r.storyId).join(',') : 'EMPTY'}`
                    );
                    if (!check || check.length === 0) return true;
                }
                return false;
            } catch {
                // No IndexedDB / already closed — nothing to reset.
                return true;
            }
        }),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000))
    ]);
    traceLog(cleared ? 'reset queued clear done' : 'reset queued clear BAILED');
    // Sever the queue: the remaining old-chain ops are all generation-stale
    // (skipped at run time), so dropping the chain is safe.
    writeQueue = Promise.resolve();
    // DIRECT final wipe (outside the queue): guarantees emptiness even when
    // the queued clear bailed or the queue stalled past the reset. Any put
    // that already completed before the generation bump is wiped here; any
    // put still pending in the old chain is generation-stale and skipped at
    // run time — so nothing can write after this pass.
    try {
        for (let pass = 0; pass < 3; pass++) {
            const db = await openDatabase();
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                // Zombie-tx watchdog (see armTxWatchdog).
                const cancelWatchdog = armTxWatchdog(tx, () => resolve());
                tx.objectStore(STORE_NAME).clear();
                tx.oncomplete = () => {
                    cancelWatchdog();
                    db.close();
                    resolve();
                };
                tx.onerror = () => {
                    cancelWatchdog();
                    db.close();
                    reject(tx.error ?? new Error('IndexedDB clear failed'));
                };
            });
            const check = await storyCacheGet();
            traceLog(
                `reset direct pass ${pass}: ${check ? check.map((r) => r.storyId).join(',') : 'EMPTY'}`
            );
            if (!check || check.length === 0) break;
        }
    } catch {
        // No IndexedDB — nothing to wipe.
    }
    traceLog('reset end');
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
