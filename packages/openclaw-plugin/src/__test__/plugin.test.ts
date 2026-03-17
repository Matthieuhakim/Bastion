import { describe, it, expect, vi, beforeEach } from 'vitest';
import bastionPlugin, { BASTION_FETCH_TOOL_NAME } from '../plugin.js';
import type {
  OpenClawPluginApi,
  OpenClawToolDefinition,
  OpenClawToolResult,
} from '../types.js';

// Mock BastionBridge to avoid real HTTP calls.
vi.mock('../bastionBridge.js', () => ({
  BastionBridge: vi.fn().mockImplementation(() => ({
    executeProxy: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(true),
  })),
}));

import { BastionBridge } from '../bastionBridge.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MockBastionBridge = vi.mocked(BastionBridge) as any;

function makeApi(pluginConfig?: Record<string, unknown>) {
  const handlers: Record<string, ((...args: unknown[]) => unknown)[]> = {};
  const services: { id: string }[] = [];
  const tools: OpenClawToolDefinition[] = [];
  const logs: { level: string; msg: string }[] = [];

  const api: OpenClawPluginApi = {
    pluginConfig,
    on: (event, handler) => {
      handlers[event] = handlers[event] ?? [];
      handlers[event].push(handler);
    },
    registerTool: (tool) => tools.push(tool),
    registerService: (service) => services.push(service),
    logger: {
      info: (msg) => logs.push({ level: 'info', msg }),
      warn: (msg) => logs.push({ level: 'warn', msg }),
      error: (msg) => logs.push({ level: 'error', msg }),
    },
  };

  const triggerBeforeCall = async (toolName: string, params: Record<string, unknown>) => {
    const handler = handlers['before_tool_call']?.[0];
    if (!handler) throw new Error('before_tool_call handler not registered');
    return handler({ toolName, params });
  };

  const executeRegisteredTool = async (params: Record<string, unknown>): Promise<OpenClawToolResult> => {
    const tool = tools.find((entry) => entry.name === BASTION_FETCH_TOOL_NAME);
    if (!tool) throw new Error(`${BASTION_FETCH_TOOL_NAME} not registered`);
    return tool.execute(undefined, params);
  };

  return { api, handlers, services, tools, logs, triggerBeforeCall, executeRegisteredTool };
}

const validConfig = {
  serverUrl: 'http://localhost:3000',
  agentSecret: 'bst_test_secret',
  rules: [
    {
      tool: 'web_fetch',
      urlPattern: 'https://api.stripe.com/**',
      credentialId: 'cred_stripe',
      action: 'stripe.charges',
    },
  ],
};

