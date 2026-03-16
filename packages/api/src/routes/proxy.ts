import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAgent } from '../middleware/auth.js';
import { ValidationError } from '../errors.js';
import { executeProxy } from '../services/proxy.js';
import type { ProxyExecuteInput, InjectionConfig } from '../services/proxy.js';
import { MAX_TIMEOUT_MS } from '../services/httpClient.js';

export const proxyRouter = Router();

proxyRouter.use(requireAgent);

const ALLOWED_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);

function validateExecuteInput(req: Request): ProxyExecuteInput {
  const { credentialId, action, params, target, injection, timeout } = req.body;

  if (typeof credentialId !== 'string' || credentialId.length === 0) {
    throw new ValidationError('credentialId is required');
  }

  if (typeof action !== 'string' || action.length === 0) {
    throw new ValidationError('action is required');
  }

  // Validate params
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

  // Validate target
  if (typeof target !== 'object' || target === null || Array.isArray(target)) {
    throw new ValidationError('target is required and must be an object');
  }

  if (typeof target.url !== 'string' || target.url.length === 0) {
    throw new ValidationError('target.url is required');
  }

  const method = target.method ? String(target.method).toUpperCase() : 'GET';
  if (!ALLOWED_METHODS.has(method)) {
    throw new ValidationError(
      `target.method must be one of: ${[...ALLOWED_METHODS].join(', ')}`,
    );
  }

  const headers: Record<string, string> = {};
  if (target.headers !== undefined) {
    if (typeof target.headers !== 'object' || target.headers === null || Array.isArray(target.headers)) {
      throw new ValidationError('target.headers must be an object');
    }
    for (const [key, value] of Object.entries(target.headers)) {
      if (typeof value !== 'string') {
        throw new ValidationError(`target.headers["${key}"] must be a string`);
      }
      headers[key] = value;
    }
  }

  // Validate injection
  let parsedInjection: InjectionConfig | undefined;
  if (injection !== undefined) {
    if (typeof injection !== 'object' || injection === null || Array.isArray(injection)) {
      throw new ValidationError('injection must be an object');
    }
    if (!['header', 'query', 'body'].includes(injection.location)) {
      throw new ValidationError('injection.location must be one of: header, query, body');
    }
    if (typeof injection.key !== 'string' || injection.key.length === 0) {
      throw new ValidationError('injection.key is required');
    }
    parsedInjection = { location: injection.location, key: injection.key };
  }

  // Validate timeout
  let parsedTimeout: number | undefined;
  if (timeout !== undefined) {
    if (typeof timeout !== 'number' || timeout <= 0) {
      throw new ValidationError('timeout must be a positive number');
    }
    parsedTimeout = Math.min(timeout, MAX_TIMEOUT_MS);
  }

  return {
    agentId: req.agent!.id,
    credentialId,
    action,
    params: evalParams,
    target: { url: target.url, method, headers, body: target.body },
    injection: parsedInjection,
    timeout: parsedTimeout,
  };
}

// POST /v1/proxy/execute
proxyRouter.post('/execute', async (req: Request, res: Response) => {
  const input = validateExecuteInput(req);
  const result = await executeProxy(input);

  res.json({
    upstream: result.upstream,
    meta: result.meta,
  });
});
