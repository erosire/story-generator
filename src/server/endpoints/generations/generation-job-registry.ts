// ---------------------------------------------------------------------------
// Story job registry — process-local, in-memory tracker for EVERY background
// generation thread (create, fork, append, resume, chapter re-expansion,
// chapter rewrite).
//
// Two responsibilities:
//
// 1. CONCURRENCY GUARD (unchanged contract, richer bookkeeping): every
//    fire-and-forget whole-story flow (create, fork, append, resume —
//    generation-create-new-story.ts handler) writes into the same
//    plotpoint.json. Two simultaneous writers (e.g. the user clicking the
//    dashboard's resume button while an original create is still streaming)
//    would interleave writes and corrupt the outline. `acquireStoryJob`
//    rejects a second EXCLUSIVE job for a storyId that already holds the
//    exclusive slot (caller answers 400 'already in progress') instead of
//    corrupting state.
//
// 2. LIVE JOB TRACKING: every active job is recorded with its storyId, kind,
//    and start timestamp. The collection endpoint (generation-list-stories.ts)
//    reads this registry so the dashboard sidebar can animate tiles for
//    stories with a background thread in flight — including jobs started by
//    ANOTHER session/device. Chapter-level flows (expand/rewrite —
//    generation-update-chapter.ts) register as NON-exclusive tracked jobs:
//    they never blocked other work before (no guard existed) and must keep
//    that behavior, so they are tracked for visibility only.
//
// Process-local by design (module-level Maps, no persistence): a server
// restart clears the registry — which is exactly when all in-flight jobs die
// too. A story whose job died with the restart (status 'generating' with
// partial chapters in plotpoint.json) is then resumable via the resume branch
// (generation-resume-story.ts). Restart → blank slate is the intended
// semantics, mirrored on the client by rehydrating serverProcessing=false.
//
// 3. USER-REQUESTED TERMINATION: requestStoryAbort lets a client kill the
//    active job(s) for a story (the dashboard's Terminate button) without
//    deleting the story folder. Background flows throw at their next
//    checkpoint; the abort flag clears with the last released job.
// ---------------------------------------------------------------------------

// The kinds of background work this registry tracks. Exclusive kinds hold the
// per-story write slot; tracked kinds are visibility-only.
export type StoryJobKind = 'create' | 'fork' | 'append' | 'resume' | 'expand' | 'rewrite';

// One active background job. Shape returned by the collection endpoint's
// `jobs` array (see generation-list-stories.ts) so any session can see every
// background thread currently running on the server.
export type StoryJob = {
    // Registry-assigned id, unique within the process lifetime
    // (`job-<sequence>` — the sequence resets on restart, which is fine
    // because the registry itself is blank on restart).
    jobId: string;
    // The story this job writes to.
    storyId: string;
    // Which background flow is running (drives UI copy like "Expanding…").
    kind: StoryJobKind;
    // ISO 8601 timestamp of when the job was registered.
    startedAt: string;
};

// Internal registry record: the public StoryJob shape plus an `exclusive`
// flag marking whether the job HOLDS the story's exclusive write slot. The
// flag — not the kind — decides what releaseStoryJob frees, so a tracked job
// can never accidentally release an exclusive slot it does not own.
type RegistryJob = StoryJob & { exclusive: boolean };

// All currently-registered jobs (exclusive + tracked), keyed by jobId.
const activeJobs = new Map<string, RegistryJob>();

// storyIds holding an EXCLUSIVE job slot (create/fork/append/resume). Kept as
// a separate set so the acquire guard is an O(1) lookup and so releasing a
// tracked (non-exclusive) job can never accidentally free a story slot it
// does not own.
const exclusiveStoryIds = new Set<string>();

// storyIds whose active job(s) the user asked to TERMINATE (the dashboard's
// Terminate button → PATCH abortJob → requestStoryAbort). In-memory abort
// signal only: background flows consult isStoryAborted at their existing
// checkpoint boundaries (assertStoryExists-style guards) and bail out by
// throwing, which retires the job via the standard .finally(releaseStoryJob).
// A streaming LLM call in flight is not interrupted mid-stream — the abort
// lands at the NEXT boundary (chapter loop iteration / post-call write), the
// same granularity the folder-deletion guard has always had. The flag is
// cleared by releaseStoryJob once NO active jobs remain for the story, so a
// terminated story is immediately resumable/expandable again.
const abortedStoryIds = new Set<string>();

// Monotonic jobId sequence — process-local, resets on restart together with
// the rest of the registry.
let jobSequence = 0;

