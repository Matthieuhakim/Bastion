import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAgent } from '../middleware/auth.js';
import { ValidationError } from '../errors.js';
import { executeProxy, executeTransparentProxy } from '../services/proxy.js';
import type { ProxyExecuteInput, ProxyFetchInput, InjectionConfig } from '../services/proxy.js';
import { MAX_TIMEOUT_MS } from '../services/httpClient.js';

export const proxyRouter = Router();

proxyRouter.use(requireAgent);

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

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
    throw new ValidationError(`target.method must be one of: ${[...ALLOWED_METHODS].join(', ')}`);
  }

  const headers: Record<string, string> = {};
  if (target.headers !== undefined) {
    if (
      typeof target.headers !== 'object' ||
      target.headers === null ||
      Array.isArray(target.headers)
    ) {
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

function parseParams(params: unknown): { amount?: number; ip?: string } {
  const evalParams: { amount?: number; ip?: string } = {};
  if (params !== undefined) {
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      throw new ValidationError('params must be an object');
    }
    if ((params as Record<string, unknown>).amount !== undefined) {
      if (typeof (params as Record<string, unknown>).amount !== 'number') {
        throw new ValidationError('params.amount must be a number');
      }
      evalParams.amount = (params as Record<string, unknown>).amount as number;
    }
    if ((params as Record<string, unknown>).ip !== undefined) {
      if (typeof (params as Record<string, unknown>).ip !== 'string') {
        throw new ValidationError('params.ip must be a string');
      }
      evalParams.ip = (params as Record<string, unknown>).ip as string;
    }
  }
  return evalParams;
}

function parseHeaders(headers: unknown): Record<string, string> {
  const parsedHeaders: Record<string, string> = {};
  if (headers !== undefined) {
    if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
      throw new ValidationError('headers must be an object');
    }
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value !== 'string') {
        throw new ValidationError(`headers["${key}"] must be a string`);
      }
      parsedHeaders[key] = value;
    }
  }
  return parsedHeaders;
}

function parseInjection(injection: unknown): InjectionConfig | undefined {
  if (injection === undefined) {
    return undefined;
  }

  if (typeof injection !== 'object' || injection === null || Array.isArray(injection)) {
    throw new ValidationError('injection must be an object');
  }
  if (
    !['header', 'query', 'body'].includes((injection as Record<string, unknown>).location as string)
  ) {
    throw new ValidationError('injection.location must be one of: header, query, body');
  }
  if (
    typeof (injection as Record<string, unknown>).key !== 'string' ||
    ((injection as Record<string, unknown>).key as string).length === 0
  ) {
    throw new ValidationError('injection.key is required');
  }

  return {
    location: (injection as Record<string, unknown>).location as InjectionConfig['location'],
    key: (injection as Record<string, unknown>).key as string,
  };
}

function parseTimeout(timeout: unknown): number | undefined {
  if (timeout === undefined) {
    return undefined;
  }

  if (typeof timeout !== 'number' || timeout <= 0) {
    throw new ValidationError('timeout must be a positive number');
  }

  return Math.min(timeout, MAX_TIMEOUT_MS);
}

function validateFetchInput(req: Request): ProxyFetchInput {
  const { url, method, headers, body, params, action, credentialId, injection, timeout } =
    req.body as Record<string, unknown>;

  if (typeof url !== 'string' || url.length === 0) {
    throw new ValidationError('url is required');
  }

  const normalizedMethod = method ? String(method).toUpperCase() : 'GET';
  if (!ALLOWED_METHODS.has(normalizedMethod)) {
    throw new ValidationError(`method must be one of: ${[...ALLOWED_METHODS].join(', ')}`);
  }

  if (action !== undefined && (typeof action !== 'string' || action.length === 0)) {
    throw new ValidationError('action must be a non-empty string');
  }

  if (
    credentialId !== undefined &&
    (typeof credentialId !== 'string' || credentialId.length === 0)
  ) {
    throw new ValidationError('credentialId must be a non-empty string');
  }

  return {
    agentId: req.agent!.id,
    url,
    method: normalizedMethod,
    headers: parseHeaders(headers),
    body,
    params: parseParams(params),
    action: action as string | undefined,
    credentialId: credentialId as string | undefined,
    injection: parseInjection(injection),
    timeout: parseTimeout(timeout),
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

// POST /v1/proxy/fetch
proxyRouter.post('/fetch', async (req: Request, res: Response) => {
  const input = validateFetchInput(req);
  const result = await executeTransparentProxy(input);

  res.json({
    upstream: result.upstream,
    meta: result.meta,
  });
});
