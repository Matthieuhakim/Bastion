import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { ValidationError } from '../errors.js';
import { queryAuditRecords, verifyChain } from '../services/auditChain.js';

export const auditRouter = Router();

auditRouter.use(requireAdmin);

function requireAgentId(req: Request): string {
  const agentId = req.query['agentId'];
  if (typeof agentId !== 'string' || agentId.length === 0) {
    throw new ValidationError('agentId is required');
  }

  return agentId;
}

function parseOptionalDate(value: unknown, field: string): Date | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} must be a valid ISO 8601 date`);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(`${field} must be a valid ISO 8601 date`);
  }

  return parsed;
}

function parseOptionalCursor(value: unknown): bigint | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new ValidationError('cursor must be a positive integer string');
  }

  return BigInt(value);
}

function parseOptionalLimit(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new ValidationError('limit must be a positive integer');
  }

  const limit = Number.parseInt(value, 10);
  if (limit <= 0) {
    throw new ValidationError('limit must be a positive integer');
  }

  return limit;
}

function parseOptionalPolicyDecision(value: unknown): 'ALLOW' | 'DENY' | 'ESCALATE' | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value !== 'ALLOW' && value !== 'DENY' && value !== 'ESCALATE') {
    throw new ValidationError('policyDecision must be one of: ALLOW, DENY, ESCALATE');
  }

  return value;
}

// GET /v1/audit
auditRouter.get('/', async (req: Request, res: Response) => {
  const from = parseOptionalDate(req.query['from'], 'from');
  const to = parseOptionalDate(req.query['to'], 'to');

  if (from && to && from > to) {
    throw new ValidationError('from must be before or equal to to');
  }

  const result = await queryAuditRecords({
    agentId: requireAgentId(req),
    from,
    to,
    action: typeof req.query['action'] === 'string' ? req.query['action'] : undefined,
    policyDecision: parseOptionalPolicyDecision(req.query['policyDecision']),
    cursor: parseOptionalCursor(req.query['cursor']),
    limit: parseOptionalLimit(req.query['limit']),
  });

  res.json(result);
});

// GET /v1/audit/verify
auditRouter.get('/verify', async (req: Request, res: Response) => {
  const result = await verifyChain(requireAgentId(req));
  res.json(result);
});
