/**
 * Stage 1 (260502): watchdog level-1 Sentry-capture gate — typed-predicate
 * path coverage plus F17 (lens-testability) integration coverage for the
 * rawStreamTracker contract that the executor relies on.
 *
 * Scoping decision (per Stage 1 packet): `executeAgentTurn` is heavyweight —
 * wiring a full executor harness (model client, MCP, settings, IPC, registry,
 * tool registry, plugin pre-turn, etc.) for one gate test would dwarf the test
 * itself in setup. The packet explicitly authorises scoping to verifying the
 * gate's decision via the watchdog tracker callback path. This file does
 * exactly that:
 *
 *   (a) builds the same `rawStreamTracker` shape and the same
 *       `onStreamActivity` callback the executor wires,
 *   (b) exercises the same gate-suppression decision the executor's setInterval
 *       tick computes.
 *
 * The full canonical-event-type-derived parameterised suite that walks every
 * Anthropic SDK delta type and every documented OpenAI Responses event type
 * lives in `watchdogTracker.test.ts` (typed-predicate coverage) and
 * `runtimeActivity.test.ts` (mapper coverage).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { shouldSuppressLevel1WatchdogCapture, isStreamCompletedLifecycle } from '../watchdogTracker';
import {
  mapAnthropicStreamEvent,
  mapOpenAIChatChunk,
  mapOpenAIResponsesEvent,
  serializeRuntimeActivityForTelemetry,
  type RuntimeActivityEvent,
} from '@core/rebelCore/runtimeActivity';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  UNMAPPED_RUNTIME_ACTIVITY_OBSERVED_CAP,
  recordUnmappedActivityObservationOnce,
  __resetUnmappedActivityObservedForTests,
} from '../agentTurnExecutor';

interface RawStreamTracker {
  lastActivity: RuntimeActivityEvent | null;
  lastEventType: string | null;
  lastTimestamp: number | null;
  eventCount: number;
  /**
   * Stage B / F1 attempt boundary. Mirrors the executor's
   * `RawStreamTrackerState.streamCompletionSupersededByNewAttempt` so this test
   * exercises the exact same combined-gate decision the executor computes.
   */
  streamCompletionSupersededByNewAttempt: boolean;
}

function makeRawStreamTracker(): RawStreamTracker {
  return {
    lastActivity: null,
    lastEventType: null,
    lastTimestamp: null,
    eventCount: 0,
    streamCompletionSupersededByNewAttempt: false,
  };
}

function makeOnStreamActivity(tracker: RawStreamTracker, now: () => number) {
  return (event: RuntimeActivityEvent): void => {
    tracker.lastActivity = event;
    tracker.lastEventType = serializeRuntimeActivityForTelemetry(event);
    tracker.lastTimestamp = now();
    tracker.eventCount++;
    // Mirror the executor's onStreamActivity: any real stream event clears the
    // attempt-boundary flag (a fresh terminal completion opens a NEW legitimate
    // post-completion window for the attempt that just produced this event).
    tracker.streamCompletionSupersededByNewAttempt = false;
  };
}

/**
 * Mirrors the executor's new-attempt dispatch boundary: the continuation loop
 * emits a `routing:model:` status BEFORE `runAgentLoop` for each iteration,
 * which the executor's onMessage observes to mark any pending terminal
 * completion as superseded by the newly-dispatched attempt.
 */
function markNewAttemptDispatched(tracker: RawStreamTracker): void {
  tracker.streamCompletionSupersededByNewAttempt = true;
}

function evaluateGate(tracker: RawStreamTracker): boolean {
  return shouldSuppressLevel1WatchdogCapture(tracker.lastActivity);
}

