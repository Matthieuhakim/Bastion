import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BastionClient } from '../client.js';
import {
  BastionError,
  BastionValidationError,
  BastionUnauthorizedError,
  BastionForbiddenError,
  BastionNotFoundError,
  BastionConflictError,
  BastionBadGatewayError,
} from '../errors.js';

const BASE_URL = 'http://localhost:3000';
const API_KEY = 'test-api-key';

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'mock',
    json: () => Promise.resolve(body),
  });
}

let client: BastionClient;

beforeEach(() => {
  client = new BastionClient({ baseUrl: BASE_URL, apiKey: API_KEY });
  vi.restoreAllMocks();
});

describe('health', () => {
  it('returns health response', async () => {
    const body = { status: 'ok', timestamp: '2026-03-16T00:00:00Z', version: '0.1.0' };
    global.fetch = mockFetch(200, body);

    const result = await client.health();

    expect(result).toEqual(body);
    expect(global.fetch).toHaveBeenCalledWith(
      `${BASE_URL}/health`,
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

describe('agents', () => {
  it('createAgent sends POST with body', async () => {
    const agent = { id: 'a1', name: 'Bot', agentSecret: 'bst_abc' };
    global.fetch = mockFetch(201, agent);

    const result = await client.createAgent({ name: 'Bot', description: 'Test bot' });

    expect(result).toEqual(agent);
    const [url, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v1/agents`);
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ name: 'Bot', description: 'Test bot' });
  });

  it('listAgents sends GET', async () => {
    global.fetch = mockFetch(200, []);
    await client.listAgents();
    const [url, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v1/agents`);
    expect(opts.method).toBe('GET');
  });

  it('getAgent sends GET with id', async () => {
    global.fetch = mockFetch(200, { id: 'a1' });
    await client.getAgent('a1');
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v1/agents/a1`);
  });

  it('updateAgent sends PATCH', async () => {
    global.fetch = mockFetch(200, { id: 'a1', name: 'Updated' });
    await client.updateAgent('a1', { name: 'Updated' });
    const [url, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v1/agents/a1`);
    expect(opts.method).toBe('PATCH');
  });

  it('deleteAgent sends DELETE', async () => {
    global.fetch = mockFetch(200, { id: 'a1', isActive: false });
    const result = await client.deleteAgent('a1');
    expect(result).toEqual({ id: 'a1', isActive: false });
    const [, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.method).toBe('DELETE');
  });
});

describe('credentials', () => {
  it('createCredential sends POST', async () => {
    global.fetch = mockFetch(201, { id: 'c1', name: 'Stripe' });
    await client.createCredential({
      name: 'Stripe',
      type: 'API_KEY',
      value: 'sk_test_123',
      agentId: 'a1',
    });
    const [url, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v1/credentials`);
    expect(opts.method).toBe('POST');
  });

  it('listCredentials with agentId filter', async () => {
    global.fetch = mockFetch(200, []);
    await client.listCredentials('a1');
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('agentId=a1');
  });

  it('listCredentials without filter', async () => {
    global.fetch = mockFetch(200, []);
    await client.listCredentials();
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v1/credentials`);
  });

  it('revokeCredential sends DELETE', async () => {
    global.fetch = mockFetch(200, { id: 'c1', isRevoked: true });
    const result = await client.revokeCredential('c1');
    expect(result).toEqual({ id: 'c1', isRevoked: true });
  });
});

describe('policies', () => {
  it('createPolicy sends POST', async () => {
    global.fetch = mockFetch(201, { id: 'p1' });
    await client.createPolicy({ agentId: 'a1', credentialId: 'c1' });
    const [url, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v1/policies`);
    expect(opts.method).toBe('POST');
  });

  it('listPolicies with filters', async () => {
    global.fetch = mockFetch(200, []);
    await client.listPolicies({ agentId: 'a1', credentialId: 'c1' });
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('agentId=a1');
    expect(url).toContain('credentialId=c1');
  });

  it('updatePolicy sends PATCH', async () => {
    global.fetch = mockFetch(200, { id: 'p1' });
    await client.updatePolicy('p1', { isActive: false });
    const [url, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v1/policies/p1`);
    expect(opts.method).toBe('PATCH');
  });

  it('deletePolicy sends DELETE', async () => {
    global.fetch = mockFetch(200, { id: 'p1', isActive: false });
    const result = await client.deletePolicy('p1');
    expect(result).toEqual({ id: 'p1', isActive: false });
  });

  it('evaluatePolicy sends POST to /evaluate', async () => {
    const evalResult = { decision: 'ALLOW', policyId: 'p1', reason: 'Allowed' };
    global.fetch = mockFetch(200, evalResult);
    const result = await client.evaluatePolicy({
      agentId: 'a1',
      credentialId: 'c1',
      action: 'charges.create',
      params: { amount: 100 },
    });
    expect(result).toEqual(evalResult);
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v1/policies/evaluate`);
  });
});

describe('proxy', () => {
  it('execute sends POST to /proxy/execute', async () => {
    const proxyResult = {
      upstream: { status: 200, headers: {}, body: { ok: true } },
      meta: {
        credentialId: 'c1',
        action: 'test',
        policyDecision: 'ALLOW',
        policyId: 'p1',
        durationMs: 100,
      },
    };
    global.fetch = mockFetch(200, proxyResult);

    const result = await client.execute({
      credentialId: 'c1',
      action: 'test.create',
      target: { url: 'https://api.example.com/test', method: 'POST', body: { foo: 'bar' } },
    });

    expect(result).toEqual(proxyResult);
    const [url, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v1/proxy/execute`);
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.credentialId).toBe('c1');
    expect(body.target.url).toBe('https://api.example.com/test');
  });

  it('execute with injection config', async () => {
    global.fetch = mockFetch(200, { upstream: {}, meta: {} });
    await client.execute({
      credentialId: 'c1',
      action: 'test',
      target: { url: 'https://api.example.com' },
      injection: { location: 'header', key: 'X-Api-Key' },
      timeout: 5000,
    });
    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.injection).toEqual({ location: 'header', key: 'X-Api-Key' });
    expect(body.timeout).toBe(5000);
  });

  it('proxyRequest sends POST to /proxy/fetch', async () => {
    const proxyResult = {
      upstream: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: { ok: true },
      },
      meta: {
        credentialId: 'c1',
        action: 'openai.post.v1.chat.completions',
        policyDecision: 'ALLOW',
        policyId: 'p1',
        durationMs: 42,
      },
    };
    global.fetch = mockFetch(200, proxyResult);

    const result = await client.proxyRequest({
      url: 'https://api.openai.com/v1/chat/completions',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { model: 'gpt-5.4-mini' },
    });

    expect(result).toEqual(proxyResult);
    const [url, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v1/proxy/fetch`);
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toMatchObject({
      url: 'https://api.openai.com/v1/chat/completions',
      method: 'POST',
    });
  });
});

describe('hitl', () => {
  it('listPendingRequests sends GET', async () => {
    global.fetch = mockFetch(200, []);
    await client.listPendingRequests();
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v1/hitl/pending`);
  });

  it('getPendingRequest sends GET with id', async () => {
    global.fetch = mockFetch(200, { requestId: 'r1' });
    await client.getPendingRequest('r1');
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v1/hitl/r1`);
  });

  it('approveRequest sends POST', async () => {
    global.fetch = mockFetch(200, {
      requestId: 'r1',
      status: 'approved',
      message: 'Request approved',
    });
    const result = await client.approveRequest('r1');
    expect(result.status).toBe('approved');
    const [url, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v1/hitl/r1/approve`);
    expect(opts.method).toBe('POST');
  });

  it('denyRequest sends POST with reason', async () => {
    global.fetch = mockFetch(200, { requestId: 'r1', status: 'denied', message: 'Request denied' });
    await client.denyRequest('r1', 'Too risky');
    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body).toEqual({ reason: 'Too risky' });
  });

  it('denyRequest without reason sends no body', async () => {
    global.fetch = mockFetch(200, { requestId: 'r1', status: 'denied', message: 'Request denied' });
    await client.denyRequest('r1');
    const opts = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(opts.body).toBeUndefined();
  });
});

