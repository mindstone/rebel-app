// @vitest-environment happy-dom
//
// Contract test for postmortem 260211
// (onboarding_auth_refresh_draft_key_deadlock).
//
// The race: onboarding writes draft-only values (`coreDirectory`,
// `eulaAcceptedAt`) into `draftSettings` and relies on the 800ms autosave
// debounce to persist them. Separately, `onAuthConfigReceived` /
// `onSettingsExternalUpdate` trigger `refreshSettings()`, which replaces the
// draft with server-fetched values immediately. If that refresh fires BEFORE
// the debounce flushes, the draft loses the very keys `canProceed` needs and
// the onboarding "Continue" button silently deadlocks.
//
// The shipped fix merges caller-requested draft keys plus the centralized
// onboarding lifecycle floor back over the server snapshot.
//
// This test asserts the SPECIFIC required keys survive (not merely
// `canProceed === true`), so an incomplete preserve set cannot pass green by
// accident.
//
// NON-VACUOUSNESS: the server settings returned by `settingsApi.get()` (used by
// `refreshSettings`) intentionally OMIT `coreDirectory` and `eulaAcceptedAt`.
// The only way those keys can be present in the draft after the refresh is the
// `preserveDraftKeys` merge. If `preserveDraftKeys` were removed from the
// `onAuthConfigReceived` / `onSettingsExternalUpdate` handlers, the post-refresh
// draft would carry the server snapshot's values (undefined/null) and this test
// would go RED.
//
// GUARD: if a future required onboarding draft key is added, it MUST be covered
// by the refreshSettings preservation contract in useSettingsFeature.ts AND
// asserted here. This test guards `coreDirectory`, `eulaAcceptedAt`, and
// onboarding lifecycle keys specifically.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanupFakeTimers, flushAsync, renderHook, setupFakeTimers } from '@renderer/test-utils';
import type { AppSettings } from '@shared/types';
import { useSettingsFeature } from '../useSettingsFeature';

const ONBOARDING_CORE_DIRECTORY = '/Users/test/MindstoneLibrary';
const ONBOARDING_EULA_ACCEPTED_AT = 1_700_000_000_000;
const ONBOARDING_FIRST_COMPLETED_AT = 1_700_000_010_000;
const ONBOARDING_COMPLETED_AT = 1_700_000_020_000;

let getMock: ReturnType<typeof vi.fn>;
let updateMock: ReturnType<typeof vi.fn>;

/**
 * The settings the MAIN process returns from `settingsApi.get()` during the
 * auth-config refresh. This represents the server/persisted snapshot AFTER login
 * but BEFORE the onboarding draft has been autosaved — so it deliberately has NO
 * `coreDirectory` and NO `eulaAcceptedAt`. Those live only in the unsaved draft.
 */
const makeServerSettingsWithoutDraftKeys = (): AppSettings => ({
  coreDirectory: null,
  eulaAcceptedAt: null,
  mcpConfigFile: null,
  onboardingCompleted: false,
  userEmail: '[Mindstone-email]',
  onboardingFirstCompletedAt: null,
  voice: {
    provider: 'openai-whisper',
    openaiApiKey: null,
    elevenlabsApiKey: null,
    model: 'gpt-4o-mini-transcribe-2025-12-15',
    ttsVoice: null,
    activationHotkey: null,
    activationHotkeyVoiceMode: true,
  },
  claude: {
    apiKey: null,
    oauthToken: null,
    authMethod: 'api-key',
    model: 'claude-sonnet-4-6',
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: false,
    extendedContext: true,
    thinkingEffort: 'high',
  },
  models: {
    // Auth config delivered a server-provisioned API key — the whole reason a
    // refresh fires after login.
    apiKey: 'server-provisioned-key',
    oauthToken: null,
    authMethod: 'api-key',
    model: 'claude-opus-4-7',
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: false,
    extendedContext: true,
    thinkingEffort: 'high',
  },
  diagnostics: {
    debugBreadcrumbsUntil: null,
  },
  localModel: {
    profiles: [],
    activeProfileId: null,
  },
  openRouter: {
    enabled: false,
    oauthToken: null,
    selectedModel: 'openai/gpt-5.5',
  },
  activeProvider: 'anthropic',
} as AppSettings);

