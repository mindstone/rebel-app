---
event: bug_postmortem
phase: 8
activity: specialist
actor: chief-pathologist
harness: claude_code
model: claude-opus-4-8
session_id: d3f1e12d-a592-47a4-9ff1-59f1c89a9300
created_at: 2026-06-23T18:35:00Z
severity: low-medium
surface: oss-onboarding
regression_risk: low
planning_doc: docs/plans/260623_fix-oss-onboarding-connector-stuck/PLAN.md
---

# [BUG-POSTMORTEM] — OSS onboarding: required email connector stuck as a loading skeleton + Continue hard-blocked

## TL;DR

In **OSS builds only**, clicking a required email connector (Gmail / Slack / Outlook) on the onboarding "connectors" step opened the "set up your own client" dialog (`oauth-credentials-not-configured`), but the clicked tile got **stuck as a loading skeleton forever** — even after dismissing the dialog — and the **Continue button was permanently disabled**, hard-blocking onboarding. Root cause: a code branch dispatched the "into generation" FSM event, then on the credentials-miss deliberately *skipped* the terminal failure event without dispatching any replacement, orphaning the tool in `generating`. Fixed by adding a `SETUP_REQUIRED` named FSM event (`generating→pending`, atomic `setupRequired` flag) plus an OSS-gated, email-scoped Continue bypass and render/auto-gen guards.

## Severity & scope

- **Severity:** Low/Medium. No data loss, no production impact (commercial builds ship configured OAuth client creds and never take the not-configured branch). Confined to the OSS build's first-run onboarding UX.
- **Surface:** OSS onboarding → connectors step (`useOnboardingFlow` / `toolAuthMachine` / `OnboardingWizard` / `ToolAuthStep`).
- **User impact:** An OSS user trying onboarding could not get past the connectors step at all — the tile they clicked looked permanently "loading" and Continue stayed greyed out. A dead-end on the very first run. (No corruption; relaunching onboarding would just reproduce it.)

## Root cause

The required-email tile lifecycle is `pending → generating → ready_to_connect/connected`. On click (or auto-gen), `generateAuthLink` in `useOnboardingFlow.ts` dispatched `GENERATE_REQUESTED` (`pending → generating`, skeleton shows), then called the provider `startAuth`. In OSS builds there are no OAuth client credentials, so `startAuth` returned `{ success: false, setupGuidance: { code: 'oauth-credentials-not-configured', … } }`.

The code routed that result to the setup dialog and — explicitly, to avoid stacking a generic error on top of the helpful dialog — **skipped `GENERATE_FAILED`**:

```ts
if (!setupGuidanceDialog.handleResult(result)) {   // handleResult returns true here
  dispatch GENERATE_FAILED                          // ...so this is skipped
}
// ...and nothing else dispatched — tool orphaned in `generating`
```

`handleResult` returns `true` for the not-configured discriminant, so `GENERATE_FAILED` was skipped and **no other event was dispatched**. The tool was left in `generating`. Consequences:

1. **Permanent skeleton** — `ToolAuthStep.renderExistingProvider` computes `showSkeleton = isGeneratingStatus(status)`. `generating` never exits, so the skeleton never clears (and dismissing the dialog only clears `guidance`, not tool-auth state).
2. **Continue hard-blocked** — the gate `toolAuthReady` required `anyEmailConnected || anyEmailError`. A tool stuck in `generating` is neither, and `canSkipToolAuth` is dev-mode-only, so packaged/OSS builds had no escape → `canProceed` false forever.

This is a textbook **"skip the error, but forget to leave the in-progress state"** bug: a branch transitions *into* an in-flight status (`generating`) and then returns down a path that omits both the success transition and the failure transition, with no terminal/exit event of any kind. The in-flight status is, by construction, not a resting state — leaving it orphaned strands every consumer keyed off it (the skeleton render *and* the gate).

## Why it wasn't caught earlier

There was an existing test for exactly this path — `useOnboardingFlow.setupGuidance.test.tsx` — and **it passed while the bug was live**, because it only asserted the *non-buggy half* of the intent:

