import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Response, Test } from 'supertest';
import { createApp } from '../app.js';
import {
  cleanDatabase,
  cleanRedis,
  disconnectDatabase,
  testPrisma,
} from '../__test__/helpers/db.js';

const app = createApp();
const API_KEY = process.env['PROJECT_API_KEY']!;

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function adminAuthed(method: 'get' | 'post', path: string) {
  return request(app)[method](path).set('Authorization', `Bearer ${API_KEY}`);
}

function agentAuthed(path: string, agentSecret: string) {
  return request(app).post(path).set('Authorization', `Bearer ${agentSecret}`);
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
    name: 'Audit Test Agent',
    ...overrides,
  });
  return res.body;
}

async function createTestCredential(agentId: string) {
  const res = await adminAuthed('post', '/v1/credentials').send({
    name: 'Audit Credential',
    type: 'API_KEY',
    value: 'sk_test_audit_key',
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
    allowedActions: ['charges.*', 'refunds.*'],
    ...overrides,
  });
  return res.body;
}

function mockUpstreamSuccess(status = 200, body: unknown = { ok: true }) {
  const headers = new Headers({ 'content-type': 'application/json' });
  mockFetch.mockImplementation(async (url: string) => {
    if (typeof url === 'string' && url.includes('api.stripe.com')) {
      return {
        status,
        headers,
        arrayBuffer: vi
          .fn()
          .mockResolvedValue(new TextEncoder().encode(JSON.stringify(body)).buffer),
      };
    }

    return { status: 200, ok: true };
  });
}

function mockUpstreamFailure(message = 'network down') {
  mockFetch.mockImplementation(async (url: string) => {
    if (typeof url === 'string' && url.includes('api.stripe.com')) {
      throw new TypeError(message);
    }

    return { status: 200, ok: true };
  });
}

async function executeProxyRequest(
  agentSecret: string,
  credentialId: string,
  action = 'charges.create',
  params: Record<string, unknown> = { amount: 100 },
) {
  return agentAuthed('/v1/proxy/execute', agentSecret).send({
    credentialId,
    action,
    params,
    target: {
      url: 'https://api.stripe.com/v1/charges',
      method: 'POST',
      headers: {},
      body: { amount: 100, currency: 'usd' },
    },
  });
}

beforeEach(async () => {
  await cleanDatabase();
  await cleanRedis();
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mockFetch);
});

afterAll(() => disconnectDatabase());

