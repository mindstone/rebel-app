---
description: "How to check whether an AI provider (Anthropic / OpenAI / OpenRouter) was actually having an outage at a given time — current status + historical incident correlation for error triage, with the load-bearing caveat that status pages lag and under-report."
last_updated: "2026-06-24"
---

# Provider Status & Outages

Reference for answering one question during triage: **was the AI provider actually having an outage at the time of this error — or was it Rebel?**

## When to use this

You're triaging an AI-service error and want external evidence about the provider:

- A Sentry issue with a `5xx` / `overloaded_error` from a model provider (e.g. Anthropic `529`).
- A `rebel://conversation/...` where turns failed with *"AI Service had a moment"* / *"Connection Dropped"*.
- A user bug report ("nothing works", "every prompt fails") that smells upstream.

The goal is to correlate the **error's timestamp** against the provider's status history, and to do it honestly (see the caveat below — a clean status page does **not** mean there was no outage).

## See also

- [ERROR_MONITORING_AND_SENTRY](./ERROR_MONITORING_AND_SENTRY.md) — capture pipeline + triage; **our own `5xx`/`overloaded_error` telemetry is the stronger per-incident signal** (see the caveat below).
- [DIAGNOSE_ONE_OF_MY_CONVERSATIONS](./DIAGNOSE_ONE_OF_MY_CONVERSATIONS.md) — conversation-level investigation workflow.
- [MODEL_AND_PROVIDER_OVERVIEW](./MODEL_AND_PROVIDER_OVERVIEW.md) — model/provider/routing territory hub.
- `packages/shared/src/utils/providerStatusRegistry.ts` — **code source of truth** for the status-page URLs and the provider→status mapping (`STATUSPAGE_REGISTRY`, `statusProviderIdForProvider`).

## Where to look — per provider

All three are (or would be) **Atlassian Statuspage v2**.

| Provider | Human page | Current-status JSON | Incident history JSON |
|---|---|---|---|
| **Anthropic** | `https://status.claude.com/` | `https://status.claude.com/api/v2/summary.json` | `https://status.claude.com/api/v2/incidents.json` |
| **OpenAI** (also **Codex / ChatGPT**, which ride OpenAI's API) | `https://status.openai.com/` | `https://status.openai.com/api/v2/summary.json` | `https://status.openai.com/api/v2/incidents.json` |
| **OpenRouter** (also the path for the **Mindstone-managed** pool) | `https://status.openrouter.ai/` | — *(no public JSON API; the `/api/v2/...` paths 404)* | — |

**Provider → status-page mapping** (from `statusProviderIdForProvider`): `anthropic→anthropic`, `openai→openai`, **`codex→openai`** (Codex/ChatGPT Pro rides OpenAI's API), `openrouter→openrouter`, **`mindstone→openrouter`** (managed pool routes via OpenRouter).

**Gotcha — Anthropic host migration:** `status.anthropic.com` **302-redirects** to `status.claude.com` (the host migrated). Use the `claude.com` host directly, or follow redirects (`curl -L`).

### Reading `summary.json` (current status)

Top-level shape: `{ status: { indicator, description }, incidents[], components[], scheduled_maintenances[] }`. The `indicator` is the quick yes/no — one of `none | minor | major | critical`:

```bash
curl -sL https://status.claude.com/api/v2/summary.json | jq '.status'
# { "indicator": "none", "description": "All Systems Operational" }
```

## Historical correlation (the key part for timestamped errors)

To check a Sentry error at time **T**, you need *incident history*, not current status. `incidents.json` returns `{ page, incidents[] }`; each incident carries `name`, `status`, `impact`, `shortlink`, and timestamps:

- **Anthropic:** `started_at` / `created_at` / `monitoring_at` / `resolved_at` / `updated_at`.
- **OpenAI:** `created_at` / `updated_at` / `resolved_at` (**no `started_at`**), plus `incident_updates[]` each with their own timestamps.

An error at **T** is plausibly explained by an incident whose window `[started_at|created_at … resolved_at]` contains **T** (an unresolved incident has `resolved_at: null` → ongoing).

```bash
# Anthropic incident windows, newest first
curl -sL https://status.claude.com/api/v2/incidents.json \
  | jq '.incidents[] | {name, impact, started_at, resolved_at, shortlink}'

# OpenAI (no started_at — created_at is the start proxy)
curl -sL https://status.openai.com/api/v2/incidents.json \
  | jq '.incidents[] | {name, impact, created_at, resolved_at, shortlink}'
```

OpenRouter has no JSON API — open `https://status.openrouter.ai/` and read the history by hand.

## ⚠️ The load-bearing caveat — status pages lag and under-report

**Absence of a posted incident ≠ no outage.** Status pages are posted by humans, lag real events, and routinely never mention transient overloads at all.

Empirical proof, from the incident that motivated this doc (**REBEL-6D2**): a real Anthropic `529 overloaded_error` **storm** hit a user roughly **15:00–15:20 UTC on 2026-06-23** — clearly visible in our own telemetry, with Anthropic `request_id`s. That overload was **never posted** as an incident. The only nearby posted incident was a *separate* minor "Claude.ai elevated error rates" item at **18:24→18:32 UTC** — different window, different impact. Trusting the status page alone would have concluded "no outage" during a genuine one.

So treat the status page as **corroboration, not a verdict**:

- A posted **`major` / `critical`** incident overlapping T is **strong corroboration** of an upstream outage.
- **Silence / `operational` / `none` proves nothing** — especially for short-lived overloads.
- For transient overloads, **our own telemetry is the stronger per-incident signal**: search Sentry for the `5xx` / `overloaded_error` events (with the Anthropic `request_id`s) around T. Cross-reference that against the status page — see [ERROR_MONITORING_AND_SENTRY](./ERROR_MONITORING_AND_SENTRY.md).

Never tell a user "no outage / it's not the provider" on the strength of a green status page.

## Related surfaces (in-app)

The same registry powers two user/triage-facing features:

- **Error notice link** — when a turn fails with a provider `server_error`, the error notice offers a "Check <Provider> status" link (a pure registry lookup, no fetch) so the user can check for themselves.
- **Settings → diagnostics reachability panel** — a live status fetch (`summary.json`) surfaces a quiet "<Provider> reports an incident" line on `major|critical`, and rides into bug-report bundles as a machine-readable triage signal. It is corroborate-only and never drives the error verdict or copy.

Code: `packages/shared/src/utils/providerStatusRegistry.ts` (URLs + mapping); `src/core/services/diagnostics/providerStatusService.ts` (the live fetch). Design rationale: `docs/plans/260623_provider-status-probe/PLAN.md`.
