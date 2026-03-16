import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { cleanDatabase, cleanRedis, disconnectDatabase } from '../__test__/helpers/db.js';

const app = createApp();
const API_KEY = process.env['PROJECT_API_KEY']!;

function authed(method: 'get' | 'post' | 'patch' | 'delete', path: string) {
  return request(app)[method](path).set('Authorization', `Bearer ${API_KEY}`);
}

async function createTestAgent(overrides: Record<string, unknown> = {}) {
  const res = await authed('post', '/v1/agents').send({
    name: 'Policy Test Agent',
    ...overrides,
  });
  return res.body;
}

async function createTestCredential(agentId: string, overrides: Record<string, unknown> = {}) {
  const res = await authed('post', '/v1/credentials').send({
    name: 'Test Credential',
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
  const res = await authed('post', '/v1/policies').send({
    agentId,
    credentialId,
    allowedActions: ['charges.create', 'charges.read'],
    ...overrides,
  });
  return res.body;
}

beforeEach(async () => {
  await cleanDatabase();
  await cleanRedis();
});
afterAll(() => disconnectDatabase());

describe('POST /v1/policies', () => {
  it('creates a policy and returns 201', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);

    const res = await authed('post', '/v1/policies').send({
      agentId: agent.id,
      credentialId: credential.id,
      allowedActions: ['charges.create'],
      deniedActions: ['transfers.*'],
      requiresApprovalAbove: 2000,
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.agentId).toBe(agent.id);
    expect(res.body.credentialId).toBe(credential.id);
    expect(res.body.allowedActions).toEqual(['charges.create']);
    expect(res.body.deniedActions).toEqual(['transfers.*']);
    expect(res.body.requiresApprovalAbove).toBe(2000);
    expect(res.body.isActive).toBe(true);
  });

  it('accepts full constraints object', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);

    const res = await authed('post', '/v1/policies').send({
      agentId: agent.id,
      credentialId: credential.id,
      constraints: {
        maxAmountPerTransaction: 5000,
        maxDailySpend: 15000,
        rateLimit: { maxRequests: 100, windowSeconds: 3600 },
        timeWindow: {
          days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
          hours: { start: '09:00', end: '17:00' },
          timezone: 'America/New_York',
        },
        ipAllowlist: ['10.0.0.1'],
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.constraints.maxAmountPerTransaction).toBe(5000);
    expect(res.body.constraints.rateLimit.maxRequests).toBe(100);
  });

  it('returns 400 for missing agentId', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);

    const res = await authed('post', '/v1/policies').send({
      credentialId: credential.id,
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing credentialId', async () => {
    const agent = await createTestAgent();

    const res = await authed('post', '/v1/policies').send({
      agentId: agent.id,
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent agentId', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);

    const res = await authed('post', '/v1/policies').send({
      agentId: '00000000-0000-0000-0000-000000000000',
      credentialId: credential.id,
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 for non-existent credentialId', async () => {
    const agent = await createTestAgent();

    const res = await authed('post', '/v1/policies').send({
      agentId: agent.id,
      credentialId: '00000000-0000-0000-0000-000000000000',
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid constraints', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);

    const res = await authed('post', '/v1/policies').send({
      agentId: agent.id,
      credentialId: credential.id,
      constraints: { maxAmountPerTransaction: -100 },
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for expiresAt in the past', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);

    const res = await authed('post', '/v1/policies').send({
      agentId: agent.id,
      credentialId: credential.id,
      expiresAt: '2020-01-01T00:00:00Z',
    });
    expect(res.status).toBe(400);
  });

  it('returns 401 without Authorization header', async () => {
    const res = await request(app).post('/v1/policies').send({
      agentId: 'some-id',
      credentialId: 'some-id',
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/policies', () => {
  it('returns empty array when no policies exist', async () => {
    const res = await authed('get', '/v1/policies');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns all policies', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);
    await createTestPolicy(agent.id, credential.id);
    await createTestPolicy(agent.id, credential.id);

    const res = await authed('get', '/v1/policies');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('filters by agentId', async () => {
    const agent1 = await createTestAgent({ name: 'Agent 1' });
    const agent2 = await createTestAgent({ name: 'Agent 2' });
    const cred1 = await createTestCredential(agent1.id);
    const cred2 = await createTestCredential(agent2.id);
    await createTestPolicy(agent1.id, cred1.id);
    await createTestPolicy(agent2.id, cred2.id);

    const res = await authed('get', `/v1/policies?agentId=${agent1.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].agentId).toBe(agent1.id);
  });

  it('filters by credentialId', async () => {
    const agent = await createTestAgent();
    const cred1 = await createTestCredential(agent.id, { name: 'Cred 1' });
    const cred2 = await createTestCredential(agent.id, { name: 'Cred 2' });
    await createTestPolicy(agent.id, cred1.id);
    await createTestPolicy(agent.id, cred2.id);

    const res = await authed('get', `/v1/policies?credentialId=${cred1.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].credentialId).toBe(cred1.id);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/v1/policies');
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/policies/:id', () => {
  it('returns a policy by ID', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);
    const policy = await createTestPolicy(agent.id, credential.id);

    const res = await authed('get', `/v1/policies/${policy.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(policy.id);
  });

  it('returns 404 for non-existent ID', async () => {
    const res = await authed('get', '/v1/policies/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });
});

describe('PATCH /v1/policies/:id', () => {
  it('updates allowedActions', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);
    const policy = await createTestPolicy(agent.id, credential.id);

    const res = await authed('patch', `/v1/policies/${policy.id}`).send({
      allowedActions: ['transfers.create'],
    });
    expect(res.status).toBe(200);
    expect(res.body.allowedActions).toEqual(['transfers.create']);
  });

  it('updates constraints', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);
    const policy = await createTestPolicy(agent.id, credential.id);

    const res = await authed('patch', `/v1/policies/${policy.id}`).send({
      constraints: { maxAmountPerTransaction: 999 },
    });
    expect(res.status).toBe(200);
    expect(res.body.constraints.maxAmountPerTransaction).toBe(999);
  });

  it('updates isActive', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);
    const policy = await createTestPolicy(agent.id, credential.id);

    const res = await authed('patch', `/v1/policies/${policy.id}`).send({
      isActive: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
  });

  it('clears requiresApprovalAbove with null', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);
    const policy = await createTestPolicy(agent.id, credential.id, {
      requiresApprovalAbove: 1000,
    });

    const res = await authed('patch', `/v1/policies/${policy.id}`).send({
      requiresApprovalAbove: null,
    });
    expect(res.status).toBe(200);
    expect(res.body.requiresApprovalAbove).toBeNull();
  });

  it('returns 404 for non-existent ID', async () => {
    const res = await authed('patch', '/v1/policies/00000000-0000-0000-0000-000000000000').send({
      isActive: false,
    });
    expect(res.status).toBe(404);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).patch('/v1/policies/some-id').send({ isActive: false });
    expect(res.status).toBe(401);
  });
});

describe('DELETE /v1/policies/:id', () => {
  it('soft-deletes a policy (sets isActive to false)', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);
    const policy = await createTestPolicy(agent.id, credential.id);

    const res = await authed('delete', `/v1/policies/${policy.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(policy.id);
    expect(res.body.isActive).toBe(false);
  });

  it('policy still exists after soft-delete', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);
    const policy = await createTestPolicy(agent.id, credential.id);
    await authed('delete', `/v1/policies/${policy.id}`);

    const res = await authed('get', `/v1/policies/${policy.id}`);
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
  });

  it('returns 404 for non-existent ID', async () => {
    const res = await authed('delete', '/v1/policies/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).delete('/v1/policies/some-id');
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/policies/evaluate', () => {
  it('returns ALLOW for a valid request within policy', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);
    await createTestPolicy(agent.id, credential.id, {
      allowedActions: ['charges.create'],
    });

    const res = await authed('post', '/v1/policies/evaluate').send({
      agentId: agent.id,
      credentialId: credential.id,
      action: 'charges.create',
    });
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe('ALLOW');
  });

  it('returns DENY when action is denied', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);
    await createTestPolicy(agent.id, credential.id, {
      allowedActions: [],
      deniedActions: ['charges.create'],
    });

    const res = await authed('post', '/v1/policies/evaluate').send({
      agentId: agent.id,
      credentialId: credential.id,
      action: 'charges.create',
    });
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe('DENY');
  });

  it('returns DENY when no policy exists (fail closed)', async () => {
    const res = await authed('post', '/v1/policies/evaluate').send({
      agentId: '00000000-0000-0000-0000-000000000000',
      credentialId: '00000000-0000-0000-0000-000000000000',
      action: 'charges.create',
    });
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe('DENY');
    expect(res.body.reason).toContain('No active policy');
  });

  it('returns ESCALATE when amount exceeds approval threshold', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);
    await createTestPolicy(agent.id, credential.id, {
      allowedActions: ['charges.create'],
      requiresApprovalAbove: 2000,
    });

    const res = await authed('post', '/v1/policies/evaluate').send({
      agentId: agent.id,
      credentialId: credential.id,
      action: 'charges.create',
      params: { amount: 3000 },
    });
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe('ESCALATE');
  });

  it('returns 400 for missing action', async () => {
    const res = await authed('post', '/v1/policies/evaluate').send({
      agentId: 'some-id',
      credentialId: 'some-id',
    });
    expect(res.status).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).post('/v1/policies/evaluate').send({
      agentId: 'some-id',
      credentialId: 'some-id',
      action: 'test',
    });
    expect(res.status).toBe(401);
  });
});