- It asserted the setup dialog **opens** (`setupGuidance.isOpen === true`). ✅ (still correct)
- It asserted the tool status is **NOT `error`** (i.e. we didn't surface a generic error). ✅ (still correct)
- It **never asserted that the tool LEFT `generating`** (no stuck skeleton), and **never asserted the step could proceed** (`toolAuthReady` / `canProceed`).

So the test locked in "don't show an error" and "open the dialog" — the *good* parts of the original intent — while being silent on "and also leave the in-progress state and let the user continue." It encoded half a requirement and gave false confidence on the other half. A test that asserts only the absence of a wrong state (`!error`) without asserting the presence of a correct resting state is a classic blind spot.

## The fix (brief)

Per the product decision ("let OSS users continue past the step without BYO creds; tile resets to a clickable non-error 'Set up'"):

- **FSM (`toolAuthMachine.ts` / `toolAuthTypes.ts`):** new named event `SETUP_REQUIRED` with the single new legal edge `generating → pending` (no-op from every other status). It **atomically** sets a new orthogonal `setupRequired?: boolean` field and clears transient fields (`error`, `awaitingSince`, `authUrl`). `setupRequired` is **excluded from `ToolAuthFieldPatch`**, so only named events can mutate it; it's cleared on `GENERATE_REQUESTED`, connected-family events, and `DISCONNECTED` so it can't go stale.
- **Hook (`useOnboardingFlow.ts`):** all three local-OAuth branches now dispatch `SETUP_REQUIRED` on the credentials-miss (instead of dispatching nothing). `toolAuthReady` gains `anyEmailSetupRequired`, **scoped to `EMAIL_TOOLS`** and **gated on `rendererIsOss()`** so a *misconfigured commercial build* (same discriminant) can't silently skip required connect. The FSM reset itself is **ungated** — a stuck `generating` tile is always a bug.
- **Render (`OnboardingWizard.tsx`):** required-tool `pending` skeleton is gated on `!setupRequired`, and the auto-gen effect early-returns on `setupRequired` so it can't re-fire and re-loop the dialog.
- **Tests:** red→green regression assertions (not-stuck-in-`generating`, lands `pending`+`setupRequired`, `toolAuthReady` true in OSS / false in non-OSS, Slack-only stays blocked, `startAuth` called once) + FSM reducer/property tests for the new edge.

## (a) What testing / monitoring would have surfaced this faster

Concrete and ordered by leverage:

1. **The now-added assertions** are the direct fix for the test blind spot: assert the tile **left `generating`** (no stuck skeleton) and that the step **can proceed** (`toolAuthReady` / `canProceed` true). The general principle worth internalizing: *when testing a "graceful" branch, assert the resting/terminal state and the user's ability to move on — never just the absence of an error.*
2. **An OSS onboarding smoke / E2E** (build with no OAuth creds → onboarding → connectors → click Gmail → dialog → dismiss → tile clickable "Set up", Continue enabled). The hook tests now cover this, but the bug was OSS-build-specific and only reachable through the unconfigured-creds path — an OSS-flavored smoke would have caught it without anyone reasoning about the FSM. Highest-value *new* coverage.
3. **Telemetry on stranded in-flight statuses** — e.g. a count/alert for any onboarding tool that dwells in `generating` (or `awaiting_auth`) beyond a short threshold, or onboarding-step dwell-time / abandonment on the connectors step. A spike in "connectors step never completes" for OSS users would have flagged the dead-end empirically. (PostHog onboarding funnels already exist; a "stuck-in-generating" event would be cheap to emit.)

## (b) Structural prevention — can this class be made unrepresentable / caught by construction?

This is the interesting bit, because the FSM here is **already guarded** (postmortem `251202`: status changes go through named events only; `ToolAuthFieldPatch` omits `status`; the transition table is invariant-tested). That guard is exactly why the fix was clean and low-risk. But it did **not** prevent this bug — and it's worth being honest about why: the FSM guarantees *every status transition is legal and named*, but it cannot guarantee *that a caller who entered `generating` ever dispatches a follow-up event at all*. The orphaning happened in the **caller** (`generateAuthLink`), not in an illegal transition. The bug lives in the gap between "the machine is correct" and "every async caller drives the machine to a terminal state."

Options considered, with honest assessment:

1. **Lint/exhaustiveness rule: "every code path that dispatches `GENERATE_REQUESTED` must dispatch a follow-up terminal/exit event."** Appealing in principle, but very hard to express soundly — it's an inter-procedural, async control-flow property (the follow-up is in a `.then`/`await` branch, sometimes a different function). A lint rule would be either unsound (misses the real cases) or noisy (false positives on legitimate multi-step flows). **Not worth building.**
2. **FSM-level "no terminal status reachable" / liveness detector.** A static check that from every in-flight status (`generating`, `awaiting_auth`, `verifying`) a terminal status (`connected`/`error`/clickable `pending`) is *reachable in the table*. Useful as a table invariant, but note: it would **not** have caught this bug — `generating → error` and `generating → ready_to_connect` were always reachable in the table. The failure was a caller not firing the event, not an unreachable state. So this guards a different (real but distinct) class. **Low value for this specific class.**
3. **Watchdog / timeout on in-flight statuses.** A timer that, if a tool sits in `generating`/`awaiting_auth` past N seconds with no event, dispatches a terminal event (e.g. resets to a clickable state and/or logs). This is the **only option that would have actually caught and self-healed this bug** regardless of which caller forgot to fire an event — it's a backstop at the machine boundary, not the caller. It also doubles as the telemetry hook in (a)(3). Downside: timers add complexity and can mask the underlying caller bug if it logs quietly (violates "silent failure is a bug" unless it emits a structured warning). If built, it **must** log loudly when it fires.

**Honest recommendation:** Option 3 (a watchdog with a loud structured log on fire) is the most defensible, because it targets the actual class ("entered an in-flight status, caller returned without a terminal event") at the right layer and self-heals. But it is **not** make-unrepresentable — it's a runtime backstop, not a compile-time guarantee — and it carries real complexity. The pragmatic, already-shipped prevention is the **test discipline** in (a)(1)+(a)(2): assert resting state + proceed-ability on every graceful branch, plus an OSS onboarding smoke. That covers the realistic recurrence path at far lower cost.

## Prevention recommendations — drain-now bar (cheap AND high-priority AND killable-by-construction)

| # | Recommendation | Drain-now? | Notes |
|---|---|---|---|
| a1 | Resting-state + proceed-ability assertions on graceful branches | **Already done** in this fix | Not a backlog item |
| a2 | OSS onboarding smoke/E2E (no-creds connectors path) | Worth filing, **not drain-now** | High value but real effort (OSS-build harness); medium-priority |
| a3 | Telemetry: tool stranded in `generating` / connectors-step dwell | Worth filing, **not drain-now** | Cheap-ish to emit; pairs with b3 |
| b3 | In-flight-status watchdog with loud log | Worth filing, **not drain-now** | Honest best structural option, but adds complexity; not killable-by-construction |
| b1/b2 | Lint rule / FSM liveness detector | **Do not file** | Unsound/noisy, or guards a different class than this bug |

**Nothing here clears the drain-now bar** (cheap AND high-priority AND killable-by-construction simultaneously): the cheap fix (a1) is already done; the genuinely preventive items (a2, a3, b3) are valuable but each carries non-trivial cost and none is "killable by construction." File a2/a3/b3 as backlog; skip b1/b2.
