import type { CredentialType } from '@prisma/client';
import { prisma } from './db.js';
import { decryptCredential } from './credentials.js';
import { evaluateRequest, commitRateLimitAndSpend } from './policyEngine.js';
import type { EvaluationParams } from './policyEngine.js';
import { callExternalApi } from './httpClient.js';
import type { ExternalResponse } from './httpClient.js';
import { ForbiddenError, ValidationError } from '../errors.js';

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
}

export type ProxyResult =
  | { outcome: 'executed'; upstream: ExternalResponse; meta: ProxyMeta }
  | { outcome: 'escalated'; policyId: string | null; reason: string };

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '0.0.0.0',
]);

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
    throw new ForbiddenError(evaluation.reason);
  }

  if (evaluation.decision === 'ESCALATE') {
    return {
      outcome: 'escalated',
      policyId: evaluation.policyId,
      reason: evaluation.reason,
    };
  }

  // 4. Decrypt credential
  const credentialValue = await decryptCredential(credentialId);

  // 5. Inject credential into request
  const injectedTarget = injectCredential(target, credentialValue, credential.type, injection);

  // 6. Call external API
  const upstream = await callExternalApi(injectedTarget, timeout);

  // 7. Commit rate limit and spend counters (only after successful upstream call)
  await commitRateLimitAndSpend(agentId, credentialId, params);

  // 8. Return result
  return {
    outcome: 'executed',
    upstream,
    meta: {
      credentialId,
      action,
      policyDecision: 'ALLOW',
      policyId: evaluation.policyId,
      durationMs: Date.now() - start,
    },
  };
}
