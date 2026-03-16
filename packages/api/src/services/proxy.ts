import type { Credential, CredentialType } from '@prisma/client';
import { prisma } from './db.js';
import { decryptCredential } from './credentials.js';
import { evaluateRequest, commitRateLimitAndSpend } from './policyEngine.js';
import type { EvaluationParams } from './policyEngine.js';
import { callExternalApi } from './httpClient.js';
import type { ExternalResponse } from './httpClient.js';
import { ForbiddenError, ValidationError } from '../errors.js';
import { createPendingRequest, waitForResolution } from './hitl.js';
import { sendWebhookNotification, buildWebhookPayload } from './notifications.js';
import { appendAuditRecord } from './auditChain.js';
import { logger } from './logger.js';

export interface ProxyTarget {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface InjectionConfig {
  location: 'header' | 'query' | 'body';
  key: string;
}

export interface ProxyExecuteInput {
  agentId: string;
  credentialId: string;
  action: string;
  params?: EvaluationParams;
  target: ProxyTarget;
  injection?: InjectionConfig;
  timeout?: number;
}

export interface ProxyMeta {
  credentialId: string;
  action: string;
  policyDecision: 'ALLOW';
  policyId: string | null;
  durationMs: number;
  hitlRequestId?: string;
}

export interface ProxyResult {
  outcome: 'executed';
  upstream: ExternalResponse;
  meta: ProxyMeta;
}

const BLOCKED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

const HITL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function appendAuditRecordSafely(
  input: Parameters<typeof appendAuditRecord>[0],
): Promise<void> {
  try {
    await appendAuditRecord(input);
  } catch (error) {
    logger.error('Failed to append audit record', error instanceof Error ? error : { error });
  }
}

function validateTargetUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError('target.url must be a valid URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ValidationError('target.url must use http or https protocol');
  }

  const hostname = parsed.hostname;

  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.local')) {
    throw new ValidationError('target.url must not point to a local address');
  }

  // Block link-local / cloud metadata
  if (hostname.startsWith('169.254.')) {
    throw new ValidationError('target.url must not point to a link-local address');
  }

  return parsed;
}

function getDefaultInjection(type: CredentialType): InjectionConfig {
  switch (type) {
    case 'API_KEY':
    case 'OAUTH2':
      return { location: 'header', key: 'Authorization' };
    case 'CUSTOM':
      throw new ValidationError(
        'CUSTOM credential type requires an explicit injection configuration',
      );
  }
}

function injectCredential(
  target: ProxyTarget,
  credentialValue: string,
  credentialType: CredentialType,
  injection?: InjectionConfig,
): ProxyTarget {
  const config = injection ?? getDefaultInjection(credentialType);
  const injectedTarget: ProxyTarget = {
    ...target,
    headers: { ...target.headers },
  };

  switch (config.location) {
    case 'header': {
      const value =
        config.key.toLowerCase() === 'authorization'
          ? `Bearer ${credentialValue}`
          : credentialValue;
      injectedTarget.headers[config.key] = value;
      break;
    }
    case 'query': {
      const url = new URL(injectedTarget.url);
      url.searchParams.set(config.key, credentialValue);
      injectedTarget.url = url.toString();
      break;
    }
    case 'body': {
      const body =
        typeof injectedTarget.body === 'object' && injectedTarget.body !== null
          ? { ...(injectedTarget.body as Record<string, unknown>) }
          : {};
      body[config.key] = credentialValue;
      injectedTarget.body = body;
      break;
    }
  }

  return injectedTarget;
}

