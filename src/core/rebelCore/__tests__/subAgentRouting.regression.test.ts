import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, ModelProfile } from '@shared/types';
import type { PlanningStep } from '../planningMode';
import type { AgentToolContext } from '../types';
import type { DispatchableRoutePlan } from '../providerRoutePlanTypes';

const {
  mockRunAgentLoop,
  mockCreateClientFromRoutePlan,
  mockResolveThinkingConfig,
  mockResolveEffortForApi,
} = vi.hoisted(() => ({
  mockRunAgentLoop: vi.fn(),
  mockCreateClientFromRoutePlan: vi.fn().mockReturnValue({}),
  mockResolveThinkingConfig: vi.fn().mockReturnValue({ type: 'disabled' }),
  mockResolveEffortForApi: vi.fn(),
}));

 
vi.mock('../agentLoop', () => ({
  runAgentLoop: mockRunAgentLoop,
}));

 
vi.mock('../hookPipeline', () => ({
  runSubagentStartHooks: vi.fn().mockResolvedValue(undefined),
  runSubagentStopHooks: vi.fn().mockResolvedValue(undefined),
  createHookAwareToolExecutor: vi.fn().mockImplementation((base: unknown) => base),
}));

 
vi.mock('../builtinTools', () => ({
  getBuiltinToolDefinitions: vi.fn().mockReturnValue([]),
  isBuiltinToolName: vi.fn().mockReturnValue(false),
  executeBuiltinTool: vi.fn(),
  GET_MISSION_CONTEXT_TOOL_DEFINITION: {
    name: 'GetMissionContext',
    description: 'Get mission context',
    input_schema: { type: 'object', properties: {} },
  },
  SUMMARIZE_RESULT_TOOL_DEFINITION: {
    name: 'SummarizeResult',
    description: 'Summarize result',
    input_schema: { type: 'object', properties: {} },
  },
}));

 
vi.mock('../mcpClient', () => ({
  isMcpToolName: vi.fn().mockReturnValue(false),
}));

 
vi.mock('../taskState', () => ({
  createScopedTaskStore: vi.fn().mockReturnValue({
    listTasks: vi.fn().mockReturnValue([]),
    createTask: vi.fn(),
  }),
  createTaskStore: vi.fn().mockReturnValue({
    listTasks: vi.fn().mockReturnValue([]),
    createTask: vi.fn(),
  }),
}));

 
vi.mock('../modelLimits', () => ({
  shouldSuppressProfileReasoning: (profile?: { thinkingCompatibility?: string; reasoningEffort?: string }) => profile?.thinkingCompatibility === 'incompatible',
  resolveProfileReasoningEffort: (profile?: { thinkingCompatibility?: string; reasoningEffort?: string }) => (profile?.thinkingCompatibility === 'incompatible' ? undefined : profile?.reasoningEffort),
  resolveThinkingConfig: mockResolveThinkingConfig,
  resolveEffortForApi: mockResolveEffortForApi,
  resolveModelLimits: vi.fn().mockReturnValue({ contextWindow: 200_000, maxOutputTokens: 64_000 }),
}));

 
vi.mock('../clientFactory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../clientFactory')>();
  return {
    ...actual,
    createClientFromRoutePlan: mockCreateClientFromRoutePlan,
  };
});

import { executeAgentTool } from '../agentTool';

function capturedPlan(): DispatchableRoutePlan {
  return mockCreateClientFromRoutePlan.mock.calls[0][0];
}

function capturedHeaders(plan: DispatchableRoutePlan): Record<string, string> {
  return Object.fromEntries(plan.headers);
}

const ROUTED_AGENT_SLUG = 'model-google-gemini-pro-3-1';
const WORKING_AGENT_SLUG = 'model-openai-gpt-5-5-mini';
const ROUTED_MODEL_ID = 'gemini-2.5-pro';
const WORKING_MODEL_ID = 'gpt-5.5-mini';

const ROUTED_AGENT_PROMPT = [
  'You are an ad-hoc routed sub-agent.',
  'Investigate and report with evidence.',
].join('\n');

