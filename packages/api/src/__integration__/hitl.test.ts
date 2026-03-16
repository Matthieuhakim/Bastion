import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import type { Response, Test } from 'supertest';
import { createApp } from '../app.js';
import { cleanDatabase, cleanRedis, disconnectDatabase } from '../__test__/helpers/db.js';
import { redis } from '../services/redis.js';

const app = createApp();
const API_KEY = process.env['PROJECT_API_KEY']!;

// Mock global fetch for upstream API calls and webhook notifications
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function adminAuthed(method: 'get' | 'post' | 'patch' | 'delete', path: string) {
  return request(app)[method](path).set('Authorization', `Bearer ${API_KEY}`);
}

function agentAuthed(method: 'post', path: string, agentSecret: string) {
  return request(app)[method](path).set('Authorization', `Bearer ${agentSecret}`);
}

function sendNow(test: Test): Promise<Response> {
  return new Promise((resolve, reject) => {
    test.end((error, response) => {
      if (response) {
        resolve(response);
        return;
      }

      reject(error);
    });
  });
}

async function createTestAgent(overrides: Record<string, unknown> = {}) {
  const res = await adminAuthed('post', '/v1/agents').send({
    name: 'HITL Test Agent',
    ...overrides,
  });
  return res.body;
}

async function createTestCredential(agentId: string) {
  const res = await adminAuthed('post', '/v1/credentials').send({
    name: 'Test API Key',
    type: 'API_KEY',
    value: 'sk_test_hitl_key',
    agentId,
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
    allowedActions: ['charges.*'],
    requiresApprovalAbove: 1000,
    ...overrides,
  });
  return res.body;
}

function mockUpstreamResponse(status = 200, body: unknown = { charged: true }) {
  const headers = new Headers({ 'content-type': 'application/json' });
  mockFetch.mockImplementation(async (url: string) => {
    // Don't mock webhook calls, only upstream API calls
    if (typeof url === 'string' && url.includes('api.stripe.com')) {
      return {
        status,
        headers,
        arrayBuffer: vi
          .fn()
          .mockResolvedValue(new TextEncoder().encode(JSON.stringify(body)).buffer),
      };
    }
    // Webhook calls: return ok
    return { status: 200, ok: true };
  });
}

beforeEach(async () => {
  await cleanDatabase();
  await cleanRedis();
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mockFetch);
});

afterAll(() => disconnectDatabase());

