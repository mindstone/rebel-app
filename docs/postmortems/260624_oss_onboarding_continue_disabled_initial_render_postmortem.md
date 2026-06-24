<!-- Workflow: CHIEF_PATHOLOGIST @ bug-mode lightweight (low severity) -->

## Postmortem

### TL;DR

In **OSS builds only**, the onboarding connectors-step **"Continue"** button was
disabled on initial render and stayed disabled until the user clicked a connector,
hit the "set up your own OAuth client" wall, and dismissed the modal. Desired
behaviour: in OSS the connectors step is freely skippable, so Continue should
**never** be disabled there.

The gate is `toolAuthReady` in
`src/renderer/features/onboarding/hooks/useOnboardingFlow.ts`. The intended
"OSS users can skip connectors" carve-out was implemented as a clause gated on
`t.setupRequired === true`. But `setupRequired` is `undefined` on initial render —
it only flips to `true` *after* the user clicks a connector and the connect attempt
resolves the `oauth-credentials-not-configured` discriminant (the `SETUP_REQUIRED`
FSM event). So the skip behaviour only kicked in **after the very interaction it
was meant to make unnecessary**. The clause was added in the prior same-day F2/F3
task (commit `4f01e2df9e`) but was only ever validated against the post-`SETUP_REQUIRED`
state, never against initial render.

Fixed by returning `true` up front in OSS (`if (rendererIsOss()) return true;`),
gated on `rendererIsOss()` so commercial builds are unchanged, and removing the dead
`setupRequired` clause. Initial-render regression tests added for both OSS (`true`)
and commercial (`false`).

### References
- **Sentry:** N/A (caught during OSS dogfooding / internal review)
- **Linear:** N/A
- **Fix commit:** pending — `toolAuthReady` returns `true` up front in OSS in `useOnboardingFlow.ts`; dead `setupRequired` clause removed; adds initial-render tests in `useOnboardingFlow.setupGuidance.test.tsx`
- **Fix PR:** N/A
- **Planning doc:** N/A (lightweight bug_mode run)
- **Related postmortems:** [260623_oss_onboarding_connector_stuck_skeleton](260623_oss_onboarding_connector_stuck_skeleton.md) and [260623_oss_settings_connect_navigate_away](260623_oss_settings_connect_navigate_away.md) — same OSS `oauth-credentials-not-configured` / setup-guidance flow; this bug shares lineage with the F3 onboarding fix that introduced the gating clause.

### Origin
- **Origin type:** regression
- **Introducing commit:** `4f01e2df9e` — `fix(onboarding): reset stuck OSS connector tile + unblock progression on "set up your own client"` (2026-06-23, liampcollins). This is the F2/F3 task that added the `setupRequired`-gated OSS skip clause.
- **Contributing commits:** none
- **Author:** liampcollins
- **Date introduced:** 2026-06-23
- **Time to discovery:** 1 day
- **Original conversation:** not searched (low-severity lightweight run; Phase 2 skipped).

### Classification
- **Bug type:** logic (skip-condition gated on an optional field that is unpopulated at the moment the gate is first evaluated)
- **Pipeline stage failure:** implementation (and test design — the new tests only exercised the post-interaction state)
- **Severity:** low (OSS-only onboarding UX defect; the step was still reachable after one throwaway interaction; no data loss, no commercial-build impact)

### Root Cause Class

**OSS-only / build-flavor-conditional logic validated only against
post-interaction state, not initial render.** The OSS carve-out
(`toolAuthReady` should be `true` when there is nothing meaningful to gate on)
was coupled to `setupRequired`, a per-tool optional field that is `undefined`
until the `SETUP_REQUIRED` FSM event populates it — and that event only fires as
a *consequence* of the user interaction the carve-out was meant to render
unnecessary. The predicate was therefore correct in exactly one state (post-wall)
and wrong in the state that matters for the user (initial render). Because the
field is an interaction-populated optional, the bug is invisible to any test or
manual check that starts from the post-`SETUP_REQUIRED` state — which is precisely
how it was validated.

### Test Gap
- **Category:** missing_coverage
- **Modules:** `src/renderer/features/onboarding/hooks/useOnboardingFlow.ts`
- **What test should exist:** an **initial-render** assertion for the build-flavor-gated UI predicate — render the hook in OSS with no connector interaction (no `generateAuthLink`, no `SETUP_REQUIRED` dispatch, no email tool connected) and assert `toolAuthReady === true`; and the mirror commercial-build assertion (`false`). (Now added as the initial-render cases in `useOnboardingFlow.setupGuidance.test.tsx`.)
- **Why it didn't exist:** the existing setup-guidance tests asserted `toolAuthReady` only **after** dispatching the `SETUP_REQUIRED` event (post-wall). That state happened to satisfy the buggy `setupRequired`-gated clause, so the tests were green while the initial-render state — the one users actually hit — was never asserted.