const WORKING_PROFILE: ModelProfile = {
  id: 'profile-working',
  name: 'Working GPT profile',
  providerType: 'openai',
  serverUrl: 'https://api.openai.com/v1',
  apiKey: 'fake-working-key-test',
  model: WORKING_MODEL_ID,
  enabled: true,
  routingEligible: true,
  createdAt: 1,
};

const ROUTED_PROFILE: ModelProfile = {
  id: 'profile-routed-gemini',
  name: 'Gemini Pro profile',
  providerType: 'google',
  serverUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  apiKey: 'google-key-test',
  model: ROUTED_MODEL_ID,
  enabled: true,
  routingEligible: true,
  createdAt: 2,
};

function makeBaseSettings(): AppSettings {
  return {
    coreDirectory: null,
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: { enabled: false },
    models: {
      apiKey: 'fake-ant-test',
      oauthToken: null,
      authMethod: 'api-key',
      model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
      permissionMode: 'plan',
      executablePath: null,
      planMode: true,
      extendedContext: false,
      thinkingModel: undefined,
      workingProfileId: WORKING_PROFILE.id,
      thinkingProfileId: null,
      behindTheScenesModel: undefined,
    },
    diagnostics: { enabled: false },
    experimental: { adaptiveRoutingEnabled: true },
    localModel: {
      activeProfileId: WORKING_PROFILE.id,
      profiles: [WORKING_PROFILE, ROUTED_PROFILE],
    },
    providerKeys: {},
  } as unknown as AppSettings;
}

function makeOpenRouterSettings(): AppSettings {
  return {
    ...makeBaseSettings(),
    activeProvider: 'openrouter',
    openRouter: {
      enabled: true,
      oauthToken: 'or-oauth-test',
      selectedModel: 'anthropic/claude-sonnet-4-6',
    },
  } as unknown as AppSettings;
}

function makeCodexSettings(): AppSettings {
  return {
    ...makeBaseSettings(),
    activeProvider: 'codex',
  } as unknown as AppSettings;
}

function makePlanSteps(
  assignmentModel: string,
  effort: 'low' | 'medium' | 'high' | 'xhigh',
  context: 'scoped' | 'contextual',
): PlanningStep[] {
  return [
    {
      id: 's1',
      sub_agents: [
        {
          task: `Use ${ROUTED_AGENT_SLUG} to investigate routing behavior`,
          model: assignmentModel,
          effort,
          context,
        },
      ],
    },
  ];
}

function makeCtx(overrides: {
  settings: AppSettings;
  assignmentModel: string;
  assignmentEffort: 'low' | 'medium' | 'high' | 'xhigh';
  assignmentContext: 'scoped' | 'contextual';
  turnId: string;
  parentProxyHeaders?: Record<string, string>;
  codexConnectivity?: AgentToolContext['codexConnectivity'];
}): AgentToolContext {
  const routedAgentDefinition: AgentToolContext['agents'][string] = {
    description: 'Routed ad-hoc sub-agent',
    prompt: ROUTED_AGENT_PROMPT,
    model: 'working',
    routingMode: 'ad-hoc',
    routedModel: ROUTED_MODEL_ID,
  };

  return {
    agents: {
      [ROUTED_AGENT_SLUG]: routedAgentDefinition,
    },
    client: {} as AgentToolContext['client'],
    settings: overrides.settings,
    parentModel: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
    parentMaxTokens: 4096,
    parentEffort: 'low',
    depth: 0,
    planRouting: {
      default_model: 'claude-sonnet-4-20250514',
      default_effort: 'low',
    },
    planSteps: makePlanSteps(
      overrides.assignmentModel,
      overrides.assignmentEffort,
      overrides.assignmentContext,
    ),
    consumedAssignments: new Set<string>(),
    proxyConfig: {
      baseURL: 'http://localhost:11444',
      defaultHeaders: {
        'x-proxy-auth': 'proxy-token',
        ...(overrides.parentProxyHeaders ?? {}),
      },
    },
    turnId: overrides.turnId,
    codexConnectivity: overrides.codexConnectivity ?? 'unknown',
  };
}

function getRunConfig(): Parameters<typeof mockRunAgentLoop>[0][0] {
  expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
  return mockRunAgentLoop.mock.calls[0][0];
}

interface CaseAVariant {
  name: string;
  settings: AppSettings;
  turnId: string;
  parentProxyHeaders?: Record<string, string>;
  strippedHeader?: string;
  codexConnectivity?: AgentToolContext['codexConnectivity'];
}

