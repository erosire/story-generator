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
const traceLog = (message: string): void => {
    if (process.env.STORY_CACHE_TRACE !== '1') return;
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

// Last-mirrored payload signature per storyId — the change detector that lets
// storyCacheSet skip re-putting stories whose data did not change (a poll tick
// for ONE story must not rewrite the other stories' mirror entries). Paired
// with the ACTUAL key listing from getAllKeys: a signature match only skips
// the put when the key still exists in IndexedDB, so a wiped mirror self-heals
// on the next sync.
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
                    const store = tx.objectStore(STORE_NAME);
                    const keysRequest = store.getAllKeys(storyKeyRange());
                    keysRequest.onsuccess = () => {
                        const keys = keysRequest.result as IDBValidKey[];
                        if (keys.length === 0) {
                            // No per-story keys → try the legacy single-blob key.
                            const legacy = store.get(LEGACY_RECORDS_KEY);
                            legacy.onsuccess = () => {
                                db.close();
                                resolve(legacy.result ?? null);
                            };
                            legacy.onerror = () => {
                                db.close();
                                reject(legacy.error ?? new Error('IndexedDB legacy get failed'));
                            };
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
                                if (pending === 0) {
                                    db.close();
                                    resolve(results);
                                }
                            };
                            get.onerror = () => {
                                db.close();
                                reject(get.error ?? new Error('IndexedDB get failed'));
                            };
                        });
                    };
                    keysRequest.onerror = () => {
                        db.close();
                        reject(keysRequest.error ?? new Error('IndexedDB getAllKeys failed'));
                    };
                })
        )
        .catch(() => null);

// Write/sync the records payload — PER STORY. The caller (saveRecordsToStorage)
// always passes the COMPLETE records array, so this is a full-set sync:
//   - each entry is put under its own 'story:<storyId>' key,
//   - entries whose serialized payload did not change AND whose key still
//     exists in IndexedDB are SKIPPED (a poll tick for one story must not
//     rewrite the other stories' mirror entries),
//   - previously-mirrored story keys ABSENT from the array are DELETED
//     (the story was removed — e.g. deleteStory — so it must not resurrect),
//   - the legacy single-blob 'records' key is deleted (superseded layout).
// Resolves true when the sync completed, false when the tier is unavailable
// or the write failed (never rejects — fire-and-forget callers cannot
// await-catch meaningfully). Serialized through the write queue so a rapid
// save→save→reset sequence cannot reorder puts after a clear; a
// stale-generation sync (enqueued before a reset) is skipped entirely.
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
        return dbPromise.then(
            (db) =>
                db
                    ? new Promise<boolean>((resolve, reject) => {
                          const tx = db.transaction(STORE_NAME, 'readwrite');
                          const store = tx.objectStore(STORE_NAME);
                          // First list the EXISTING per-story keys (source of
                          // truth for both the skip check and orphan cleanup);
                          // all puts/deletes are issued from its onsuccess,
                          // inside the same transaction.
                          const keysRequest = store.getAllKeys(storyKeyRange());
                          keysRequest.onsuccess = () => {
                              const existingKeys = new Set(
                                  (keysRequest.result as IDBValidKey[]).map((k) => String(k))
                              );
                              const incomingKeys = new Set<string>();
                              records.forEach((entry) => {
                                  const key = STORY_KEY_PREFIX + entry.storyId;
                                  incomingKeys.add(key);
                                  const signature = JSON.stringify(entry);
                                  const unchanged =
                                      existingKeys.has(key) && mirrorSignatures.get(entry.storyId) === signature;
                                  mirrorSignatures.set(entry.storyId, signature);
                                  if (unchanged) return;
                                  store.put(entry, key);
                              });
                              // Orphan cleanup: mirrored keys not present in the
                              // incoming full set belong to deleted stories.
                              existingKeys.forEach((key) => {
                                  if (incomingKeys.has(key)) return;
                                  mirrorSignatures.delete(key.slice(STORY_KEY_PREFIX.length));
                                  store.delete(key);
                              });
                              // The pre-per-story blob is dead weight once the
                              // per-story keys exist — remove it on every sync.
                              store.delete(LEGACY_RECORDS_KEY);
                          };
                          keysRequest.onerror = () => {
                              reject(keysRequest.error ?? new Error('IndexedDB getAllKeys failed'));
                          };
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
                    : Promise.resolve(false)
        );
    });
};

// Purge the mirror (story deletion writes the emptied records array through
// the normal set path — its orphan cleanup deletes the story's key — so an
// explicit per-story delete is only needed for completeness).
// Same open-hoisting rationale as storyCacheSet above.
export const storyCacheClear = (): Promise<boolean> => {
    const dbPromise = openDatabase().catch(() => null);
    return enqueue(() =>
        dbPromise.then(
            (db) =>
                db
                    ? new Promise<boolean>((resolve, reject) => {
                          const tx = db.transaction(STORE_NAME, 'readwrite');
                          const store = tx.objectStore(STORE_NAME);
                          // Remove every per-story key AND the legacy blob key.
                          store.delete(storyKeyRange());
                          store.delete(LEGACY_RECORDS_KEY);
                          tx.oncomplete = () => {
                              db.close();
                              resolve(true);
                          };
                          tx.onerror = () => {
                              db.close();
                              reject(tx.error ?? new Error('IndexedDB delete failed'));
                          };
                      })
                    : Promise.resolve(false)
        )
    );
};

// Test isolation: vitest runs every test file in a fresh worker, but MULTIPLE
// tests within one file share the module — and beforeEach only clears
// localStorage. Expose an explicit reset so App.test.tsx's afterEach can wipe
// the fake IndexedDB database between tests (prevents a test's mirrored
// records from "recovering" into the next test's empty-localStorage boot).
// In the browser this is never called; the cache is meant to persist.
//
// HANG GUARD: the reset races the writeQueue with a 2s timeout. A queued put
// whose completion was swallowed by a fake-timer teardown (vitest
// useFakeTimers/useRealTimers transitions) would otherwise block the queue
// forever and time out the afterEach hook.
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
    // every pending op. The writeQueue can STALL for seconds under
    // fake-timer/act conditions (observed ~3.2s stalls in App.test.tsx's
    // fake-timer tests), so the bail-out here must NOT be treated as "the
    // queue is empty" — it only means "stop waiting". The direct-clear pass
    // at the end handles whatever the queued clear missed.
    const drained = await Promise.race([
        writeQueue.catch(() => undefined).then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000))
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
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000))
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
