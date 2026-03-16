import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRedis, mockSubscriber } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('events') as typeof import('events');
  const emitter = new EventEmitter();
  return {
    mockRedis: {
      set: vi.fn().mockResolvedValue('OK'),
      get: vi.fn().mockResolvedValue(null),
      sadd: vi.fn().mockResolvedValue(1),
      srem: vi.fn().mockResolvedValue(1),
      smembers: vi.fn().mockResolvedValue([]),
      mget: vi.fn().mockResolvedValue([]),
      ttl: vi.fn().mockResolvedValue(200),
      publish: vi.fn().mockResolvedValue(1),
      disconnect: vi.fn(),
    },
    mockSubscriber: Object.assign(emitter, {
      subscribe: vi.fn().mockResolvedValue(1),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    }),
  };
});

vi.mock('./redis.js', () => ({
  redis: mockRedis,
  createSubscriberConnection: vi.fn(() => mockSubscriber),
}));

import {
  createPendingRequest,
  resolveRequest,
  getPendingRequest,
  listPendingRequests,
  waitForResolution,
} from './hitl.js';

const baseInput = {
  agentId: 'agent-1',
  credentialId: 'cred-1',
  action: 'charges.create',
  params: { amount: 5000 },
  target: { url: 'https://api.stripe.com/v1/charges', method: 'POST', headers: {} },
};

const escalation = {
  policyId: 'policy-1',
  reason: 'Amount 5000 exceeds approval threshold 1000',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSubscriber.removeAllListeners();
});

describe('createPendingRequest', () => {
  it('stores pending request in Redis with TTL and adds to pending set', async () => {
    const result = await createPendingRequest(baseInput, escalation);

    expect(result.requestId).toBeDefined();
    expect(result.status).toBe('pending');
    expect(result.agentId).toBe('agent-1');
    expect(result.credentialId).toBe('cred-1');
    expect(result.action).toBe('charges.create');
    expect(result.policyId).toBe('policy-1');
    expect(result.reason).toBe('Amount 5000 exceeds approval threshold 1000');
    expect(result.createdAt).toBeDefined();

    expect(mockRedis.set).toHaveBeenCalledWith(
      `hitl:${result.requestId}`,
      expect.any(String),
      'EX',
      300,
    );
    expect(mockRedis.sadd).toHaveBeenCalledWith('hitl:pending', result.requestId);
  });
});

describe('resolveRequest', () => {
  it('approves a pending request and publishes resolution', async () => {
    const pending = {
      requestId: 'req-1',
      status: 'pending',
      agentId: 'agent-1',
      credentialId: 'cred-1',
      action: 'charges.create',
      params: {},
      target: { url: 'https://example.com', method: 'POST', headers: {} },
      policyId: 'policy-1',
      reason: 'test',
      createdAt: new Date().toISOString(),
    };
    mockRedis.get.mockResolvedValue(JSON.stringify(pending));

    const result = await resolveRequest('req-1', 'approved');

    expect(result.status).toBe('approved');
    expect(result.resolvedBy).toBe('admin');
    expect(mockRedis.srem).toHaveBeenCalledWith('hitl:pending', 'req-1');
    expect(mockRedis.publish).toHaveBeenCalledWith(
      'hitl:req-1:resolution',
      JSON.stringify({ status: 'approved' }),
    );
  });

  it('denies a pending request with reason', async () => {
    const pending = {
      requestId: 'req-1',
      status: 'pending',
      agentId: 'agent-1',
      credentialId: 'cred-1',
      action: 'charges.create',
      params: {},
      target: { url: 'https://example.com', method: 'POST', headers: {} },
      policyId: 'policy-1',
      reason: 'test',
      createdAt: new Date().toISOString(),
    };
    mockRedis.get.mockResolvedValue(JSON.stringify(pending));

    const result = await resolveRequest('req-1', 'denied', 'Too risky');

    expect(result.status).toBe('denied');
    expect(result.denialReason).toBe('Too risky');
  });

  it('throws NotFoundError for expired request', async () => {
    mockRedis.get.mockResolvedValue(null);

    await expect(resolveRequest('req-1', 'approved')).rejects.toThrow(
      'Pending request not found or expired',
    );
  });

  it('throws ConflictError for already resolved request', async () => {
    const resolved = {
      requestId: 'req-1',
      status: 'approved',
      agentId: 'agent-1',
      credentialId: 'cred-1',
      action: 'charges.create',
      params: {},
      target: { url: 'https://example.com', method: 'POST', headers: {} },
      policyId: 'policy-1',
      reason: 'test',
      createdAt: new Date().toISOString(),
    };
    mockRedis.get.mockResolvedValue(JSON.stringify(resolved));

    await expect(resolveRequest('req-1', 'denied')).rejects.toThrow(
      'Request has already been resolved',
    );
  });
});