const CASE_A_VARIANTS: CaseAVariant[] = [
  {
    name: 'direct Anthropic (activeProvider unset)',
    settings: makeBaseSettings(),
    turnId: 'turn-anthropic',
  },
  {
    name: 'OpenRouter active provider',
    settings: makeOpenRouterSettings(),
    turnId: 'turn-openrouter',
    parentProxyHeaders: { 'x-openrouter-turn': 'true' },
    strippedHeader: 'x-openrouter-turn',
  },
  {
    name: 'Codex active provider',
    settings: makeCodexSettings(),
    turnId: 'turn-codex',
    parentProxyHeaders: { 'x-codex-turn': 'true' },
    strippedHeader: 'x-codex-turn',
    // Route-table dispatch now mirrors the unassigned path: body = the slash-free
    // alias (`'working'`) with `routeProfile = null`, so under activeProvider=codex
    // the alias resolves through the codex provider arm and gates on codex
    // connectivity (same as the unassigned route-table path / subAgentProxyRouting
    // "route-table ad-hoc terminal fail-closed-codex-disconnected"). The previous
    // assigned-branch behaviour collapsed to the concrete google profile, which
    // wrongly bypassed that gate — the bug this fix closes. This variant exists to
    // prove the `x-codex-turn` header is stripped on a SUCCESSFUL route-table
    // dispatch, so give it a connected codex so dispatch proceeds.
    codexConnectivity: 'connected',
  },
];

// Stage 0 scope note:
// OpenRouter/Codex variants here only prove pre-existing provider identity headers are stripped in route-table mode.
// Full multi-state provider behavior is deferred to Stage 4, where routedModel is consumed end-to-end.