describe('HITL Gate', () => {
  describe('admin endpoints', () => {
    it('GET /v1/hitl/pending returns empty array initially', async () => {
      const res = await adminAuthed('get', '/v1/hitl/pending');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('GET /v1/hitl/:requestId returns 404 for unknown request', async () => {
      const res = await adminAuthed('get', '/v1/hitl/nonexistent-id');
      expect(res.status).toBe(404);
    });

    it('POST /v1/hitl/:requestId/approve returns 404 for unknown request', async () => {
      const res = await adminAuthed('post', '/v1/hitl/nonexistent-id/approve');
      expect(res.status).toBe(404);
    });

    it('POST /v1/hitl/:requestId/deny returns 404 for unknown request', async () => {
      const res = await adminAuthed('post', '/v1/hitl/nonexistent-id/deny');
      expect(res.status).toBe(404);
    });

    it('requires admin auth', async () => {
      const res = await request(app).get('/v1/hitl/pending');
      expect(res.status).toBe(401);
    });
  });

  describe('approve flow', () => {
    it('approves a pending request and returns upstream response to agent', async () => {
      const agent = await createTestAgent();
      const credential = await createTestCredential(agent.id);
      await createTestPolicy(agent.id, credential.id);

      mockUpstreamResponse(200, { charged: true });

      // Start the proxy request (will block on HITL)
      const proxyPromise = sendNow(
        agentAuthed('post', '/v1/proxy/execute', agent.agentSecret).send({
          credentialId: credential.id,
          action: 'charges.create',
          params: { amount: 5000 },
          target: { url: 'https://api.stripe.com/v1/charges', method: 'POST' },
        }),
      );

      // Wait for the HITL request to be created in Redis
      await new Promise((resolve) => setTimeout(resolve, 200));

      // List pending requests
      const pendingRes = await adminAuthed('get', '/v1/hitl/pending');
      expect(pendingRes.status).toBe(200);
      expect(pendingRes.body).toHaveLength(1);

      const requestId = pendingRes.body[0].requestId;
      expect(pendingRes.body[0].status).toBe('pending');
      expect(pendingRes.body[0].agentId).toBe(agent.id);
      expect(pendingRes.body[0].action).toBe('charges.create');

      // Get single pending request
      const singleRes = await adminAuthed('get', `/v1/hitl/${requestId}`);
      expect(singleRes.status).toBe(200);
      expect(singleRes.body.requestId).toBe(requestId);

      // Approve the request
      const approveRes = await adminAuthed('post', `/v1/hitl/${requestId}/approve`);
      expect(approveRes.status).toBe(200);
      expect(approveRes.body.status).toBe('approved');

      // The proxy request should now complete
      const res = await proxyPromise;
      expect(res.status).toBe(200);
      expect(res.body.upstream.status).toBe(200);
      expect(res.body.upstream.body).toEqual({ charged: true });
      expect(res.body.meta.hitlRequestId).toBe(requestId);
    });
  });

  describe('deny flow', () => {
    it('denies a pending request and returns 403 to agent', async () => {
      const agent = await createTestAgent();
      const credential = await createTestCredential(agent.id);
      await createTestPolicy(agent.id, credential.id);

      // Start the proxy request (will block on HITL)
      const proxyPromise = sendNow(
        agentAuthed('post', '/v1/proxy/execute', agent.agentSecret).send({
          credentialId: credential.id,
          action: 'charges.create',
          params: { amount: 5000 },
          target: { url: 'https://api.stripe.com/v1/charges', method: 'POST' },
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Get pending request
      const pendingRes = await adminAuthed('get', '/v1/hitl/pending');
      const requestId = pendingRes.body[0].requestId;

      // Deny with reason
      const denyRes = await adminAuthed('post', `/v1/hitl/${requestId}/deny`).send({
        reason: 'Too risky',
      });
      expect(denyRes.status).toBe(200);
      expect(denyRes.body.status).toBe('denied');

      // The proxy request should return 403
      const res = await proxyPromise;
      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('denied by human reviewer');
    });
  });

  describe('double resolution', () => {
    it('returns 409 when approving an already resolved request', async () => {
      const agent = await createTestAgent();
      const credential = await createTestCredential(agent.id);
      await createTestPolicy(agent.id, credential.id);

      mockUpstreamResponse();

      const proxyPromise = sendNow(
        agentAuthed('post', '/v1/proxy/execute', agent.agentSecret).send({
          credentialId: credential.id,
          action: 'charges.create',
          params: { amount: 5000 },
          target: { url: 'https://api.stripe.com/v1/charges', method: 'POST' },
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 200));

      const pendingRes = await adminAuthed('get', '/v1/hitl/pending');
      const requestId = pendingRes.body[0].requestId;

      // First approve
      await adminAuthed('post', `/v1/hitl/${requestId}/approve`);
      await proxyPromise;

      // Second approve should 409
      const secondRes = await adminAuthed('post', `/v1/hitl/${requestId}/approve`);
      expect(secondRes.status).toBe(409);
      expect(secondRes.body.error.message).toContain('already been resolved');
    });
  });

  describe('webhook notification', () => {
    it('fires webhook when agent has callbackUrl', async () => {
      const agent = await createTestAgent({ callbackUrl: 'https://example.com/webhook' });
      const credential = await createTestCredential(agent.id);
      await createTestPolicy(agent.id, credential.id);

      mockUpstreamResponse();

      const proxyPromise = sendNow(
        agentAuthed('post', '/v1/proxy/execute', agent.agentSecret).send({
          credentialId: credential.id,
          action: 'charges.create',
          params: { amount: 5000 },
          target: { url: 'https://api.stripe.com/v1/charges', method: 'POST' },
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify webhook was called
      const webhookCalls = mockFetch.mock.calls.filter(
        ([url]) => typeof url === 'string' && url.includes('example.com/webhook'),
      );
      expect(webhookCalls.length).toBeGreaterThanOrEqual(1);

      const webhookBody = JSON.parse(webhookCalls[0][1].body);
      expect(webhookBody.agentId).toBe(agent.id);
      expect(webhookBody.action).toBe('charges.create');
      expect(webhookBody.approveUrl).toContain('/v1/hitl/');
      expect(webhookBody.denyUrl).toContain('/v1/hitl/');

      // Clean up: approve the request so the test doesn't hang
      const pendingRes = await adminAuthed('get', '/v1/hitl/pending');
      await adminAuthed('post', `/v1/hitl/${pendingRes.body[0].requestId}/approve`);
      await proxyPromise;
    });
  });

  describe('pending list', () => {
    it('removes resolved requests from pending list', async () => {
      const agent = await createTestAgent();
      const credential = await createTestCredential(agent.id);
      await createTestPolicy(agent.id, credential.id);

      mockUpstreamResponse();

      const proxyPromise = sendNow(
        agentAuthed('post', '/v1/proxy/execute', agent.agentSecret).send({
          credentialId: credential.id,
          action: 'charges.create',
          params: { amount: 5000 },
          target: { url: 'https://api.stripe.com/v1/charges', method: 'POST' },
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Should have 1 pending
      const beforeRes = await adminAuthed('get', '/v1/hitl/pending');
      expect(beforeRes.body).toHaveLength(1);

      // Approve
      await adminAuthed('post', `/v1/hitl/${beforeRes.body[0].requestId}/approve`);
      await proxyPromise;

      // Should have 0 pending
      const afterRes = await adminAuthed('get', '/v1/hitl/pending');
      expect(afterRes.body).toHaveLength(0);
    });

    it('handles stale entries in pending set', async () => {
      // Manually add a stale entry to the pending set
      await redis.sadd('hitl:pending', 'stale-request-id');

      const res = await adminAuthed('get', '/v1/hitl/pending');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);

      // Stale entry should be cleaned up
      const members = await redis.smembers('hitl:pending');
      expect(members).not.toContain('stale-request-id');
    });
  });
});