async function executeUpstreamCall(
  credential: Credential,
  target: ProxyTarget,
  injection: InjectionConfig | undefined,
  timeout: number | undefined,
  agentId: string,
  credentialId: string,
  action: string,
  params: EvaluationParams,
  policyId: string | null,
  start: number,
  hitlRequestId?: string,
): Promise<ProxyResult> {
  try {
    // Decrypt credential
    const credentialValue = await decryptCredential(credentialId);

    // Inject credential into request
    const injectedTarget = injectCredential(target, credentialValue, credential.type, injection);

    // Call external API
    const upstream = await callExternalApi(injectedTarget, timeout);

    // Commit rate limit and spend counters (only after successful upstream call)
    await commitRateLimitAndSpend(agentId, credentialId, params);

    const durationMs = Date.now() - start;
    await appendAuditRecordSafely({
      agentId,
      action,
      targetUrl: target.url,
      targetMethod: target.method,
      credentialId,
      policyDecision: 'ALLOW',
      policyId,
      reason: 'Request executed successfully',
      params,
      durationMs,
      hitlRequestId,
      upstreamStatus: upstream.status,
      outcome: 'executed',
    });

    return {
      outcome: 'executed',
      upstream,
      meta: {
        credentialId,
        action,
        policyDecision: 'ALLOW',
        policyId,
        durationMs,
        hitlRequestId,
      },
    };
  } catch (error) {
    await appendAuditRecordSafely({
      agentId,
      action,
      targetUrl: target.url,
      targetMethod: target.method,
      credentialId,
      policyDecision: 'ALLOW',
      policyId,
      reason: 'Request allowed but upstream execution failed',
      params,
      durationMs: Date.now() - start,
      hitlRequestId,
      outcome: 'failed',
      error: getErrorMessage(error),
    });

    throw error;
  }
}

export async function executeProxy(input: ProxyExecuteInput): Promise<ProxyResult> {
  const { agentId, credentialId, action, params = {}, target, injection, timeout } = input;
  const start = Date.now();

  // 1. Validate target URL (SSRF protection)
  validateTargetUrl(target.url);

  // 2. Validate credential ownership
  const credential = await prisma.credential.findUnique({
    where: { id: credentialId },
  });
  if (!credential) {
    throw new ForbiddenError('Credential not found');
  }
  if (credential.agentId !== agentId) {
    throw new ForbiddenError('Credential does not belong to this agent');
  }

  // 3. Evaluate policy
  const evaluation = await evaluateRequest(agentId, credentialId, action, params);

  if (evaluation.decision === 'DENY') {
    await appendAuditRecordSafely({
      agentId,
      action,
      targetUrl: target.url,
      targetMethod: target.method,
      credentialId,
      policyDecision: 'DENY',
      policyId: evaluation.policyId,
      reason: evaluation.reason,
      params,
      durationMs: Date.now() - start,
      outcome: 'denied',
    });
    throw new ForbiddenError(evaluation.reason);
  }

  // 4. Handle ESCALATE via HITL gate
  if (evaluation.decision === 'ESCALATE') {
    const pending = await createPendingRequest(
      { agentId, credentialId, action, params, target, injection, timeout },
      { policyId: evaluation.policyId, reason: evaluation.reason },
    );

    // Fire webhook notification (non-blocking)
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (agent?.callbackUrl) {
      const payload = buildWebhookPayload(
        pending.requestId,
        agentId,
        action,
        params,
        evaluation.reason,
      );
      sendWebhookNotification(agent.callbackUrl, payload).catch(() => {});
    }

    // Block until admin approves/denies or timeout
    const resolution = await waitForResolution(pending.requestId, HITL_TIMEOUT_MS);

    if (resolution === 'denied') {
      await appendAuditRecordSafely({
        agentId,
        action,
        targetUrl: target.url,
        targetMethod: target.method,
        credentialId,
        policyDecision: 'ESCALATE',
        policyId: evaluation.policyId,
        reason: 'Request denied by human reviewer',
        params,
        durationMs: Date.now() - start,
        hitlRequestId: pending.requestId,
        outcome: 'denied',
      });
      throw new ForbiddenError('Request denied by human reviewer');
    }
    if (resolution === 'timeout') {
      await appendAuditRecordSafely({
        agentId,
        action,
        targetUrl: target.url,
        targetMethod: target.method,
        credentialId,
        policyDecision: 'ESCALATE',
        policyId: evaluation.policyId,
        reason: 'Request timed out waiting for human approval',
        params,
        durationMs: Date.now() - start,
        hitlRequestId: pending.requestId,
        outcome: 'denied',
      });
      throw new ForbiddenError('Request timed out waiting for human approval');
    }

    // Approved — continue with upstream call
    return executeUpstreamCall(
      credential,
      target,
      injection,
      timeout,
      agentId,
      credentialId,
      action,
      params,
      evaluation.policyId,
      start,
      pending.requestId,
    );
  }

  // 5. ALLOW — execute upstream call directly
  return executeUpstreamCall(
    credential,
    target,
    injection,
    timeout,
    agentId,
    credentialId,
    action,
    params,
    evaluation.policyId,
    start,
  );
}