describe('Audit chain integration', () => {
  it('creates an audit record for ALLOW decisions', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);
    await createTestPolicy(agent.id, credential.id);
    mockUpstreamSuccess(200, { charged: true });

    const proxyRes = await executeProxyRequest(agent.agentSecret, credential.id);
    expect(proxyRes.status).toBe(200);

    const auditRes = await adminAuthed('get', `/v1/audit?agentId=${agent.id}`);
    expect(auditRes.status).toBe(200);
    expect(auditRes.body.records).toHaveLength(1);
    expect(auditRes.body.records[0].recordJson.policyDecision).toBe('ALLOW');
    expect(auditRes.body.records[0].recordJson.upstreamStatus).toBe(200);
    expect(auditRes.body.records[0].recordJson.outcome).toBe('executed');
    expect(auditRes.body.records[0].id).toMatch(/^\d+$/);
  });

  it('creates an audit record for DENY decisions', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);
    await createTestPolicy(agent.id, credential.id, {
      allowedActions: [],
      deniedActions: ['charges.*'],
    });
    mockUpstreamSuccess();

    const proxyRes = await executeProxyRequest(agent.agentSecret, credential.id);
    expect(proxyRes.status).toBe(403);

    const auditRes = await adminAuthed('get', `/v1/audit?agentId=${agent.id}`);
    expect(auditRes.body.records).toHaveLength(1);
    expect(auditRes.body.records[0].recordJson.policyDecision).toBe('DENY');
    expect(auditRes.body.records[0].recordJson.reason).toContain('denied');
  });

  it('creates an audit record for HITL denials', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);
    await createTestPolicy(agent.id, credential.id, {
      allowedActions: ['charges.*'],
      requiresApprovalAbove: 1000,
    });
    mockUpstreamSuccess();

    const proxyPromise = sendNow(
      agentAuthed('/v1/proxy/execute', agent.agentSecret).send({
        credentialId: credential.id,
        action: 'charges.create',
        params: { amount: 5000 },
        target: {
          url: 'https://api.stripe.com/v1/charges',
          method: 'POST',
          headers: {},
          body: { amount: 100, currency: 'usd' },
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 200));
    const pendingRes = await adminAuthed('get', '/v1/hitl/pending');
    const requestId = pendingRes.body[0].requestId;

    const denyRes = await adminAuthed('post', `/v1/hitl/${requestId}/deny`).send({
      reason: 'Too risky',
    });
    expect(denyRes.status).toBe(200);

    const proxyRes = await proxyPromise;
    expect(proxyRes.status).toBe(403);

    const auditRes = await adminAuthed('get', `/v1/audit?agentId=${agent.id}`);
    expect(auditRes.body.records).toHaveLength(1);
    expect(auditRes.body.records[0].recordJson.policyDecision).toBe('ESCALATE');
    expect(auditRes.body.records[0].recordJson.hitlRequestId).toBe(requestId);
    expect(auditRes.body.records[0].recordJson.reason).toContain('human reviewer');
  });

  it('creates an audit record when upstream execution fails after ALLOW', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);
    await createTestPolicy(agent.id, credential.id);
    mockUpstreamFailure('socket hang up');

    const proxyRes = await executeProxyRequest(agent.agentSecret, credential.id);
    expect(proxyRes.status).toBe(502);

    const auditRes = await adminAuthed('get', `/v1/audit?agentId=${agent.id}`);
    expect(auditRes.body.records).toHaveLength(1);
    expect(auditRes.body.records[0].recordJson.policyDecision).toBe('ALLOW');
    expect(auditRes.body.records[0].recordJson.outcome).toBe('failed');
    expect(auditRes.body.records[0].recordJson.error).toContain('socket hang up');
  });

  it('verifies a valid chain across three records', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);
    await createTestPolicy(agent.id, credential.id);
    mockUpstreamSuccess();

    await executeProxyRequest(agent.agentSecret, credential.id, 'charges.create', { amount: 100 });
    await executeProxyRequest(agent.agentSecret, credential.id, 'charges.create', { amount: 200 });
    await executeProxyRequest(agent.agentSecret, credential.id, 'refunds.create', { amount: 50 });

    const verifyRes = await adminAuthed('get', `/v1/audit/verify?agentId=${agent.id}`);
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.valid).toBe(true);
    expect(verifyRes.body.recordCount).toBe(3);
    expect(verifyRes.body.firstRecord).toBeTruthy();
    expect(verifyRes.body.lastRecord).toBeTruthy();
  });

  it('detects tampering during chain verification', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);
    await createTestPolicy(agent.id, credential.id);
    mockUpstreamSuccess();

    await executeProxyRequest(agent.agentSecret, credential.id);

    const stored = await testPrisma.auditRecord.findFirst({
      where: { agentId: agent.id },
      orderBy: { id: 'asc' },
    });
    expect(stored).not.toBeNull();

    await testPrisma.auditRecord.update({
      where: { id: stored!.id },
      data: { recordHash: Buffer.alloc(32, 3) },
    });

    const verifyRes = await adminAuthed('get', `/v1/audit/verify?agentId=${agent.id}`);
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.valid).toBe(false);
    expect(verifyRes.body.reason).toContain('recordHash');
  });

  it('supports cursor-based pagination', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);
    await createTestPolicy(agent.id, credential.id);
    mockUpstreamSuccess();

    await executeProxyRequest(agent.agentSecret, credential.id, 'charges.create', { amount: 1 });
    await executeProxyRequest(agent.agentSecret, credential.id, 'charges.create', { amount: 2 });
    await executeProxyRequest(agent.agentSecret, credential.id, 'charges.create', { amount: 3 });

    const firstPage = await adminAuthed('get', `/v1/audit?agentId=${agent.id}&limit=2`);
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.records).toHaveLength(2);
    expect(firstPage.body.nextCursor).toMatch(/^\d+$/);

    const secondPage = await adminAuthed(
      'get',
      `/v1/audit?agentId=${agent.id}&limit=2&cursor=${firstPage.body.nextCursor}`,
    );
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.records).toHaveLength(1);
    expect(secondPage.body.nextCursor).toBeNull();
  });

  it('filters audit records by time range and action', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);
    await createTestPolicy(agent.id, credential.id);
    mockUpstreamSuccess();

    await executeProxyRequest(agent.agentSecret, credential.id, 'charges.create', { amount: 10 });
    const firstRecord = await testPrisma.auditRecord.findFirstOrThrow({
      where: { agentId: agent.id },
      orderBy: { id: 'asc' },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    await executeProxyRequest(agent.agentSecret, credential.id, 'refunds.create', { amount: 5 });

    const actionRes = await adminAuthed(
      'get',
      `/v1/audit?agentId=${agent.id}&action=refunds.create`,
    );
    expect(actionRes.status).toBe(200);
    expect(actionRes.body.records).toHaveLength(1);
    expect(actionRes.body.records[0].recordJson.action).toBe('refunds.create');

    const to = new Date(firstRecord.createdAt.getTime() + 1).toISOString();
    const timeRes = await adminAuthed('get', `/v1/audit?agentId=${agent.id}&to=${to}`);
    expect(timeRes.status).toBe(200);
    expect(timeRes.body.records).toHaveLength(1);
    expect(timeRes.body.records[0].recordJson.action).toBe('charges.create');
  });

  it('maintains isolated chains per agent', async () => {
    const agentA = await createTestAgent({ name: 'Agent A' });
    const agentB = await createTestAgent({ name: 'Agent B' });
    const credentialA = await createTestCredential(agentA.id);
    const credentialB = await createTestCredential(agentB.id);
    await createTestPolicy(agentA.id, credentialA.id);
    await createTestPolicy(agentB.id, credentialB.id);
    mockUpstreamSuccess();

    await executeProxyRequest(agentA.agentSecret, credentialA.id, 'charges.create', { amount: 10 });
    await executeProxyRequest(agentB.agentSecret, credentialB.id, 'charges.create', { amount: 20 });

    const [verifyA, verifyB, auditA, auditB] = await Promise.all([
      adminAuthed('get', `/v1/audit/verify?agentId=${agentA.id}`),
      adminAuthed('get', `/v1/audit/verify?agentId=${agentB.id}`),
      adminAuthed('get', `/v1/audit?agentId=${agentA.id}`),
      adminAuthed('get', `/v1/audit?agentId=${agentB.id}`),
    ]);

    expect(verifyA.body).toMatchObject({ valid: true, recordCount: 1 });
    expect(verifyB.body).toMatchObject({ valid: true, recordCount: 1 });
    expect(auditA.body.records[0].agentId).toBe(agentA.id);
    expect(auditB.body.records[0].agentId).toBe(agentB.id);
  });
});
