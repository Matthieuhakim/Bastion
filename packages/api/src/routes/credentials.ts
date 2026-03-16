import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Credential } from '@prisma/client';
import { requireAdmin } from '../middleware/auth.js';
import { ValidationError } from '../errors.js';
import * as credentialService from '../services/credentials.js';

export const credentialRouter = Router();

credentialRouter.use(requireAdmin);

const VALID_TYPES = ['API_KEY', 'OAUTH2', 'CUSTOM'] as const;

function serializeCredential(credential: Credential) {
  const { encryptedBlob: _b, encryptedDek: _d, iv: _i, authTag: _t, ...safe } = credential;
  return safe;
}

function validateCreateInput(
  body: Record<string, unknown>,
): credentialService.CreateCredentialInput {
  const { name, type, value, agentId, metadata, scopes, expiresAt } = body;

  if (typeof name !== 'string' || name.length === 0 || name.length > 255) {
    throw new ValidationError('name is required and must be 1-255 characters');
  }

  if (typeof type !== 'string' || !VALID_TYPES.includes(type as (typeof VALID_TYPES)[number])) {
    throw new ValidationError('type must be one of: API_KEY, OAUTH2, CUSTOM');
  }

  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('value is required and must be a non-empty string');
  }

  if (typeof agentId !== 'string' || agentId.length === 0) {
    throw new ValidationError('agentId is required');
  }

  if (
    metadata !== undefined &&
    (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))
  ) {
    throw new ValidationError('metadata must be an object');
  }

  if (scopes !== undefined) {
    if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === 'string')) {
      throw new ValidationError('scopes must be an array of strings');
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
    name,
    type: type as credentialService.CreateCredentialInput['type'],
    value: value as string,
    agentId: agentId as string,
    metadata: metadata as Record<string, unknown> | undefined,
    scopes: scopes as string[] | undefined,
    expiresAt: parsedExpiresAt,
  };
}

// POST /v1/credentials — Create credential
credentialRouter.post('/', async (req: Request, res: Response) => {
  const input = validateCreateInput(req.body);
  const credential = await credentialService.createCredential(input);
  res.status(201).json(serializeCredential(credential));
});

// GET /v1/credentials — List credentials
credentialRouter.get('/', async (req: Request, res: Response) => {
  const agentId = typeof req.query['agentId'] === 'string' ? req.query['agentId'] : undefined;
  const credentials = await credentialService.listCredentials(agentId);
  res.json(credentials.map(serializeCredential));
});

// GET /v1/credentials/:id — Get single credential
credentialRouter.get('/:id', async (req: Request<{ id: string }>, res: Response) => {
  const credential = await credentialService.getCredential(req.params.id);
  res.json(serializeCredential(credential));
});

// DELETE /v1/credentials/:id — Revoke credential
credentialRouter.delete('/:id', async (req: Request<{ id: string }>, res: Response) => {
  const credential = await credentialService.revokeCredential(req.params.id);
  res.json({ id: credential.id, isRevoked: credential.isRevoked });
});
