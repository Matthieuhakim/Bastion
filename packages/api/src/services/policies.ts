import type { Policy } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from './db.js';
import { NotFoundError } from '../errors.js';

export interface PolicyConstraints {
  maxAmountPerTransaction?: number;
  maxDailySpend?: number;
  timeWindow?: {
    days: string[];
    hours: { start: string; end: string };
    timezone: string;
  };
  rateLimit?: {
    maxRequests: number;
    windowSeconds: number;
  };
  ipAllowlist?: string[];
  intentReview?: {
    enabled: boolean;
    mode?: 'escalate_on_risk';
    instructions?: string;
  };
}

export interface CreatePolicyInput {
  agentId: string;
  credentialId: string;
  allowedActions?: string[];
  deniedActions?: string[];
  constraints?: PolicyConstraints;
  requiresApprovalAbove?: number;
  expiresAt?: Date;
}

export interface UpdatePolicyInput {
  allowedActions?: string[];
  deniedActions?: string[];
  constraints?: PolicyConstraints | null;
  requiresApprovalAbove?: number | null;
  expiresAt?: Date | null;
  isActive?: boolean;
}

export interface ListPoliciesFilter {
  agentId?: string;
  credentialId?: string;
}

export async function createPolicy(input: CreatePolicyInput): Promise<Policy> {
  const agent = await prisma.agent.findUnique({ where: { id: input.agentId } });
  if (!agent) {
    throw new NotFoundError('Agent not found');
  }

  const credential = await prisma.credential.findUnique({ where: { id: input.credentialId } });
  if (!credential) {
    throw new NotFoundError('Credential not found');
  }

  return prisma.policy.create({
    data: {
      agentId: input.agentId,
      credentialId: input.credentialId,
      allowedActions: input.allowedActions ?? [],
      deniedActions: input.deniedActions ?? [],
      constraints: (input.constraints as Prisma.InputJsonValue) ?? undefined,
      requiresApprovalAbove: input.requiresApprovalAbove,
      expiresAt: input.expiresAt,
    },
  });
}

export async function listPolicies(filter: ListPoliciesFilter = {}): Promise<Policy[]> {
  const where: Record<string, string> = {};
  if (filter.agentId) where.agentId = filter.agentId;
  if (filter.credentialId) where.credentialId = filter.credentialId;

  return prisma.policy.findMany({
    where: Object.keys(where).length > 0 ? where : undefined,
    orderBy: { createdAt: 'desc' },
  });
}

export async function getPolicy(id: string): Promise<Policy> {
  const policy = await prisma.policy.findUnique({ where: { id } });
  if (!policy) {
    throw new NotFoundError('Policy not found');
  }
  return policy;
}

export async function updatePolicy(id: string, input: UpdatePolicyInput): Promise<Policy> {
  await getPolicy(id);

  const data: Prisma.PolicyUpdateInput = {};
  if (input.allowedActions !== undefined) data.allowedActions = input.allowedActions;
  if (input.deniedActions !== undefined) data.deniedActions = input.deniedActions;
  if (input.constraints !== undefined) {
    data.constraints =
      input.constraints === null ? Prisma.JsonNull : (input.constraints as Prisma.InputJsonValue);
  }
  if (input.requiresApprovalAbove !== undefined)
    data.requiresApprovalAbove = input.requiresApprovalAbove;
  if (input.expiresAt !== undefined) data.expiresAt = input.expiresAt;
  if (input.isActive !== undefined) data.isActive = input.isActive;

  return prisma.policy.update({ where: { id }, data });
}

export async function deletePolicy(id: string): Promise<Policy> {
  await getPolicy(id);
  return prisma.policy.update({
    where: { id },
    data: { isActive: false },
  });
}
