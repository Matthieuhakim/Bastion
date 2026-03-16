import { config } from '../config.js';
import type { EvaluationParams } from './policyEngine.js';

export interface WebhookPayload {
  requestId: string;
  agentId: string;
  action: string;
  params: EvaluationParams;
  reason: string;
  approveUrl: string;
  denyUrl: string;
}

export function buildWebhookPayload(
  requestId: string,
  agentId: string,
  action: string,
  params: EvaluationParams,
  reason: string,
): WebhookPayload {
  return {
    requestId,
    agentId,
    action,
    params,
    reason,
    approveUrl: `${config.baseUrl}/v1/hitl/${requestId}/approve`,
    denyUrl: `${config.baseUrl}/v1/hitl/${requestId}/deny`,
  };
}

export async function sendWebhookNotification(
  callbackUrl: string,
  payload: WebhookPayload,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    console.error(`HITL webhook notification failed for ${payload.requestId}:`, err);
  } finally {
    clearTimeout(timer);
  }
}
