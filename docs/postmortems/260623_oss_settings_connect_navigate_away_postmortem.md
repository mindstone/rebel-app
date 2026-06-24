<!-- Workflow: CHIEF_PATHOLOGIST @ bug-mode lightweight (low severity) -->

## Postmortem

### TL;DR

In **OSS builds**, connecting an email/calendar (or any broken-by-default OAuth)
connector from the **Settings** page opened the `ConnectorSetupDialog` (the
"register your own OAuth app" modal) and then immediately tore it down. The
Settings connect button is always **"Set up with Rebel"** (`launchRebel: true`),
and `handleConnect` fired `onConfigureWithRebel(...)` *unconditionally* alongside
the modal open. `onConfigureWithRebel` synchronously calls `closeSettingsDialog()`,
which unmounts the Settings surface (and the dialog it hosts) and navigates to a
fresh conversation — so OSS users saw a "Set up with Rebel" setup chat / the
production connect flow instead of the credentials modal, which breaks for them
(they have no OAuth client). The modal was wired through `handleResult` correctly;
the bug was the *adjacent* unconditional launch, in **both** the bundled
(Google/Microsoft) and direct/community (GitHub/generic) branches. Onboarding was
unaffected — it never calls `onConfigureWithRebel`/`launchRebel`.

Fixed by guarding both launch sites so they don't fire on the not-configured path,
keeping the dialog mounted: bundled branch gains `!isNotConfigured`, direct branch
gains `!isOAuthSetupGuidance(oauthResult?.setupGuidance)`.

### References
- **Sentry:** N/A (caught during OSS dogfooding / internal review)
- **Linear:** N/A
- **Fix commit:** pending — guards `launchRebel`/`onConfigureWithRebel` on the OSS not-configured path in `UnifiedConnectionsPanel.tsx` (both branches) + adds `UnifiedConnectionsPanel.ossNotConfigured.test.tsx`
- **Fix PR:** N/A
- **Planning doc:** [260623_oss-connector-setup-guidance/PLAN.md](../plans/260623_oss-connector-setup-guidance/PLAN.md)
- **Related postmortems:** [260623_oss_onboarding_connector_stuck_skeleton](260623_oss_onboarding_connector_stuck_skeleton.md) — same OSS `oauth-credentials-not-configured` setup-guidance flow, same introducing commit lineage (055f1664b2), adjacent-effect class on a different surface (onboarding FSM orphan vs settings navigate-away).

### Origin
- **Origin type:** regression
- **Introducing commit:** `055f1664b2` — `feat(oauth): ConnectorSetupDialog + route all connect surfaces through setup guidance (Stage 5)` (2026-06-08, liampcollins)
- **Contributing commits:** none (single commit introduced the regression; the unconditional `if (launchRebel)` blocks pre-dated it but only became wrong once 055f routed OSS not-configured connects into the setup-guidance modal on the same synchronous path)
- **Author:** liampcollins
- **Date introduced:** 2026-06-08
- **Time to discovery:** 15 days
- **Original conversation:** not searched (low-severity lightweight run; Phase 2 skipped). Introducing commit trailers present (`Co-Authored-By: Claude Opus 4.8 (1M context)`); no `AI-Workflow`/`AI-Session-ID` trailer to resolve a transcript.

### Classification
- **Bug type:** timing (state-set-then-unmounted race: two effects — open modal vs close-surface/navigate-away — fire in the same synchronous handler with no ordering or guard)
- **Pipeline stage failure:** implementation (the new wiring at 055f opened the modal correctly but the implementation left the adjacent navigation unguarded)
- **Severity:** low (OSS-only UX defect; no data loss, no production-build impact, onboarding unaffected, skip-past behaviour preserved)

### Root Cause Class

A **state-set-then-unmounted race**. In a single synchronous `handleConnect`
path the code performs two competing actions with no ordering guard or mutual
exclusion:

1. `setupGuidanceDialog.handleResult(oauthResult)` — sets the modal's guidance
   state ("open").
2. `if (launchRebel) onConfigureWithRebel(...)` — whose first statement
   (`closeSettingsDialog()` → `setSettingsOpen(false)`) unmounts the Settings
   surface that hosts the modal, in the same React batch.

The modal is opened then torn down before it can ever render. Critically, the
**setup-guidance modal was wired through `handleResult` correctly in BOTH
onboarding and settings** (same commit 055f1664b2). The bug was the *adjacent*
unconditional `onConfigureWithRebel` call — two independent `if`s where one
silently undoes the other — not a missing wiring. This is exactly why a pure
"is `handleResult` called?" code reading falsely concludes "should work": the
reader confirms the modal is opened and stops, never noticing the sibling branch
that unmounts its host. The two surfaces diverged only because onboarding's
connect paths `return` after `handleResult` and never reach a launch branch,
while settings' single "Set up with Rebel" button always sets `launchRebel:true`.

### Test Gap
- **Category:** missing_coverage
- **Modules:** `src/renderer/features/settings/components/UnifiedConnectionsPanel.tsx`
- **What test should exist:** a settings-connect regression test for the OSS not-configured path — simulate a bundled (and a direct/GitHub) OAuth connect resolving `{ success:false, setupGuidance:{ code:'oauth-credentials-not-configured' } }` with `launchRebel:true`, and assert that `onConfigureWithRebel` is NOT called and the `ConnectorSetupDialog` renders and stays mounted. (Now added as `UnifiedConnectionsPanel.ossNotConfigured.test.tsx`, red→green confirmed for both branches.)
- **Why it didn't exist:** the OSS not-configured connect path is a build-conditional branch (only broken-by-default in OSS, where no OAuth client credentials ship) that the production-focused settings tests never exercised; 055f added the wiring without a test asserting the *negative* — that the launch must not fire when guidance was shown.