describe('sub-agent routing regression (Stage 0, intentionally red on main)', () => {
  beforeEach(() => {
    mockRunAgentLoop.mockReset();
    mockCreateClientFromRoutePlan.mockReset();
    mockResolveThinkingConfig.mockReset();
    mockResolveEffortForApi.mockReset();

    mockRunAgentLoop.mockResolvedValue(undefined);
    mockCreateClientFromRoutePlan.mockReturnValue({});
    mockResolveThinkingConfig.mockReturnValue({ type: 'disabled' });
    mockResolveEffortForApi.mockImplementation((effort: string | undefined) => {
      if (effort === 'xhigh') return 'high';
      if (effort === 'high' || effort === 'medium' || effort === 'low' || effort === 'max') {
        return effort;
      }
      return undefined;
    });
  });

  it.each(CASE_A_VARIANTS)(
    'Case A (Bug 1): scoped routed sub-agent must carry routing target in proxy headers — $name',
    async (variant) => {
      const ctx = makeCtx({
        settings: variant.settings,
        assignmentModel: ROUTED_MODEL_ID,
        assignmentEffort: 'high',
        assignmentContext: 'scoped',
        turnId: variant.turnId,
        parentProxyHeaders: variant.parentProxyHeaders,
        ...(variant.codexConnectivity ? { codexConnectivity: variant.codexConnectivity } : {}),
      });

      await executeAgentTool(
        { agent: ROUTED_AGENT_SLUG, prompt: 'Investigate sub-agent routing regressions' },
        ctx,
        'toolu_bug1_regression',
      );

      const runConfig = getRunConfig();
      // Body model is the route-table-safe alias (Anthropic-dialect-safe); the
      // concrete routed backend rides in x-routed-model (asserted below).
      // HANDOFF Constraint #1 — see subAgentProxyRouting.test.ts "(a) route-table ad-hoc".
      expect(runConfig.model).toBe('working');

      expect(mockCreateClientFromRoutePlan).toHaveBeenCalledTimes(1);
      const plan = capturedPlan();
      const headers = capturedHeaders(plan);
      expect(plan.decision.transport).toBe('anthropic-compatible-local-proxy');
      expect(plan.decision.dispatchPath).toBe('local-proxy-route-table');
      expect(headers['x-routed-turn-id']).toBe(variant.turnId);
      if (variant.strippedHeader) {
        expect(ctx.proxyConfig?.defaultHeaders?.[variant.strippedHeader]).toBe('true');
        expect(headers).not.toHaveProperty(variant.strippedHeader);
      }

      expect(
        headers['x-routed-model'],
        `[Bug 1 regression] ${variant.name}: scoped sub-agent execution must preserve routed-model header transport. ` +
          'Without x-routed-model header, local proxy route resolution silently falls back to the base working profile.',
      ).toBe(ROUTED_MODEL_ID);
    },
  );

  it('Case A.1 (Stage 4 amend): matched-assignment routed model must drive wire header when invoked agent differs', async () => {
    const ctx = makeCtx({
      settings: makeBaseSettings(),
      assignmentModel: ROUTED_AGENT_SLUG,
      assignmentEffort: 'high',
      assignmentContext: 'contextual',
      turnId: 'turn-matched-assignment-wire',
    });
    ctx.agents[WORKING_AGENT_SLUG] = {
      description: 'Working-model ad-hoc sub-agent',
      prompt: ROUTED_AGENT_PROMPT,
      model: 'working',
      routingMode: 'ad-hoc',
      routedModel: WORKING_MODEL_ID,
    };

    await executeAgentTool(
      { agent: WORKING_AGENT_SLUG, prompt: 'Investigate routing regressions and gather routing evidence' },
      ctx,
      'toolu_bug1_stage4_amend_wire',
    );

    const runConfig = getRunConfig();
    // Body model is the route-table-safe alias; the concrete routed backend is
    // carried in x-routed-model (the load-bearing assertion below).
    // HANDOFF Constraint #1.
    expect(runConfig.model).toBe('working');

    expect(mockCreateClientFromRoutePlan).toHaveBeenCalledTimes(1);
    const headers = capturedHeaders(capturedPlan());
    expect(headers['x-routed-model']).toBe(ROUTED_MODEL_ID);
    expect(headers['x-routed-model']).not.toBe(WORKING_MODEL_ID);
  });

  // --- GLM 5.2 slash-body route-table coercion regression ----------------------
  // A planner-assigned route-table sub-agent for a keyless OpenRouter pool profile
  // whose routed model is a SLASH model (`z-ai/glm-5.2`). On unfixed code, the
  // matchedAssignment route-table branch collapses to the concrete profile
  // (routeModel = z-ai/glm-5.2, routeProfile = the OpenRouter profile), so
  // profileDecision emits an openrouter-proxy passthrough with wireModelId =
  // z-ai/glm-5.2; coerceToRouteTable swaps the transport to non-passthrough
  // anthropic-compatible-local-proxy but keeps the slash body → the client-seam
  // guard throws "non-passthrough Anthropic dispatch … foreign body model".
  // Opus/gpt-5.5 assigned route-table sub-agents never tripped this because their
  // routed model is slash-free.
  const GLM_AGENT_SLUG = 'model-glm-5-2';
  const GLM_ROUTED_MODEL_ID = 'z-ai/glm-5.2';

  const GLM_OPENROUTER_PROFILE: ModelProfile = {
    id: 'profile-glm-openrouter',
    name: 'GLM 5.2 (OpenRouter pool)',
    providerType: 'openrouter',
    routeSurface: 'pool',
    serverUrl: 'https://openrouter.ai/api/v1',
    model: GLM_ROUTED_MODEL_ID,
    enabled: true,
    routingEligible: true,
    createdAt: 3,
  } as unknown as ModelProfile;

  function makeGlmOpenRouterSettings(): AppSettings {
    const base = makeBaseSettings();
    return {
      ...base,
      activeProvider: 'openrouter',
      openRouter: {
        enabled: true,
        // Account-wide OAuth token; NO per-profile apiKey / customProviderId /
        // providerKeys.openrouter — the keyless-OpenRouter passthrough arm.
        oauthToken: 'or-oauth-test',
        selectedModel: GLM_ROUTED_MODEL_ID,
      },
      localModel: {
        activeProfileId: WORKING_PROFILE.id,
        profiles: [WORKING_PROFILE, ROUTED_PROFILE, GLM_OPENROUTER_PROFILE],
      },
      providerKeys: {},
    } as unknown as AppSettings;
  }

  function makeGlmCtx(turnId: string): AgentToolContext {
    const ctx = makeCtx({
      settings: makeGlmOpenRouterSettings(),
      assignmentModel: GLM_AGENT_SLUG,
      assignmentEffort: 'high',
      assignmentContext: 'scoped',
      turnId,
    });
    // The generated route-table agent: alias body (`working`) + concrete routed
    // backend (`z-ai/glm-5.2`), exactly as adHocAgentService produces it.
    ctx.agents[GLM_AGENT_SLUG] = {
      description: 'GLM 5.2 routed ad-hoc sub-agent',
      prompt: ROUTED_AGENT_PROMPT,
      model: 'working',
      routingMode: 'ad-hoc',
      routedModel: GLM_ROUTED_MODEL_ID,
    };
    // Register the concrete slash model as a turn route key, mirroring the live
    // turn route table (the proxy resolves x-routed-model: z-ai/glm-5.2).
    ctx.planSteps = [
      {
        id: 's1',
        sub_agents: [
          {
            task: `Use ${GLM_AGENT_SLUG} to investigate routing behavior`,
            model: GLM_AGENT_SLUG,
            effort: 'high',
            context: 'scoped',
          },
        ],
      },
    ] as PlanningStep[];
    return ctx;
  }

  it('GLM 5.2 (slash OpenRouter pool, planner-assigned, route-table scope) dispatches with an alias body + concrete x-routed-model — must NOT trip the non-passthrough-Anthropic foreign-body guard', async () => {
    const ctx = makeGlmCtx('turn-glm-route-table');

    await executeAgentTool(
      { agent: GLM_AGENT_SLUG, prompt: 'Investigate sub-agent routing regressions and gather routing evidence' },
      ctx,
      'toolu_glm_route_table',
    );

    // Dispatched (no throw) and the concrete backend rides in the x-routed-model
    // header, while the streamed body model stays a slash-free alias.
    expect(mockCreateClientFromRoutePlan).toHaveBeenCalledTimes(1);
    const plan = capturedPlan();
    const headers = capturedHeaders(plan);
    expect(plan.decision.transport).toBe('anthropic-compatible-local-proxy');
    expect(plan.decision.dispatchPath).toBe('local-proxy-route-table');
    expect(headers['x-routed-model']).toBe(GLM_ROUTED_MODEL_ID);

    const runConfig = getRunConfig();
    // The streamed body model must be the slash-free route-table alias, NOT the
    // concrete slash backend — same value the other route-table tests assert
    // (`'working'`; cf. subAgentProxyRouting.test.ts "(a) route-table ad-hoc").
    // The concrete slash backend `z-ai/glm-5.2` rides only in x-routed-model
    // (asserted above), which keeps it the authority for limits/billing/replay.
    expect(String(runConfig.model)).not.toContain('/');
    expect(String(runConfig.model)).toBe('working');
  });

  it('Case B (Bug 2): planner slug assignment should resolve routed profile model + effort instead of silently downgrading', async () => {
    const ctx = makeCtx({
      settings: makeBaseSettings(),
      assignmentModel: ROUTED_AGENT_SLUG,
      assignmentEffort: 'xhigh',
      assignmentContext: 'contextual',
      turnId: 'turn-bug2',
    });

    await executeAgentTool(
      { agent: ROUTED_AGENT_SLUG, prompt: 'Investigate sub-agent routing regressions' },
      ctx,
      'toolu_bug2_regression',
    );

    const runConfig = getRunConfig();

    expect.soft(
      runConfig.model,
      '[Bug 2 regression] Planner sub_agents[].model emits agent slug (e.g. model-google-gemini-pro-3-1). ' +
        'Dispatch resolves that slug to the route-table-safe alias body; the concrete routed profile model ' +
        'rides in x-routed-model (asserted below). HANDOFF Constraint #1.',
    ).toBe('working');

    expect.soft(
      runConfig.effort,
      '[Bug 2 regression] Planner-assigned xhigh effort must survive slug resolution for routed sub-agents. ' +
        'Current behavior silently downgrades to parent default effort when slug lookup misses.',
    ).toBe('high');

    expect(mockCreateClientFromRoutePlan).toHaveBeenCalledTimes(1);
    expect(capturedHeaders(capturedPlan())['x-routed-model']).toBe(ROUTED_MODEL_ID);
  });
});
