import { BastionClient } from '@bastion-ai/sdk';
import type { ProxyExecuteResult } from '@bastion-ai/sdk';
import { BastionForbiddenError } from '@bastion-ai/sdk';
import { BastionUnreachableError, BastionBlockedError } from './errors.js';
import { extractParams } from './ruleEngine.js';
import type { CompiledRule } from './ruleEngine.js';

/** Timeout for HITL-escalated requests (5.5 min — slightly above Bastion's 5-min HITL window). */
const HITL_CLIENT_TIMEOUT_MS = 330_000;

export class BastionBridge {
  private readonly client: BastionClient;
  private readonly defaultTimeout: number;

  constructor(serverUrl: string, agentSecret: string, defaultTimeout = 30_000) {
    this.client = new BastionClient({ baseUrl: serverUrl, apiKey: agentSecret });
    this.defaultTimeout = defaultTimeout;
  }

  /**
   * Execute a proxied request through Bastion.
   * Builds the ProxyExecuteInput from the matched rule and tool args, then
   * delegates to the SDK. Throws BastionUnreachableError on network failures
   * and BastionBlockedError when the policy denies the request.
   */
  async executeProxy(
    rule: CompiledRule,
    toolArgs: Record<string, unknown>,
  ): Promise<ProxyExecuteResult> {
    const url = toolArgs['url'] as string;
    const method = typeof toolArgs['method'] === 'string' ? toolArgs['method'] : 'GET';
    const headers =
      typeof toolArgs['headers'] === 'object' && toolArgs['headers'] !== null
        ? (toolArgs['headers'] as Record<string, string>)
        : {};
    const body = toolArgs['body'];
    const requestedTimeout =
      typeof toolArgs['timeout'] === 'number' && toolArgs['timeout'] > 0
        ? toolArgs['timeout']
        : this.defaultTimeout;

    const params = rule.params ? extractParams(toolArgs, rule.params) : undefined;

    // For HITL escalations, Bastion may block up to 5 min — use a longer client timeout.
    const timeout = Math.max(requestedTimeout, HITL_CLIENT_TIMEOUT_MS);

    try {
      return await this.client.execute({
        credentialId: rule.credentialId,
        action: rule.action,
        params: Object.keys(params ?? {}).length > 0 ? params : undefined,
        target: { url, method, headers, body },
        injection: rule.injection,
        timeout,
      });
    } catch (error) {
      if (error instanceof BastionForbiddenError) {
        throw new BastionBlockedError(error.message);
      }
      // Network-level failure (TypeError from fetch, or any non-HTTP error)
      if (error instanceof TypeError || isNetworkError(error)) {
        throw new BastionUnreachableError(
          `Bastion server unreachable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }
  }

  /** Check Bastion server availability. Returns false if unreachable. */
  async healthCheck(): Promise<boolean> {
    try {
      await this.client.health();
      return true;
    } catch {
      return false;
    }
  }
}

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // Node fetch throws TypeError for network errors; also check for ECONNREFUSED etc.
  return (
    error.message.includes('ECONNREFUSED') ||
    error.message.includes('ENOTFOUND') ||
    error.message.includes('fetch failed')
  );
}
