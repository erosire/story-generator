// ---------------------------------------------------------------------------
// Story job registry — process-local guard against CONCURRENT background
// generation jobs on the SAME storyId.
//
// Why this exists: every fire-and-forget background flow (create, append,
// fork, resume — generation-create-new-story.ts handler) writes into the
// same plotpoint.json. Two simultaneous writers (e.g. the user clicking the
// dashboard's resume button while an original create is still streaming)
// would interleave writes and corrupt the outline. The registry lets each
// handler reject a second job for a storyId that already has one in flight
// (400 'already in progress') instead of corrupting state.
//
// Process-local by design: a server restart clears the registry — which is
// exactly when all in-flight jobs die too. A story whose job died with the
// restart (status 'generating' with partial chapters in plotpoint.json) is
// then resumable via the resume branch (generation-resume-story.ts).
// ---------------------------------------------------------------------------

// storyIds with a currently-running background job.
const activeStoryJobs = new Set<string>();

/**
 * Try to register storyId as having an active background job.
 * Returns true when the caller now owns the job slot; false when another
 * job for the same storyId is already running.
 */
export const acquireStoryJob = (storyId: string): boolean => {
    if (activeStoryJobs.has(storyId)) return false;
    activeStoryJobs.add(storyId);
    return true;
};

/**
 * Release the job slot for storyId. Always pair with acquireStoryJob via
 * `.finally(() => releaseStoryJob(storyId))` on the background promise so a
 * crashed job never wedges the story.
 */
export const releaseStoryJob = (storyId: string): void => {
    activeStoryJobs.delete(storyId);
};