### Review Analysis
- **Review miss type:** behavioral_semantic_gap (the `setupRequired`-gated clause type-checks and reads as a correct OSS skip; the gap is that `setupRequired` is unpopulated at first evaluation — visible only by reasoning about *when* the field is set relative to *when* the predicate is read)
- **Reviewer that came closest:** N/A for the introducing review.
- **Why it was missed:** the introducing change was itself an OSS-skip fix, validated against the post-interaction state it was reasoning about; nobody asserted the initial-render state, so the temporal coupling between `setupRequired` population and predicate evaluation went unnoticed.

### Prevention
- **Recommended actions:**
  1. **(adopted, test_coverage, priority high)** Initial-render assertions for the build-flavor-gated `toolAuthReady` predicate — OSS → `true`, commercial → `false` — with no connector interaction. Done in this run.
  2. **(workflow_improvement, priority medium)** Convention: any **OSS-/build-flavor-gated UI gate** gets an explicit initial-render test, not only a post-interaction one. The recurring failure mode in this lineage is build-conditional logic validated only against the state produced by the very interaction it was meant to bypass. Deferred (not implement_now): it's a process/convention nudge, not a kill-by-construction change; `revisit_signal`: revisit if a third build-flavor-gated predicate ships without an initial-render test.
  3. **(workflow_improvement, priority medium)** Prefer an **unconditional build-flavor early-return** (`if (rendererIsOss()) return true;`) over coupling skip-logic to an interaction-populated optional field. The fix already adopted this shape here; the general guidance is to make build-flavor carve-outs independent of runtime interaction state by construction. Deferred (not implement_now): applies as a pattern preference going forward, not a mechanical gate.
- **Boundary registry candidate:** none — renderer-internal onboarding predicate, not a cross-process/cross-surface contract.

### Related Bugs
- [260623_oss_onboarding_connector_stuck_skeleton](260623_oss_onboarding_connector_stuck_skeleton.md) — same onboarding surface, same OSS `oauth-credentials-not-configured` / setup-guidance flow; the F3 fix that introduced this gating clause lived in the same lineage.
- [260623_oss_settings_connect_navigate_away](260623_oss_settings_connect_navigate_away.md) — sibling OSS not-configured setup-guidance defect on the Settings surface.

[BUG-POSTMORTEM] {"bug_id":"260624_oss_onboarding_continue_disabled_initial_render","severity":"low","bug_type":"logic","pipeline_stage":"implementation","origin_type":"regression","introducing_commit":"4f01e2df9e","contributing_commits":[],"fix_commit":"pending","time_to_discovery_days":1,"developer":"liampcollins","ide":"factory","workflow":"chief-engineer-bug-mode","implementer_model":"unknown","reviewer_models":[],"review_mode":"lightweight","spec_quality":"unknown","test_gap":"missing_coverage","review_miss":"behavioral_semantic_gap","modules":["src/renderer/features/onboarding/hooks/useOnboardingFlow.ts"],"prevention_actions":3,"related_bugs":["260623_oss_onboarding_connector_stuck_skeleton","260623_oss_settings_connect_navigate_away"],"mode":"bug-mode","discovery_strategy":"not_found","discovery_source":"dogfooding"}
[BUG-ORIGIN] {"bug_id":"260624_oss_onboarding_continue_disabled_initial_render","origin_type":"regression","introducing_commit":"4f01e2df9e","contributing_commits":[],"author":"liampcollins","date":"2026-06-23","original_session_id":null,"transcript_found":false,"transcript_path":null,"spec_quality":"unknown","discovery_strategy":"not_found"}
[BUG-TEST-GAP] {"bug_id":"260624_oss_onboarding_continue_disabled_initial_render","category":"missing_coverage","modules":["src/renderer/features/onboarding/hooks/useOnboardingFlow.ts"],"description":"Initial-render assertion for the build-flavor-gated toolAuthReady predicate (OSS true, commercial false) with no connector interaction; existing tests only asserted post-SETUP_REQUIRED state"}
[BUG-REVIEW-MISS] {"bug_id":"260624_oss_onboarding_continue_disabled_initial_render","category":"behavioral_semantic_gap","reviewer_models":[],"closest_reviewer":null,"original_confidence":null}
[BUG-PREVENTION] {"bug_id":"260624_oss_onboarding_continue_disabled_initial_render","action_type":"test_coverage","description":"Initial-render regression tests for build-flavor-gated toolAuthReady (OSS true, commercial false), no connector interaction","priority":"high","implement_now":false}
[BUG-PREVENTION] {"bug_id":"260624_oss_onboarding_continue_disabled_initial_render","action_type":"workflow_improvement","description":"Convention: OSS-/build-flavor-gated UI gates get an explicit initial-render test, not only a post-interaction one; revisit if a third build-flavor-gated predicate ships without one","priority":"medium","implement_now":false}
[BUG-PREVENTION] {"bug_id":"260624_oss_onboarding_continue_disabled_initial_render","action_type":"workflow_improvement","description":"Prefer an unconditional build-flavor early-return over coupling skip-logic to an interaction-populated optional field, so build-flavor carve-outs are independent of runtime interaction state by construction","priority":"medium","implement_now":false}
