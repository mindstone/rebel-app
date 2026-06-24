<!-- Workflow: CHIEF_PATHOLOGIST @ bug-mode lightweight (low severity) -->

## Postmortem

### TL;DR

In **OSS builds**, the **Settings → AI provider** tab rendered the managed "Let
Mindstone handle it" panel (the Dash/Rogue subscription tiers, `activeProvider:
'mindstone'`) with **no OSS guard**. Managed subscriptions need the Mindstone
backend (login + server-provisioned key + Stripe checkout), which the OSS build
deliberately lacks (`@private/mindstone` resolves to a stub: `getAccessToken()`
→ `null`, login throws `OSS_NO_LOGIN`). So an OSS user could click **Subscribe**,
which called `window.subscriptionApi.createCheckout` → the unconditionally-
registered handler hit the `if (!accessToken) throw new Error('Not authenticated')`
guard (`src/main/ipc/subscriptionHandlers.ts:46`) **before any network call**, and
the renderer rendered that raw internal string under the tier cards. Onboarding
(`ApiStep`) correctly hid the same panel; **only Settings was ungated** — an
asymmetry, not a total miss.

Fixed by gating the Settings panel behind the same OSS check onboarding uses
(`AgentsTab.tsx`), then drift-proofing both surfaces through a shared
`managedSubscriptionOfferingsAvailable()` predicate and making
`SubscriptionSection` self-gate (return `null` when offerings are unavailable),
so any future consumer of that component is safe-by-construction.

### References
- **Sentry:** N/A (caught during OSS dogfooding / internal review)
- **Linear:** N/A
- **Fix commit:** `e61083fc88` — `fix(settings): gate managed-subscription panel out of the OSS build` (gates `AgentsTab` + adds `AgentsTab` gating tests); landed on `dev` via merge `e83ba249ff`
- **Prevention commit:** this change — shared `managedSubscriptionOfferingsAvailable()` predicate + `SubscriptionSection` self-gate + predicate/self-gate tests
- **Diagnosis doc:** [260623_oss-managed-tier-onboarding-bug/DIAGNOSIS.md](../plans/260623_oss-managed-tier-onboarding-bug/DIAGNOSIS.md)
- **Prevention planning doc:** [260623_oss-managed-offerings-predicate/PLAN.md](../plans/260623_oss-managed-offerings-predicate/PLAN.md)
- **Related postmortems:** [260623_oss_settings_connect_navigate_away_postmortem](260623_oss_settings_connect_navigate_away_postmortem.md) and [260623_oss_onboarding_connector_stuck_skeleton](260623_oss_onboarding_connector_stuck_skeleton.md) — same OSS theme: a Settings/onboarding surface exposing a production-only flow that has no backend in the OSS build. Recurring class worth watching.

### Origin
- **Origin type:** latent gap surfaced by an asymmetric fix
- **Introducing change:** the Settings managed panel was never OSS-gated. The asymmetry became sharp on **2026-06-22**, commit `e34061f848` (`fix(onboarding): gate the managed-subscription panel out of the OSS build`, liampcollins) — it added the `!isOss` gate to **onboarding `ApiStep` only** (its diff touches `ApiStep.tsx` + `ApiStep.ossGating.test.tsx`, not `AgentsTab`), leaving the identical Settings panel exposed.
- **Author:** liampcollins
- **Time to discovery:** ~1 day after the onboarding-only gate (reported via OSS dogfooding 2026-06-23)
- **Original conversation:** not searched (low-severity lightweight run).

### Classification
- **Bug type:** missing-guard / incomplete-rollout (a build-mode gate applied to one of two surfaces that render the same panel)
- **Pipeline stage failure:** implementation + review (the onboarding-only fix didn't enumerate the other surface that renders the same managed panel)
- **Severity:** low (OSS-only; no data loss; no production-build impact; the bad outcome was a confusing error string, not a crash; BYO providers unaffected)

### Root Cause Class

**Duplicated cross-surface gating with no single source of truth.** The same
product concept ("offer managed subscriptions") was decided independently on each
surface via an inline `!rendererIsOss()`. When the gate was introduced it was
applied to one surface, and nothing tied the two together — so the second surface
silently retained the wrong behaviour. The deeper smell: a **render-able dead-end**
— a checkout trigger whose backend doesn't exist in this build — was reachable
from the UI, and the failure mode at the seam was a raw `'Not authenticated'`
rather than an intentional, build-aware outcome.

### What would have surfaced this faster
- A **build-mode smoke pass** (launch the OSS build, walk onboarding + Settings AI-provider) — the panel is visible immediately; this is exactly what dogfooding caught, just a day late.
- A test asserting **parity between onboarding and Settings** for the managed panel under OSS (the onboarding-only fix shipped with an onboarding-only test, which is precisely why the gap wasn't caught in CI).

### Prevention (shipped here)
- **Kill-by-construction (structural):** `SubscriptionSection` now self-gates on `managedSubscriptionOfferingsAvailable()` and returns `null` when offerings are unavailable — any current or future consumer of that component is safe regardless of whether the surrounding surface remembers to gate it.
- **Single source of truth:** both managed-panel gates (onboarding inline cards + Settings) now route through `managedSubscriptionOfferingsAvailable()` — one named, documented concept to grep for, and one place to evolve the condition when OSS gains partial auth/checkout (today exactly `!isOss`).
- **Tests:** predicate unit test + `SubscriptionSection` OSS self-gate test, alongside the existing onboarding and Settings OSS-gating tests.

### Deliberately deferred
- **Seam-level hardening (option C):** making the `subscription:create-checkout` IPC return a typed "unavailable in OSS" result instead of throwing `'Not authenticated'`. Architecturally the strongest kill, but it changes the IPC response contract (renderer/preload/schema/error-flow) — disproportionate for now that the UI dead-end is closed on every surface. Revisit if more checkout surfaces appear or OSS gains partial auth. (Cross-family DA concurred: rank B > D > A > C; ship B, defer C.)
