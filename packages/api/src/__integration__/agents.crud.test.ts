import request from 'supertest';
import { createApp } from '../app.js';
import { cleanDatabase, disconnectDatabase } from '../__test__/helpers/db.js';

const app = createApp();
const API_KEY = process.env['PROJECT_API_KEY']!;

function authed(method: 'get' | 'post' | 'patch' | 'delete', path: string) {
  return request(app)[method](path).set('Authorization', `Bearer ${API_KEY}`);
}

async function createTestAgent(overrides: Record<string, unknown> = {}) {
  const res = await authed('post', '/v1/agents').send({
    name: 'Test Agent',
    description: 'A test agent',
    ...overrides,
  });
  return res.body;
}

describe('Agent CRUD', () => {
  beforeEach(() => cleanDatabase());
  afterAll(() => disconnectDatabase());

  describe('POST /v1/agents', () => {
    it('returns 201 with agent data', async () => {
      const res = await authed('post', '/v1/agents').send({ name: 'My Agent' });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('My Agent');
      expect(res.body.id).toBeDefined();
    });

    it('returns agentSecret starting with "bst_"', async () => {
      const res = await authed('post', '/v1/agents').send({ name: 'Agent' });
      expect(res.body.agentSecret).toMatch(/^bst_[0-9a-f]{64}$/);
    });

    it('does not return apiKeyHash in response', async () => {
      const res = await authed('post', '/v1/agents').send({ name: 'Agent' });
      expect(res.body).not.toHaveProperty('apiKeyHash');
    });

    it('does not return encryptedPrivateKey in response', async () => {
      const res = await authed('post', '/v1/agents').send({ name: 'Agent' });
      expect(res.body).not.toHaveProperty('encryptedPrivateKey');
    });

    it('returns publicKey and keyFingerprint', async () => {
      const res = await authed('post', '/v1/agents').send({ name: 'Agent' });
      expect(res.body.publicKey).toMatch(/^[0-9a-f]{64}$/);
      expect(res.body.keyFingerprint).toMatch(/^[0-9a-f]{64}$/);
    });

    it('accepts optional description and callbackUrl', async () => {
      const res = await authed('post', '/v1/agents').send({
        name: 'Agent',
        description: 'Desc',
        callbackUrl: 'https://example.com/callback',
      });
      expect(res.status).toBe(201);
      expect(res.body.description).toBe('Desc');
      expect(res.body.callbackUrl).toBe('https://example.com/callback');
    });

    it('returns 400 for missing name', async () => {
      const res = await authed('post', '/v1/agents').send({});
      expect(res.status).toBe(400);
    });

    it('returns 400 for empty name', async () => {
      const res = await authed('post', '/v1/agents').send({ name: '' });
      expect(res.status).toBe(400);
    });

    it('returns 400 for name > 255 chars', async () => {
      const res = await authed('post', '/v1/agents').send({ name: 'x'.repeat(256) });
      expect(res.status).toBe(400);
    });

    it('returns 400 for description > 1000 chars', async () => {
      const res = await authed('post', '/v1/agents').send({
        name: 'Agent',
        description: 'x'.repeat(1001),
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid callbackUrl', async () => {
      const res = await authed('post', '/v1/agents').send({
        name: 'Agent',
        callbackUrl: 'not-a-url',
      });
      expect(res.status).toBe(400);
    });

    it('returns 401 without Authorization header', async () => {
      const res = await request(app).post('/v1/agents').send({ name: 'Agent' });
      expect(res.status).toBe(401);
    });

    it('returns 401 with wrong API key', async () => {
      const res = await request(app)
        .post('/v1/agents')
        .set('Authorization', 'Bearer wrong-key')
        .send({ name: 'Agent' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /v1/agents', () => {
    it('returns empty array when no agents', async () => {
      const res = await authed('get', '/v1/agents');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns all agents', async () => {
      await createTestAgent({ name: 'Agent 1' });
      await createTestAgent({ name: 'Agent 2' });

      const res = await authed('get', '/v1/agents');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it('does not include apiKeyHash in list response', async () => {
      await createTestAgent();
      const res = await authed('get', '/v1/agents');
      expect(res.body[0]).not.toHaveProperty('apiKeyHash');
      expect(res.body[0]).not.toHaveProperty('encryptedPrivateKey');
    });

    it('does not include agentSecret in list response', async () => {
      await createTestAgent();
      const res = await authed('get', '/v1/agents');
      expect(res.body[0]).not.toHaveProperty('agentSecret');
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/v1/agents');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /v1/agents/:id', () => {
    it('returns agent by ID', async () => {
      const agent = await createTestAgent({ name: 'Find Me' });
      const res = await authed('get', `/v1/agents/${agent.id}`);
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Find Me');
    });

    it('returns 404 for non-existent ID', async () => {
      const res = await authed('get', '/v1/agents/00000000-0000-0000-0000-000000000000');
      expect(res.status).toBe(404);
    });

    it('does not include sensitive fields', async () => {
      const agent = await createTestAgent();
      const res = await authed('get', `/v1/agents/${agent.id}`);
      expect(res.body).not.toHaveProperty('apiKeyHash');
      expect(res.body).not.toHaveProperty('encryptedPrivateKey');
    });
  });

  describe('PATCH /v1/agents/:id', () => {
    it('updates name', async () => {
      const agent = await createTestAgent();
      const res = await authed('patch', `/v1/agents/${agent.id}`).send({ name: 'New Name' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('New Name');
    });

    it('updates description', async () => {
      const agent = await createTestAgent();
      const res = await authed('patch', `/v1/agents/${agent.id}`).send({
        description: 'New desc',
      });
      expect(res.status).toBe(200);
      expect(res.body.description).toBe('New desc');
    });

    it('updates isActive', async () => {
      const agent = await createTestAgent();
      const res = await authed('patch', `/v1/agents/${agent.id}`).send({ isActive: false });
      expect(res.status).toBe(200);
      expect(res.body.isActive).toBe(false);
    });

    it('returns 400 for empty name', async () => {
      const agent = await createTestAgent();
      const res = await authed('patch', `/v1/agents/${agent.id}`).send({ name: '' });
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid callbackUrl', async () => {
      const agent = await createTestAgent();
      const res = await authed('patch', `/v1/agents/${agent.id}`).send({
        callbackUrl: 'not-valid',
      });
      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent ID', async () => {
      const res = await authed('patch', '/v1/agents/00000000-0000-0000-0000-000000000000').send({
        name: 'Nope',
      });
      expect(res.status).toBe(404);
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).patch('/v1/agents/some-id').send({ name: 'Nope' });
      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /v1/agents/:id', () => {
    it('soft-deletes agent (sets isActive = false)', async () => {
      const agent = await createTestAgent();
      const res = await authed('delete', `/v1/agents/${agent.id}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(agent.id);
      expect(res.body.isActive).toBe(false);
    });

    it('agent still exists after soft-delete', async () => {
      const agent = await createTestAgent();
      await authed('delete', `/v1/agents/${agent.id}`);

      const res = await authed('get', `/v1/agents/${agent.id}`);
      expect(res.status).toBe(200);
      expect(res.body.isActive).toBe(false);
    });

    it('returns 404 for non-existent ID', async () => {
      const res = await authed('delete', '/v1/agents/00000000-0000-0000-0000-000000000000');
      expect(res.status).toBe(404);
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).delete('/v1/agents/some-id');
      expect(res.status).toBe(401);
    });
  });
});