describe('agentTurnExecutor watchdog gate — typed RuntimeActivityEvent path', () => {
  let tracker: RawStreamTracker;
  let onStreamActivity: (event: RuntimeActivityEvent) => void;
  let nowMs = 1_700_000_000_000;

  beforeEach(() => {
    tracker = makeRawStreamTracker();
    nowMs = 1_700_000_000_000;
    onStreamActivity = makeOnStreamActivity(tracker, () => nowMs);
  });

  it('updates rawStreamTracker.lastActivity from typed callback', () => {
    onStreamActivity({ kind: 'token-delta', subkind: 'text', rawEventType: 'text_delta' });
    expect(tracker.lastActivity).toEqual({
      kind: 'token-delta', subkind: 'text', rawEventType: 'text_delta',
    });
    expect(tracker.eventCount).toBe(1);
    expect(tracker.lastTimestamp).toBe(nowMs);
  });

  it('serialises lastEventType to the exact raw provider string (F3 — round-trip)', () => {
    const cases: RuntimeActivityEvent[] = [
      { kind: 'token-delta', subkind: 'text', rawEventType: 'text_delta' },
      { kind: 'token-delta', subkind: 'thinking', rawEventType: 'thinking_delta' },
      { kind: 'token-delta', subkind: 'tool-input', rawEventType: 'input_json_delta' },
      { kind: 'lifecycle', subkind: 'message-start', rawEventType: 'message_start' },
      { kind: 'token-delta', subkind: 'text', rawEventType: 'response.output_text.delta' },
      {
        kind: 'token-delta', subkind: 'tool-input',
        rawEventType: 'response.function_call_arguments.delta',
      },
      { kind: 'lifecycle', subkind: 'chat-chunk-final', rawEventType: 'chat.completion.chunk' },
      { kind: 'unknown', rawEventType: 'vendor.unknown.event' },
    ];
    for (const event of cases) {
      const local = makeRawStreamTracker();
      const cb = makeOnStreamActivity(local, () => nowMs);
      cb(event);
      expect(local.lastEventType).toBe(event.rawEventType);
    }
  });

  it('gate suppresses level-1 capture for token-delta activities', () => {
    onStreamActivity({ kind: 'token-delta', subkind: 'text', rawEventType: 'text_delta' });
    expect(evaluateGate(tracker)).toBe(true);
    onStreamActivity({ kind: 'token-delta', subkind: 'thinking', rawEventType: 'thinking_delta' });
    expect(evaluateGate(tracker)).toBe(true);
    onStreamActivity({
      kind: 'token-delta', subkind: 'tool-input', rawEventType: 'input_json_delta',
    });
    expect(evaluateGate(tracker)).toBe(true);
  });

  it('gate fires (does NOT suppress) for lifecycle activities', () => {
    onStreamActivity({ kind: 'lifecycle', subkind: 'message-start', rawEventType: 'message_start' });
    expect(evaluateGate(tracker)).toBe(false);
    onStreamActivity({
      kind: 'lifecycle', subkind: 'response-completed', rawEventType: 'response.completed',
    });
    expect(evaluateGate(tracker)).toBe(false);
    onStreamActivity({
      kind: 'lifecycle', subkind: 'chat-chunk-final', rawEventType: 'chat.completion.chunk',
    });
    expect(evaluateGate(tracker)).toBe(false);
  });

  it('gate fires (does NOT suppress) for unknown activities — fail-closed', () => {
    onStreamActivity({ kind: 'unknown', rawEventType: 'vendor.unknown.event' });
    expect(evaluateGate(tracker)).toBe(false);
  });

  it('gate fires (does NOT suppress) when no activity has been recorded', () => {
    expect(evaluateGate(tracker)).toBe(false);
  });
});

// ============================================================================
// Stage B (260623): phantom-stall fix — the COMBINED level-1 capture gate that
// the executor computes at agentTurnExecute.ts:~6081:
//   shouldSuppressLevel1WatchdogCapture(lastActivity)
//     || isStreamCompletedLifecycle(lastActivity)
// After the model stream finishes (message_stop / response.completed / final
// chat chunk) but before clearInterval, the watchdog keeps ticking and would
// fire a FALSE level-1 stall. The combined gate must suppress that, while still
// firing for a genuine pre-first-token stall (null) and a genuine mid-stream
// stall (non-terminal lifecycle).
// ============================================================================
function combinedGateSuppresses(tracker: RawStreamTracker): boolean {
  // Mirrors agentTurnExecute.ts: the `isStreamCompletedLifecycle` arm is gated
  // by `!streamCompletionSupersededByNewAttempt` (Stage B / F1), the token-delta
  // arm is not.
  return (
    shouldSuppressLevel1WatchdogCapture(tracker.lastActivity)
    || (
      !tracker.streamCompletionSupersededByNewAttempt
      && isStreamCompletedLifecycle(tracker.lastActivity)
    )
  );
}

