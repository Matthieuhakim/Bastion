import { Router } from 'express';
import type { Request, Response } from 'express';
import { DateTime } from 'luxon';
import { requireAdmin } from '../middleware/auth.js';
import { ValidationError } from '../errors.js';
import * as policyService from '../services/policies.js';
import type { PolicyConstraints } from '../services/policies.js';
import { evaluateRequest } from '../services/policyEngine.js';

export const policyRouter = Router();

policyRouter.use(requireAdmin);

function validateConstraints(constraints: unknown): PolicyConstraints {
  if (typeof constraints !== 'object' || constraints === null || Array.isArray(constraints)) {
    throw new ValidationError('constraints must be an object');
  }

  const c = constraints as Record<string, unknown>;
  const result: PolicyConstraints = {};

  if (c.maxAmountPerTransaction !== undefined) {
    if (typeof c.maxAmountPerTransaction !== 'number' || c.maxAmountPerTransaction <= 0) {
      throw new ValidationError('constraints.maxAmountPerTransaction must be a positive number');
    }
    result.maxAmountPerTransaction = c.maxAmountPerTransaction;
  }

  if (c.maxDailySpend !== undefined) {
    if (typeof c.maxDailySpend !== 'number' || c.maxDailySpend <= 0) {
      throw new ValidationError('constraints.maxDailySpend must be a positive number');
    }
    result.maxDailySpend = c.maxDailySpend;
  }

  if (c.timeWindow !== undefined) {
    const tw = c.timeWindow as Record<string, unknown>;
    if (typeof tw !== 'object' || tw === null || Array.isArray(tw)) {
      throw new ValidationError('constraints.timeWindow must be an object');
    }
    if (!Array.isArray(tw.days) || !tw.days.every((d: unknown) => typeof d === 'string')) {
      throw new ValidationError('constraints.timeWindow.days must be an array of strings');
    }
    if (typeof tw.hours !== 'object' || tw.hours === null || Array.isArray(tw.hours)) {
      throw new ValidationError(
        'constraints.timeWindow.hours must be an object with start and end',
      );
    }
    const hours = tw.hours as Record<string, unknown>;
    if (typeof hours.start !== 'string' || !/^\d{2}:\d{2}$/.test(hours.start)) {
      throw new ValidationError('constraints.timeWindow.hours.start must be in HH:mm format');
    }
    if (typeof hours.end !== 'string' || !/^\d{2}:\d{2}$/.test(hours.end)) {
      throw new ValidationError('constraints.timeWindow.hours.end must be in HH:mm format');
    }
    if (typeof tw.timezone !== 'string') {
      throw new ValidationError('constraints.timeWindow.timezone must be a string');
    }
    if (!DateTime.now().setZone(tw.timezone).isValid) {
      throw new ValidationError('constraints.timeWindow.timezone must be a valid IANA timezone');
    }
    result.timeWindow = {
      days: tw.days as string[],
      hours: { start: hours.start, end: hours.end },
      timezone: tw.timezone,
    };
  }

  if (c.rateLimit !== undefined) {
    const rl = c.rateLimit as Record<string, unknown>;
    if (typeof rl !== 'object' || rl === null || Array.isArray(rl)) {
      throw new ValidationError('constraints.rateLimit must be an object');
    }
    if (
      typeof rl.maxRequests !== 'number' ||
      !Number.isInteger(rl.maxRequests) ||
      rl.maxRequests <= 0
    ) {
      throw new ValidationError('constraints.rateLimit.maxRequests must be a positive integer');
    }
    if (
      typeof rl.windowSeconds !== 'number' ||
      !Number.isInteger(rl.windowSeconds) ||
      rl.windowSeconds <= 0
    ) {
      throw new ValidationError('constraints.rateLimit.windowSeconds must be a positive integer');
    }
    result.rateLimit = {
      maxRequests: rl.maxRequests,
      windowSeconds: rl.windowSeconds,
    };
  }

  if (c.ipAllowlist !== undefined) {
    if (
      !Array.isArray(c.ipAllowlist) ||
      !c.ipAllowlist.every((ip: unknown) => typeof ip === 'string')
    ) {
      throw new ValidationError('constraints.ipAllowlist must be an array of strings');
    }
    result.ipAllowlist = c.ipAllowlist as string[];
  }

  if (c.intentReview !== undefined) {
    const ir = c.intentReview as Record<string, unknown>;
    if (typeof ir !== 'object' || ir === null || Array.isArray(ir)) {
      throw new ValidationError('constraints.intentReview must be an object');
    }
    if (typeof ir.enabled !== 'boolean') {
      throw new ValidationError('constraints.intentReview.enabled must be a boolean');
    }
    if (ir.mode !== undefined && ir.mode !== 'escalate_on_risk') {
      throw new ValidationError('constraints.intentReview.mode must be escalate_on_risk');
    }
    if (ir.instructions !== undefined && typeof ir.instructions !== 'string') {
      throw new ValidationError('constraints.intentReview.instructions must be a string');
    }

    result.intentReview = {
      enabled: ir.enabled,
      mode: 'escalate_on_risk',
      ...(ir.instructions ? { instructions: ir.instructions } : {}),
    };
  }

  return result;
}

