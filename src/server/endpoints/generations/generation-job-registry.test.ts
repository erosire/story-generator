/**
 * @vitest-environment node
 * Pure module-level registry tests — no DOM needed. The registry is
 * process-local state, so every test fully drains it (release/track pairs)
 * to keep the suite order-independent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    acquireStoryJob,
    getActiveStoryJobs,
    isStoryAborted,
    isStoryJobActive,
    releaseStoryJob,
    requestStoryAbort,
    trackStoryJob
} from './generation-job-registry';

// Freeze time so `startedAt` is an exact, assertable ISO string.
const FROZEN_NOW = new Date('2026-08-29T12:00:00.000Z');

describe('generation-job-registry', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(FROZEN_NOW);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('acquireStoryJob registers an exclusive job and returns its jobId', () => {
        const jobId = acquireStoryJob('story-a', 'create');
        expect(jobId).toBe('job-1');

        expect(isStoryJobActive('story-a')).toBe(true);
        expect(getActiveStoryJobs()).toEqual([
            { jobId: 'job-1', storyId: 'story-a', kind: 'create', startedAt: '2026-08-29T12:00:00.000Z' }
        ]);

        releaseStoryJob(jobId!);
    });

    it('rejects a second exclusive job for the same storyId', () => {
        const first = acquireStoryJob('story-b', 'create');
        expect(first).toBe('job-2');

        // Every exclusive kind is rejected while the slot is held.
        expect(acquireStoryJob('story-b', 'create')).toBeNull();
        expect(acquireStoryJob('story-b', 'fork')).toBeNull();
        expect(acquireStoryJob('story-b', 'append')).toBeNull();
        expect(acquireStoryJob('story-b', 'resume')).toBeNull();

        // Only ONE job is registered — the rejected attempts add nothing.
        expect(getActiveStoryJobs()).toEqual([
            { jobId: 'job-2', storyId: 'story-b', kind: 'create', startedAt: '2026-08-29T12:00:00.000Z' }
        ]);

        releaseStoryJob(first!);
    });

    it('allows exclusive jobs for different storyIds in parallel', () => {
        const a = acquireStoryJob('story-c', 'create');
        const b = acquireStoryJob('story-d', 'append');
        expect(a).toBe('job-3');
        expect(b).toBe('job-4');
        expect(isStoryJobActive('story-c')).toBe(true);
        expect(isStoryJobActive('story-d')).toBe(true);

        releaseStoryJob(a!);
        releaseStoryJob(b!);
    });

    it('releasing the jobId frees the exclusive slot for reacquisition', () => {
        const first = acquireStoryJob('story-e', 'resume');
        expect(first).toBe('job-5');

        releaseStoryJob(first!);
        expect(isStoryJobActive('story-e')).toBe(false);
        expect(getActiveStoryJobs()).toEqual([]);

        // The slot is free again — a new job gets the NEXT sequence number.
        const second = acquireStoryJob('story-e', 'resume');
        expect(second).toBe('job-6');
        releaseStoryJob(second!);
    });

    it('releasing an unknown jobId is a no-op', () => {
        expect(() => releaseStoryJob('job-does-not-exist')).not.toThrow();
        expect(getActiveStoryJobs()).toEqual([]);
    });

    it('trackStoryJob registers a non-exclusive job and never rejects', () => {
        const a = trackStoryJob('story-f', 'expand');
        const b = trackStoryJob('story-f', 'rewrite');
        expect(a).toBe('job-7');
        expect(b).toBe('job-8');

        // Both tracked jobs are visible; oldest first (same frozen timestamp,
        // so jobId order breaks the tie).
        expect(getActiveStoryJobs()).toEqual([
            { jobId: 'job-7', storyId: 'story-f', kind: 'expand', startedAt: '2026-08-29T12:00:00.000Z' },
            { jobId: 'job-8', storyId: 'story-f', kind: 'rewrite', startedAt: '2026-08-29T12:00:00.000Z' }
        ]);

        releaseStoryJob(a);
        releaseStoryJob(b);
    });

    it('tracked jobs do not block exclusive acquisition (pre-registry expand/rewrite behavior)', () => {
        const tracked = trackStoryJob('story-g', 'expand');
        expect(tracked).toBe('job-9');

        // An exclusive job MAY still be acquired while a tracked job runs —
        // the guard only protects plotpoint.json writers from each other.
        const exclusive = acquireStoryJob('story-g', 'create');
        expect(exclusive).toBe('job-10');

        // Releasing the tracked job must NOT free the exclusive slot.
        releaseStoryJob(tracked);
        expect(isStoryJobActive('story-g')).toBe(true);

        // Releasing the exclusive job frees it.
        releaseStoryJob(exclusive!);
        expect(isStoryJobActive('story-g')).toBe(false);
        expect(getActiveStoryJobs()).toEqual([]);
    });

    it('releasing an exclusive job keeps tracked jobs on the same story alive', () => {
        const tracked = trackStoryJob('story-h', 'rewrite');
        const exclusive = acquireStoryJob('story-h', 'create');
        expect(exclusive).toBe('job-12');

        releaseStoryJob(exclusive!);
        // The tracked rewrite is still running — the story stays processing.
        expect(isStoryJobActive('story-h')).toBe(true);
        expect(getActiveStoryJobs()).toEqual([
            { jobId: 'job-11', storyId: 'story-h', kind: 'rewrite', startedAt: '2026-08-29T12:00:00.000Z' }
        ]);

        releaseStoryJob(tracked);
        expect(getActiveStoryJobs()).toEqual([]);
    });

    it('snapshot is a copy — mutating it does not touch the registry', () => {
        const jobId = acquireStoryJob('story-i', 'fork');
        const snapshot = getActiveStoryJobs();
        snapshot.pop();
        expect(getActiveStoryJobs()).toHaveLength(1);
        releaseStoryJob(jobId!);
    });

    it('isStoryJobActive is false for unknown stories', () => {
        expect(isStoryJobActive('story-never-registered')).toBe(false);
    });

    // ── Abort (user-requested Terminate) ─────────────────────────────────
    it('requestStoryAbort marks an active job aborted and reports the targeted count', () => {
        const jobId = acquireStoryJob('story-abort-1', 'create');
        expect(jobId).not.toBeNull();

        expect(isStoryAborted('story-abort-1')).toBe(false);
        expect(requestStoryAbort('story-abort-1')).toBe(1);
        expect(isStoryAborted('story-abort-1')).toBe(true);

        releaseStoryJob(jobId!);
    });

    it('requestStoryAbort counts BOTH exclusive and tracked jobs on the story', () => {
        const exclusive = acquireStoryJob('story-abort-2', 'append');
        const tracked = trackStoryJob('story-abort-2', 'expand');

        // 2 active jobs → the abort targets both.
        expect(requestStoryAbort('story-abort-2')).toBe(2);
        expect(isStoryAborted('story-abort-2')).toBe(true);

        releaseStoryJob(exclusive!);
        releaseStoryJob(tracked);
    });

    it('requestStoryAbort for a story with no active job is a no-op (returns 0, flag NOT set)', () => {
        // A no-op abort must not poison a story that a NEW job might start a
        // moment later — the flag is only set when something is running.
        expect(requestStoryAbort('story-abort-idle')).toBe(0);
        expect(isStoryAborted('story-abort-idle')).toBe(false);
    });

    it('releaseStoryJob clears the abort flag once the LAST job for the story is gone', () => {
        const first = trackStoryJob('story-abort-3', 'expand');
        const second = trackStoryJob('story-abort-3', 'rewrite');
        expect(requestStoryAbort('story-abort-3')).toBe(2);

        // First job released → another job still runs → the abort flag STAYS
        // (the surviving flow must still observe the termination request).
        releaseStoryJob(first);
        expect(isStoryJobActive('story-abort-3')).toBe(true);
        expect(isStoryAborted('story-abort-3')).toBe(true);

        // Last job released → nothing left to abort → the flag clears so the
        // story is immediately resumable/expandable again.
        releaseStoryJob(second);
        expect(isStoryJobActive('story-abort-3')).toBe(false);
        expect(isStoryAborted('story-abort-3')).toBe(false);
    });

    it('an exclusive job released while a tracked job runs keeps the abort flag alive', () => {
        const tracked = trackStoryJob('story-abort-4', 'rewrite');
        const exclusive = acquireStoryJob('story-abort-4', 'create');
        expect(requestStoryAbort('story-abort-4')).toBe(2);

        releaseStoryJob(exclusive!);
        // The tracked rewrite still runs — the abort signal must survive.
        expect(isStoryAborted('story-abort-4')).toBe(true);

        releaseStoryJob(tracked);
        expect(isStoryAborted('story-abort-4')).toBe(false);
    });

    it('abort flags are story-scoped — aborting one story does not touch another', () => {
        const a = acquireStoryJob('story-abort-5', 'create');
        const b = acquireStoryJob('story-abort-6', 'create');

        expect(requestStoryAbort('story-abort-5')).toBe(1);
        expect(isStoryAborted('story-abort-5')).toBe(true);
        expect(isStoryAborted('story-abort-6')).toBe(false);

        releaseStoryJob(a!);
        releaseStoryJob(b!);
    });
});