/**
 * Try to acquire the EXCLUSIVE job slot for storyId (create/fork/append/resume).
 *
 * Returns the new job's jobId when the caller now owns the slot; null when
 * another exclusive job for the same storyId is already running (the caller
 * must answer 400 'already in progress'). The caller MUST pair the returned
 * jobId with `releaseStoryJob` via
 * `.finally(() => releaseStoryJob(jobId))` on the background promise so a
 * crashed job never wedges the story.
 *
 * Tracked-only jobs (expand/rewrite) do NOT block acquisition — the guard
 * protects plotpoint.json writers from each other, and chapter expansion
 * never held that guard before.
 */
export const acquireStoryJob = (storyId: string, kind: StoryJobKind = 'create'): string | null => {
    if (exclusiveStoryIds.has(storyId)) return null;
    jobSequence += 1;
    const job: RegistryJob = { jobId: `job-${jobSequence}`, storyId, kind, startedAt: new Date().toISOString(), exclusive: true };
    activeJobs.set(job.jobId, job);
    exclusiveStoryIds.add(storyId);
    return job.jobId;
};

/**
 * Register a NON-exclusive background job (expand/rewrite) for observability.
 *
 * Unlike acquireStoryJob this NEVER rejects: multiple chapter jobs may run
 * concurrently on the same story (matching the pre-registry behavior of
 * generation-update-chapter.ts, which fired expand/rewrite without any
 * guard). Returns the jobId the caller must pass to `releaseStoryJob` when
 * the background promise settles.
 */
export const trackStoryJob = (storyId: string, kind: StoryJobKind): string => {
    jobSequence += 1;
    const job: RegistryJob = { jobId: `job-${jobSequence}`, storyId, kind, startedAt: new Date().toISOString(), exclusive: false };
    activeJobs.set(job.jobId, job);
    return job.jobId;
};

/**
 * Release a job by its jobId (works for both exclusive and tracked jobs).
 * Releasing an exclusive job frees the story's exclusive slot; releasing a
 * tracked job only removes that one job entry — an exclusive slot on the
 * same story stays held.
 *
 * Abort-flag cleanup: when the LAST active job for the story is released,
 * any pending abort signal is cleared too — with nothing running there is
 * nothing left to abort, and a stale flag would make a future job for the
 * same storyId die on its first boundary check.
 */
export const releaseStoryJob = (jobId: string): void => {
    const job = activeJobs.get(jobId);
    if (!job) return;
    if (job.exclusive) exclusiveStoryIds.delete(job.storyId);
    activeJobs.delete(jobId);
    // No more active jobs for this story → the abort signal has nowhere left
    // to land; drop it so the next job starts clean.
    if (!isStoryJobActive(job.storyId)) {
        abortedStoryIds.delete(job.storyId);
    }
};

/**
 * Request termination of every active background job for storyId (the
 * dashboard's Terminate button). Marks the story aborted so the background
 * flow(s) bail out at their next checkpoint boundary (assertStoryExists-style
 * guards), then the standard .finally(releaseStoryJob) retires the job(s).
 *
 * Returns how many active jobs the abort targets: 0 means nothing was
 * running (the job may have finished between the UI's list sync and the
 * click) — the caller answers with a "no active job" message instead of
 * claiming success.
 */
export const requestStoryAbort = (storyId: string): number => {
    let activeCount = 0;
    for (const job of activeJobs.values()) {
        if (job.storyId === storyId) activeCount++;
    }
    // Only mark the abort when something is actually running; a no-op abort
    // must not poison a story that a NEW job might start a moment later.
    if (activeCount > 0) {
        abortedStoryIds.add(storyId);
    }
    return activeCount;
};

/**
 * True when storyId has a pending user-requested abort. Background flows
 * check this at their checkpoint boundaries (alongside the story-folder
 * existence guard) and throw to unwind the fire-and-forget promise.
 */
export const isStoryAborted = (storyId: string): boolean => abortedStoryIds.has(storyId);

/**
 * True when storyId has ANY active background job (exclusive or tracked).
 * This is the per-story flag the collection endpoint reports as
 * `processing` so the sidebar can animate the tile.
 */
export const isStoryJobActive = (storyId: string): boolean => {
    for (const job of activeJobs.values()) {
        if (job.storyId === storyId) return true;
    }
    return false;
};

/**
 * Snapshot of every active background job, oldest first. Served by the
 * collection endpoint (`jobs` array) — the "keep track of all background
 * threads" surface. Returns copies so callers cannot mutate registry state.
 */
export const getActiveStoryJobs = (): StoryJob[] =>
    [...activeJobs.values()]
        // Oldest first; jobId breaks ties for jobs registered in the same ms.
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.jobId.localeCompare(b.jobId))
        // Strip the internal `exclusive` flag — the wire shape is StoryJob
        // (the `kind` already tells the UI whether the job writes the story
        // outline or only a chapter payload).
        .map(({ jobId, storyId, kind, startedAt }) => ({ jobId, storyId, kind, startedAt }));