describe('getPendingRequest', () => {
  it('returns parsed request when found', async () => {
    const pending = {
      requestId: 'req-1',
      status: 'pending',
      agentId: 'agent-1',
      credentialId: 'cred-1',
      action: 'charges.create',
      params: {},
      target: { url: 'https://example.com', method: 'POST', headers: {} },
      policyId: null,
      reason: 'test',
      createdAt: new Date().toISOString(),
    };
    mockRedis.get.mockResolvedValue(JSON.stringify(pending));

    const result = await getPendingRequest('req-1');
    expect(result).toEqual(pending);
  });

  it('returns null when not found', async () => {
    mockRedis.get.mockResolvedValue(null);
    const result = await getPendingRequest('req-999');
    expect(result).toBeNull();
  });
});

describe('listPendingRequests', () => {
  it('returns pending requests sorted by createdAt descending', async () => {
    const older = {
      requestId: 'req-1',
      status: 'pending',
      createdAt: '2026-03-16T10:00:00.000Z',
    };
    const newer = {
      requestId: 'req-2',
      status: 'pending',
      createdAt: '2026-03-16T11:00:00.000Z',
    };
    mockRedis.smembers.mockResolvedValue(['req-1', 'req-2']);
    mockRedis.mget.mockResolvedValue([JSON.stringify(older), JSON.stringify(newer)]);

    const results = await listPendingRequests();

    expect(results).toHaveLength(2);
    expect(results[0].requestId).toBe('req-2');
    expect(results[1].requestId).toBe('req-1');
  });

  it('cleans up stale entries from pending set', async () => {
    mockRedis.smembers.mockResolvedValue(['req-1', 'req-expired']);
    mockRedis.mget.mockResolvedValue([
      JSON.stringify({ requestId: 'req-1', status: 'pending', createdAt: '2026-03-16T10:00:00.000Z' }),
      null,
    ]);

    await listPendingRequests();

    expect(mockRedis.srem).toHaveBeenCalledWith('hitl:pending', 'req-expired');
  });

  it('returns empty array when no pending requests', async () => {
    mockRedis.smembers.mockResolvedValue([]);
    const results = await listPendingRequests();
    expect(results).toEqual([]);
  });
});

describe('waitForResolution', () => {
  it('resolves approved when message received on channel', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({ status: 'pending' }));

    const promise = waitForResolution('req-1', 5000);

    // Simulate pub/sub message after a tick
    await new Promise((r) => setTimeout(r, 10));
    mockSubscriber.emit('message', 'hitl:req-1:resolution', JSON.stringify({ status: 'approved' }));

    const result = await promise;
    expect(result).toBe('approved');
  });

  it('resolves denied when message received on channel', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({ status: 'pending' }));

    const promise = waitForResolution('req-1', 5000);

    await new Promise((r) => setTimeout(r, 10));
    mockSubscriber.emit('message', 'hitl:req-1:resolution', JSON.stringify({ status: 'denied' }));

    const result = await promise;
    expect(result).toBe('denied');
  });

  it('resolves timeout when no message within deadline', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({ status: 'pending' }));

    const result = await waitForResolution('req-1', 50);

    expect(result).toBe('timeout');
  });

  it('resolves immediately if already approved (race condition)', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({ status: 'approved' }));

    const result = await waitForResolution('req-1', 5000);

    expect(result).toBe('approved');
  });
});
