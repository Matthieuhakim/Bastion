import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { matchesAction, isWithinTimeWindow, evaluateRequest } from './policyEngine.js';

// Mock Prisma
vi.mock('./db.js', () => ({
  prisma: {
    policy: {
      findMany: vi.fn(),
    },
  },
}));

// Mock Redis helpers
vi.mock('./redis.js', () => ({
  redis: { disconnect: vi.fn() },
  getRateLimitCount: vi.fn().mockResolvedValue(0),
  getDailySpend: vi.fn().mockResolvedValue(0),
  incrementRateLimit: vi.fn().mockResolvedValue(1),
  incrementDailySpend: vi.fn().mockResolvedValue(0),
}));

import { prisma } from './db.js';
import { getRateLimitCount, getDailySpend } from './redis.js';

const mockFindMany = prisma.policy.findMany as ReturnType<typeof vi.fn>;
const mockGetRateLimitCount = getRateLimitCount as ReturnType<typeof vi.fn>;
const mockGetDailySpend = getDailySpend as ReturnType<typeof vi.fn>;

function makePolicy(overrides: Record<string, unknown> = {}) {
  return {
    id: 'policy-1',
    agentId: 'agent-1',
    credentialId: 'cred-1',
    allowedActions: [],
    deniedActions: [],
    constraints: null,
    requiresApprovalAbove: null,
    expiresAt: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('matchesAction', () => {
  it('matches exact action', () => {
    expect(matchesAction('charges.create', 'charges.create')).toBe(true);
  });

  it('does not match different action', () => {
    expect(matchesAction('charges.create', 'charges.read')).toBe(false);
  });

  it('matches wildcard *', () => {
    expect(matchesAction('*', 'anything.here')).toBe(true);
  });

  it('matches prefix wildcard transfers.*', () => {
    expect(matchesAction('transfers.*', 'transfers.create')).toBe(true);
    expect(matchesAction('transfers.*', 'transfers.read')).toBe(true);
  });

  it('does not match different prefix with wildcard', () => {
    expect(matchesAction('transfers.*', 'charges.create')).toBe(false);
  });

  it('matches nested wildcard', () => {
    expect(matchesAction('transfers.*', 'transfers.read.all')).toBe(true);
  });
});

describe('isWithinTimeWindow', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns true when within time window', () => {
    // Wednesday 2026-03-18 at 14:00 UTC
    vi.setSystemTime(new Date('2026-03-18T14:00:00Z'));
    expect(
      isWithinTimeWindow({
        days: ['wednesday'],
        hours: { start: '09:00', end: '17:00' },
        timezone: 'UTC',
      }),
    ).toBe(true);
  });

  it('returns false when outside hours', () => {
    // Wednesday 2026-03-18 at 20:00 UTC
    vi.setSystemTime(new Date('2026-03-18T20:00:00Z'));
    expect(
      isWithinTimeWindow({
        days: ['wednesday'],
        hours: { start: '09:00', end: '17:00' },
        timezone: 'UTC',
      }),
    ).toBe(false);
  });

  it('returns false when wrong day', () => {
    // Wednesday 2026-03-18 at 14:00 UTC
    vi.setSystemTime(new Date('2026-03-18T14:00:00Z'));
    expect(
      isWithinTimeWindow({
        days: ['monday', 'tuesday'],
        hours: { start: '09:00', end: '17:00' },
        timezone: 'UTC',
      }),
    ).toBe(false);
  });

  it('respects timezone', () => {
    // Wednesday 2026-03-18 at 22:00 UTC = Thursday 2026-03-19 at 06:00 in Asia/Singapore
    vi.setSystemTime(new Date('2026-03-18T22:00:00Z'));
    expect(
      isWithinTimeWindow({
        days: ['thursday'],
        hours: { start: '05:00', end: '07:00' },
        timezone: 'Asia/Singapore',
      }),
    ).toBe(true);
  });

  it('returns false for invalid timezone', () => {
    vi.setSystemTime(new Date('2026-03-18T14:00:00Z'));
    expect(
      isWithinTimeWindow({
        days: ['wednesday'],
        hours: { start: '09:00', end: '17:00' },
        timezone: 'Invalid/Zone',
      }),
    ).toBe(false);
  });
});

