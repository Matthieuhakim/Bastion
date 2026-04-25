import type { Credential, CredentialType } from '@prisma/client';
import { prisma } from './db.js';
import {
  decryptCredential,
  getCredentialRoutingMetadata,
  resolveCredentialForTarget,
} from './credentials.js';
import { evaluateRequest, commitRateLimitAndSpend } from './policyEngine.js';
import type { EvaluationParams } from './policyEngine.js';
import { callExternalApi } from './httpClient.js';
import type { ExternalResponse } from './httpClient.js';
import { ForbiddenError, ValidationError } from '../errors.js';
import { createPendingRequest, waitForResolution } from './hitl.js';
import { sendWebhookNotification, buildWebhookPayload } from './notifications.js';
import { appendAuditRecord } from './auditChain.js';
import { isIntentReviewActive, judgeIntent } from './intentJudge.js';
import type { IntentJudgeVerdict } from './intentJudge.js';
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

export interface ProxyFetchInput {
  agentId: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  params?: EvaluationParams;
  action?: string;
  credentialId?: string;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function buildIntentEscalationReason(verdict: IntentJudgeVerdict): string {
  const reason = verdict.reasons[0] ?? 'Intent judge requires human approval';
  return `Intent judge requires human approval (${verdict.riskLevel} risk): ${reason}`;
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

async function waitForHumanApproval(input: {
  agentId: string;
  credentialId: string;
  action: string;
  params: EvaluationParams;
  target: ProxyTarget;
  injection?: InjectionConfig;
  timeout?: number;
  policyId: string | null;
  reason: string;
  start: number;
  intentReview?: IntentJudgeVerdict;
}): Promise<string> {
  const pending = await createPendingRequest(
    {
      agentId: input.agentId,
      credentialId: input.credentialId,
      action: input.action,
      params: input.params,
      target: input.target,
      injection: input.injection,
      timeout: input.timeout,
    },
    {
      policyId: input.policyId,
      reason: input.reason,
      intentReview: input.intentReview,
    },
  );

  // Fire webhook notification (non-blocking)
  const agent = await prisma.agent.findUnique({ where: { id: input.agentId } });
  if (agent?.callbackUrl) {
    const payload = buildWebhookPayload(
      pending.requestId,
      input.agentId,
      input.action,
      input.params,
      input.reason,
    );
    sendWebhookNotification(agent.callbackUrl, payload).catch(() => {});
  }

  // Block until admin approves/denies or timeout
  const resolution = await waitForResolution(pending.requestId, HITL_TIMEOUT_MS);

  if (resolution === 'denied') {
    await appendAuditRecordSafely({
      agentId: input.agentId,
      action: input.action,
      targetUrl: input.target.url,
      targetMethod: input.target.method,
      credentialId: input.credentialId,
      policyDecision: 'ESCALATE',
      policyId: input.policyId,
      reason: 'Request denied by human reviewer',
      params: input.params,
      durationMs: Date.now() - input.start,
      hitlRequestId: pending.requestId,
      intentReview: input.intentReview,
      outcome: 'denied',
    });
    throw new ForbiddenError('Request denied by human reviewer');
  }
  if (resolution === 'timeout') {
    await appendAuditRecordSafely({
      agentId: input.agentId,
      action: input.action,
      targetUrl: input.target.url,
      targetMethod: input.target.method,
      credentialId: input.credentialId,
      policyDecision: 'ESCALATE',
      policyId: input.policyId,
      reason: 'Request timed out waiting for human approval',
      params: input.params,
      durationMs: Date.now() - input.start,
      hitlRequestId: pending.requestId,
      intentReview: input.intentReview,
      outcome: 'denied',
    });
    throw new ForbiddenError('Request timed out waiting for human approval');
  }

  return pending.requestId;
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

function slugifyActionSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .replace(/\.{2,}/g, '.');
}

function inferActionFromTarget(url: string, method: string, actionPrefix: string): string {
  const parsed = new URL(url);
  const pathSegments = parsed.pathname
    .split('/')
    .map((segment) => slugifyActionSegment(segment))
    .filter((segment) => segment.length > 0);

  return [actionPrefix, method.toLowerCase(), ...pathSegments].join('.');
}

function normalizeTargetHeaders(headers?: Record<string, string>): Record<string, string> {
  if (!headers) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string] =>
        typeof entry[0] === 'string' && typeof entry[1] === 'string',
    ),
  );
}

function getHeaderValue(headers: Record<string, string>, key: string): string | undefined {
  const entry = Object.entries(headers).find(
    ([header]) => header.toLowerCase() === key.toLowerCase(),
  );
  return entry?.[1];
}

