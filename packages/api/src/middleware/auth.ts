import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { findAgentBySecret } from '../services/agents.js';
import { UnauthorizedError } from '../errors.js';

function extractBearerToken(req: Request): string {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing or malformed Authorization header');
  }
  return header.slice(7);
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);

  const tokenBuf = Buffer.from(token);
  const keyBuf = Buffer.from(config.projectApiKey);

  if (tokenBuf.length !== keyBuf.length || !crypto.timingSafeEqual(tokenBuf, keyBuf)) {
    throw new UnauthorizedError();
  }

  next();
}

export async function requireAgent(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractBearerToken(req);

  const agent = await findAgentBySecret(token);
  if (!agent) {
    throw new UnauthorizedError();
  }

  if (!agent.isActive) {
    throw new UnauthorizedError('Agent is deactivated');
  }

  req.agent = agent;
  next();
}
