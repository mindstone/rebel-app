// @vitest-environment happy-dom

/**
 * Regression test for the OSS "navigate-away before modal" bug
 * (docs/plans/260623_oss-connector-setup-guidance/PLAN.md, Stage 1).
 *
 * In the OSS build a bundled OAuth connector's `startAuth()` resolves
 * `{ success:false, setupGuidance:{ code:'oauth-credentials-not-configured', … } }`.
 * `handleConnect` opens the `ConnectorSetupDialog` for that case — but the same
 * synchronous path used to ALSO fire `onConfigureWithRebel` (because the only
 * Settings connect button passes `launchRebel:true`), which closes the Settings
 * surface and unmounts the dialog we just opened. The fix guards the
 * `launchRebel`/`onConfigureWithRebel` branch with `!isNotConfigured`.
 *
 * This test uses the REAL `useConnectorSetupGuidance` hook (not a mock) so the
 * actual `ConnectorSetupDialog` renders, then asserts:
 *  - `onConfigureWithRebel` is NOT called on the not-configured path, and
 *  - the `connector-setup-dialog` IS rendered (guidance state set + dialog open).
 *
 * Mocking mirrors `UnifiedConnectionsPanel.connectDeferred.test.tsx` / `.slackBranch.test.tsx`.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnifiedConnectionsPanel } from '../UnifiedConnectionsPanel';
import type { UnifiedConnection } from '../../hooks/useUnifiedConnections';
import type { OAuthSetupGuidance } from '@shared/ipc/schemas/common';

const mockShowToast = vi.hoisted(() => vi.fn());
const mockConnectSlack = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockConnectionsState = vi.hoisted(() => ({
  connections: [] as UnifiedConnection[],
}));
const trackingMocks = vi.hoisted(() => ({
  connectorViewed: vi.fn(),
  connectorConnectStarted: vi.fn(),
  connectorConnected: vi.fn(),
  connectorConnectionFailed: vi.fn(),
  connectorDisconnected: vi.fn(),
  customMcpServerClicked: vi.fn(),
}));

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  LayoutGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}));

vi.mock('@renderer/contexts/AppContext', () => ({
  useAppContext: () => ({ showToast: mockShowToast }),
}));

vi.mock('../../SettingsProvider', () => ({
  useSettings: () => ({ settings: {} }),
}));

vi.mock('../../hooks/useAppBridgePairedCount', () => ({
  useAppBridgePairedCount: () => ({ pairedCount: 0, refresh: vi.fn() }),
}));

vi.mock('../../hooks/useConnectSlackMcpAction', () => ({
  useConnectSlackMcpAction: () => ({
    connect: mockConnectSlack,
    isInFlight: false,
  }),
}));

// NOTE: deliberately NOT mocking '../../hooks/useConnectorSetupGuidance' — we use the
// real hook so that handleResult() actually sets guidance state and the real
// ConnectorSetupDialog renders, letting us assert the dialog opened.

vi.mock('../../hooks/useUnifiedConnections', () => ({
  useUnifiedConnections: () => ({
    connections: mockConnectionsState.connections,
    categoryTabs: [],
  }),
  computeUnifiedConnectionsSnapshot: () => ({
    connections: mockConnectionsState.connections,
  }),
  getConnectionAttentionState: () => 'healthy',
}));

vi.mock('@renderer/src/tracking', () => ({
  tracking: {
    settings: trackingMocks,
  },
}));

vi.mock('../ConnectionChip', () => ({
  ConnectionChip: ({
    connection,
    onClick,
  }: {
    connection: UnifiedConnection;
    onClick: () => void;
  }) => (
    <button type="button" aria-label={`${connection.name} connector`} onClick={onClick}>
      {connection.name}
    </button>
  ),
}));

vi.mock('../ExpandedConnectionCard', () => ({
  ExpandedConnectionCard: ({
    connection,
    onConnect,
  }: {
    connection: UnifiedConnection;
    onConnect?: (
      email?: string,
      options?: { launchRebel?: boolean },
    ) => void | Promise<void>;
  }) => (
    <section aria-label={`${connection.name} connector card`}>
      <h3>{connection.name}</h3>
      {/* Mirrors the real "Set up with Rebel" button: always passes launchRebel:true. */}
      <button
        type="button"
        aria-label={`Connect ${connection.name}`}
        onClick={() => void onConnect?.(undefined, { launchRebel: true })}
      >
        {`Connect ${connection.name}`}
      </button>
    </section>
  ),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const microsoftConnection: UnifiedConnection = {
  id: 'catalog:bundled-microsoft',
  name: 'Microsoft 365',
  description: 'Microsoft 365',
  icon: 'Plug',
  status: 'available',
  provider: 'bundled',
  catalogEntry: {
    id: 'bundled-microsoft',
    name: 'Microsoft 365',
    description: 'Microsoft 365',
    icon: 'Plug',
    provider: 'bundled',
    category: 'productivity',
    bundledConfig: {
      serverName: 'Microsoft365',
      authType: 'oauth',
      authApi: 'microsoftApi',
    },
  } as unknown as UnifiedConnection['catalogEntry'],
};