describe('agentTurnExecutor watchdog gate — combined phantom-stall suppression (Stage B)', () => {
  let tracker: RawStreamTracker;
  let onStreamActivity: (event: RuntimeActivityEvent) => void;
  let nowMs = 1_700_000_000_000;

  beforeEach(() => {
    tracker = makeRawStreamTracker();
    nowMs = 1_700_000_000_000;
    onStreamActivity = makeOnStreamActivity(tracker, () => nowMs);
  });

  it('SUPPRESSES after Anthropic message_stop (phantom post-stream window)', () => {
    onStreamActivity(mapAnthropicStreamEvent({ type: 'message_stop' } as unknown as RawMessageStreamEvent));
    expect(tracker.lastActivity).toEqual({
      kind: 'lifecycle', subkind: 'message-stop', rawEventType: 'message_stop',
    });
    expect(combinedGateSuppresses(tracker)).toBe(true);
  });

  it('SUPPRESSES after OpenAI Responses response.completed', () => {
    onStreamActivity(mapOpenAIResponsesEvent('response.completed'));
    expect(combinedGateSuppresses(tracker)).toBe(true);
  });

  it('SUPPRESSES after final OpenAI chat chunk', () => {
    onStreamActivity(mapOpenAIChatChunk({ choices: [{ finish_reason: 'stop' }] }));
    expect(combinedGateSuppresses(tracker)).toBe(true);
  });

  it('STILL FIRES for a pre-first-token stall (null lastActivity)', () => {
    expect(combinedGateSuppresses(tracker)).toBe(false);
  });

  it('STILL FIRES for a mid-stream stall — non-terminal lifecycle (load-bearing negative)', () => {
    onStreamActivity(mapOpenAIResponsesEvent('response.in_progress'));
    expect(combinedGateSuppresses(tracker)).toBe(false);
    onStreamActivity(mapAnthropicStreamEvent(
      { type: 'content_block_start' } as unknown as RawMessageStreamEvent,
    ));
    expect(combinedGateSuppresses(tracker)).toBe(false);
  });

  it('STILL SUPPRESSES for token-delta via the existing predicate (regression guard)', () => {
    onStreamActivity({ kind: 'token-delta', subkind: 'text', rawEventType: 'text_delta' });
    expect(combinedGateSuppresses(tracker)).toBe(true);
    // ...and the new predicate alone does NOT claim it (separation of concerns)
    expect(isStreamCompletedLifecycle(tracker.lastActivity)).toBe(false);
  });
});

// ============================================================================
// Stage B / F1 (260623): MULTI-ATTEMPT over-suppression regression (F2).
//
// `rawStreamTracker.lastActivity` is TURN-scoped, not stream-ATTEMPT-scoped:
// it is created once per `executeAgentTurn` and is NOT reset when
// `rebelCoreQuery`/`runAgentLoop` continues into a NEW model-stream attempt
// (Stop-hook continuation, task-board continuation, output-cap/retry chain).
//
// Hole the original Stage B fix left open: attempt 1 ends with a terminal
// completion (`message-stop`) → a continuation dispatches attempt 2 → attempt 2
// stalls BEFORE its first byte. Without an attempt boundary, `lastActivity` is
// STILL attempt 1's terminal event, so `isStreamCompletedLifecycle` returns
// true and the combined gate WRONGLY suppresses the genuine pre-first-byte
// stall on attempt 2 — exactly the pre-first-token class that MUST still fire.
//
// Fix: a separate `streamCompletionSupersededByNewAttempt` flag, set at the
// new-attempt dispatch boundary (the per-iteration `routing:model:` status the
// continuation loop emits before `runAgentLoop`) and cleared by the first real
// stream event of the new attempt. The combined gate ANDs
// `!streamCompletionSupersededByNewAttempt` onto the `isStreamCompletedLifecycle`
// arm only.
// ============================================================================
describe('agentTurnExecutor watchdog gate — multi-attempt over-suppression (Stage B / F1)', () => {
  let tracker: RawStreamTracker;
  let onStreamActivity: (event: RuntimeActivityEvent) => void;
  let nowMs = 1_700_000_000_000;

  beforeEach(() => {
    tracker = makeRawStreamTracker();
    nowMs = 1_700_000_000_000;
    onStreamActivity = makeOnStreamActivity(tracker, () => nowMs);
  });

  it('STILL FIRES on attempt 2 pre-first-byte stall after attempt 1 completed (message_stop) [F2]', () => {
    // Attempt 1 runs and completes normally.
    onStreamActivity(mapAnthropicStreamEvent({ type: 'message_start' } as unknown as RawMessageStreamEvent));
    onStreamActivity({ kind: 'token-delta', subkind: 'text', rawEventType: 'text_delta' });
    onStreamActivity(mapAnthropicStreamEvent({ type: 'message_stop' } as unknown as RawMessageStreamEvent));

    // Single-attempt phantom window: still suppressed (Stage B baseline preserved).
    expect(combinedGateSuppresses(tracker)).toBe(true);
    expect(tracker.streamCompletionSupersededByNewAttempt).toBe(false);

    // A continuation dispatches attempt 2 (the loop's per-iteration `routing:model:`
    // status fires before runAgentLoop). lastActivity is STILL attempt 1's message_stop.
    markNewAttemptDispatched(tracker);
    expect(tracker.lastActivity).toEqual({
      kind: 'lifecycle', subkind: 'message-stop', rawEventType: 'message_stop',
    });

    // Attempt 2 produces NO raw stream activity (stalls pre-first-byte). The watchdog
    // ticks past 30s → the combined level-1 gate must NOT suppress: this is a genuine
    // pre-first-byte stall on the new attempt.
    expect(combinedGateSuppresses(tracker)).toBe(false);

    // Sanity: the predicate alone would still claim the stale terminal event — the
    // attempt-boundary flag is what flips the combined decision.
    expect(isStreamCompletedLifecycle(tracker.lastActivity)).toBe(true);
  });

  it('re-SUPPRESSES once attempt 2 actually completes (boundary clears on real activity)', () => {
    // Attempt 1 completes; continuation dispatches attempt 2.
    onStreamActivity(mapAnthropicStreamEvent({ type: 'message_stop' } as unknown as RawMessageStreamEvent));
    markNewAttemptDispatched(tracker);
    expect(combinedGateSuppresses(tracker)).toBe(false);

    // Attempt 2's stream connects and streams (clears the boundary flag via onStreamActivity).
    onStreamActivity(mapAnthropicStreamEvent({ type: 'message_start' } as unknown as RawMessageStreamEvent));
    expect(tracker.streamCompletionSupersededByNewAttempt).toBe(false);
    // Mid-stream, non-terminal: still fires (correct — turn is progressing).
    expect(combinedGateSuppresses(tracker)).toBe(false);

    // Attempt 2 completes normally → its OWN post-completion window suppresses again.
    onStreamActivity(mapAnthropicStreamEvent({ type: 'message_stop' } as unknown as RawMessageStreamEvent));
    expect(combinedGateSuppresses(tracker)).toBe(true);
  });

  it('does NOT disturb the token-delta arm when a new attempt is mid-stream', () => {
    // Even if the boundary flag is set, an active token-delta must still suppress
    // (the token-delta arm is intentionally NOT gated by the attempt boundary).
    onStreamActivity({ kind: 'token-delta', subkind: 'text', rawEventType: 'text_delta' });
    markNewAttemptDispatched(tracker); // pathological: flag set while a token-delta is current
    expect(combinedGateSuppresses(tracker)).toBe(true);
  });
});

