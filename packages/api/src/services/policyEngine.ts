import type { Policy } from '@prisma/client';
import { DateTime } from 'luxon';
import { prisma } from './db.js';
import {
  getRateLimitCount,
  getDailySpend,
  incrementRateLimit,
  incrementDailySpend,
} from './redis.js';
import type { PolicyConstraints } from './policies.js';

export type PolicyDecision = 'ALLOW' | 'DENY' | 'ESCALATE';

export type IntentReviewConstraint = NonNullable<PolicyConstraints['intentReview']> & {
  policyId: string | null;
};

export interface EvaluationResult {
  decision: PolicyDecision;
  policyId: string | null;
  reason: string;
  intentReview?: IntentReviewConstraint;
}

export interface EvaluationParams {
  amount?: number;
  ip?: string;
}

export function matchesAction(pattern: string, action: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === action;
  // Wildcard: 'transfers.*' matches 'transfers.create', 'transfers.read.all', etc.
  const prefix = pattern.slice(0, pattern.indexOf('*'));
  return action.startsWith(prefix);
}

export function isWithinTimeWindow(timeWindow: {
  days: string[];
  hours: { start: string; end: string };
  timezone: string;
}): boolean {
  const now = DateTime.now().setZone(timeWindow.timezone);
  if (!now.isValid) return false;

  const dayName = now.weekdayLong?.toLowerCase();
  if (!dayName || !timeWindow.days.includes(dayName)) return false;

  const [startHour, startMin] = timeWindow.hours.start.split(':').map(Number);
  const [endHour, endMin] = timeWindow.hours.end.split(':').map(Number);
  const currentMinutes = now.hour * 60 + now.minute;
  const startMinutes = startHour * 60 + startMin;
  const endMinutes = endHour * 60 + endMin;

  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

async function evaluatePolicy(
  policy: Policy,
  action: string,
  params: EvaluationParams,
  dryRun: boolean,
): Promise<EvaluationResult> {
  const constraints = (policy.constraints as PolicyConstraints) ?? {};
  const policyId = policy.id;

  // 1. Check denied actions
  if (policy.deniedActions.length > 0) {
    for (const pattern of policy.deniedActions) {
      if (matchesAction(pattern, action)) {
        return { decision: 'DENY', policyId, reason: `Action "${action}" is denied by policy` };
      }
    }
  }

  // 2. Check allowed actions (if non-empty, action must match at least one)
  if (policy.allowedActions.length > 0) {
    const allowed = policy.allowedActions.some((pattern) => matchesAction(pattern, action));
    if (!allowed) {
      return {
        decision: 'DENY',
        policyId,
        reason: `Action "${action}" is not in the allowed actions list`,
      };
    }
  }

  // 3. Check IP allowlist
  if (constraints.ipAllowlist && constraints.ipAllowlist.length > 0) {
    if (!params.ip || !constraints.ipAllowlist.includes(params.ip)) {
      return { decision: 'DENY', policyId, reason: 'IP address is not in the allowlist' };
    }
  }

  // 4. Check time window
  if (constraints.timeWindow) {
    if (!isWithinTimeWindow(constraints.timeWindow)) {
      return { decision: 'DENY', policyId, reason: 'Request is outside the allowed time window' };
    }
  }

  // 5. Check max amount per transaction
  if (constraints.maxAmountPerTransaction != null && params.amount != null) {
    if (params.amount > constraints.maxAmountPerTransaction) {
      return {
        decision: 'DENY',
        policyId,
        reason: `Amount ${params.amount} exceeds maximum ${constraints.maxAmountPerTransaction} per transaction`,
      };
    }
  }

  // 6. Check rate limit
  if (constraints.rateLimit) {
    const count = dryRun
      ? await getRateLimitCount(policyId, constraints.rateLimit.windowSeconds)
      : await getRateLimitCount(policyId, constraints.rateLimit.windowSeconds);
    if (count >= constraints.rateLimit.maxRequests) {
      return {
        decision: 'DENY',
        policyId,
        reason: `Rate limit exceeded: ${count}/${constraints.rateLimit.maxRequests} requests`,
      };
    }
  }

  // 7. Check daily spend
  if (constraints.maxDailySpend != null && params.amount != null) {
    const tz = constraints.timeWindow?.timezone ?? 'UTC';
    const dateKey = DateTime.now().setZone(tz).toFormat('yyyy-MM-dd');
    const currentSpend = await getDailySpend(policyId, dateKey);
    if (currentSpend + params.amount > constraints.maxDailySpend) {
      return {
        decision: 'DENY',
        policyId,
        reason: `Daily spend would be ${currentSpend + params.amount}, exceeding limit of ${constraints.maxDailySpend}`,
      };
    }
  }

  // 8. Check approval threshold
  if (policy.requiresApprovalAbove != null && params.amount != null) {
    if (params.amount > policy.requiresApprovalAbove) {
      return {
        decision: 'ESCALATE',
        policyId,
        reason: `Amount ${params.amount} exceeds approval threshold ${policy.requiresApprovalAbove}`,
      };
    }
  }

  return { decision: 'ALLOW', policyId, reason: 'Request allowed by policy' };
}

export async function evaluateRequest(
  agentId: string,
  credentialId: string,
  action: string,
  params: EvaluationParams = {},
  options: { dryRun?: boolean } = {},
): Promise<EvaluationResult> {
  const dryRun = options.dryRun ?? false;

  // Find all active policies for this agent+credential pair
  const policies = await prisma.policy.findMany({
    where: { agentId, credentialId, isActive: true },
  });

  // Filter out expired policies
  const now = new Date();
  const activePolicies = policies.filter((p) => !p.expiresAt || p.expiresAt > now);

  // Fail closed: no policy = deny
  if (activePolicies.length === 0) {
    return {
      decision: 'DENY',
      policyId: null,
      reason: 'No active policy found for this agent and credential',
    };
  }

  // Evaluate all policies; most restrictive wins
  let finalResult: EvaluationResult = {
    decision: 'ALLOW',
    policyId: activePolicies[0].id,
    reason: 'Request allowed by policy',
  };
  let intentReview: IntentReviewConstraint | undefined;

  for (const policy of activePolicies) {
    const constraints = (policy.constraints as PolicyConstraints) ?? {};
    if (constraints.intentReview?.enabled && !intentReview) {
      intentReview = {
        ...constraints.intentReview,
        mode: constraints.intentReview.mode ?? 'escalate_on_risk',
        policyId: policy.id,
      };
    }

    const result = await evaluatePolicy(policy, action, params, dryRun);

    if (result.decision === 'DENY') {
      return result; // DENY is the most restrictive, return immediately
    }
    if (result.decision === 'ESCALATE' && finalResult.decision !== 'DENY') {
      finalResult = result;
    }
  }

  if (intentReview) {
    finalResult.intentReview = intentReview;
  }

  return finalResult;
}

export async function commitRateLimitAndSpend(
  agentId: string,
  credentialId: string,
  params: EvaluationParams = {},
): Promise<void> {
  const policies = await prisma.policy.findMany({
    where: { agentId, credentialId, isActive: true },
  });

  const now = new Date();
  const activePolicies = policies.filter((p) => !p.expiresAt || p.expiresAt > now);

  for (const policy of activePolicies) {
    const constraints = (policy.constraints as PolicyConstraints) ?? {};

    if (constraints.rateLimit) {
      await incrementRateLimit(policy.id, constraints.rateLimit.windowSeconds);
    }

    if (constraints.maxDailySpend != null && params.amount != null) {
      const tz = constraints.timeWindow?.timezone ?? 'UTC';
      const dateKey = DateTime.now().setZone(tz).toFormat('yyyy-MM-dd');
      await incrementDailySpend(policy.id, params.amount, dateKey);
    }
  }
}