const notConfiguredGuidance: OAuthSetupGuidance = {
  code: 'oauth-credentials-not-configured',
  provider: 'microsoft',
  displayName: 'Microsoft',
  message: 'Microsoft needs OAuth client credentials before anyone can connect.',
  selfServe: true,
  setupUrl: 'https://entra.microsoft.com/',
  envVars: ['MICROSOFT_CLIENT_ID'],
  redirectUris: ['https://rebel-auth.mindstone.com/microsoft/callback'],
};

// Direct/community OAuth connector (GitHub, authMethod 'rebel-oauth') — exercises the
// post-bundled-branch launch guard (Stage 1b), which is a separate code path from the bundled one.
const githubConnection: UnifiedConnection = {
  id: 'catalog:github',
  name: 'GitHub',
  description: 'GitHub',
  icon: 'Plug',
  status: 'available',
  provider: 'direct',
  catalogEntry: {
    id: 'github',
    name: 'GitHub',
    description: 'GitHub',
    icon: 'Plug',
    provider: 'direct',
    category: 'productivity',
    authMethod: 'rebel-oauth',
    mcpConfig: {
      transport: 'stdio',
      oauth: true,
    },
  } as unknown as UnifiedConnection['catalogEntry'],
};

const githubNotConfiguredGuidance: OAuthSetupGuidance = {
  code: 'oauth-credentials-not-configured',
  provider: 'github',
  displayName: 'GitHub',
  message: 'GitHub needs OAuth client credentials before anyone can connect.',
  selfServe: true,
  setupUrl: 'https://github.com/settings/developers',
  envVars: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
  redirectUris: ['https://rebel-auth.mindstone.com/github/callback'],
};

function buttonByName(name: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.getAttribute('aria-label') === name || candidate.textContent === name,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${name}`);
  }
  return button;
}

function renderPanel({
  onConfigureWithRebel,
}: {
  onConfigureWithRebel?: (params: unknown) => void;
} = {}): { root: Root; container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <UnifiedConnectionsPanel
        servers={[]}
        onUpsertServer={vi.fn().mockResolvedValue(undefined)}
        onConfigureWithRebel={onConfigureWithRebel}
        mcpMutationPending={false}
        mcpSummary={{
          status: 'ready',
          mode: 'super-mcp',
          configPath: '/tmp/mcp.json',
          servers: [],
          upstreamCount: 0,
          lastLoadedAt: Date.parse('2026-05-23T12:00:00.000Z'),
        }}
        mcpSummaryLoading={false}
      />,
    );
  });

  return {
    root,
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('UnifiedConnectionsPanel — OSS not-configured connect (navigate-away-before-modal regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.api = {
      ...(window.api ?? {}),
      onSuperMcpRestartDeferred: () => () => {},
    } as never;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('opens the setup-guidance dialog and does NOT launch the Rebel setup chat when credentials are not configured', async () => {
    const onConfigureWithRebel = vi.fn();
    window.microsoftApi = {
      ...(window.microsoftApi ?? {}),
      // OSS build: no OAuth client credentials → structured not-configured guidance.
      startAuth: vi.fn().mockResolvedValue({ success: false, setupGuidance: notConfiguredGuidance }),
    } as never;
    mockConnectionsState.connections = [microsoftConnection];
    const mounted = renderPanel({ onConfigureWithRebel });

    act(() => {
      buttonByName('Microsoft 365 connector').click();
    });
    await act(async () => {
      // The only Settings connect button passes launchRebel:true.
      buttonByName('Connect Microsoft 365').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(window.microsoftApi.startAuth).toHaveBeenCalledTimes(1);
    // The fix: launchRebel branch is guarded by !isNotConfigured.
    expect(onConfigureWithRebel).not.toHaveBeenCalled();
    // The dialog the user should see instead of being navigated away.
    expect(document.querySelector('[data-testid="connector-setup-dialog"]')).not.toBeNull();

    mounted.unmount();
  });

  // Stage 1b: the direct/community OAuth branch (GitHub rebel-oauth path) has the same
  // navigate-away bug as the bundled branch; its launch block is now guarded by
  // !isOAuthSetupGuidance(oauthResult?.setupGuidance).
  it('does NOT launch the Rebel setup chat for a direct OAuth connector (GitHub) when credentials are not configured', async () => {
    const onConfigureWithRebel = vi.fn();
    window.githubApi = {
      ...(window.githubApi ?? {}),
      // OSS build: no OAuth client credentials → structured not-configured guidance.
      startAuth: vi
        .fn()
        .mockResolvedValue({ success: false, setupGuidance: githubNotConfiguredGuidance }),
    } as never;
    mockConnectionsState.connections = [githubConnection];
    const mounted = renderPanel({ onConfigureWithRebel });

    act(() => {
      buttonByName('GitHub connector').click();
    });
    await act(async () => {
      buttonByName('Connect GitHub').click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(window.githubApi.startAuth).toHaveBeenCalledTimes(1);
    expect(onConfigureWithRebel).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="connector-setup-dialog"]')).not.toBeNull();

    mounted.unmount();
  });
});
