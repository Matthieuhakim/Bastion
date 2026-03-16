import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({
  prisma: {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    agent: {
      findUnique: vi.fn(),
    },
    auditRecord: {
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from './db.js';
import { canonicalize } from './canonicalize.js';
import { appendAuditRecord, GENESIS_HASH, verifyChain } from './auditChain.js';
import { generateKeypair, sha256, signHash, verifySignature } from './crypto.js';

const mockTransaction = prisma.$transaction as ReturnType<typeof vi.fn>;
const mockFindAgent = prisma.agent.findUnique as ReturnType<typeof vi.fn>;
const mockFindMany = prisma.auditRecord.findMany as ReturnType<typeof vi.fn>;

interface StoredRecordInput {
  id: bigint;
  agentId: string;
  keyFingerprint: string;
  privateKey: string;
  previousHash: Uint8Array;
  timestamp: string;
}

async function makeStoredRecord(input: StoredRecordInput) {
  const recordJson = {
    agentId: input.agentId,
    action: `charges.${input.id}`,
    targetUrl: 'https://api.stripe.com/v1/charges',
    targetMethod: 'POST',
    credentialId: 'cred-1',
    policyDecision: 'ALLOW' as const,
    policyId: 'policy-1',
    reason: 'Allowed',
    params: { amount: 100 },
    durationMs: 42,
    previousHash: Buffer.from(input.previousHash).toString('hex'),
    timestamp: input.timestamp,
    outcome: 'executed' as const,
    upstreamStatus: 200,
  };
  const recordHash = Buffer.from(sha256(new TextEncoder().encode(canonicalize(recordJson))));
  const signature = Buffer.from(await signHash(recordHash, input.privateKey));

  return {
    id: input.id,
    agentId: input.agentId,
    recordJson,
    recordHash,
    signature,
    signerKeyFingerprint: input.keyFingerprint,
    previousHash: Buffer.from(input.previousHash),
    createdAt: new Date(input.timestamp),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('appendAuditRecord', () => {
  it('uses the genesis hash for the first record and acquires an advisory lock', async () => {
    const keypair = await generateKeypair();
    const executeRaw = vi.fn().mockResolvedValue(1);
    const findFirst = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockImplementation(async ({ data }) => ({ id: 1n, ...data }));
    const findUnique = vi.fn().mockResolvedValue({
      encryptedPrivateKey: keypair.privateKey,
      keyFingerprint: keypair.fingerprint,
    });

    mockTransaction.mockImplementation(async (callback) =>
      callback({
        $executeRaw: executeRaw,
        agent: { findUnique },
        auditRecord: { findFirst, create },
      }),
    );

    const record = await appendAuditRecord({
      agentId: 'agent-1',
      action: 'charges.create',
      targetUrl: 'https://api.stripe.com/v1/charges',
      targetMethod: 'POST',
      credentialId: 'cred-1',
      policyDecision: 'ALLOW',
      policyId: 'policy-1',
      reason: 'Allowed',
      params: { amount: 100 },
      durationMs: 25,
      outcome: 'executed',
      upstreamStatus: 200,
    });

    expect(executeRaw).toHaveBeenCalledOnce();
    expect(findFirst).toHaveBeenCalledWith({
      where: { agentId: 'agent-1' },
      orderBy: { id: 'desc' },
      select: { recordHash: true },
    });

    const createArgs = create.mock.calls[0][0].data;
    expect(Buffer.from(createArgs.previousHash).equals(GENESIS_HASH)).toBe(true);
    expect(createArgs.recordJson.previousHash).toBe('0'.repeat(64));
    expect(
      await verifySignature(
        Buffer.from(record.recordHash, 'hex'),
        Buffer.from(record.signature, 'hex'),
        keypair.publicKey,
      ),
    ).toBe(true);
  });
});

describe('verifyChain', () => {
  it('returns valid for an intact chain', async () => {
    const keypair = await generateKeypair();
    mockFindAgent.mockResolvedValue({
      publicKey: keypair.publicKey,
      keyFingerprint: keypair.fingerprint,
    });

    const record1 = await makeStoredRecord({
      id: 1n,
      agentId: 'agent-1',
      keyFingerprint: keypair.fingerprint,
      privateKey: keypair.privateKey,
      previousHash: GENESIS_HASH,
      timestamp: '2026-03-16T19:00:00.000Z',
    });
    const record2 = await makeStoredRecord({
      id: 2n,
      agentId: 'agent-1',
      keyFingerprint: keypair.fingerprint,
      privateKey: keypair.privateKey,
      previousHash: record1.recordHash,
      timestamp: '2026-03-16T19:01:00.000Z',
    });

    mockFindMany.mockResolvedValueOnce([record1, record2]).mockResolvedValueOnce([]);

    await expect(verifyChain('agent-1')).resolves.toEqual({
      valid: true,
      recordCount: 2,
      firstRecord: '2026-03-16T19:00:00.000Z',
      lastRecord: '2026-03-16T19:01:00.000Z',
    });
  });

  it('detects a tampered hash', async () => {
    const keypair = await generateKeypair();
    mockFindAgent.mockResolvedValue({
      publicKey: keypair.publicKey,
      keyFingerprint: keypair.fingerprint,
    });

    const record = await makeStoredRecord({
      id: 1n,
      agentId: 'agent-1',
      keyFingerprint: keypair.fingerprint,
      privateKey: keypair.privateKey,
      previousHash: GENESIS_HASH,
      timestamp: '2026-03-16T19:00:00.000Z',
    });
    record.recordHash = Buffer.alloc(32, 7);

    mockFindMany.mockResolvedValueOnce([record]).mockResolvedValueOnce([]);

    await expect(verifyChain('agent-1')).resolves.toMatchObject({
      valid: false,
      brokenAt: '1',
      reason: 'recordHash does not match the canonicalized record payload',
    });
  });
});