const proxyResult = {
  upstream: { status: 200, headers: {}, body: { id: 'ch_123' } },
  meta: {
    credentialId: 'cred_stripe',
    action: 'stripe.charges',
    policyDecision: 'ALLOW' as const,
    policyId: 'pol_1',
    durationMs: 100,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('bastionPlugin', () => {
  it('stays idle when no config is provided', async () => {
    const { api, handlers, services, tools, logs } = makeApi();
    await bastionPlugin(api);

    expect(handlers['before_tool_call']).toBeUndefined();
    expect(tools).toHaveLength(0);
    expect(services.find((s) => s.id === 'bastion')).toBeDefined();
    expect(logs.some((entry) => entry.msg.includes('not configured'))).toBe(true);
  });

  it('stays idle when plugin config is empty', async () => {
    const { api, handlers, services, tools, logs } = makeApi({});
    await bastionPlugin(api);

    expect(handlers['before_tool_call']).toBeUndefined();
    expect(tools).toHaveLength(0);
    expect(services.find((s) => s.id === 'bastion')).toBeDefined();
    expect(logs.some((entry) => entry.msg.includes('not configured'))).toBe(true);
  });

  it('throws on missing serverUrl in partial config', async () => {
    const { api } = makeApi({ agentSecret: 'bst_x', rules: [{}] });
    expect(() => bastionPlugin(api)).toThrow('config.serverUrl');
  });

  it('throws on missing agentSecret in partial config', async () => {
    const { api } = makeApi({ serverUrl: 'http://localhost:3000', rules: [{}] });
    expect(() => bastionPlugin(api)).toThrow('config.agentSecret');
  });

  it('throws on empty rules array in partial config', async () => {
    const { api } = makeApi({
      serverUrl: 'http://localhost:3000',
      agentSecret: 'bst_x',
      rules: [],
    });
    expect(() => bastionPlugin(api)).toThrow('config.rules');
  });

  it('registers bastion_fetch tool, before_tool_call hook, and service', async () => {
    const { api, handlers, services, tools } = makeApi(validConfig);
    await bastionPlugin(api);

    expect(handlers['before_tool_call']).toHaveLength(1);
    expect(services.find((s) => s.id === 'bastion')).toBeDefined();
    expect(tools.find((tool) => tool.name === BASTION_FETCH_TOOL_NAME)).toBeDefined();
  });

  it('bastion_fetch executes a matched request through Bastion', async () => {
    const { api, executeRegisteredTool } = makeApi(validConfig);
    const mockExecuteProxy = vi.fn().mockResolvedValue(proxyResult);
    MockBastionBridge.mockImplementation(() => ({
      executeProxy: mockExecuteProxy,
      healthCheck: vi.fn().mockResolvedValue(true),
    }));

    await bastionPlugin(api);

    const result = await executeRegisteredTool({
      url: 'https://api.stripe.com/v1/charges',
      method: 'POST',
    });

    expect(result.details).toMatchObject({
      status: 200,
      url: 'https://api.stripe.com/v1/charges',
    });
    expect(result.content[0]?.type).toBe('text');
    expect(mockExecuteProxy).toHaveBeenCalledOnce();
  });

  it('bastion_fetch throws when no rule matches the URL', async () => {
    const { api, executeRegisteredTool } = makeApi(validConfig);
    await bastionPlugin(api);

    await expect(
      executeRegisteredTool({
        url: 'https://api.github.com/repos/openclaw/openclaw',
      }),
    ).rejects.toThrow('No Bastion rule matches');
  });

  it('blocks direct calls to protected tools when a rule matches', async () => {
    const { api, triggerBeforeCall } = makeApi(validConfig);
    await bastionPlugin(api);

    const result = await triggerBeforeCall('web_fetch', {
      url: 'https://api.stripe.com/v1/charges',
    });

    expect(result).toMatchObject({
      block: true,
    });
    expect((result as { blockReason: string }).blockReason).toContain(BASTION_FETCH_TOOL_NAME);
  });

  it('does not block unmatched tool calls', async () => {
    const { api, triggerBeforeCall } = makeApi(validConfig);
    await bastionPlugin(api);

    const result = await triggerBeforeCall('web_fetch', {
      url: 'https://api.github.com/repos/openclaw/openclaw',
    });

    expect(result).toBeUndefined();
  });

  it('does not block bastion_fetch itself', async () => {
    const { api, triggerBeforeCall } = makeApi(validConfig);
    await bastionPlugin(api);

    const result = await triggerBeforeCall(BASTION_FETCH_TOOL_NAME, {
      url: 'https://api.stripe.com/v1/charges',
    });

    expect(result).toBeUndefined();
  });

  it('surfaces Bastion policy blocks from bastion_fetch', async () => {
    const { BastionBlockedError } = await import('../errors.js');
    const { api, executeRegisteredTool } = makeApi(validConfig);
    MockBastionBridge.mockImplementation(() => ({
      executeProxy: vi.fn().mockRejectedValue(new BastionBlockedError('Policy denied')),
      healthCheck: vi.fn().mockResolvedValue(true),
    }));

    await bastionPlugin(api);

    await expect(
      executeRegisteredTool({
        url: 'https://api.stripe.com/v1/charges',
      }),
    ).rejects.toThrow('Blocked by Bastion policy');
  });

  it('surfaces fail-closed errors when Bastion is unreachable', async () => {
    const { BastionUnreachableError } = await import('../errors.js');
    const { api, executeRegisteredTool } = makeApi(validConfig);
    MockBastionBridge.mockImplementation(() => ({
      executeProxy: vi.fn().mockRejectedValue(new BastionUnreachableError('Connection refused')),
      healthCheck: vi.fn().mockResolvedValue(false),
    }));

    await bastionPlugin(api);

    await expect(
      executeRegisteredTool({
        url: 'https://api.stripe.com/v1/charges',
      }),
    ).rejects.toThrow('fail-closed');
  });

  it('logs a warning when health check fails at startup', async () => {
    const { api, logs } = makeApi(validConfig);
    MockBastionBridge.mockImplementation(() => ({
      executeProxy: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(false),
    }));

    await bastionPlugin(api);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(logs.some((l) => l.level === 'warn' && l.msg.includes('unreachable'))).toBe(true);
  });
});
