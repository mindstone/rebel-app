/**
 * Credential Rejection Tracker — Circuit breaker for persistently-rejected API credentials.
 *
 * Tracks consecutive auth failures (HTTP 401) per credential source and trips a
 * "rejected" signal once the threshold is met. The signal is consumed by the
 * automation provider-readiness gate (evaluateProviderReadinessRule) to stop
 * doomed scheduled spawns without burning through quota or flooding logs.
 *
 * Thresholds are deliberately conservative: a transient 401 (network blip, clock
 * skew, short-lived token expiry) must NOT trip the gate. Two independent trips
 * are required — either N consecutive failures OR N failures within a rolling
 * time window.
 *
 * Pure class with injected clock for unit-testability. A module-level singleton
 * (`credentialRejectionTracker`) is exported for production use, consistent with
 * the `toolFailureTracker` and cooldown service patterns.
 *
 * SECURITY: This module must never log key material, token values, or credential
 * content — only the ProviderCredentialSource identifier (a classification string,
 * not a secret).
 */

import type { ProviderCredentialSource } from '@shared/types/providerRoute';

// ---------------------------------------------------------------------------
// Thresholds — named constants for easy tuning
// ---------------------------------------------------------------------------

/**
 * Number of *consecutive* auth failures required to trip the rejected state.
 * A single 401 is too easy to hit transiently; two in a row is a strong signal.
 */
export const REJECTED_CONSECUTIVE_THRESHOLD = 2;

/**
 * Number of auth failures within the rolling window required to trip the
 * rejected state (even if they are not strictly consecutive).
 */
export const REJECTED_WINDOW_THRESHOLD = 3;

/**
 * Rolling window duration in milliseconds. Failures older than this are
 * discarded from the window count.
 */
export const REJECTED_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// Internal state per credential source
// ---------------------------------------------------------------------------

interface CredentialFailureState {
  /** Number of consecutive auth failures (reset to 0 on any success). */
  consecutiveCount: number;
  /**
   * Timestamps (ms) of recent auth failures within the rolling window.
   * Old entries are pruned on each record/check.
   */
  recentFailureTimes: number[];
}

// ---------------------------------------------------------------------------
// Core tracker class (injectable clock for unit tests)
// ---------------------------------------------------------------------------

export class CredentialRejectionTracker {
  private readonly state = new Map<ProviderCredentialSource, CredentialFailureState>();
  private readonly now: () => number;

  constructor(options?: { now?: () => number }) {
    this.now = options?.now ?? (() => Date.now());
  }

  /**
   * Record an auth failure (HTTP 401 or equivalent credential-rejected error)
   * for the given credential source.
   */
  recordAuthFailure(credentialSource: ProviderCredentialSource): void {
    const ts = this.now();
    const entry = this._getOrCreate(credentialSource);
    entry.consecutiveCount++;
    entry.recentFailureTimes.push(ts);
    this._pruneWindow(entry, ts);
  }

  /**
   * Record a successful authenticated call. Fully resets the rejection state
   * for this credential source — both the consecutive counter (Arm A) and the
   * rolling-window timestamps (Arm B).
   *
   * A success proves the credential currently works. Preserving old failure
   * timestamps after a confirmed success would give stale evidence undue weight:
   * e.g. "fail, success, fail" within an hour should NOT look like the credential
   * is broken, because the success in the middle demonstrated it was working at
   * that point. Keeping window history across a success would silently accumulate
   * counts from before the credential was known-good, which is misleading for an
   * auth signal.
   *
   * Deliberate credential-change and login events use clear() directly. Both
   * recordSuccess() and clear() now guarantee a clean slate.
   */
  recordSuccess(credentialSource: ProviderCredentialSource): void {
    // Full reset: a success proves the credential works — wipe both arms.
    this.state.delete(credentialSource);
  }

  /**
   * Explicitly clear (reset) the rejection state for a credential source.
   * Stage 3 will call this on credential-change and login events so that a
   * fresh key is given a clean slate.
   */
  clear(credentialSource: ProviderCredentialSource): void {
    this.state.delete(credentialSource);
  }

  /**
   * Returns true when the credential is considered "persistently rejected":
   * either N consecutive failures, OR N failures within the rolling window.
   *
   * The two-arm design means:
   *   - Arm A (consecutive): catches "every call is failing right now".
   *   - Arm B (windowed): catches "keeps failing across restarts / retries"
   *     even when successes pepper the sequence.
   */
  isRejected(credentialSource: ProviderCredentialSource): boolean {
    const entry = this.state.get(credentialSource);
    if (!entry) return false;
    const ts = this.now();
    this._pruneWindow(entry, ts);
    return (
      entry.consecutiveCount >= REJECTED_CONSECUTIVE_THRESHOLD
      || entry.recentFailureTimes.length >= REJECTED_WINDOW_THRESHOLD
    );
  }

  /**
   * Returns the set of credential sources that are currently in the rejected
   * state. Intended for feeding into evaluateProviderReadinessRule as an
   * optional runtime-health argument.
   */
  getRejectedCredentials(): ReadonlySet<ProviderCredentialSource> {
    const ts = this.now();
    const result = new Set<ProviderCredentialSource>();
    for (const [source, entry] of this.state) {
      this._pruneWindow(entry, ts);
      if (
        entry.consecutiveCount >= REJECTED_CONSECUTIVE_THRESHOLD
        || entry.recentFailureTimes.length >= REJECTED_WINDOW_THRESHOLD
      ) {
        result.add(source);
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _getOrCreate(credentialSource: ProviderCredentialSource): CredentialFailureState {
    let entry = this.state.get(credentialSource);
    if (!entry) {
      entry = { consecutiveCount: 0, recentFailureTimes: [] };
      this.state.set(credentialSource, entry);
    }
    return entry;
  }

  /** Remove failure timestamps that are older than the rolling window. */
  private _pruneWindow(entry: CredentialFailureState, now: number): void {
    const cutoff = now - REJECTED_WINDOW_MS;
    entry.recentFailureTimes = entry.recentFailureTimes.filter((t) => t >= cutoff);
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton for production use
// ---------------------------------------------------------------------------

/**
 * Singleton tracker instance. Import and call directly from the turn-execution
 * pipeline (Stage 3) and the scheduler (Stage 4).
 */
export const credentialRejectionTracker = new CredentialRejectionTracker();
