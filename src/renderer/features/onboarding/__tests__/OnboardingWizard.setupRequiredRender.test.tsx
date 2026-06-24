// @vitest-environment happy-dom

/**
 * Regression (GPT review F6): pin the VISIBLE render path + the auto-gen suppression
 * for a `pending + setupRequired` email tool — the OSS BYO-client reset end-state.
 *
 * The hook-level test (`useOnboardingFlow.setupGuidance.test.tsx`) calls
 * `generateAuthLink` directly, so it would still pass even if the wizard auto-gen
 * `setupRequired` guard or the visible chip render regressed. These two tests close
 * that gap:
 *
 *  1. ToolAuthStep.renderExistingProvider renders a clickable "Set up" affordance —
 *     NOT a skeleton, NOT an error/Retry chip — for a `pending + setupRequired` Gmail
 *     tool (`showSkeleton = isGeneratingStatus`, so a stuck `generating` would have
 *     shown a skeleton instead).
 *  2. The OnboardingWizard auto-gen effect does NOT re-fire `generateAuthLink` for a
 *     `setupRequired` pending tool (the guard at OnboardingWizard.tsx is load-bearing).
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type {
  OnboardingFlowActions,
  OnboardingFlowState,
  ToolAuthState,
} from '../hooks/useOnboardingFlow';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// --- shared lightweight mocks ------------------------------------------------

vi.mock('@renderer/features/settings/SettingsProvider', () => ({
  useSettings: () => ({
    mcpSummary: { editableServers: [], servers: [], router: { upstreamServers: [] } },
    refreshMcpSummary: vi.fn().mockResolvedValue(undefined),
    upsertMcpServer: vi.fn(),
    removeMcpServer: vi.fn(),
  }),
}));
vi.mock('@renderer/features/settings/hooks/useUnifiedConnections', () => ({
  useUnifiedConnections: () => ({ connections: [] }),
  matchesConnectorSearch: () => true,
}));
vi.mock('@renderer/features/settings/hooks/useConnectorSetupGuidance', () => ({
  useConnectorSetupGuidance: () => ({
    guidance: null,
    isOpen: false,
    handleResult: () => false,
    open: vi.fn(),
    setOpen: vi.fn(),
    close: vi.fn(),
  }),
}));

function makeGmailToolState(overrides: Partial<ToolAuthState> = {}): ToolAuthState {
  return {
    tool: 'gmail',
    displayName: 'Gmail',
    description: 'Gmail',
    serverName: 'gmail',
    status: 'pending',
    authUrl: null,
    error: null,
    awaitingSince: null,
    required: true,
    setupRequired: true,
    ...overrides,
  };
}

function makeDraftSettings(): AppSettings {
  return {
    activeProvider: 'anthropic',
    claude: { apiKey: null },
    coreDirectory: null,
    onboardingCompleted: false,
    voice: { provider: 'local-parakeet', openaiApiKey: null, elevenlabsApiKey: null },
  } as AppSettings;
}

function makeState(overrides: Partial<OnboardingFlowState> = {}): OnboardingFlowState {
  return {
    stepIndex: 4,
    activeStep: 'toolAuth',
    totalSteps: 5,
    canProceed: true,
    triedContinue: false,
    stepSequence: ['welcome', 'googleDrive', 'api', 'voiceSetup', 'toolAuth'],
    apiKeyValidationStatus: 'idle',
    canSkipApiStep: false,
    microphoneStatus: 'granted',
    isCompleting: false,
    completionError: null,
    canSkipToolAuth: false,
    toolAuthStates: [makeGmailToolState()],
    isGeneratingAuthLinks: false,
    isVerifyingAuth: false,
    toolAuthReady: true,
    activeAuthTool: 'gmail',
    userFirstName: null,
    fetchingUserName: false,
    workspaceReady: false,
    workspaceValidation: { checking: false, errors: [], warnings: [] },
    claudeReady: true,
    voiceReady: true,
    voiceProvider: 'local-parakeet',
    googleDriveInstalled: false,
    companyName: '',
    googleDriveError: null,
    googleDriveReady: true,
    connectedSpaces: [],
    orgCompanyDisplayName: null,
    orgHasSpaces: false,
    orgSharedDriveProvider: null,
    oneDriveInstalled: false,
    oneDriveConfigured: false,
    useCaseGenerationStatus: 'idle',
    useCaseGenerationError: null,
    generatedUseCases: [],
    useCasesReady: true,
    eulaAccepted: true,
    setupGuidance: {
      guidance: null,
      isOpen: false,
      handleResult: () => false,
      open: () => undefined,
      setOpen: () => undefined,
      close: () => undefined,
    },
    ...overrides,
  };
}

function makeActions(overrides: Partial<OnboardingFlowActions> = {}): OnboardingFlowActions {
  return {
    setStepIndex: vi.fn(),
    goNext: vi.fn(),
    goBack: vi.fn(),
    completeOnboardingWithOrganisationSeed: vi.fn(),
    setMicrophoneStatus: vi.fn(),
    setIsCompleting: vi.fn(),
    setCompletionError: vi.fn(),
    updateToolAuthState: vi.fn(),
    setToolAuthStatusForTest: vi.fn(),
    clearToolAuthError: vi.fn(),
    observeCatalogConnection: vi.fn(),
    markToolAuthConnected: vi.fn(),
    disconnectToolAuth: vi.fn(),
    generateAuthLink: vi.fn(),
    startOAuthFlow: vi.fn(),
    verifyToolAuth: vi.fn(),
    skipTool: vi.fn(),
    setUserFirstName: vi.fn(),
    setFetchingUserName: vi.fn(),
    handleFinish: vi.fn(),
    setGoogleDriveInstalled: vi.fn(),
    setCompanyName: vi.fn(),
    setGoogleDriveError: vi.fn(),
    addConnectedSpace: vi.fn(),
    removeConnectedSpace: vi.fn(),
    refreshConnectedSpaces: vi.fn(),
    startUseCaseGeneration: vi.fn(),
    retryUseCaseGeneration: vi.fn(),
    setEulaAccepted: vi.fn(),
    startMigrationImportBranch: vi.fn(),
    startStandardSetupBranch: vi.fn(),
    ...overrides,
  };
}

type Mounted = { root: Root; container: HTMLDivElement; unmount: () => void };

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// --- #1: ToolAuthStep visible primary tile -----------------------------------

describe('ToolAuthStep — setupRequired Gmail tile renders a clickable "Set up" (not skeleton/error)', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('shows a clickable Set up affordance and no skeleton / no error chip', async () => {
    const { ToolAuthStep } = await import('../steps/ToolAuthStep');
    const generateAuthLink = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <ToolAuthStep
          state={makeState()}
          actions={makeActions({ generateAuthLink })}
          draftSettings={makeDraftSettings()}
          isDevMode={false}
          renderToolStatus={() => <span data-testid="render-tool-status" />}
        />,
      );
    });
    await flushEffects();

    mounted = { root, container, unmount: () => { act(() => root.unmount()); container.remove(); } };

    // A clickable "Set up Gmail" affordance is present...
    const setUp = container.querySelector('[aria-label="Set up Gmail"]');
    expect(setUp).not.toBeNull();
    expect((setUp as HTMLButtonElement).disabled).toBe(false);
    expect(container.textContent).toContain('Set up');

    // ...and it is NOT a skeleton and NOT a Retry/error chip (stuck `generating` would
    // have shown a skeleton; an `error` status would have shown Retry).
    expect(container.querySelector('[aria-label="Retry Gmail"]')).toBeNull();
    expect(container.textContent).not.toContain('Retry');
  });
});

// --- #2: OnboardingWizard auto-gen suppression -------------------------------

describe('OnboardingWizard — auto-gen does NOT re-fire for a setupRequired pending tool', () => {
  const settingsContext = { value: null as unknown };
  const flowContext = { state: null as unknown, actions: null as unknown };
  let mounted: Mounted | null = null;

  beforeEach(() => {
    // Re-mock the wizard's collaborators for this block. The real OnboardingWizard
    // (with its real auto-gen effect) is mounted; ToolAuthStep is stubbed because the
    // effect lives in OnboardingWizard and does not depend on the step's render.
    vi.doMock('../../settings', () => ({ useSettings: () => settingsContext.value }));
    vi.doMock('../hooks', () => ({
      DISPLAY_STEPS: ['welcome', 'googleDrive', 'api', 'voiceSetup', 'toolAuth'],
      STEP_ACCESSIBLE_LABELS: { welcome: 'Welcome', googleDrive: 'Library', api: 'API', voiceSetup: 'Voice', toolAuth: 'Tools' },
      STEP_LABELS: { welcome: 'Welcome', googleDrive: 'Library', api: 'API', voiceSetup: 'Voice', toolAuth: 'Tools' },
      useOnboardingFlow: () => ({ state: flowContext.state, actions: flowContext.actions }),
    }));
    vi.doMock('../hooks/useEscapeHatchHotkey', () => ({ useEscapeHatchHotkey: vi.fn() }));
    vi.doMock('@renderer/hooks/useTimeoutRef', () => ({ useTimeoutRef: () => ({ clear: vi.fn(), set: vi.fn() }) }));
    vi.doMock('@renderer/src/tracking', () => ({
      tracking: { onboarding: {
        completed: vi.fn(), escapeHatchCancelled: vi.fn(), escapeHatchConfirmed: vi.fn(),
        escapeHatchTriggered: vi.fn(), microphonePermissionDenied: vi.fn(), microphonePermissionGranted: vi.fn(),
        microphonePermissionRequested: vi.fn(), stepCompleted: vi.fn(),
      } },
    }));
    vi.doMock('../components', () => ({
      SideAnnotation: ({ children }: { children: React.ReactNode }) => <aside>{children}</aside>,
      StepPill: ({ label }: { label: string }) => <button type="button">{label}</button>,
    }));
    vi.doMock('../steps', () => ({
      ApiStep: () => <div data-testid="api-step" />,
      GoogleDriveStep: () => <div data-testid="google-drive-step" />,
      ToolAuthStep: () => <div data-testid="tool-auth-step" />,
      VoiceSetupStep: () => <div data-testid="voice-setup-step" />,
      WelcomeStep: () => <div data-testid="welcome-step" />,
    }));

    Object.defineProperty(window, 'electronEnv', { configurable: true, value: { platform: 'linux' } });
    Object.defineProperty(window, 'settingsApi', {
      configurable: true,
      value: { getDefaultWorkspace: vi.fn().mockResolvedValue('/tmp/ws'), validateClaudeKey: vi.fn(), validateOpenaiKey: vi.fn(), validateElevenlabsKey: vi.fn() },
    });
    Object.defineProperty(window, 'systemHealthApi', {
      configurable: true,
      value: { validateWorkspaceAccess: vi.fn().mockResolvedValue({ accessible: true }) },
    });
    Object.defineProperty(window, 'permissionsApi', {
      configurable: true,
      value: { getMicrophoneStatus: vi.fn().mockResolvedValue('granted'), openSystemPreferences: vi.fn(), requestMicrophone: vi.fn().mockResolvedValue({ granted: true }) },
    });
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('does not call generateAuthLink on mount for a setupRequired pending tool', async () => {
    const generateAuthLink = vi.fn();
    flowContext.state = makeState({ activeStep: 'toolAuth', activeAuthTool: 'gmail', toolAuthStates: [makeGmailToolState()] });
    flowContext.actions = makeActions({ generateAuthLink });
    settingsContext.value = {
      draftSettings: makeDraftSettings(),
      updateDraft: vi.fn(),
      updateClaude: vi.fn(),
      updateVoice: vi.fn(),
      saveSettings: vi.fn().mockResolvedValue(undefined),
    };

    const { OnboardingWizard } = await import('../OnboardingWizard');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<OnboardingWizard isOpen completeOnboarding={vi.fn().mockResolvedValue(undefined)} />);
    });
    await flushEffects();
    await flushEffects();

    mounted = { root, container, unmount: () => { act(() => root.unmount()); container.remove(); } };

    // The auto-gen guard must suppress re-firing for a setupRequired tile.
    expect(generateAuthLink).not.toHaveBeenCalled();
  });

  it('control: WITHOUT setupRequired, a pending activeAuthTool DOES auto-fire generateAuthLink', async () => {
    const generateAuthLink = vi.fn();
    flowContext.state = makeState({
      activeStep: 'toolAuth',
      activeAuthTool: 'gmail',
      toolAuthStates: [makeGmailToolState({ setupRequired: false })],
    });
    flowContext.actions = makeActions({ generateAuthLink });
    settingsContext.value = {
      draftSettings: makeDraftSettings(),
      updateDraft: vi.fn(),
      updateClaude: vi.fn(),
      updateVoice: vi.fn(),
      saveSettings: vi.fn().mockResolvedValue(undefined),
    };

    const { OnboardingWizard } = await import('../OnboardingWizard');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<OnboardingWizard isOpen completeOnboarding={vi.fn().mockResolvedValue(undefined)} />);
    });
    await flushEffects();
    await flushEffects();

    mounted = { root, container, unmount: () => { act(() => root.unmount()); container.remove(); } };

    // Non-vacuity: proves the test would catch a removed guard (this control fires).
    expect(generateAuthLink).toHaveBeenCalledWith('gmail');
  });
});