function validateCreateInput(body: Record<string, unknown>): policyService.CreatePolicyInput {
  const {
    agentId,
    credentialId,
    allowedActions,
    deniedActions,
    constraints,
    requiresApprovalAbove,
    expiresAt,
  } = body;

  if (typeof agentId !== 'string' || agentId.length === 0) {
    throw new ValidationError('agentId is required');
  }

  if (typeof credentialId !== 'string' || credentialId.length === 0) {
    throw new ValidationError('credentialId is required');
  }

  if (allowedActions !== undefined) {
    if (
      !Array.isArray(allowedActions) ||
      !allowedActions.every((a: unknown) => typeof a === 'string')
    ) {
      throw new ValidationError('allowedActions must be an array of strings');
    }
  }

  if (deniedActions !== undefined) {
    if (
      !Array.isArray(deniedActions) ||
      !deniedActions.every((a: unknown) => typeof a === 'string')
    ) {
      throw new ValidationError('deniedActions must be an array of strings');
    }
  }

  let parsedConstraints: PolicyConstraints | undefined;
  if (constraints !== undefined) {
    parsedConstraints = validateConstraints(constraints);
  }

  if (requiresApprovalAbove !== undefined) {
    if (typeof requiresApprovalAbove !== 'number' || requiresApprovalAbove <= 0) {
      throw new ValidationError('requiresApprovalAbove must be a positive number');
    }
  }

  let parsedExpiresAt: Date | undefined;
  if (expiresAt !== undefined) {
    const date = new Date(expiresAt as string);
    if (isNaN(date.getTime())) {
      throw new ValidationError('expiresAt must be a valid ISO 8601 date');
    }
    if (date <= new Date()) {
      throw new ValidationError('expiresAt must be in the future');
    }
    parsedExpiresAt = date;
  }

  return {
    agentId: agentId as string,
    credentialId: credentialId as string,
    allowedActions: allowedActions as string[] | undefined,
    deniedActions: deniedActions as string[] | undefined,
    constraints: parsedConstraints,
    requiresApprovalAbove: requiresApprovalAbove as number | undefined,
    expiresAt: parsedExpiresAt,
  };
}

