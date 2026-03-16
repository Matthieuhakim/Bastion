import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { cleanDatabase, disconnectDatabase, testPrisma } from '../__test__/helpers/db.js';
import { decryptCredential } from '../services/credentials.js';

const app = createApp();
const API_KEY = process.env['PROJECT_API_KEY']!;

function authed(method: 'get' | 'post' | 'delete', path: string) {
  return request(app)[method](path).set('Authorization', `Bearer ${API_KEY}`);
}

async function createTestAgent(overrides: Record<string, unknown> = {}) {
  const res = await authed('post', '/v1/agents').send({
    name: 'Credential Test Agent',
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

beforeEach(() => cleanDatabase());
afterAll(() => disconnectDatabase());

describe('POST /v1/credentials', () => {
  it('creates a credential and returns 201', async () => {
    const agent = await createTestAgent();
    const res = await authed('post', '/v1/credentials').send({
      name: 'Stripe Key',
      type: 'API_KEY',
      value: 'sk_test_abc123',
      agentId: agent.id,
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe('Stripe Key');
    expect(res.body.type).toBe('API_KEY');
    expect(res.body.agentId).toBe(agent.id);
    expect(res.body.isRevoked).toBe(false);
    expect(res.body.createdAt).toBeDefined();
  });

  it('does not return encrypted fields or raw value', async () => {
    const agent = await createTestAgent();
    const res = await authed('post', '/v1/credentials').send({
      name: 'Key',
      type: 'API_KEY',
      value: 'sk_test_secret',
      agentId: agent.id,
    });

    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('encryptedBlob');
    expect(res.body).not.toHaveProperty('encryptedDek');
    expect(res.body).not.toHaveProperty('iv');
    expect(res.body).not.toHaveProperty('authTag');
    expect(res.body).not.toHaveProperty('value');
  });

  it('stores a display hint in metadata', async () => {
    const agent = await createTestAgent();
    const res = await authed('post', '/v1/credentials').send({
      name: 'Key',
      type: 'API_KEY',
      value: 'sk_test_abc123xyz',
      agentId: agent.id,
    });

    expect(res.status).toBe(201);
    expect(res.body.metadata._displayHint).toBe('sk_...3xyz');
  });

  it('accepts metadata and scopes', async () => {
    const agent = await createTestAgent();
    const res = await authed('post', '/v1/credentials').send({
      name: 'Stripe Key',
      type: 'API_KEY',
      value: 'sk_test_abc123',
      agentId: agent.id,
      metadata: { provider: 'stripe' },
      scopes: ['charges.create', 'charges.read'],
    });

    expect(res.status).toBe(201);
    expect(res.body.metadata.provider).toBe('stripe');
    expect(res.body.scopes).toEqual(['charges.create', 'charges.read']);
  });

  it('returns 400 for missing name', async () => {
    const agent = await createTestAgent();
    const res = await authed('post', '/v1/credentials').send({
      type: 'API_KEY',
      value: 'sk_test',
      agentId: agent.id,
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing type', async () => {
    const agent = await createTestAgent();
    const res = await authed('post', '/v1/credentials').send({
      name: 'Key',
      value: 'sk_test',
      agentId: agent.id,
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid type', async () => {
    const agent = await createTestAgent();
    const res = await authed('post', '/v1/credentials').send({
      name: 'Key',
      type: 'INVALID',
      value: 'sk_test',
      agentId: agent.id,
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing value', async () => {
    const agent = await createTestAgent();
    const res = await authed('post', '/v1/credentials').send({
      name: 'Key',
      type: 'API_KEY',
      agentId: agent.id,
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for empty value', async () => {
    const agent = await createTestAgent();
    const res = await authed('post', '/v1/credentials').send({
      name: 'Key',
      type: 'API_KEY',
      value: '',
      agentId: agent.id,
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing agentId', async () => {
    const res = await authed('post', '/v1/credentials').send({
      name: 'Key',
      type: 'API_KEY',
      value: 'sk_test',
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent agentId', async () => {
    const res = await authed('post', '/v1/credentials').send({
      name: 'Key',
      type: 'API_KEY',
      value: 'sk_test',
      agentId: '00000000-0000-0000-0000-000000000000',
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 for expiresAt in the past', async () => {
    const agent = await createTestAgent();
    const res = await authed('post', '/v1/credentials').send({
      name: 'Key',
      type: 'API_KEY',
      value: 'sk_test',
      agentId: agent.id,
      expiresAt: '2020-01-01T00:00:00Z',
    });
    expect(res.status).toBe(400);
  });

  it('returns 401 without Authorization header', async () => {
    const res = await request(app).post('/v1/credentials').send({
      name: 'Key',
      type: 'API_KEY',
      value: 'sk_test',
      agentId: 'some-id',
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/credentials', () => {
  it('returns empty array when no credentials exist', async () => {
    const res = await authed('get', '/v1/credentials');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns all credentials', async () => {
    const agent = await createTestAgent();
    await createTestCredential(agent.id, { name: 'Key 1' });
    await createTestCredential(agent.id, { name: 'Key 2' });

    const res = await authed('get', '/v1/credentials');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('filters by agentId query parameter', async () => {
    const agent1 = await createTestAgent({ name: 'Agent 1' });
    const agent2 = await createTestAgent({ name: 'Agent 2' });
    await createTestCredential(agent1.id);
    await createTestCredential(agent2.id);

    const res = await authed('get', `/v1/credentials?agentId=${agent1.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].agentId).toBe(agent1.id);
  });

  it('does not include encrypted fields', async () => {
    const agent = await createTestAgent();
    await createTestCredential(agent.id);

    const res = await authed('get', '/v1/credentials');
    expect(res.body[0]).not.toHaveProperty('encryptedBlob');
    expect(res.body[0]).not.toHaveProperty('encryptedDek');
    expect(res.body[0]).not.toHaveProperty('iv');
    expect(res.body[0]).not.toHaveProperty('authTag');
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/v1/credentials');
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/credentials/:id', () => {
  it('returns a credential by ID', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);

    const res = await authed('get', `/v1/credentials/${credential.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(credential.id);
    expect(res.body.name).toBe('Test Credential');
  });

  it('returns 404 for non-existent ID', async () => {
    const res = await authed('get', '/v1/credentials/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it('does not include encrypted fields', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);

    const res = await authed('get', `/v1/credentials/${credential.id}`);
    expect(res.body).not.toHaveProperty('encryptedBlob');
    expect(res.body).not.toHaveProperty('encryptedDek');
  });
});

describe('DELETE /v1/credentials/:id', () => {
  it('revokes a credential', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);

    const res = await authed('delete', `/v1/credentials/${credential.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(credential.id);
    expect(res.body.isRevoked).toBe(true);
  });

  it('credential still exists after revocation', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);
    await authed('delete', `/v1/credentials/${credential.id}`);

    const res = await authed('get', `/v1/credentials/${credential.id}`);
    expect(res.status).toBe(200);
    expect(res.body.isRevoked).toBe(true);
  });

  it('returns 404 for non-existent ID', async () => {
    const res = await authed('delete', '/v1/credentials/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).delete('/v1/credentials/some-id');
    expect(res.status).toBe(401);
  });
});

describe('data integrity', () => {
  it('stores encrypted data in the database, not plaintext', async () => {
    const agent = await createTestAgent();
    const plainValue = 'sk_test_supersecret123';
    const credential = await createTestCredential(agent.id, { value: plainValue });

    const dbRecord = await testPrisma.credential.findUnique({ where: { id: credential.id } });
    expect(dbRecord).not.toBeNull();

    const blobString = Buffer.from(dbRecord!.encryptedBlob).toString('utf8');
    expect(blobString).not.toContain(plainValue);
  });

  it('decryptCredential returns the original plaintext', async () => {
    const agent = await createTestAgent();
    const plainValue = 'sk_test_roundtrip_value';
    const credential = await createTestCredential(agent.id, { value: plainValue });

    const decrypted = await decryptCredential(credential.id);
    expect(decrypted).toBe(plainValue);
  });

  it('decryptCredential throws for a revoked credential', async () => {
    const agent = await createTestAgent();
    const credential = await createTestCredential(agent.id);
    await authed('delete', `/v1/credentials/${credential.id}`);

    await expect(decryptCredential(credential.id)).rejects.toThrow('revoked');
  });
});