### Review Analysis
- **Review miss type:** behavioral_semantic_gap (the modal-open call and the navigate-away call both type-check and look individually correct; the runtime contract violated — "don't navigate away from the surface hosting a modal you just opened" — is invisible unless the reviewer mentally co-executes both `if`s in the same batch)
- **Reviewer that came closest:** N/A for the introducing review; in *this* fix run the Phase-5 reviewers (Chief cross-check + GPT-5.5) caught the parity sibling (the direct/community branch had the identical bug), upgrading the fix from one branch to both (Stage 1b).
- **Why it was missed:** the bug isn't visible in the changed lines of 055f alone — the unconditional `if (launchRebel)` blocks were pre-existing context, and the new `handleResult` wiring reads as complete on its own. Catching it required tracing `onConfigureWithRebel → closeSettingsDialog → unmount` across modules (UnifiedConnectionsPanel → App.tsx → useSettingsFeature) on the OSS-only failure branch.

### Prevention
- **Recommended actions:**
  1. **(adopted, test_coverage)** OSS not-configured settings-connect regression test asserting modal-stays-mounted / launch-not-fired for both bundled and direct branches. Done in this run.
  2. **(workflow_improvement, priority medium — wait-for-signal)** A single decision point that chooses **recovery-modal XOR launch-rebel** based on the connect result, rather than two independent `if`s. E.g. compute one `postConnectAction: 'show-setup-guidance' | 'launch-rebel' | 'none'` from the result and branch once, making "open the modal" and "navigate away from the surface hosting it" mutually exclusive *by construction*. Cheapest durable variant: make `onConfigureWithRebel` a no-op (or assert) when setup guidance is pending. Deferred (not implement_now): it's a small refactor of working code with no second known instance beyond the two branches now guarded — `revisit_signal`: revisit if a third adjacent-effect instance of this class appears in `handleConnect`, or when `handleConnect`'s post-connect block is next refactored.
  3. **(detection/observability, priority low)** Telemetry that distinguishes "setup guidance shown" from "navigated to setup chat" on a connect attempt would have surfaced "modal opened then unmounted in the same cycle" as a measurable anomaly (guidance-shown event immediately followed by a fresh-session navigation). Gate against alert-fatigue; low priority.
- **Boundary registry candidate:** none — this is a renderer-internal effect-ordering bug, not a cross-process/cross-surface contract drift.

### Related Bugs
- [260623_oss_onboarding_connector_stuck_skeleton](260623_oss_onboarding_connector_stuck_skeleton.md) — sibling, same day, same OSS `oauth-credentials-not-configured` setup-guidance flow and same 055f lineage; adjacent-effect class on a different surface.

[BUG-POSTMORTEM] {"bug_id":"260623_oss_settings_connect_navigate_away","severity":"low","bug_type":"timing","pipeline_stage":"implementation","origin_type":"regression","introducing_commit":"055f1664b2","contributing_commits":[],"fix_commit":"pending","time_to_discovery_days":15,"developer":"liampcollins","ide":"factory","workflow":"unknown","implementer_model":"unknown","reviewer_models":[],"review_mode":"unknown","spec_quality":"unknown","test_gap":"missing_coverage","review_miss":"behavioral_semantic_gap","modules":["src/renderer/features/settings/components/UnifiedConnectionsPanel.tsx"],"prevention_actions":3,"related_bugs":["260623_oss_onboarding_connector_stuck_skeleton"],"mode":"bugfixer-chained","discovery_strategy":"not_found","discovery_source":"dogfooding"}
[BUG-ORIGIN] {"bug_id":"260623_oss_settings_connect_navigate_away","origin_type":"regression","introducing_commit":"055f1664b2","contributing_commits":[],"author":"liampcollins","date":"2026-06-08","original_session_id":null,"transcript_found":false,"transcript_path":null,"spec_quality":"unknown","discovery_strategy":"not_found"}
[BUG-TEST-GAP] {"bug_id":"260623_oss_settings_connect_navigate_away","category":"missing_coverage","modules":["src/renderer/features/settings/components/UnifiedConnectionsPanel.tsx"],"description":"OSS not-configured settings-connect regression test asserting onConfigureWithRebel is NOT called and ConnectorSetupDialog stays mounted, for both bundled and direct/GitHub branches"}
[BUG-REVIEW-MISS] {"bug_id":"260623_oss_settings_connect_navigate_away","category":"behavioral_semantic_gap","reviewer_models":[],"closest_reviewer":null,"original_confidence":null}
[BUG-PREVENTION] {"bug_id":"260623_oss_settings_connect_navigate_away","action_type":"test_coverage","description":"OSS not-configured settings-connect regression test (bundled + direct branches): assert modal stays mounted and onConfigureWithRebel not fired","priority":"high","implement_now":false}
[BUG-PREVENTION] {"bug_id":"260623_oss_settings_connect_navigate_away","action_type":"workflow_improvement","description":"Collapse the two independent post-connect ifs into one decision point choosing recovery-modal XOR launch-rebel (or make onConfigureWithRebel a no-op when setup guidance is pending) so the two are mutually exclusive by construction; revisit if a third instance of the class appears","priority":"medium","implement_now":false}
[BUG-PREVENTION] {"bug_id":"260623_oss_settings_connect_navigate_away","action_type":"workflow_improvement","description":"Telemetry distinguishing 'setup guidance shown' from 'navigated to setup chat' on a connect attempt, to surface modal-opened-then-unmounted anomalies; gate against alert-fatigue","priority":"low","implement_now":false}
