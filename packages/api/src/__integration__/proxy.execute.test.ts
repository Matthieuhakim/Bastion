import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { cleanDatabase, cleanRedis, disconnectDatabase } from '../__test__/helpers/db.js';

const app = createApp();
const API_KEY = process.env['PROJECT_API_KEY']!;

// Mock global fetch for upstream API calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function adminAuthed(method: 'get' | 'post' | 'patch' | 'delete', path: string) {
  return request(app)[method](path).set('Authorization', `Bearer ${API_KEY}`);
}

function agentAuthed(method: 'post', path: string, agentSecret: string) {
  return request(app)[method](path).set('Authorization', `Bearer ${agentSecret}`);
}

async function createTestAgent(overrides: Record<string, unknown> = {}) {
  const res = await adminAuthed('post', '/v1/agents').send({
    name: 'Proxy Test Agent',
    ...overrides,
  });
  return res.body; // includes id and agentSecret
}

async function createTestCredential(agentId: string, overrides: Record<string, unknown> = {}) {
  const res = await adminAuthed('post', '/v1/credentials').send({
    name: 'Test API Key',
    type: 'API_KEY',
    value: 'sk_test_abc123xyz789',
    agentId,
    ...overrides,
  });
  return res.body;
}

async function createTestPolicy(
  agentId: string,
  credentialId: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await adminAuthed('post', '/v1/policies').send({
    agentId,
    credentialId,
    allowedActions: ['*'],
    ...overrides,
  });
  return res.body;
}

function mockUpstreamResponse(status = 200, body: unknown = { ok: true }) {
  const headers = new Headers({ 'content-type': 'application/json' });
  mockFetch.mockResolvedValue({
    status,
    headers,
    arrayBuffer: vi.fn().mockResolvedValue(new TextEncoder().encode(JSON.stringify(body)).buffer),
  });
}

beforeEach(async () => {
  await cleanDatabase();
  await cleanRedis();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  // Re-stub fetch after restoreAllMocks
  vi.stubGlobal('fetch', mockFetch);
});

afterAll(() => disconnectDatabase());