function parseBodyValue(target: ProxyTarget, key: string): string | number | undefined {
  if (typeof target.body === 'object' && target.body !== null && !Array.isArray(target.body)) {
    const value = (target.body as Record<string, unknown>)[key];
    if (typeof value === 'string' || typeof value === 'number') {
      return value;
    }
    return undefined;
  }

  if (typeof target.body === 'string') {
    const contentType = getHeaderValue(target.headers, 'content-type') ?? '';
    if (contentType.includes('application/x-www-form-urlencoded')) {
      return new URLSearchParams(target.body).get(key) ?? undefined;
    }

    if (contentType.includes('application/json')) {
      try {
        const parsed = JSON.parse(target.body) as Record<string, unknown>;
        const value = parsed[key];
        if (typeof value === 'string' || typeof value === 'number') {
          return value;
        }
      } catch {
        return undefined;
      }
    }
  }

  return undefined;
}

function inferAmountParam(provider: string | undefined, target: ProxyTarget): number | undefined {
  const amountValue = parseBodyValue(target, 'amount');
  if (amountValue === undefined) {
    return undefined;
  }

  const numericAmount =
    typeof amountValue === 'number' ? amountValue : Number.parseFloat(amountValue);
  if (!Number.isFinite(numericAmount)) {
    return undefined;
  }

  if (provider?.toLowerCase() === 'stripe') {
    return numericAmount / 100;
  }

  return numericAmount;
}

function inferEvaluationParams(
  provider: string | undefined,
  target: ProxyTarget,
  params?: EvaluationParams,
): EvaluationParams | undefined {
  const nextParams: EvaluationParams = { ...(params ?? {}) };

  if (nextParams.amount === undefined) {
    const inferredAmount = inferAmountParam(provider, target);
    if (inferredAmount !== undefined) {
      nextParams.amount = inferredAmount;
    }
  }

  return Object.keys(nextParams).length > 0 ? nextParams : undefined;
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

  throw new ValidationError('Unsupported credential type');
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
  intentReview?: IntentJudgeVerdict,
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
      intentReview,
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
      intentReview,
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

  let intentReview: IntentJudgeVerdict | undefined;
  if (evaluation.decision === 'ALLOW' && isIntentReviewActive(evaluation.intentReview)) {
    intentReview = await judgeIntent({
      agentId,
      credentialId,
      credentialName: credential.name,
      credentialType: credential.type,
      credentialMetadata: asRecord(credential.metadata),
      credentialScopes: credential.scopes,
      action,
      params,
      target,
      policyDecision: evaluation.decision,
      policyId: evaluation.policyId,
      policyReason: evaluation.reason,
      review: evaluation.intentReview!,
    });

    if (intentReview.decision === 'NEEDS_APPROVAL') {
      const hitlRequestId = await waitForHumanApproval({
        agentId,
        credentialId,
        action,
        params,
        target,
        injection,
        timeout,
        policyId: evaluation.policyId,
        reason: buildIntentEscalationReason(intentReview),
        start,
        intentReview,
      });

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
        hitlRequestId,
        intentReview,
      );
    }
  }

  // 4. Handle ESCALATE via HITL gate
  if (evaluation.decision === 'ESCALATE') {
    const hitlRequestId = await waitForHumanApproval({
      agentId,
      credentialId,
      action,
      params,
      target,
      injection,
      timeout,
      policyId: evaluation.policyId,
      reason: evaluation.reason,
      start,
    });

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
      hitlRequestId,
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
    undefined,
    intentReview,
  );
}

export async function executeTransparentProxy(input: ProxyFetchInput): Promise<ProxyResult> {
  const method = (input.method ?? 'GET').toUpperCase();
  validateTargetUrl(input.url);
  const target = {
    url: input.url,
    method,
    headers: normalizeTargetHeaders(input.headers),
    body: input.body,
  };

  let credentialId = input.credentialId;
  let injection = input.injection;
  let actionPrefix: string | undefined;
  let provider: string | undefined;

  if (credentialId) {
    const credential = await prisma.credential.findUnique({ where: { id: credentialId } });
    if (!credential) {
      throw new ForbiddenError('Credential not found');
    }
    if (credential.agentId !== input.agentId) {
      throw new ForbiddenError('Credential does not belong to this agent');
    }

    const routing = getCredentialRoutingMetadata(credential);
    actionPrefix = routing.actionPrefix;
    provider = routing.provider;
    injection = injection ?? routing.injection;
  } else {
    const resolved = await resolveCredentialForTarget(input.agentId, input.url);
    credentialId = resolved.credential.id;
    actionPrefix = resolved.actionPrefix;
    provider = resolved.provider;
    injection = injection ?? resolved.injection;
  }

  const action =
    input.action ??
    inferActionFromTarget(
      input.url,
      method,
      actionPrefix ??
        (slugifyActionSegment(new URL(input.url).hostname.replace(/\./g, '-')) || 'http'),
    );

  return executeProxy({
    agentId: input.agentId,
    credentialId: credentialId!,
    action,
    params: inferEvaluationParams(provider, target, input.params),
    target,
    injection,
    timeout: input.timeout,
  });
}