describe('useSettingsFeature — 260211 draft-key vs auth-refresh race', () => {
  // Captured handlers the hook registers via useIpcEvent; invoking them
  // simulates the external IPC event firing.
  let demoModeHandler: (() => void) | undefined;
  let authConfigHandler: (() => void) | undefined;
  let externalUpdateHandler: (() => void) | undefined;

  beforeEach(() => {
    setupFakeTimers();
    demoModeHandler = undefined;
    authConfigHandler = undefined;
    externalUpdateHandler = undefined;

    Object.assign(window, {
      api: {
        onDemoModeChange: vi.fn((handler: () => void) => {
          demoModeHandler = handler;
          return () => {};
        }),
        onSettingsExternalUpdate: vi.fn((handler: () => void) => {
          externalUpdateHandler = handler;
          return () => {};
        }),
        onAuthConfigReceived: vi.fn((handler: () => void) => {
          authConfigHandler = handler;
          return () => {};
        }),
        getAnalyticsStatus: vi.fn(async () => null),
      },
      settingsApi: {
        // Initial mount + every refresh fetch the server snapshot that LACKS
        // the onboarding draft keys.
        get: vi.fn(async () => makeServerSettingsWithoutDraftKeys()),
        update: vi.fn(async (next: AppSettings) => next),
      },
    });
    getMock = window.settingsApi.get as ReturnType<typeof vi.fn>;
    updateMock = window.settingsApi.update as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    cleanupFakeTimers();
    vi.restoreAllMocks();
  });

  it('preserves coreDirectory and eulaAcceptedAt when onAuthConfigReceived refresh races the autosave debounce', async () => {
    const { result, unmount } = renderHook(() => useSettingsFeature({
      emitLog: vi.fn(),
      showToast: vi.fn(),
    }));

    // Let the mount-time refreshSettings() settle.
    await flushAsync();
    await flushAsync();

    // Onboarding populates the required draft keys. updateDraft schedules the
    // 800ms autosave debounce; we deliberately do NOT advance past it.
    act(() => {
      result.current.updateDraft('coreDirectory', ONBOARDING_CORE_DIRECTORY);
    });
    act(() => {
      result.current.updateDraft('eulaAcceptedAt', ONBOARDING_EULA_ACCEPTED_AT);
    });

    // Sanity: the draft holds the onboarding values pre-refresh.
    expect(result.current.draftSettings?.coreDirectory).toBe(ONBOARDING_CORE_DIRECTORY);
    expect(result.current.draftSettings?.eulaAcceptedAt).toBe(ONBOARDING_EULA_ACCEPTED_AT);

    // The autosave debounce (800ms) has NOT fired yet — the values are
    // draft-only. Now auth config arrives and triggers a refresh.
    expect(authConfigHandler).toBeTypeOf('function');
    await act(async () => {
      authConfigHandler?.();
      await flushAsync();
    });

    // The server-provisioned key flows in (refresh did happen)...
    expect(result.current.draftSettings?.models?.apiKey).toBe('server-provisioned-key');

    // ...but the unsaved onboarding draft keys MUST survive the refresh.
    // Assert the EXACT keys (not merely canProceed) so an incomplete
    // preserveDraftKeys set cannot pass green by accident.
    expect(result.current.draftSettings?.coreDirectory).toBe(ONBOARDING_CORE_DIRECTORY);
    expect(result.current.draftSettings?.eulaAcceptedAt).toBe(ONBOARDING_EULA_ACCEPTED_AT);

    unmount();
  });

  it('preserves coreDirectory and eulaAcceptedAt when onSettingsExternalUpdate refresh races the autosave debounce', async () => {
    const { result, unmount } = renderHook(() => useSettingsFeature({
      emitLog: vi.fn(),
      showToast: vi.fn(),
    }));

    await flushAsync();
    await flushAsync();

    act(() => {
      result.current.updateDraft('coreDirectory', ONBOARDING_CORE_DIRECTORY);
    });
    act(() => {
      result.current.updateDraft('eulaAcceptedAt', ONBOARDING_EULA_ACCEPTED_AT);
    });

    expect(externalUpdateHandler).toBeTypeOf('function');
    await act(async () => {
      externalUpdateHandler?.();
      await flushAsync();
    });

    expect(result.current.draftSettings?.coreDirectory).toBe(ONBOARDING_CORE_DIRECTORY);
    expect(result.current.draftSettings?.eulaAcceptedAt).toBe(ONBOARDING_EULA_ACCEPTED_AT);

    unmount();
  });

  it('preserves onboarding lifecycle keys during a refresh call that passes no preserveDraftKeys', async () => {
    const { result, unmount } = renderHook(() => useSettingsFeature({
      emitLog: vi.fn(),
      showToast: vi.fn(),
    }));

    await flushAsync();
    await flushAsync();

    await act(async () => {
      await result.current.saveSettingsWith((current) => ({
        ...current,
        onboardingCompleted: true,
        onboardingFirstCompletedAt: ONBOARDING_FIRST_COMPLETED_AT,
        onboardingCompletedAt: ONBOARDING_COMPLETED_AT,
        onboardingChecklist: { step: 1 },
      }));
    });

    expect(result.current.draftSettings?.onboardingCompleted).toBe(true);

    getMock.mockResolvedValueOnce({
      ...makeServerSettingsWithoutDraftKeys(),
      models: {
        ...makeServerSettingsWithoutDraftKeys().models,
        apiKey: 'demo-refresh-server-key',
      },
    });

    expect(demoModeHandler).toBeTypeOf('function');
    await act(async () => {
      demoModeHandler?.();
      await flushAsync();
    });

    // Demo-mode refresh calls refreshSettings() with no preserveDraftKeys. These
    // values survive only because refreshSettings centrally adds the lifecycle floor.
    expect(result.current.draftSettings?.models?.apiKey).toBe('demo-refresh-server-key');
    expect(result.current.draftSettings?.onboardingCompleted).toBe(true);
    expect(result.current.draftSettings?.onboardingFirstCompletedAt).toBe(ONBOARDING_FIRST_COMPLETED_AT);
    expect(result.current.draftSettings?.onboardingCompletedAt).toBe(ONBOARDING_COMPLETED_AT);
    expect(result.current.draftSettings?.onboardingChecklist).toEqual({ step: 1 });

    unmount();
  });

  it('preserves onboarding lifecycle keys and the autosave payload when onAuthConfigReceived refresh races the debounce', async () => {
    const { result, unmount } = renderHook(() => useSettingsFeature({
      emitLog: vi.fn(),
      showToast: vi.fn(),
    }));

    await flushAsync();
    await flushAsync();

    act(() => {
      result.current.updateDraft('coreDirectory', ONBOARDING_CORE_DIRECTORY);
    });
    await act(async () => {
      await result.current.saveSettingsWith((current) => ({
        ...current,
        onboardingCompleted: true,
        onboardingFirstCompletedAt: ONBOARDING_FIRST_COMPLETED_AT,
        onboardingCompletedAt: ONBOARDING_COMPLETED_AT,
        onboardingChecklist: { step: 1 },
      }));
    });
    updateMock.mockClear();

    expect(result.current.draftSettings?.onboardingCompleted).toBe(true);

    expect(authConfigHandler).toBeTypeOf('function');
    await act(async () => {
      authConfigHandler?.();
      await flushAsync();
    });

    expect(result.current.draftSettings?.models?.apiKey).toBe('server-provisioned-key');
    expect(result.current.draftSettings?.onboardingCompleted).toBe(true);
    expect(result.current.draftSettings?.onboardingFirstCompletedAt).toBe(ONBOARDING_FIRST_COMPLETED_AT);
    expect(result.current.draftSettings?.onboardingCompletedAt).toBe(ONBOARDING_COMPLETED_AT);
    // This fixture has no completedSteps, so normalizeSettings leaves step 1 intact.
    expect(result.current.draftSettings?.onboardingChecklist).toEqual({ step: 1 });

    await act(async () => {
      vi.advanceTimersByTime(900);
      await flushAsync();
    });

    expect(updateMock).toHaveBeenCalledTimes(1);
    const writePayload = updateMock.mock.calls[0]?.[0] as AppSettings;
    expect(writePayload.onboardingCompleted).toBe(true);
    expect(writePayload.onboardingFirstCompletedAt).toBe(ONBOARDING_FIRST_COMPLETED_AT);
    expect(writePayload.onboardingCompletedAt).toBe(ONBOARDING_COMPLETED_AT);
    expect(writePayload.onboardingChecklist).toEqual({ step: 1 });

    unmount();
  });

  it('preserves onboarding lifecycle keys and the autosave payload when onSettingsExternalUpdate refresh races the debounce', async () => {
    const { result, unmount } = renderHook(() => useSettingsFeature({
      emitLog: vi.fn(),
      showToast: vi.fn(),
    }));

    await flushAsync();
    await flushAsync();

    act(() => {
      result.current.updateDraft('coreDirectory', ONBOARDING_CORE_DIRECTORY);
    });
    await act(async () => {
      await result.current.saveSettingsWith((current) => ({
        ...current,
        onboardingCompleted: true,
        onboardingFirstCompletedAt: ONBOARDING_FIRST_COMPLETED_AT,
        onboardingCompletedAt: ONBOARDING_COMPLETED_AT,
        onboardingChecklist: { step: 1 },
      }));
    });
    updateMock.mockClear();

    expect(externalUpdateHandler).toBeTypeOf('function');
    await act(async () => {
      externalUpdateHandler?.();
      await flushAsync();
    });

    expect(result.current.draftSettings?.onboardingCompleted).toBe(true);
    expect(result.current.draftSettings?.onboardingFirstCompletedAt).toBe(ONBOARDING_FIRST_COMPLETED_AT);
    expect(result.current.draftSettings?.onboardingCompletedAt).toBe(ONBOARDING_COMPLETED_AT);
    expect(result.current.draftSettings?.onboardingChecklist).toEqual({ step: 1 });

    await act(async () => {
      vi.advanceTimersByTime(900);
      await flushAsync();
    });

    expect(updateMock).toHaveBeenCalledTimes(1);
    const writePayload = updateMock.mock.calls[0]?.[0] as AppSettings;
    expect(writePayload.onboardingCompleted).toBe(true);
    expect(writePayload.onboardingFirstCompletedAt).toBe(ONBOARDING_FIRST_COMPLETED_AT);
    expect(writePayload.onboardingCompletedAt).toBe(ONBOARDING_COMPLETED_AT);
    expect(writePayload.onboardingChecklist).toEqual({ step: 1 });

    unmount();
  });

  it('does not resurrect onboardingCompleted after an explicit relaunch-onboarding save writes false', async () => {
    const initialCompletedSettings = {
      ...makeServerSettingsWithoutDraftKeys(),
      onboardingCompleted: true,
      onboardingFirstCompletedAt: ONBOARDING_FIRST_COMPLETED_AT,
      onboardingCompletedAt: ONBOARDING_COMPLETED_AT,
      onboardingChecklist: { step: 1 },
    } as AppSettings;
    getMock.mockResolvedValueOnce(initialCompletedSettings);
    const { result, unmount } = renderHook(() => useSettingsFeature({
      emitLog: vi.fn(),
      showToast: vi.fn(),
    }));

    await flushAsync();
    await flushAsync();

    act(() => {
      result.current.updateDraft('coreDirectory', ONBOARDING_CORE_DIRECTORY);
    });
    await act(async () => {
      await result.current.saveSettingsWith((current) => ({
        ...current,
        onboardingCompleted: false,
      }));
    });
    updateMock.mockClear();

    expect(result.current.draftSettings?.onboardingCompleted).toBe(false);

    getMock.mockResolvedValueOnce({
      ...initialCompletedSettings,
      // Stale refresh snapshot disagrees with the relaunch draft; preserve must keep explicit false.
      onboardingCompleted: true,
    });
    expect(authConfigHandler).toBeTypeOf('function');
    await act(async () => {
      authConfigHandler?.();
      await flushAsync();
    });

    expect(result.current.draftSettings?.onboardingCompleted).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(900);
      await flushAsync();
    });

    expect(updateMock).toHaveBeenCalledTimes(1);
    const writePayload = updateMock.mock.calls[0]?.[0] as AppSettings;
    expect(writePayload.onboardingCompleted).toBe(false);

    unmount();
  });
});
