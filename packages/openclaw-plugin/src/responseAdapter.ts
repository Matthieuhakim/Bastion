import type { ProxyExecuteResult } from '@bastion-ai/sdk';
import type { BastionFetchResponse, OpenClawToolResult } from './types.js';

export function buildBastionResponse(
  result: ProxyExecuteResult,
  originalUrl: string,
): BastionFetchResponse {
  return {
    status: result.upstream.status,
    headers: result.upstream.headers,
    body: result.upstream.body ?? null,
    url: originalUrl,
    _bastion: {
      credentialId: result.meta.credentialId,
      action: result.meta.action,
      policyDecision: result.meta.policyDecision,
      durationMs: result.meta.durationMs,
      ...(result.meta.hitlRequestId !== undefined
        ? { hitlRequestId: result.meta.hitlRequestId }
        : {}),
    },
  };
}

/**
 * Adapt the Bastion response into a standard OpenClaw tool result.
 * `details` keeps the structured payload, while `content` gives the model a
 * readable JSON summary in the same turn.
 */
export function adaptToolResult(
  result: ProxyExecuteResult,
  originalUrl: string,
): OpenClawToolResult {
  const payload = buildBastionResponse(result, originalUrl);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
  };
}