describe('POST /v1/proxy/execute', () => {
  describe('happy path', () => {
    it('executes a proxied request and returns upstream response', async () => {
      const agent = await createTestAgent();
      const credential = await createTestCredential(agent.id);
      await createTestPolicy(agent.id, credential.id);

      mockUpstreamResponse(200, { data: 'from external api' });

      const res = await agentAuthed('post', '/v1/proxy/execute', agent.agentSecret).send({
        credentialId: credential.id,
        action: 'test.get',
        target: {
          url: 'https://api.example.com/data',
          method: 'GET',
        },
      });

      expect(res.status).toBe(200);
      expect(res.body.upstream.status).toBe(200);
      expect(res.body.upstream.body).toEqual({ data: 'from external api' });
      expect(res.body.meta.credentialId).toBe(credential.id);
      expect(res.body.meta.action).toBe('test.get');
      expect(res.body.meta.policyDecision).toBe('ALLOW');
      expect(res.body.meta.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('injects credential as Authorization Bearer header', async () => {
      const agent = await createTestAgent();
      const credential = await createTestCredential(agent.id, {
        value: 'sk_live_secret_key',
      });
      await createTestPolicy(agent.id, credential.id);

      mockUpstreamResponse();

      await agentAuthed('post', '/v1/proxy/execute', agent.agentSecret).send({
        credentialId: credential.id,
        action: 'test.get',
        target: {
          url: 'https://api.example.com/data',
          method: 'GET',
        },
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, fetchInit] = mockFetch.mock.calls[0];
      expect(fetchInit.headers['Authorization']).toBe('Bearer sk_live_secret_key');
    });

    it('passes through upstream non-200 status', async () => {
      const agent = await createTestAgent();
      const credential = await createTestCredential(agent.id);
      await createTestPolicy(agent.id, credential.id);

      mockUpstreamResponse(404, { error: 'not found' });

      const res = await agentAuthed('post', '/v1/proxy/execute', agent.agentSecret).send({
        credentialId: credential.id,
        action: 'test.get',
        target: { url: 'https://api.example.com/missing', method: 'GET' },
      });

      expect(res.status).toBe(200);
      expect(res.body.upstream.status).toBe(404);
      expect(res.body.upstream.body).toEqual({ error: 'not found' });
    });
  });

  describe('policy enforcement', () => {
    it('returns 403 when action is denied by policy', async () => {
      const agent = await createTestAgent();
      const credential = await createTestCredential(agent.id);
      await createTestPolicy(agent.id, credential.id, {
        allowedActions: ['read.*'],
        deniedActions: ['write.*'],
      });

      const res = await agentAuthed('post', '/v1/proxy/execute', agent.agentSecret).send({
        credentialId: credential.id,
        action: 'write.create',
        target: { url: 'https://api.example.com/data', method: 'POST' },
      });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('denied');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns 403 when no policy exists (fail closed)', async () => {
      const agent = await createTestAgent();
      const credential = await createTestCredential(agent.id);
      // No policy created

      const res = await agentAuthed('post', '/v1/proxy/execute', agent.agentSecret).send({
        credentialId: credential.id,
        action: 'test.get',
        target: { url: 'https://api.example.com/data', method: 'GET' },
      });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('No active policy');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns 403 on escalation timeout (HITL gate)', async () => {
      const agent = await createTestAgent();
      const credential = await createTestCredential(agent.id);
      await createTestPolicy(agent.id, credential.id, {
        allowedActions: ['charges.*'],
        requiresApprovalAbove: 1000,
      });

      // The proxy will block waiting for HITL approval, but the
      // waitForResolution timeout is internal (5 min default).
      // For this test, we mock the HITL service to return timeout immediately.
      // Full HITL integration is tested in hitl.test.ts.
      const hitlModule = await import('../services/hitl.js');
      vi.spyOn(hitlModule, 'createPendingRequest').mockResolvedValue({
        requestId: 'test-hitl-req',
        status: 'pending',
        agentId: agent.id,
        credentialId: credential.id,
        action: 'charges.create',
        params: { amount: 5000 },
        target: { url: 'https://api.stripe.com/v1/charges', method: 'POST', headers: {} },
        policyId: null,
        reason: 'Amount exceeds threshold',
        createdAt: new Date().toISOString(),
      });
      vi.spyOn(hitlModule, 'waitForResolution').mockResolvedValue('timeout');

      const res = await agentAuthed('post', '/v1/proxy/execute', agent.agentSecret).send({
        credentialId: credential.id,
        action: 'charges.create',
        params: { amount: 5000 },
        target: { url: 'https://api.stripe.com/v1/charges', method: 'POST' },
      });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('timed out waiting for human approval');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('credential ownership', () => {
    it('returns 403 when credential belongs to a different agent', async () => {
      const agent1 = await createTestAgent({ name: 'Agent 1' });
      const agent2 = await createTestAgent({ name: 'Agent 2' });
      const credential = await createTestCredential(agent1.id);
      await createTestPolicy(agent1.id, credential.id);

      // Agent 2 tries to use Agent 1's credential
      const res = await agentAuthed('post', '/v1/proxy/execute', agent2.agentSecret).send({
        credentialId: credential.id,
        action: 'test.get',
        target: { url: 'https://api.example.com/data', method: 'GET' },
      });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('does not belong');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('authentication', () => {
    it('returns 401 without Authorization header', async () => {
      const res = await request(app)
        .post('/v1/proxy/execute')
        .send({
          credentialId: 'some-id',
          action: 'test.get',
          target: { url: 'https://api.example.com/data', method: 'GET' },
        });

      expect(res.status).toBe(401);
    });

    it('returns 401 with invalid agent secret', async () => {
      const res = await agentAuthed('post', '/v1/proxy/execute', 'invalid-secret').send({
        credentialId: 'some-id',
        action: 'test.get',
        target: { url: 'https://api.example.com/data', method: 'GET' },
      });

      expect(res.status).toBe(401);
    });

    it('returns 401 when agent is deactivated', async () => {
      const agent = await createTestAgent();
      await adminAuthed('patch', `/v1/agents/${agent.id}`).send({ isActive: false });

      const res = await agentAuthed('post', '/v1/proxy/execute', agent.agentSecret).send({
        credentialId: 'some-id',
        action: 'test.get',
        target: { url: 'https://api.example.com/data', method: 'GET' },
      });

      expect(res.status).toBe(401);
    });
  });

  describe('input validation', () => {
    it('returns 400 for missing credentialId', async () => {
      const agent = await createTestAgent();

      const res = await agentAuthed('post', '/v1/proxy/execute', agent.agentSecret).send({
        action: 'test.get',
        target: { url: 'https://api.example.com/data', method: 'GET' },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('credentialId');
    });

    it('returns 400 for missing action', async () => {
      const agent = await createTestAgent();

      const res = await agentAuthed('post', '/v1/proxy/execute', agent.agentSecret).send({
        credentialId: 'some-id',
        target: { url: 'https://api.example.com/data', method: 'GET' },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('action');
    });

    it('returns 400 for missing target', async () => {
      const agent = await createTestAgent();

      const res = await agentAuthed('post', '/v1/proxy/execute', agent.agentSecret).send({
        credentialId: 'some-id',
        action: 'test.get',
      });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('target');
    });

    it('returns 400 for invalid target URL', async () => {
      const agent = await createTestAgent();
      const credential = await createTestCredential(agent.id);
      await createTestPolicy(agent.id, credential.id);

      const res = await agentAuthed('post', '/v1/proxy/execute', agent.agentSecret).send({
        credentialId: credential.id,
        action: 'test.get',
        target: { url: 'not-a-url', method: 'GET' },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('valid URL');
    });

    it('returns 400 for invalid HTTP method', async () => {
      const agent = await createTestAgent();

      const res = await agentAuthed('post', '/v1/proxy/execute', agent.agentSecret).send({
        credentialId: 'some-id',
        action: 'test.get',
        target: { url: 'https://api.example.com/data', method: 'INVALID' },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('method');
    });

    it('returns 400 for SSRF attempt (localhost)', async () => {
      const agent = await createTestAgent();
      const credential = await createTestCredential(agent.id);
      await createTestPolicy(agent.id, credential.id);

      const res = await agentAuthed('post', '/v1/proxy/execute', agent.agentSecret).send({
        credentialId: credential.id,
        action: 'test.get',
        target: { url: 'http://localhost:8080/admin', method: 'GET' },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('local address');
    });
  });

  describe('upstream errors', () => {
    it('returns 502 when upstream request fails', async () => {
      const agent = await createTestAgent();
      const credential = await createTestCredential(agent.id);
      await createTestPolicy(agent.id, credential.id);

      mockFetch.mockRejectedValue(new TypeError('fetch failed'));

      const res = await agentAuthed('post', '/v1/proxy/execute', agent.agentSecret).send({
        credentialId: credential.id,
        action: 'test.get',
        target: { url: 'https://api.example.com/data', method: 'GET' },
      });

      expect(res.status).toBe(502);
    });
  });
});

describe('POST /v1/proxy/fetch', () => {
  it('routes a vendor-url request through the matched credential metadata', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id, {
      metadata: {
        provider: 'openai',
        actionPrefix: 'openai',
        targetHosts: ['api.openai.com'],
      },
    });
    await createTestPolicy(agent.id, credential.id, {
      allowedActions: ['openai.*'],
    });

    mockUpstreamResponse(200, { id: 'chatcmpl_123' });

    const res = await agentAuthed('post', '/v1/proxy/fetch', agent.agentSecret).send({
      url: 'https://api.openai.com/v1/chat/completions',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { model: 'gpt-5.4-mini' },
    });

    expect(res.status).toBe(200);
    expect(res.body.upstream.status).toBe(200);
    expect(res.body.upstream.body).toEqual({ id: 'chatcmpl_123' });
    expect(res.body.meta.credentialId).toBe(credential.id);
    expect(res.body.meta.action).toBe('openai.post.v1.chat.completions');

    const [, fetchInit] = mockFetch.mock.calls[0];
    expect(fetchInit.headers['Authorization']).toBe('Bearer sk_test_abc123xyz789');
  });

  it('supports explicit credentialId with routing metadata for custom injections', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id, {
      type: 'CUSTOM',
      metadata: {
        provider: 'internal-api',
        actionPrefix: 'internal',
        targetHosts: ['api.internal.example'],
        injection: {
          location: 'header',
          key: 'X-Api-Key',
        },
      },
      value: 'internal_secret',
    });
    await createTestPolicy(agent.id, credential.id, {
      allowedActions: ['internal.*'],
    });

    mockUpstreamResponse(200, { ok: true });

    const res = await agentAuthed('post', '/v1/proxy/fetch', agent.agentSecret).send({
      credentialId: credential.id,
      url: 'https://api.internal.example/v1/jobs',
      method: 'GET',
    });

    expect(res.status).toBe(200);
    expect(res.body.meta.action).toBe('internal.get.v1.jobs');
    const [, fetchInit] = mockFetch.mock.calls[0];
    expect(fetchInit.headers['X-Api-Key']).toBe('internal_secret');
  });

  it('fails closed when no credential routing matches the target hostname', async () => {
    const agent = await createTestAgent();
    await createTestCredential(agent.id, {
      metadata: {
        provider: 'openai',
        actionPrefix: 'openai',
        targetHosts: ['api.openai.com'],
      },
    });

    const res = await agentAuthed('post', '/v1/proxy/fetch', agent.agentSecret).send({
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
    });

    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain('No credential routing found');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('infers Stripe amount from transparent requests for HITL policies', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id, {
      metadata: {
        provider: 'stripe',
        actionPrefix: 'stripe',
        targetHosts: ['api.stripe.com'],
      },
      value: 'sk_test_stripe_secret',
    });
    await createTestPolicy(agent.id, credential.id, {
      allowedActions: ['stripe.*'],
      requiresApprovalAbove: 20,
    });

    const hitlModule = await import('../services/hitl.js');
    vi.spyOn(hitlModule, 'createPendingRequest').mockResolvedValue({
      requestId: 'stripe-hitl-req',
      status: 'pending',
      agentId: agent.id,
      credentialId: credential.id,
      action: 'stripe.post.v1.payment_intents',
      params: { amount: 25 },
      target: {
        url: 'https://api.stripe.com/v1/payment_intents',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'amount=2500&currency=usd',
      },
      policyId: null,
      reason: 'Amount exceeds threshold',
      createdAt: new Date().toISOString(),
    });
    vi.spyOn(hitlModule, 'waitForResolution').mockResolvedValue('timeout');

    const res = await agentAuthed('post', '/v1/proxy/fetch', agent.agentSecret).send({
      url: 'https://api.stripe.com/v1/payment_intents',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'amount=2500&currency=usd',
    });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('timed out waiting for human approval');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
