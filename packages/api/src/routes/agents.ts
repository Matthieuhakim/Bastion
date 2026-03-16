import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Agent } from '@prisma/client';
import { requireAdmin } from '../middleware/auth.js';
import { registrationLimiter } from '../middleware/rateLimit.js';
import { ValidationError } from '../errors.js';
import * as agentService from '../services/agents.js';

export const agentRegistrationRouter = Router();
export const agentRouter = Router();

agentRouter.use(requireAdmin);

function serializeAgent(agent: Agent) {
  const { apiKeyHash: _h, encryptedPrivateKey: _k, ...safe } = agent;
  return safe;
}

function validateCreateInput(body: Record<string, unknown>): agentService.CreateAgentInput {
  const { name, description, callbackUrl } = body;

  if (typeof name !== 'string' || name.length === 0 || name.length > 255) {
    throw new ValidationError('name is required and must be 1-255 characters');
  }

  if (description !== undefined && (typeof description !== 'string' || description.length > 1000)) {
    throw new ValidationError('description must be a string of at most 1000 characters');
  }

  if (callbackUrl !== undefined) {
    if (typeof callbackUrl !== 'string') {
      throw new ValidationError('callbackUrl must be a string');
    }
    try {
      new URL(callbackUrl);
    } catch {
      throw new ValidationError('callbackUrl must be a valid URL');
    }
  }

  return {
    name,
    description: description as string | undefined,
    callbackUrl: callbackUrl as string | undefined,
  };
}

// POST /v1/agents/register — Public self-registration endpoint
agentRegistrationRouter.post(
  '/register',
  registrationLimiter,
  async (req: Request, res: Response) => {
    const input = validateCreateInput(req.body);
    const { agent, agentSecret } = await agentService.createAgent(input);

    res.status(201).json({
      ...serializeAgent(agent),
      agentSecret,
    });
  },
);

// POST /v1/agents — Create agent
agentRouter.post('/', async (req: Request, res: Response) => {
  const input = validateCreateInput(req.body);
  const { agent, agentSecret } = await agentService.createAgent(input);

  res.status(201).json({
    ...serializeAgent(agent),
    agentSecret,
  });
});

// GET /v1/agents — List agents
agentRouter.get('/', async (_req: Request, res: Response) => {
  const agents = await agentService.listAgents();
  res.json(agents.map(serializeAgent));
});

// GET /v1/agents/:id — Get single agent
agentRouter.get('/:id', async (req: Request<{ id: string }>, res: Response) => {
  const agent = await agentService.getAgent(req.params.id);
  res.json(serializeAgent(agent));
});

// PATCH /v1/agents/:id — Update agent
agentRouter.patch('/:id', async (req: Request<{ id: string }>, res: Response) => {
  const { name, description, callbackUrl, isActive } = req.body;
  const input: agentService.UpdateAgentInput = {};

  if (name !== undefined) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 255) {
      throw new ValidationError('name must be 1-255 characters');
    }
    input.name = name;
  }

  if (description !== undefined) {
    if (typeof description !== 'string' || description.length > 1000) {
      throw new ValidationError('description must be a string of at most 1000 characters');
    }
    input.description = description;
  }

  if (callbackUrl !== undefined) {
    if (typeof callbackUrl !== 'string') {
      throw new ValidationError('callbackUrl must be a string');
    }
    try {
      new URL(callbackUrl);
    } catch {
      throw new ValidationError('callbackUrl must be a valid URL');
    }
  }
  if (callbackUrl !== undefined) {
    input.callbackUrl = callbackUrl;
  }

  if (isActive !== undefined) {
    if (typeof isActive !== 'boolean') {
      throw new ValidationError('isActive must be a boolean');
    }
    input.isActive = isActive;
  }

  const agent = await agentService.updateAgent(req.params.id, input);
  res.json(serializeAgent(agent));
});

// DELETE /v1/agents/:id — Soft-delete agent
agentRouter.delete('/:id', async (req: Request<{ id: string }>, res: Response) => {
  const agent = await agentService.deleteAgent(req.params.id);
  res.json({ id: agent.id, isActive: agent.isActive });
});
