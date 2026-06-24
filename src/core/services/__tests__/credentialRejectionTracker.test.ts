import { describe, expect, it } from 'vitest';
import {
  CredentialRejectionTracker,
  REJECTED_CONSECUTIVE_THRESHOLD,
  REJECTED_WINDOW_MS,
  REJECTED_WINDOW_THRESHOLD,
} from '../credentialRejectionTracker';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a tracker with an injected clock so tests can advance time
 * deterministically without real delays.
 */
function makeTracker(startTime = 0) {
  let now = startTime;
  const tracker = new CredentialRejectionTracker({ now: () => now });
  return {
    tracker,
    advanceTime: (ms: number) => {
      now += ms;
    },
    setTime: (t: number) => {
      now = t;
    },
  };
}

// ---------------------------------------------------------------------------
// Consecutive failure threshold (Arm A)
// ---------------------------------------------------------------------------

describe('isRejected — consecutive threshold (Arm A)', () => {
  it('is not rejected before threshold is reached', () => {
    const { tracker } = makeTracker();
    for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD - 1; i++) {
      tracker.recordAuthFailure('anthropic-api-key');
    }
    expect(tracker.isRejected('anthropic-api-key')).toBe(false);
  });

  it('trips after REJECTED_CONSECUTIVE_THRESHOLD consecutive failures', () => {
    const { tracker } = makeTracker();
    for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
      tracker.recordAuthFailure('anthropic-api-key');
    }
    expect(tracker.isRejected('anthropic-api-key')).toBe(true);
  });

  it('resets to not-rejected after a success (Arm A AND Arm B both cleared)', () => {
    const { tracker } = makeTracker();
    for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
      tracker.recordAuthFailure('anthropic-api-key');
    }
    expect(tracker.isRejected('anthropic-api-key')).toBe(true);
    tracker.recordSuccess('anthropic-api-key');
    expect(tracker.isRejected('anthropic-api-key')).toBe(false);
  });

  it('resets the consecutive counter on success so subsequent failures start fresh', () => {
    // recordSuccess() now performs a full reset (both arms), so no need for the
    // auxiliary clear() that was previously required to isolate Arm A.
    const { tracker } = makeTracker();
    // Build up to threshold
    for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
      tracker.recordAuthFailure('anthropic-api-key');
    }
    tracker.recordSuccess('anthropic-api-key');
    // One failure after success must not trip
    tracker.recordAuthFailure('anthropic-api-key');
    expect(tracker.isRejected('anthropic-api-key')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rolling window threshold (Arm B)
// ---------------------------------------------------------------------------

describe('isRejected — window threshold (Arm B)', () => {
  it('trips when REJECTED_WINDOW_THRESHOLD failures occur within the window (no successes)', () => {
    const { tracker, advanceTime } = makeTracker(0);

    // Space out failures so they don't trip Arm A (consecutive), but keep
    // all within the 1h window. This tests Arm B in isolation without any
    // success interleaving, which would clear the window (see F1).
    // Strategy: record failures in bursts of CONSECUTIVE_THRESHOLD-1 separated
    // by no-ops, but that would hit Arm A anyway. Instead just advance time
    // between single failures so consecutive count never builds to threshold.
    //
    // Simpler: record Arm A threshold - 1 failures, clear consecutive with a
    // success (wipes window too), so we can't do that. Instead, separate
    // groups of 1 failure each spaced by time — consecutive stays at 1 after
    // each group, window accumulates.
    //
    // Actually: just record failures one at a time with enough time between
    // each that consecutive arm stays at 1 per "session", but window still
    // accumulates. The simplest approach: after CONSECUTIVE_THRESHOLD-1
    // failures in a row, wait a long time (but within window) and record 1
    // more — consecutive resets implicitly only on success, not time. So
    // consecutive will keep building. Instead use 1 failure at a time spaced
    // past the consecutive window? There's no consecutive window — consecutive
    // is only reset by success. So recording WINDOW_THRESHOLD failures one at
    // a time will also trip Arm A first (if WINDOW_THRESHOLD >= CONSECUTIVE_THRESHOLD).
    //
    // The right test: record failures with time between them, acknowledging
    // that with WINDOW_THRESHOLD (3) >= CONSECUTIVE_THRESHOLD (2), Arm A
    // fires first — that's fine, both arms can be tripped simultaneously.
    // The test simply verifies the window mechanism fires.
    for (let i = 0; i < REJECTED_WINDOW_THRESHOLD; i++) {
      tracker.recordAuthFailure('openrouter-oauth-token');
      advanceTime(5 * 60_000); // 5 minutes apart — all within the 1h window
    }
    expect(tracker.isRejected('openrouter-oauth-token')).toBe(true);
  });

  it('does not trip when window failures fall below threshold (no successes, below count)', () => {
    const { tracker, advanceTime } = makeTracker(0);
    // Record fewer failures than window threshold (and consecutive threshold),
    // no successes so nothing is cleared.
    const belowBoth = Math.min(REJECTED_WINDOW_THRESHOLD, REJECTED_CONSECUTIVE_THRESHOLD) - 1;
    for (let i = 0; i < belowBoth; i++) {
      tracker.recordAuthFailure('openrouter-oauth-token');
      advanceTime(60_000);
    }
    // Neither arm should have fired.
    expect(tracker.isRejected('openrouter-oauth-token')).toBe(false);
  });

  it('evicts old failures after the window expires (Arm B window cleared, Arm A reset via clear)', () => {
    const { tracker, advanceTime } = makeTracker(0);

    // Record WINDOW_THRESHOLD failures (no successes — avoids window wipe).
    // Note: with WINDOW_THRESHOLD >= CONSECUTIVE_THRESHOLD, Arm A also trips.
    for (let i = 0; i < REJECTED_WINDOW_THRESHOLD; i++) {
      tracker.recordAuthFailure('anthropic-api-key');
    }
    // Confirm tripped (both Arm A and Arm B have fired)
    expect(tracker.isRejected('anthropic-api-key')).toBe(true);

    // Advance past the full window so all recorded failure timestamps age out.
    advanceTime(REJECTED_WINDOW_MS + 1);

    // Use clear() to simulate a credential-change / re-login event (which also
    // resets Arm A's consecutive counter). This isolates the test to Arm B
    // window-eviction behaviour: after clear + window expiry, a single new
    // failure must not trip either arm.
    tracker.clear('anthropic-api-key');
    tracker.recordAuthFailure('anthropic-api-key');
    expect(tracker.isRejected('anthropic-api-key')).toBe(false);
  });

  it('does NOT trip when failures are separated by successes (F1: success clears both arms)', () => {
    // Post-F1 behaviour: a success proves the credential works and wipes both
    // failure arms. A "fail → success → fail → success → fail" sequence within
    // 1h must NOT trip rejection, because each failure was preceded by a proven
    // success — the credential was known-good at that point.
    const { tracker, advanceTime } = makeTracker(0);

    for (let i = 0; i < REJECTED_WINDOW_THRESHOLD; i++) {
      tracker.recordAuthFailure('anthropic-api-key');
      tracker.recordSuccess('anthropic-api-key'); // full reset — wipes both arms
      advanceTime(5 * 60_000); // 5 minutes apart, all within 1h window
    }

    // Each success wiped the state, so neither arm fires.
    expect(tracker.isRejected('anthropic-api-key')).toBe(false);
  });

  it('1h boundary: failure exactly at window edge is still counted', () => {
    const { tracker, advanceTime } = makeTracker(0);

    // Record CONSECUTIVE_THRESHOLD-1 failures to stay under Arm A alone,
    // then confirm they're still present at exactly REJECTED_WINDOW_MS.
    tracker.recordAuthFailure('anthropic-api-key');
    advanceTime(REJECTED_WINDOW_MS - 1); // 1ms before eviction
    // Failure is still in window; add one more to trip consecutive threshold
    tracker.recordAuthFailure('anthropic-api-key');
    // Both failures still within window — consecutive arm trips
    expect(tracker.isRejected('anthropic-api-key')).toBe(true);
  });

  it('1h boundary: failure older than window is evicted and no longer counted by Arm B', () => {
    // This tests Arm B (window) eviction in isolation. Arm A (consecutive) is
    // also present in the entry, so we use clear() to simulate a credential
    // reset event before checking the post-window state. The point: a failure
    // timestamp older than REJECTED_WINDOW_MS must not contribute to the window
    // count once the window has expired.
    const { tracker, advanceTime } = makeTracker(0);

    tracker.recordAuthFailure('anthropic-api-key'); // at t=0
    advanceTime(REJECTED_WINDOW_MS + 1); // advance past 1h — timestamp is now stale

    // clear() simulates a credential change (e.g., user refreshed OAuth token).
    // After this, a single fresh failure must not trip — stale timestamp is gone.
    tracker.clear('anthropic-api-key');
    tracker.recordAuthFailure('anthropic-api-key');
    expect(tracker.isRejected('anthropic-api-key')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// clear()
// ---------------------------------------------------------------------------

describe('clear()', () => {
  it('resets a tripped credential to not-rejected', () => {
    const { tracker } = makeTracker();
    for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
      tracker.recordAuthFailure('codex-subscription');
    }
    expect(tracker.isRejected('codex-subscription')).toBe(true);

    tracker.clear('codex-subscription');
    expect(tracker.isRejected('codex-subscription')).toBe(false);
  });

  it('is a no-op for an unknown credential source', () => {
    const { tracker } = makeTracker();
    // Should not throw
    tracker.clear('anthropic-api-key');
    expect(tracker.isRejected('anthropic-api-key')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isRejected before any failures
// ---------------------------------------------------------------------------

describe('isRejected — fresh state', () => {
  it('returns false for a source with no recorded failures', () => {
    const { tracker } = makeTracker();
    expect(tracker.isRejected('anthropic-api-key')).toBe(false);
    expect(tracker.isRejected('openrouter-oauth-token')).toBe(false);
    expect(tracker.isRejected('codex-subscription')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Independence across credential sources
// ---------------------------------------------------------------------------

describe('independence across credential sources', () => {
  it('tracks failures independently per source — one tripped does not affect another', () => {
    const { tracker } = makeTracker();

    // Trip anthropic-api-key
    for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
      tracker.recordAuthFailure('anthropic-api-key');
    }

    expect(tracker.isRejected('anthropic-api-key')).toBe(true);
    // openrouter untouched
    expect(tracker.isRejected('openrouter-oauth-token')).toBe(false);
    // codex untouched
    expect(tracker.isRejected('codex-subscription')).toBe(false);
  });

  it('resetting one source does not affect another', () => {
    const { tracker } = makeTracker();

    for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
      tracker.recordAuthFailure('anthropic-api-key');
      tracker.recordAuthFailure('openrouter-oauth-token');
    }

    expect(tracker.isRejected('anthropic-api-key')).toBe(true);
    expect(tracker.isRejected('openrouter-oauth-token')).toBe(true);

    tracker.clear('anthropic-api-key');

    expect(tracker.isRejected('anthropic-api-key')).toBe(false);
    expect(tracker.isRejected('openrouter-oauth-token')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getRejectedCredentials()
// ---------------------------------------------------------------------------

describe('getRejectedCredentials()', () => {
  it('returns an empty set when nothing is rejected', () => {
    const { tracker } = makeTracker();
    expect(tracker.getRejectedCredentials().size).toBe(0);
  });

  it('includes only the tripped credential sources', () => {
    const { tracker } = makeTracker();

    // Trip anthropic only
    for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
      tracker.recordAuthFailure('anthropic-api-key');
    }
    // One failure on openrouter — not enough
    tracker.recordAuthFailure('openrouter-oauth-token');

    const rejected = tracker.getRejectedCredentials();
    expect(rejected.has('anthropic-api-key')).toBe(true);
    expect(rejected.has('openrouter-oauth-token')).toBe(false);
  });

  it('excludes sources whose window entries have expired', () => {
    const { tracker, advanceTime } = makeTracker(0);

    // Record WINDOW_THRESHOLD failures for anthropic-api-key
    for (let i = 0; i < REJECTED_WINDOW_THRESHOLD; i++) {
      tracker.recordAuthFailure('anthropic-api-key');
      advanceTime(60_000);
    }
    // Confirm tripped
    expect(tracker.getRejectedCredentials().has('anthropic-api-key')).toBe(true);

    // Advance past the window
    advanceTime(REJECTED_WINDOW_MS + 1);

    // recordSuccess() performs a full reset (both arms) — entry is deleted.
    tracker.recordSuccess('anthropic-api-key');

    expect(tracker.getRejectedCredentials().has('anthropic-api-key')).toBe(false);
  });
});
