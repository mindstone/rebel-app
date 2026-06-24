// @vitest-environment happy-dom

/**
 * Phase 7 (F1): when an onboarding-flow `generateAuthLink` start-auth hits the broken-by-default
 * branch (no OAuth client credentials), it must route the result through the hosted setup-guidance
 * funnel so OnboardingWizard opens the `ConnectorSetupDialog` — instead of dropping `setupGuidance`
 * into a generic `GENERATE_FAILED` error. Covers the Google, Slack, and Microsoft branches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { OAUTH_CREDENTIALS_NOT_CONFIGURED_CODE, type OAuthSetupGuidance } from '@shared/ipc/schemas/common';
import { act, cleanupFakeTimers, flushAsync, renderHook } from '@renderer/test-utils/hookTestHarness';
import {
  useOnboardingFlow,
  type OnboardingFlowActions,
  type OnboardingFlowState,
  type ToolType,
} from '../useOnboardingFlow';

const mockFetchSpaces = vi.hoisted(() => vi.fn());
const mockGetSpacesSnapshotFor = vi.hoisted(() => vi.fn());
const mockInvalidateSpaces = vi.hoisted(() => vi.fn());
const mockRendererIsOss = vi.hoisted(() => vi.fn(() => false));
const mockTracking = vi.hoisted(() => ({
  onboarding: {
    started: vi.fn(),
    stageEntered: vi.fn(),
    stepViewed: vi.fn(),
    stepCompleted: vi.fn(),
    completed: vi.fn(),
    spacesStepSkipped: vi.fn(),
    apiStepSkipped: vi.fn(),
    apiStepValidationFailed: vi.fn(),
    toolAuthLinkGenerated: vi.fn(),
    toolAuthVerified: vi.fn(),
    toolAuthError: vi.fn(),
  },
}));

vi.mock('@renderer/hooks/useSpacesData', () => ({
  fetchSpaces: mockFetchSpaces,
  getSpacesSnapshotFor: mockGetSpacesSnapshotFor,
  invalidateSpaces: mockInvalidateSpaces,
}));
vi.mock('@renderer/src/rendererIsOss', () => ({ rendererIsOss: mockRendererIsOss }));
vi.mock('@renderer/src/tracking', () => ({ tracking: mockTracking }));
vi.mock('@renderer/src/sentry', () => ({ recordRendererBreadcrumb: vi.fn() }));
vi.mock('@renderer/components/ui', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('@renderer/hooks/useSubscriptionState', () => ({
  useSubscriptionState: () => ({
    subscription: null,
    phase: 'ready',
    isActive: false,
    isPastDueWithinGrace: false,
    refresh: vi.fn(),
  }),
}));

type HookApi = { state: OnboardingFlowState; actions: OnboardingFlowActions };

function guidance(provider: string, displayName: string): OAuthSetupGuidance {
  return {
    code: OAUTH_CREDENTIALS_NOT_CONFIGURED_CODE,
    provider,
    displayName,
    message: `${displayName} OAuth app not configured.`,
    selfServe: true,
    setupUrl: 'https://example.test/console',
    envVars: [`${provider.toUpperCase()}_CLIENT_ID`, `${provider.toUpperCase()}_CLIENT_SECRET`],
    redirectUris: ['mindstone://callback'],
  };
}

function makeSettings(): AppSettings {
  return {
    onboardingCompleted: false,
    coreDirectory: null,
    companyName: 'Acme',
    activeProvider: 'anthropic',
    claude: { apiKey: null },
    openRouter: { oauthToken: null },
    voice: { provider: 'local-parakeet', openaiApiKey: null, elevenlabsApiKey: null },
  } as AppSettings;
}

function installWindowApis() {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { onAuthConfigReceived: vi.fn(() => vi.fn()), onSubscriptionCallback: vi.fn(() => vi.fn()) },
  });
  Object.defineProperty(window, 'libraryApi', {
    configurable: true,
    value: {
      detectGoogleDrive: vi.fn().mockResolvedValue({ installed: false }),
      detectOnedrive: vi.fn().mockResolvedValue({ installed: false, configured: false }),
      validatePath: vi.fn().mockResolvedValue({ errors: [], warnings: [] }),
      updateSpaceFrontmatter: vi.fn().mockResolvedValue({ success: true }),
    },
  });
  Object.defineProperty(window, 'authApi', { configurable: true, value: { getConfig: vi.fn().mockResolvedValue(null) } });
  Object.defineProperty(window, 'dashboardApi', {
    configurable: true,
    value: { generateUseCases: vi.fn().mockResolvedValue({ success: true, useCases: [] }) },
  });
  Object.defineProperty(window, 'permissionsApi', {
    configurable: true,
    value: {
      getMicrophoneStatus: vi.fn().mockResolvedValue('granted'),
      checkFileAccess: vi.fn().mockResolvedValue({ hasAccess: true }),
    },
  });
  Object.defineProperty(window, 'googleWorkspaceApi', {
    configurable: true,
    value: { getAccounts: vi.fn().mockResolvedValue({ accounts: [] }), startAuth: vi.fn().mockResolvedValue({ success: true }) },
  });
  Object.defineProperty(window, 'miscApi', {
    configurable: true,
    value: {
      getToolAuthUrl: vi.fn().mockResolvedValue({ success: true, authUrl: 'https://auth.example.test/x' }),
      verifyToolAuth: vi.fn().mockResolvedValue({ success: true, isAuthenticated: false }),
    },
  });
  Object.defineProperty(window, 'appApi', { configurable: true, value: { openUrl: vi.fn().mockResolvedValue(undefined) } });
  Object.defineProperty(window, 'slackApi', {
    configurable: true,
    value: {
      startAuth: vi.fn().mockResolvedValue({ success: true, teamName: 'Acme Slack' }),
      getWorkspaces: vi.fn().mockResolvedValue({ workspaces: [] }),
    },
  });
  Object.defineProperty(window, 'microsoftApi', {
    configurable: true,
    value: {
      startAuth: vi.fn().mockResolvedValue({ success: true, email: 'user@example.test' }),
      isConnected: vi.fn().mockResolvedValue({ connected: false }),
    },
  });
}

function renderOnboardingHook() {
  return renderHook<HookApi>(() =>
    useOnboardingFlow({ isOpen: true, draftSettings: makeSettings(), completeOnboarding: vi.fn().mockResolvedValue(undefined) }),
  );
}

function statusFor(result: { current: HookApi }, tool: ToolType): string | undefined {
  return result.current.state.toolAuthStates.find((s) => s.tool === tool)?.status;
}

function setupRequiredFor(result: { current: HookApi }, tool: ToolType): boolean | undefined {
  return result.current.state.toolAuthStates.find((s) => s.tool === tool)?.setupRequired;
}

describe('useOnboardingFlow — setup guidance', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('DEV', false);
    installWindowApis();
    mockFetchSpaces.mockReset().mockResolvedValue(undefined);
    mockGetSpacesSnapshotFor.mockReset().mockReturnValue({ spaces: [], ready: true, error: false, parseWarnings: [] });
    mockInvalidateSpaces.mockReset();
    mockRendererIsOss.mockReset().mockReturnValue(false);
    Object.values(mockTracking.onboarding).forEach((fn) => fn.mockClear());
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    cleanupFakeTimers();
    vi.unstubAllEnvs();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('opens the setup-guidance dialog on a Google start-auth credentials-miss (no error status)', async () => {
    window.googleWorkspaceApi.startAuth = vi
      .fn()
      .mockResolvedValue({ success: false, error: 'Google OAuth app not configured.', setupGuidance: guidance('google', 'Google') });
    const { result, unmount } = renderOnboardingHook();

    expect(result.current.state.setupGuidance.isOpen).toBe(false);

    await act(async () => {
      await result.current.actions.generateAuthLink('gmail');
    });
    await flushAsync();

    expect(result.current.state.setupGuidance.isOpen).toBe(true);
    expect(result.current.state.setupGuidance.guidance?.provider).toBe('google');
    // Routed to dialog → NOT surfaced as a tool error.
    expect(statusFor(result, 'gmail')).not.toBe('error');
    unmount();
  });

  it('resets the Gmail tile out of the stuck skeleton on a credentials-miss (not generating, setupRequired)', async () => {
    window.googleWorkspaceApi.startAuth = vi
      .fn()
      .mockResolvedValue({ success: false, error: 'Google OAuth app not configured.', setupGuidance: guidance('google', 'Google') });
    const { result, unmount } = renderOnboardingHook();

    await act(async () => {
      await result.current.actions.generateAuthLink('gmail');
    });
    await flushAsync();

    // Bug regression: must NOT be stuck in `generating` (the permanent-skeleton state).
    expect(statusFor(result, 'gmail')).not.toBe('generating');
    expect(statusFor(result, 'gmail')).toBe('pending');
    expect(setupRequiredFor(result, 'gmail')).toBe(true);
    unmount();
  });

  it('unblocks progression (toolAuthReady) on a Gmail credentials-miss when running OSS (F3)', async () => {
    mockRendererIsOss.mockReturnValue(true);
    window.googleWorkspaceApi.startAuth = vi
      .fn()
      .mockResolvedValue({ success: false, error: 'Google OAuth app not configured.', setupGuidance: guidance('google', 'Google') });
    const { result, unmount } = renderOnboardingHook();

    // In OSS, progression is unblocked up front (no connector interaction needed) —
    // see the dedicated initial-render regression test below.
    expect(result.current.state.toolAuthReady).toBe(true);

    await act(async () => {
      await result.current.actions.generateAuthLink('gmail');
    });
    await flushAsync();

    expect(result.current.state.toolAuthReady).toBe(true);
    unmount();
  });

  it('unblocks progression (toolAuthReady) in OSS on initial render — no connector interaction (bug regression)', () => {
    // Bug: the Continue button on the connectors step was disabled until the user
    // clicked a connector and hit the BYO-client wall (which set setupRequired=true).
    // The fix returns toolAuthReady=true up front in OSS. Pre-fix this was `false`
    // on initial render because the setupRequired-based clause hadn't fired yet.
    mockRendererIsOss.mockReturnValue(true);
    const { result, unmount } = renderOnboardingHook();

    // No generateAuthLink call, no SETUP_REQUIRED dispatch, no email tool connected.
    expect(setupRequiredFor(result, 'gmail')).not.toBe(true);
    expect(statusFor(result, 'gmail')).not.toBe('error');
    expect(result.current.state.toolAuthReady).toBe(true);
    unmount();
  });

  it('does NOT unblock progression in a commercial build on initial render (no regression)', () => {
    // Dev-mode skip off (canSkipToolAuth=false via stubEnv DEV=false in beforeEach)
    // and OSS detection off → the email gate is enforced: no email connected/errored
    // means the connectors-step Continue stays blocked on initial render.
    mockRendererIsOss.mockReturnValue(false);
    const { result, unmount } = renderOnboardingHook();

    expect(result.current.state.toolAuthReady).toBe(false);
    unmount();
  });

  it('does NOT unblock progression on a Gmail credentials-miss in a NON-OSS build (F3 gate)', async () => {
    mockRendererIsOss.mockReturnValue(false);
    window.googleWorkspaceApi.startAuth = vi
      .fn()
      .mockResolvedValue({ success: false, error: 'Google OAuth app not configured.', setupGuidance: guidance('google', 'Google') });
    const { result, unmount } = renderOnboardingHook();

    await act(async () => {
      await result.current.actions.generateAuthLink('gmail');
    });
    await flushAsync();

    // The FSM reset still fires (tile isn't stuck), but a misconfigured commercial
    // build must NOT be able to skip the required email connect.
    expect(statusFor(result, 'gmail')).toBe('pending');
    expect(setupRequiredFor(result, 'gmail')).toBe(true);
    expect(result.current.state.toolAuthReady).toBe(false);
    unmount();
  });

  it('does not auto-re-fire generation after a Gmail credentials-miss reset (startAuth called once)', async () => {
    const startAuth = vi
      .fn()
      .mockResolvedValue({ success: false, error: 'Google OAuth app not configured.', setupGuidance: guidance('google', 'Google') });
    window.googleWorkspaceApi.startAuth = startAuth;
    const { result, unmount } = renderOnboardingHook();

    await act(async () => {
      await result.current.actions.generateAuthLink('gmail');
    });
    await flushAsync();
    // Let any auto-gen effect / re-render settle.
    await act(async () => {
      await flushAsync();
    });

    expect(statusFor(result, 'gmail')).toBe('pending');
    expect(setupRequiredFor(result, 'gmail')).toBe(true);
    expect(startAuth).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('opens the setup-guidance dialog on a Slack start-auth credentials-miss', async () => {
    window.slackApi.startAuth = vi
      .fn()
      .mockResolvedValue({ success: false, error: 'Slack OAuth app not configured.', setupGuidance: guidance('slack', 'Slack') });
    const { result, unmount } = renderOnboardingHook();

    await act(async () => {
      await result.current.actions.generateAuthLink('slack');
    });
    await flushAsync();

    expect(result.current.state.setupGuidance.isOpen).toBe(true);
    expect(result.current.state.setupGuidance.guidance?.provider).toBe('slack');
    unmount();
  });

  it('opens the setup-guidance dialog on a Microsoft start-auth credentials-miss', async () => {
    window.microsoftApi.startAuth = vi
      .fn()
      .mockResolvedValue({ success: false, error: 'Microsoft OAuth app not configured.', setupGuidance: guidance('microsoft', 'Microsoft 365') });
    const { result, unmount } = renderOnboardingHook();

    await act(async () => {
      await result.current.actions.generateAuthLink('outlook-mail');
    });
    await flushAsync();

    expect(result.current.state.setupGuidance.isOpen).toBe(true);
    expect(result.current.state.setupGuidance.guidance?.provider).toBe('microsoft');
    unmount();
  });

  it('resets the Outlook Mail tile out of the stuck skeleton and unblocks progression in OSS', async () => {
    mockRendererIsOss.mockReturnValue(true);
    window.microsoftApi.startAuth = vi
      .fn()
      .mockResolvedValue({ success: false, error: 'Microsoft OAuth app not configured.', setupGuidance: guidance('microsoft', 'Microsoft 365') });
    const { result, unmount } = renderOnboardingHook();

    await act(async () => {
      await result.current.actions.generateAuthLink('outlook-mail');
    });
    await flushAsync();

    expect(statusFor(result, 'outlook-mail')).not.toBe('generating');
    expect(statusFor(result, 'outlook-mail')).toBe('pending');
    expect(setupRequiredFor(result, 'outlook-mail')).toBe(true);
    expect(result.current.state.toolAuthReady).toBe(true);
    unmount();
  });

  it('a Slack-only credentials-miss still resets the tile in OSS (FSM reset preserved)', async () => {
    // NOTE: the prior version of this test asserted the email gate stayed blocked
    // after a Slack-only miss (the old EMAIL_TOOLS F2 scoping). That scoping is
    // superseded: in OSS the connectors step is freely skippable (toolAuthReady is
    // true up front regardless of tool), so the gate-blocked assertion no longer
    // applies. The tile-reset (FSM) behavior is unchanged and still asserted here.
    mockRendererIsOss.mockReturnValue(true);
    window.slackApi.startAuth = vi
      .fn()
      .mockResolvedValue({ success: false, error: 'Slack OAuth app not configured.', setupGuidance: guidance('slack', 'Slack') });
    const { result, unmount } = renderOnboardingHook();

    await act(async () => {
      await result.current.actions.generateAuthLink('slack');
    });
    await flushAsync();

    // Slack tile resets (not stuck) and is flagged...
    expect(statusFor(result, 'slack')).not.toBe('generating');
    expect(statusFor(result, 'slack')).toBe('pending');
    expect(setupRequiredFor(result, 'slack')).toBe(true);
    // ...and in OSS progression is unblocked regardless of which tool was attempted.
    expect(result.current.state.toolAuthReady).toBe(true);
    unmount();
  });

  it('does NOT open the dialog for an ordinary (non-credential) start-auth failure', async () => {
    window.googleWorkspaceApi.startAuth = vi.fn().mockResolvedValue({ success: false, error: 'User cancelled' });
    const { result, unmount } = renderOnboardingHook();

    await act(async () => {
      await result.current.actions.generateAuthLink('gmail');
    });
    await flushAsync();

    expect(result.current.state.setupGuidance.isOpen).toBe(false);
    // Generic failure still drives the normal error path.
    expect(statusFor(result, 'gmail')).toBe('error');
    unmount();
  });
});
