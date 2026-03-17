import { resolveSecret } from './secretRef.js';
import { compileRules, matchRule, matchRuleByUrl } from './ruleEngine.js';
import { adaptToolResult } from './responseAdapter.js';
import { BastionBridge } from './bastionBridge.js';
import { BastionUnreachableError, BastionBlockedError } from './errors.js';
import type {
  OpenClawPluginApi,
  BeforeCallEvent,
  BeforeCallResult,
  BastionFetchToolInput,
  BastionPluginConfig,
} from './types.js';

export const BASTION_FETCH_TOOL_NAME = 'bastion_fetch';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

const BASTION_FETCH_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: {
    url: {
      type: 'string',
      description: 'Absolute URL to request through Bastion.',
    },
    method: {
      type: 'string',
      enum: [...HTTP_METHODS],
      description: 'HTTP method. Defaults to GET.',
    },
    headers: {
      type: 'object',
      description: 'Optional request headers.',
      additionalProperties: {
        type: 'string',
      },
    },
    body: {
      description: 'Optional JSON request body forwarded through Bastion.',
    },
    timeout: {
      type: 'number',
      minimum: 1,
      description: 'Optional per-request timeout in milliseconds.',
    },
  },
} satisfies Record<string, unknown>;

function validateConfig(config: unknown): BastionPluginConfig {
  if (!config || typeof config !== 'object') {
    throw new Error('Bastion plugin: config is required');
  }
  const c = config as Record<string, unknown>;

  if (!c['serverUrl'] || typeof c['serverUrl'] !== 'string') {
    throw new Error('Bastion plugin: config.serverUrl is required and must be a string');
  }
  if (c['agentSecret'] === undefined || c['agentSecret'] === null) {
    throw new Error('Bastion plugin: config.agentSecret is required');
  }
  if (!Array.isArray(c['rules']) || c['rules'].length === 0) {
    throw new Error('Bastion plugin: config.rules must be a non-empty array');
  }

  return c as unknown as BastionPluginConfig;
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Bastion plugin: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function normalizeFetchInput(params: unknown): BastionFetchToolInput {
  const input = assertRecord(params, 'tool params');

  if (typeof input['url'] !== 'string' || input['url'].length === 0) {
    throw new Error('Bastion plugin: url is required');
  }

  const method = input['method'] ? String(input['method']).toUpperCase() : 'GET';
  if (!HTTP_METHODS.includes(method as (typeof HTTP_METHODS)[number])) {
    throw new Error(`Bastion plugin: method must be one of ${HTTP_METHODS.join(', ')}`);
  }

  let headers: Record<string, string> | undefined;
  if (input['headers'] !== undefined) {
    const rawHeaders = assertRecord(input['headers'], 'headers');
    headers = {};
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (typeof value !== 'string') {
        throw new Error(`Bastion plugin: headers["${key}"] must be a string`);
      }
      headers[key] = value;
    }
  }

  let timeout: number | undefined;
  if (input['timeout'] !== undefined) {
    if (typeof input['timeout'] !== 'number' || input['timeout'] <= 0) {
      throw new Error('Bastion plugin: timeout must be a positive number');
    }
    timeout = input['timeout'];
  }

  return {
    url: input['url'],
    method,
    headers,
    body: input['body'],
    timeout,
  };
}

function toToolArgs(input: BastionFetchToolInput): Record<string, unknown> {
  return input as unknown as Record<string, unknown>;
}

function normalizeExecutionError(error: unknown): Error {
  if (error instanceof BastionBlockedError) {
    return new Error(`Blocked by Bastion policy: ${error.message}`);
  }
  if (error instanceof BastionUnreachableError) {
    return new Error('Bastion server unreachable. Request blocked (fail-closed).');
  }
  return error instanceof Error ? error : new Error(String(error));
}

export default async function bastionPlugin(api: OpenClawPluginApi): Promise<void> {
  // 1. Validate config from the released OpenClaw plugin API surface.
  const pluginConfig = validateConfig(api.pluginConfig);

  // 2. Resolve agent secret
  const agentSecret = await resolveSecret(pluginConfig.agentSecret);

  // 3. Compile rules (glob → regex) at startup
  const compiledRules = compileRules(pluginConfig.rules);

  // 4. Instantiate Bastion bridge
  const bridge = new BastionBridge(pluginConfig.serverUrl, agentSecret, pluginConfig.timeout);

  // 5. Non-blocking health check at startup — just warn if unreachable
  bridge
    .healthCheck()
    .then((ok) => {
      if (!ok) {
        api.logger.warn(
          `Bastion plugin: server at ${pluginConfig.serverUrl} is unreachable. ` +
            `${BASTION_FETCH_TOOL_NAME} requests will fail closed.`,
        );
      } else {
        api.logger.info(`Bastion plugin: connected to ${pluginConfig.serverUrl}`);
      }
    })
    .catch(() => {
      // healthCheck already catches internally — this is just a safety net
    });

  // 6. Register the Bastion-backed tool for current OpenClaw releases.
  api.registerTool({
    name: BASTION_FETCH_TOOL_NAME,
    label: 'Bastion Fetch',
    description:
      'Execute outbound HTTP requests through Bastion using configured URL rules.',
    parameters: BASTION_FETCH_TOOL_SCHEMA,
    async execute(_toolCallId: string | undefined, params: unknown) {
      const input = normalizeFetchInput(params);
      const toolArgs = toToolArgs(input);
      const rule = matchRuleByUrl(toolArgs, compiledRules);

      if (!rule) {
        throw new Error(`No Bastion rule matches ${input.url}`);
      }

      try {
        const result = await bridge.executeProxy(rule, toolArgs);
        return adaptToolResult(result, input.url);
      } catch (error) {
        throw normalizeExecutionError(error);
      }
    },
  });

  // 7. Register a bypass-blocking hook for tools explicitly listed in rules.
  api.on('before_tool_call', (event: unknown): BeforeCallResult => {
    const { toolName, params } = event as BeforeCallEvent;
    if (toolName === BASTION_FETCH_TOOL_NAME) {
      return undefined;
    }

    const rule = matchRule(toolName, params, compiledRules);
    if (!rule) {
      return undefined;
    }

    const url = typeof params['url'] === 'string' ? params['url'] : 'the requested URL';
    return {
      block: true,
      blockReason: `Requests to ${url} must use ${BASTION_FETCH_TOOL_NAME} so Bastion can enforce policy and inject credentials.`,
    };
  });

  // 8. Register service for lifecycle awareness
  api.registerService({
    id: 'bastion-fetch',
    start: () => api.logger.info('Bastion fetch plugin active'),
    stop: () => api.logger.info('Bastion fetch plugin stopped'),
  });
}
