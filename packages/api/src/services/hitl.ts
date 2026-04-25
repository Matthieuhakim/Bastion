import { v4 as uuidv4 } from 'uuid';
import { redis, createSubscriberConnection } from './redis.js';
import { NotFoundError, ConflictError } from '../errors.js';
import type { EvaluationParams } from './policyEngine.js';
import type { ProxyTarget, InjectionConfig } from './proxy.js';
import type { IntentJudgeVerdict } from './intentJudge.js';

export interface PendingRequest {
  requestId: string;
  status: 'pending' | 'approved' | 'denied';
  agentId: string;
  credentialId: string;
  action: string;
  params: EvaluationParams;
  target: ProxyTarget;
  injection?: InjectionConfig;
  timeout?: number;
  policyId: string | null;
  reason: string;
  intentReview?: IntentJudgeVerdict;
  createdAt: string;
  resolvedBy?: string;
  denialReason?: string;
}

export interface EscalationInfo {
  policyId: string | null;
  reason: string;
  intentReview?: IntentJudgeVerdict;
}

const DEFAULT_TTL_SECONDS = 300; // 5 minutes
const MAX_TTL_SECONDS = 900; // 15 minutes
const PENDING_SET_KEY = 'hitl:pending';

function hitlKey(requestId: string): string {
  return `hitl:${requestId}`;
}

function resolutionChannel(requestId: string): string {
  return `hitl:${requestId}:resolution`;
}

export async function createPendingRequest(
  input: {
    agentId: string;
    credentialId: string;
    action: string;
    params: EvaluationParams;
    target: ProxyTarget;
    injection?: InjectionConfig;
    timeout?: number;
  },
  escalation: EscalationInfo,
): Promise<PendingRequest> {
  const requestId = uuidv4();
  const pending: PendingRequest = {
    requestId,
    status: 'pending',
    agentId: input.agentId,
    credentialId: input.credentialId,
    action: input.action,
    params: input.params,
    target: input.target,
    injection: input.injection,
    timeout: input.timeout,
    policyId: escalation.policyId,
    reason: escalation.reason,
    intentReview: escalation.intentReview,
    createdAt: new Date().toISOString(),
  };

  const ttl = Math.min(DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS);
  await redis.set(hitlKey(requestId), JSON.stringify(pending), 'EX', ttl);
  await redis.sadd(PENDING_SET_KEY, requestId);

  return pending;
}

export async function waitForResolution(
  requestId: string,
  timeoutMs: number,
): Promise<'approved' | 'denied' | 'timeout'> {
  const subscriber = createSubscriberConnection();
  const channel = resolutionChannel(requestId);

  return new Promise<'approved' | 'denied' | 'timeout'>((resolve) => {
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscriber.unsubscribe(channel).catch(() => {});
      subscriber.disconnect();
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve('timeout');
    }, timeoutMs);

    subscriber
      .subscribe(channel)
      .then(() => {
        // Race condition guard: check if already resolved between SET and SUBSCRIBE
        redis
          .get(hitlKey(requestId))
          .then((data) => {
            if (!data || settled) return;
            const parsed = JSON.parse(data) as PendingRequest;
            if (parsed.status === 'approved' || parsed.status === 'denied') {
              cleanup();
              resolve(parsed.status);
            }
          })
          .catch(() => {});
      })
      .catch(() => {
        cleanup();
        resolve('timeout');
      });

    subscriber.on('message', (_ch: string, message: string) => {
      const { status } = JSON.parse(message) as { status: 'approved' | 'denied' };
      cleanup();
      resolve(status);
    });
  });
}

export async function resolveRequest(
  requestId: string,
  decision: 'approved' | 'denied',
  denialReason?: string,
): Promise<PendingRequest> {
  const data = await redis.get(hitlKey(requestId));
  if (!data) {
    throw new NotFoundError('Pending request not found or expired');
  }

  const pending = JSON.parse(data) as PendingRequest;
  if (pending.status !== 'pending') {
    throw new ConflictError('Request has already been resolved');
  }

  pending.status = decision;
  pending.resolvedBy = 'admin';
  if (denialReason) {
    pending.denialReason = denialReason;
  }

  // Preserve remaining TTL
  const ttl = await redis.ttl(hitlKey(requestId));
  if (ttl > 0) {
    await redis.set(hitlKey(requestId), JSON.stringify(pending), 'EX', ttl);
  } else {
    await redis.set(hitlKey(requestId), JSON.stringify(pending), 'EX', 60);
  }

  await redis.srem(PENDING_SET_KEY, requestId);
  await redis.publish(resolutionChannel(requestId), JSON.stringify({ status: decision }));

  return pending;
}

export async function getPendingRequest(requestId: string): Promise<PendingRequest | null> {
  const data = await redis.get(hitlKey(requestId));
  if (!data) return null;
  return JSON.parse(data) as PendingRequest;
}

export async function listPendingRequests(): Promise<PendingRequest[]> {
  const ids = await redis.smembers(PENDING_SET_KEY);
  if (ids.length === 0) return [];

  const keys = ids.map(hitlKey);
  const values = await redis.mget(...keys);

  const results: PendingRequest[] = [];
  const staleIds: string[] = [];

  for (let i = 0; i < ids.length; i++) {
    const val = values[i];
    if (!val) {
      staleIds.push(ids[i]);
      continue;
    }
    const parsed = JSON.parse(val) as PendingRequest;
    if (parsed.status === 'pending') {
      results.push(parsed);
    } else {
      staleIds.push(ids[i]);
    }
  }

  // Clean up stale entries
  if (staleIds.length > 0) {
    await redis.srem(PENDING_SET_KEY, ...staleIds);
  }

  return results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}