describe('audit', () => {
  it('queryAuditRecords sends GET with all params', async () => {
    global.fetch = mockFetch(200, { records: [], nextCursor: null });
    await client.queryAuditRecords({
      agentId: 'a1',
      from: '2026-01-01',
      to: '2026-12-31',
      action: 'charges.create',
      policyDecision: 'ALLOW',
      cursor: '100',
      limit: 25,
    });
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('agentId=a1');
    expect(url).toContain('from=2026-01-01');
    expect(url).toContain('to=2026-12-31');
    expect(url).toContain('action=charges.create');
    expect(url).toContain('policyDecision=ALLOW');
    expect(url).toContain('cursor=100');
    expect(url).toContain('limit=25');
  });

  it('queryAuditRecords omits undefined params', async () => {
    global.fetch = mockFetch(200, { records: [], nextCursor: null });
    await client.queryAuditRecords({ agentId: 'a1' });
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('agentId=a1');
    expect(url).not.toContain('from=');
    expect(url).not.toContain('cursor=');
  });

  it('verifyChain sends GET with agentId', async () => {
    const verifyResult = { valid: true, recordCount: 5, firstRecord: null, lastRecord: null };
    global.fetch = mockFetch(200, verifyResult);
    const result = await client.verifyChain('a1');
    expect(result).toEqual(verifyResult);
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/v1/audit/verify');
    expect(url).toContain('agentId=a1');
  });
});

describe('auth header', () => {
  it('sends Authorization bearer header on every request', async () => {
    global.fetch = mockFetch(200, {});
    await client.health();
    const opts = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(opts.headers.Authorization).toBe(`Bearer ${API_KEY}`);
  });
});

describe('error handling', () => {
  const cases: Array<[number, new (...args: never[]) => BastionError]> = [
    [400, BastionValidationError],
    [401, BastionUnauthorizedError],
    [403, BastionForbiddenError],
    [404, BastionNotFoundError],
    [409, BastionConflictError],
    [502, BastionBadGatewayError],
  ];

  for (const [status, ErrorClass] of cases) {
    it(`throws ${ErrorClass.name} for status ${status}`, async () => {
      global.fetch = mockFetch(status, { message: 'test error' });
      await expect(client.health()).rejects.toThrow(ErrorClass);
      await expect(client.health()).rejects.toThrow('test error');
    });
  }

  it('throws BastionError for unknown error status', async () => {
    global.fetch = mockFetch(500, { message: 'internal' });
    await expect(client.health()).rejects.toThrow(BastionError);
    try {
      await client.health();
    } catch (e) {
      expect((e as BastionError).statusCode).toBe(500);
    }
  });

  it('extracts nested API error messages', async () => {
    global.fetch = mockFetch(404, {
      error: { message: 'No credential routing found for demo.example' },
    });
    await expect(client.health()).rejects.toThrow('No credential routing found for demo.example');
  });
});

describe('base url trailing slash', () => {
  it('strips trailing slashes from baseUrl', async () => {
    const c = new BastionClient({ baseUrl: 'http://localhost:3000///', apiKey: 'k' });
    global.fetch = mockFetch(200, {});
    await c.health();
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://localhost:3000/health');
  });
});