// ============================================================================
// F25 — F6 firehose-mitigation tests for the bounded breadcrumb dedupe Set.
// Validates per-process rate-limited breadcrumb observation behaviour:
//   (a) first call for a given key returns true (breadcrumb fires once)
//   (b) subsequent calls for the same key return false (deduped)
//   (c) cap at 256 with FIFO eviction — eldest entry evicted on overflow
// ============================================================================
describe('recordUnmappedActivityObservationOnce — F25 firehose dedupe', () => {
  beforeEach(() => {
    __resetUnmappedActivityObservedForTests();
  });

  afterEach(() => {
    __resetUnmappedActivityObservedForTests();
  });

  it('returns true on first observation, false on subsequent observations of the same key', () => {
    expect(recordUnmappedActivityObservationOnce('vendor.unknown.event')).toBe(true);
    expect(recordUnmappedActivityObservationOnce('vendor.unknown.event')).toBe(false);
    expect(recordUnmappedActivityObservationOnce('vendor.unknown.event')).toBe(false);
  });

  it('treats distinct keys independently', () => {
    expect(recordUnmappedActivityObservationOnce('vendor.unknown.event_a')).toBe(true);
    expect(recordUnmappedActivityObservationOnce('vendor.unknown.event_b')).toBe(true);
    expect(recordUnmappedActivityObservationOnce('vendor.unknown.event_a')).toBe(false);
    expect(recordUnmappedActivityObservationOnce('vendor.unknown.event_b')).toBe(false);
  });

  it('evicts the eldest entry FIFO once the cap is reached', () => {
    const cap = UNMAPPED_RUNTIME_ACTIVITY_OBSERVED_CAP;
    expect(cap).toBe(256);

    for (let i = 0; i < cap; i++) {
      expect(recordUnmappedActivityObservationOnce(`evict_test:key_${i}`)).toBe(true);
    }

    expect(recordUnmappedActivityObservationOnce('evict_test:key_0')).toBe(false);
    expect(recordUnmappedActivityObservationOnce(`evict_test:key_${cap - 1}`)).toBe(false);

    expect(recordUnmappedActivityObservationOnce(`evict_test:key_${cap}`)).toBe(true);

    expect(recordUnmappedActivityObservationOnce('evict_test:key_0')).toBe(true);
    expect(recordUnmappedActivityObservationOnce('evict_test:key_0')).toBe(false);

    expect(recordUnmappedActivityObservationOnce(`evict_test:key_${cap - 1}`)).toBe(false);
  });
});