// POST /v1/policies/evaluate — Dry-run policy evaluation (registered before /:id)
policyRouter.post('/evaluate', async (req: Request, res: Response) => {
  const { agentId, credentialId, action, params } = req.body;

  if (typeof agentId !== 'string' || agentId.length === 0) {
    throw new ValidationError('agentId is required');
  }
  if (typeof credentialId !== 'string' || credentialId.length === 0) {
    throw new ValidationError('credentialId is required');
  }
  if (typeof action !== 'string' || action.length === 0) {
    throw new ValidationError('action is required');
  }

  const evalParams: { amount?: number; ip?: string } = {};
  if (params !== undefined) {
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      throw new ValidationError('params must be an object');
    }
    if (params.amount !== undefined) {
      if (typeof params.amount !== 'number') {
        throw new ValidationError('params.amount must be a number');
      }
      evalParams.amount = params.amount;
    }
    if (params.ip !== undefined) {
      if (typeof params.ip !== 'string') {
        throw new ValidationError('params.ip must be a string');
      }
      evalParams.ip = params.ip;
    }
  }

  const result = await evaluateRequest(agentId, credentialId, action, evalParams, { dryRun: true });
  res.json(result);
});

// POST /v1/policies — Create policy
policyRouter.post('/', async (req: Request, res: Response) => {
  const input = validateCreateInput(req.body);
  const policy = await policyService.createPolicy(input);
  res.status(201).json(policy);
});

// GET /v1/policies — List policies
policyRouter.get('/', async (req: Request, res: Response) => {
  const agentId = typeof req.query['agentId'] === 'string' ? req.query['agentId'] : undefined;
  const credentialId =
    typeof req.query['credentialId'] === 'string' ? req.query['credentialId'] : undefined;
  const policies = await policyService.listPolicies({ agentId, credentialId });
  res.json(policies);
});

// GET /v1/policies/:id — Get single policy
policyRouter.get('/:id', async (req: Request<{ id: string }>, res: Response) => {
  const policy = await policyService.getPolicy(req.params.id);
  res.json(policy);
});

// PATCH /v1/policies/:id — Update policy
policyRouter.patch('/:id', async (req: Request<{ id: string }>, res: Response) => {
  const input: policyService.UpdatePolicyInput = {};

  if (req.body.allowedActions !== undefined) {
    if (
      !Array.isArray(req.body.allowedActions) ||
      !req.body.allowedActions.every((a: unknown) => typeof a === 'string')
    ) {
      throw new ValidationError('allowedActions must be an array of strings');
    }
    input.allowedActions = req.body.allowedActions;
  }

  if (req.body.deniedActions !== undefined) {
    if (
      !Array.isArray(req.body.deniedActions) ||
      !req.body.deniedActions.every((a: unknown) => typeof a === 'string')
    ) {
      throw new ValidationError('deniedActions must be an array of strings');
    }
    input.deniedActions = req.body.deniedActions;
  }

  if (req.body.constraints !== undefined) {
    input.constraints =
      req.body.constraints === null ? null : validateConstraints(req.body.constraints);
  }

  if (req.body.requiresApprovalAbove !== undefined) {
    if (req.body.requiresApprovalAbove !== null) {
      if (
        typeof req.body.requiresApprovalAbove !== 'number' ||
        req.body.requiresApprovalAbove <= 0
      ) {
        throw new ValidationError('requiresApprovalAbove must be a positive number');
      }
    }
    input.requiresApprovalAbove = req.body.requiresApprovalAbove;
  }

  if (req.body.expiresAt !== undefined) {
    if (req.body.expiresAt === null) {
      input.expiresAt = null;
    } else {
      const date = new Date(req.body.expiresAt);
      if (isNaN(date.getTime())) {
        throw new ValidationError('expiresAt must be a valid ISO 8601 date');
      }
      if (date <= new Date()) {
        throw new ValidationError('expiresAt must be in the future');
      }
      input.expiresAt = date;
    }
  }

  if (req.body.isActive !== undefined) {
    if (typeof req.body.isActive !== 'boolean') {
      throw new ValidationError('isActive must be a boolean');
    }
    input.isActive = req.body.isActive;
  }

  const policy = await policyService.updatePolicy(req.params.id, input);
  res.json(policy);
});

// DELETE /v1/policies/:id — Deactivate policy
policyRouter.delete('/:id', async (req: Request<{ id: string }>, res: Response) => {
  const policy = await policyService.deletePolicy(req.params.id);
  res.json({ id: policy.id, isActive: policy.isActive });
});
