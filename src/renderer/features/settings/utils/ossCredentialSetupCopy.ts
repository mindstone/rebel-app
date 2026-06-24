/**
 * OSS-only bring-your-own-credentials setup copy for the 4 bundled OAuth connectors
 * (Google, Microsoft, Slack, HubSpot).
 *
 * WHY THIS LIVES HERE (not in the catalog): the catalog `setupUrl` / `setupInstructions`
 * are commercial-facing — the bundled setup-FAILURE prompt path reads `setupUrl`
 * (`setupPromptGenerator.ts`), so overwriting the catalog fields drifts the commercial
 * agent prompt (GPT review F4). Instead the catalog keeps its original sign-in copy, and
 * the OSS credential form (rendered only when `rendererIsOss()`) overlays these strings via
 * `applyOssCredentialSetupCopy()`. Commercial never reads these.
 *
 * Copy authored by chief-designer (260624_093332_chief-designer.md §2). Framing → `setupNotice`
 * (rendered as a Notice above the steps); numbered steps → `setupInstructions` (each newline is
 * a numbered <li>, so there is NO intro line in `setupInstructions`). The provider-console button
 * uses `setupUrl` + `setupUrlButtonLabel` with `setupUrlBehavior: 'button'`.
 *
 * Redirect URIs are inlined as literal strings in the step text (chief-designer §2 "Preferred"
 * v1). They mirror the `getOAuthRedirectUri` worker defaults and HubSpot's fixed loopback ports;
 * an env `<PROVIDER>_REDIRECT_URI` override could drift them, which is acceptable for the OSS
 * audience (who won't override). A future enhancement (DSR Q1) could render a copyable block fed
 * by `describeMissingOAuthCredentials(provider).redirectUris`.
 */

import type { ConnectorCatalogEntry } from '@shared/types';

interface OssCredentialSetupCopy {
  /** Framing paragraph rendered as an info Notice above the steps. */
  setupNotice: string;
  /** Numbered steps; one per newline. No intro line. */
  setupInstructions: string;
  /** Provider developer-console URL (OSS-specific; differs from the catalog's sign-in URL). */
  setupUrl: string;
  setupUrlButtonLabel: string;
}