describe('evaluateRequest', () => {
  it('returns DENY when no policies found', async () => {
    mockFindMany.mockResolvedValue([]);

    const result = await evaluateRequest('agent-1', 'cred-1', 'charges.create');
    expect(result.decision).toBe('DENY');
    expect(result.policyId).toBeNull();
    expect(result.reason).toContain('No active policy');
  });

  it('returns ALLOW when action is in allowedActions', async () => {
    mockFindMany.mockResolvedValue([makePolicy({ allowedActions: ['charges.create'] })]);

    const result = await evaluateRequest('agent-1', 'cred-1', 'charges.create');
    expect(result.decision).toBe('ALLOW');
  });

  it('returns DENY when action is in deniedActions', async () => {
    mockFindMany.mockResolvedValue([makePolicy({ deniedActions: ['charges.create'] })]);

    const result = await evaluateRequest('agent-1', 'cred-1', 'charges.create');
    expect(result.decision).toBe('DENY');
    expect(result.reason).toContain('denied');
  });

  it('deny takes precedence over allow', async () => {
    mockFindMany.mockResolvedValue([
      makePolicy({
        allowedActions: ['charges.*'],
        deniedActions: ['charges.create'],
      }),
    ]);

    const result = await evaluateRequest('agent-1', 'cred-1', 'charges.create');
    expect(result.decision).toBe('DENY');
  });

  it('returns DENY when action not in allowedActions list', async () => {
    mockFindMany.mockResolvedValue([makePolicy({ allowedActions: ['charges.read'] })]);

    const result = await evaluateRequest('agent-1', 'cred-1', 'charges.create');
    expect(result.decision).toBe('DENY');
    expect(result.reason).toContain('not in the allowed actions');
  });

  it('returns DENY when amount exceeds maxAmountPerTransaction', async () => {
    mockFindMany.mockResolvedValue([
      makePolicy({ constraints: { maxAmountPerTransaction: 1000 } }),
    ]);

    const result = await evaluateRequest('agent-1', 'cred-1', 'charges.create', { amount: 1500 });
    expect(result.decision).toBe('DENY');
    expect(result.reason).toContain('exceeds maximum');
  });

  it('returns ESCALATE when amount exceeds approval threshold', async () => {
    mockFindMany.mockResolvedValue([makePolicy({ requiresApprovalAbove: 500 })]);

    const result = await evaluateRequest('agent-1', 'cred-1', 'charges.create', { amount: 1000 });
    expect(result.decision).toBe('ESCALATE');
    expect(result.reason).toContain('approval threshold');
  });

  it('returns DENY when rate limit exceeded', async () => {
    mockFindMany.mockResolvedValue([
      makePolicy({ constraints: { rateLimit: { maxRequests: 10, windowSeconds: 3600 } } }),
    ]);
    mockGetRateLimitCount.mockResolvedValue(10);

    const result = await evaluateRequest('agent-1', 'cred-1', 'charges.create');
    expect(result.decision).toBe('DENY');
    expect(result.reason).toContain('Rate limit');
  });

  it('returns DENY when daily spend would be exceeded', async () => {
    mockFindMany.mockResolvedValue([makePolicy({ constraints: { maxDailySpend: 5000 } })]);
    mockGetDailySpend.mockResolvedValue(4500);

    const result = await evaluateRequest('agent-1', 'cred-1', 'charges.create', { amount: 600 });
    expect(result.decision).toBe('DENY');
    expect(result.reason).toContain('Daily spend');
  });

  it('returns DENY when IP not in allowlist', async () => {
    mockFindMany.mockResolvedValue([
      makePolicy({ constraints: { ipAllowlist: ['10.0.0.1', '10.0.0.2'] } }),
    ]);

    const result = await evaluateRequest('agent-1', 'cred-1', 'charges.create', {
      ip: '10.0.0.99',
    });
    expect(result.decision).toBe('DENY');
    expect(result.reason).toContain('IP address');
  });

  it('filters out expired policies', async () => {
    const pastDate = new Date('2020-01-01');
    mockFindMany.mockResolvedValue([makePolicy({ expiresAt: pastDate })]);

    const result = await evaluateRequest('agent-1', 'cred-1', 'charges.create');
    expect(result.decision).toBe('DENY');
    expect(result.reason).toContain('No active policy');
  });

  it('most restrictive wins: DENY from any policy', async () => {
    mockFindMany.mockResolvedValue([
      makePolicy({ id: 'p1', allowedActions: ['charges.*'] }),
      makePolicy({ id: 'p2', deniedActions: ['charges.create'] }),
    ]);

    const result = await evaluateRequest('agent-1', 'cred-1', 'charges.create');
    expect(result.decision).toBe('DENY');
    expect(result.policyId).toBe('p2');
  });

  it('most restrictive wins: ESCALATE beats ALLOW', async () => {
    mockFindMany.mockResolvedValue([
      makePolicy({ id: 'p1', allowedActions: ['charges.*'] }),
      makePolicy({ id: 'p2', requiresApprovalAbove: 500 }),
    ]);

    const result = await evaluateRequest('agent-1', 'cred-1', 'charges.create', { amount: 1000 });
    expect(result.decision).toBe('ESCALATE');
    expect(result.policyId).toBe('p2');
  });

  it('returns ALLOW when amount is below all thresholds', async () => {
    mockFindMany.mockResolvedValue([
      makePolicy({
        allowedActions: ['charges.create'],
        constraints: { maxAmountPerTransaction: 5000, maxDailySpend: 10000 },
        requiresApprovalAbove: 2000,
      }),
    ]);

    const result = await evaluateRequest('agent-1', 'cred-1', 'charges.create', { amount: 100 });
    expect(result.decision).toBe('ALLOW');
  });

  it('returns intent review metadata when an active policy opts in', async () => {
    mockFindMany.mockResolvedValue([
      makePolicy({
        constraints: {
          intentReview: {
            enabled: true,
            mode: 'escalate_on_risk',
            instructions: 'Escalate destructive intent.',
          },
        },
      }),
    ]);

    const result = await evaluateRequest('agent-1', 'cred-1', 'charges.create');
    expect(result.decision).toBe('ALLOW');
    expect(result.intentReview).toEqual({
      enabled: true,
      mode: 'escalate_on_risk',
      instructions: 'Escalate destructive intent.',
      policyId: 'policy-1',
    });
  });

  it('returns DENY outside time window', async () => {
    vi.setSystemTime(new Date('2026-03-18T22:00:00Z')); // Wednesday 22:00 UTC
    mockFindMany.mockResolvedValue([
      makePolicy({
        constraints: {
          timeWindow: {
            days: ['wednesday'],
            hours: { start: '09:00', end: '17:00' },
            timezone: 'UTC',
          },
        },
      }),
    ]);

    const result = await evaluateRequest('agent-1', 'cred-1', 'charges.create');
    expect(result.decision).toBe('DENY');
    expect(result.reason).toContain('time window');
    vi.useRealTimers();
  });
});
