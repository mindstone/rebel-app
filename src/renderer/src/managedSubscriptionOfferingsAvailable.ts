import { rendererIsOss } from './rendererIsOss';

/**
 * Single source of truth for "can this build offer Mindstone-managed
 * subscriptions (the Dash/Rogue tiers, `activeProvider: 'mindstone'`)?"
 *
 * Managed subscriptions require Mindstone login + a server-provisioned managed
 * key + a Stripe checkout backend. The OSS build has none of that
 * (`@private/mindstone` resolves to a stub: `getAccessToken()` → null, login
 * throws `OSS_NO_LOGIN`), so rendering the "Let Mindstone handle it" panel there
 * is a dead end — clicking Subscribe hits `subscription:create-checkout`, fails
 * the null-token check, and surfaces a bare "Not authenticated" error.
 *
 * WHY A NAMED PREDICATE (kill-by-construction). The managed panel renders on two
 * surfaces (onboarding `ApiStep` + Settings `AgentsTab`/`SubscriptionSection`).
 * Each previously gated the panel with its own inline `!rendererIsOss()`, and a
 * fix that scoped only onboarding left the Settings surface ungated — the exact
 * drift that shipped the "Not authenticated" bug (see
 * docs/postmortems/260623_oss_managed_subscription_settings_gate.md). Routing
 * every managed-offering gate through THIS predicate gives one concept to grep
 * for and one place to evolve the condition when OSS gains partial auth/checkout
 * (today it's exactly `!isOss`; tomorrow it may be `!isOss || hasManagedAuth`).
 * `SubscriptionSection` additionally self-gates on this predicate so any future
 * consumer of that component is safe-by-construction.
 */
export function managedSubscriptionOfferingsAvailable(): boolean {
  return !rendererIsOss();
}