/** Keyed by catalog connector id. Only the 4 OSS BYO-credential connectors are present. */
const OSS_CREDENTIAL_SETUP_COPY: Record<string, OssCredentialSetupCopy> = {
  'bundled-google': {
    setupNotice:
      "Bring your own keys. Rebel's open-source build doesn't ship shared Google credentials, so you'll set up your own Google app once. It's the fiddly part of connecting, and if you have a technical colleague this is a fine thing to hand them. Create the app, paste the two values below, and Google stays connected.",
    setupInstructions: [
      'In Google Cloud Console, pick or create a project.',
      'Enable the APIs FIRST — this is the step most people skip. In APIs & Services → Library, enable each one you want Rebel to use: Gmail API, Google Calendar API, Google Drive API, and People API (Contacts). Miss this and connecting fails later with a "403: API has not been used / is disabled".',
      'Open APIs & Services → Credentials, click "Create credentials", and choose "OAuth client ID".',
      'If Google asks you to configure the consent screen first, do that (User type: External, add your email), then come back and start "Create credentials" → "OAuth client ID" again.',
      'For "Application type" choose "Desktop app" — Rebel signs in locally, so there\'s no redirect URL to paste. Name it and click Create.',
      'Copy the Client ID and Client Secret from the credential you just created, paste both below, and connect.',
    ].join('\n'),
    setupUrl: 'https://console.cloud.google.com/apis/credentials',
    setupUrlButtonLabel: 'Open Google Cloud Console',
  },
  'bundled-microsoft-mail': {
    setupNotice:
      "Bring your own key. Rebel's open-source build doesn't ship a shared Microsoft credential, so you'll register your own Microsoft app once. This one Application ID covers Outlook Mail, Calendar, Teams, Files, and SharePoint, so set it up here and the rest light up. It's the fiddly part; a technical colleague can do it in a few minutes if you'd rather not.",
    setupInstructions: [
      'Open the Microsoft Entra admin center, then App registrations, then New registration.',
      'Under "Redirect URI", choose the platform "Mobile and desktop applications" and add this exact address: https://rebel-auth.mindstone.com/microsoft/callback',
      'Add the Microsoft Graph permissions you want Rebel to use (Mail, Calendar, Teams, Files).',
      'Copy the "Application (client) ID" from the app\'s Overview page. There\'s no secret to copy: Microsoft uses a secret-free sign-in.',
      'Paste the Application ID below and connect.',
    ].join('\n'),
    setupUrl: 'https://entra.microsoft.com/',
    setupUrlButtonLabel: 'Open Microsoft Entra',
  },
  'bundled-slack': {
    setupNotice:
      "Bring your own keys. Rebel's open-source build doesn't ship shared Slack credentials, so you'll set up your own Slack app once. It's the fiddly part of connecting, and if you have a technical colleague this is a fine thing to hand them. Create the app, paste the two values below, and Slack stays connected.",
    setupInstructions: [
      'Open the Slack API apps page and create a new app, choosing "From scratch".',
      'Under "OAuth & Permissions", add this exact Redirect URL: https://rebel-auth.mindstone.com/slack/callback',
      'Add the scopes Rebel needs, then install the app to your workspace.',
      'Copy the Client ID and Client Secret from the app\'s "Basic Information" page.',
      'Paste both below and connect.',
    ].join('\n'),
    setupUrl: 'https://api.slack.com/apps',
    setupUrlButtonLabel: 'Open Slack API apps',
  },
  'bundled-hubspot': {
    setupNotice:
      "Bring your own keys. Rebel's open-source build doesn't ship shared HubSpot credentials, so you'll set up your own HubSpot app once. It's the fiddly part of connecting, and if you have a technical colleague this is a fine thing to hand them. Create the app, paste the two values below, and HubSpot stays connected.",
    setupInstructions: [
      'Open the HubSpot developer account page and create a new app.',
      'Under "Auth", add all four of these Redirect URLs: http://localhost:8081/callback, http://localhost:8082/callback, http://localhost:8083/callback, http://localhost:8084/callback (Rebel uses the first one that\'s free).',
      'Add the scopes you need, such as contacts, deals, and tickets.',
      'Copy the Client ID and Client Secret from the app\'s Auth settings.',
      'Paste both below and connect.',
    ].join('\n'),
    setupUrl: 'https://app.hubspot.com/developer',
    setupUrlButtonLabel: 'Open HubSpot developer',
  },
};

/** Per-field help text for the credential inputs (chief-designer §2). */
const CLIENT_ID_HELP = 'From your provider app, safe to share; it identifies the app, not you.';
const CLIENT_SECRET_HELP = 'Treated like a password. Don\'t share it.';

/**
 * Return a SHALLOW-CLONED catalog entry with the OSS-specific credential setup copy overlaid,
 * for use ONLY in the OSS credential form. Returns the original entry unchanged if the connector
 * id has no OSS copy (defensive — should only be called for the 4 mapped connectors). The catalog
 * object itself is never mutated, so the commercial-facing fields stay byte-stable.
 */
export function applyOssCredentialSetupCopy(
  entry: ConnectorCatalogEntry,
): ConnectorCatalogEntry {
  const copy = OSS_CREDENTIAL_SETUP_COPY[entry.id];
  if (!copy) return entry;

  const setupFields = entry.setupFields?.map((field) => {
    if (field.id === 'clientId') return { ...field, helpText: field.helpText ?? CLIENT_ID_HELP };
    if (field.id === 'clientSecret') {
      return { ...field, helpText: field.helpText ?? CLIENT_SECRET_HELP };
    }
    return field;
  });

  return {
    ...entry,
    setupNotice: copy.setupNotice,
    setupInstructions: copy.setupInstructions,
    setupUrl: copy.setupUrl,
    setupUrlButtonLabel: copy.setupUrlButtonLabel,
    setupUrlBehavior: 'button',
    ...(setupFields ? { setupFields } : {}),
  };
}
