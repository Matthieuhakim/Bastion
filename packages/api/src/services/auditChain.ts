import type { AuditRecord, Prisma } from '@prisma/client';
import { Prisma as PrismaNamespace } from '@prisma/client';
import type { PolicyDecision, EvaluationParams } from './policyEngine.js';
import type { IntentJudgeVerdict } from './intentJudge.js';
import { prisma } from './db.js';
import { canonicalize } from './canonicalize.js';
import { sha256, signHash, verifySignature } from './crypto.js';

export const GENESIS_HASH = Buffer.alloc(32, 0);
const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 200;
const VERIFY_BATCH_SIZE = 1000;

export interface AppendAuditRecordInput {
  agentId: string;
  action: string;
  targetUrl: string;
  targetMethod: string;
  credentialId: string;
  policyDecision: PolicyDecision;
  policyId: string | null;
  reason: string;
  params?: EvaluationParams;
  durationMs: number;
  hitlRequestId?: string;
  intentReview?: IntentJudgeVerdict;
  upstreamStatus?: number;
  outcome?: 'executed' | 'denied' | 'failed';
  error?: string;
}

export interface AuditRecordDocument {
  agentId: string;
  action: string;
  targetUrl: string;
  targetMethod: string;
  credentialId: string;
  policyDecision: PolicyDecision;
  policyId: string | null;
  reason: string;
  params: EvaluationParams;
  durationMs: number;
  previousHash: string;
  timestamp: string;
  hitlRequestId?: string;
  intentReview?: IntentJudgeVerdict;
  upstreamStatus?: number;
  outcome?: 'executed' | 'denied' | 'failed';
  error?: string;
}

export interface VerifyChainSuccess {
  valid: true;
  recordCount: number;
  firstRecord: string | null;
  lastRecord: string | null;
}

export interface VerifyChainFailure {
  valid: false;
  recordCount: number;
  firstRecord: string | null;
  lastRecord: string | null;
  brokenAt: string;
  reason: string;
}

export type VerifyChainResult = VerifyChainSuccess | VerifyChainFailure;

export interface QueryAuditRecordsInput {
  agentId: string;
  from?: Date;
  to?: Date;
  action?: string;
  policyDecision?: PolicyDecision;
  cursor?: bigint;
  limit?: number;
}

export interface SerializedAuditRecord {
  id: string;
  agentId: string;
  recordJson: AuditRecordDocument;
  recordHash: string;
  signature: string;
  signerKeyFingerprint: string;
  previousHash: string;
  createdAt: string;
}

export interface QueryAuditRecordsResult {
  records: SerializedAuditRecord[];
  nextCursor: string | null;
}

interface AuditRecordRow {
  id: bigint;
  agentId: string;
  recordJson: Prisma.JsonValue;
  recordHash: Uint8Array;
  signature: Uint8Array;
  signerKeyFingerprint: string;
  previousHash: Uint8Array;
  createdAt: Date;
}

function toHex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function areEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function serializeRecord(record: AuditRecordRow | AuditRecord): SerializedAuditRecord {
  return {
    id: record.id.toString(),
    agentId: record.agentId,
    recordJson: record.recordJson as unknown as AuditRecordDocument,
    recordHash: toHex(record.recordHash),
    signature: toHex(record.signature),
    signerKeyFingerprint: record.signerKeyFingerprint,
    previousHash: toHex(record.previousHash),
    createdAt: record.createdAt.toISOString(),
  };
}

function buildRecordDocument(
  input: AppendAuditRecordInput,
  previousHash: Uint8Array,
  timestamp: string,
): AuditRecordDocument {
  return {
    agentId: input.agentId,
    action: input.action,
    targetUrl: input.targetUrl,
    targetMethod: input.targetMethod,
    credentialId: input.credentialId,
    policyDecision: input.policyDecision,
    policyId: input.policyId,
    reason: input.reason,
    params: input.params ?? {},
    durationMs: input.durationMs,
    previousHash: toHex(previousHash),
    timestamp,
    ...(input.hitlRequestId ? { hitlRequestId: input.hitlRequestId } : {}),
    ...(input.intentReview ? { intentReview: input.intentReview } : {}),
    ...(input.upstreamStatus !== undefined ? { upstreamStatus: input.upstreamStatus } : {}),
    ...(input.outcome ? { outcome: input.outcome } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

function buildFailureResult(
  brokenAt: bigint,
  reason: string,
  recordCount: number,
  firstRecord: string | null,
  lastRecord: string | null,
): VerifyChainFailure {
  return {
    valid: false,
    recordCount,
    firstRecord,
    lastRecord,
    brokenAt: brokenAt.toString(),
    reason,
  };
}

export async function appendAuditRecord(
  input: AppendAuditRecordInput,
): Promise<SerializedAuditRecord> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.agentId}))`;

    const [agent, lastRecord] = await Promise.all([
      tx.agent.findUnique({
        where: { id: input.agentId },
        select: {
          encryptedPrivateKey: true,
          keyFingerprint: true,
        },
      }),
      tx.auditRecord.findFirst({
        where: { agentId: input.agentId },
        orderBy: { id: 'desc' },
        select: {
          recordHash: true,
        },
      }),
    ]);

    if (!agent) {
      throw new Error(`Agent ${input.agentId} not found for audit append`);
    }

    const previousHash = lastRecord?.recordHash ?? GENESIS_HASH;
    const createdAt = new Date();
    const timestamp = createdAt.toISOString();
    const recordJson = buildRecordDocument(input, previousHash, timestamp);
    const canonicalJson = canonicalize(recordJson);
    const recordHash = Buffer.from(sha256(new TextEncoder().encode(canonicalJson)));
    const signature = Buffer.from(await signHash(recordHash, agent.encryptedPrivateKey));

    const record = await tx.auditRecord.create({
      data: {
        agentId: input.agentId,
        recordJson: recordJson as unknown as PrismaNamespace.InputJsonValue,
        recordHash,
        signature,
        signerKeyFingerprint: agent.keyFingerprint,
        previousHash: Buffer.from(previousHash),
        createdAt,
      },
    });

    return serializeRecord(record);
  });
}

export async function verifyChain(agentId: string): Promise<VerifyChainResult> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: {
      publicKey: true,
      keyFingerprint: true,
    },
  });

  if (!agent) {
    throw new Error(`Agent ${agentId} not found for audit verification`);
  }

  let cursor: bigint | undefined;
  let recordCount = 0;
  let expectedPreviousHash: Uint8Array = GENESIS_HASH;
  let firstRecord: string | null = null;
  let lastRecord: string | null = null;

  while (true) {
    const records = await prisma.auditRecord.findMany({
      where: { agentId },
      orderBy: { id: 'asc' },
      take: VERIFY_BATCH_SIZE,
      ...(cursor !== undefined
        ? {
            cursor: { id: cursor },
            skip: 1,
          }
        : {}),
    });

    if (records.length === 0) {
      return {
        valid: true,
        recordCount,
        firstRecord,
        lastRecord,
      };
    }

    for (const record of records) {
      recordCount += 1;
      firstRecord ??= record.createdAt.toISOString();
      lastRecord = record.createdAt.toISOString();

      if (record.signerKeyFingerprint !== agent.keyFingerprint) {
        return buildFailureResult(
          record.id,
          'Signer key fingerprint does not match the agent public key',
          recordCount,
          firstRecord,
          lastRecord,
        );
      }

      if (!areEqualBytes(record.previousHash, expectedPreviousHash)) {
        return buildFailureResult(
          record.id,
          'previousHash does not match the prior record hash',
          recordCount,
          firstRecord,
          lastRecord,
        );
      }

      const recordDocument = record.recordJson as Partial<AuditRecordDocument>;
      if (recordDocument.previousHash !== toHex(record.previousHash)) {
        return buildFailureResult(
          record.id,
          'recordJson.previousHash does not match the stored previousHash',
          recordCount,
          firstRecord,
          lastRecord,
        );
      }

      const canonicalJson = canonicalize(record.recordJson);
      const computedHash = Buffer.from(sha256(new TextEncoder().encode(canonicalJson)));
      if (!areEqualBytes(record.recordHash, computedHash)) {
        return buildFailureResult(
          record.id,
          'recordHash does not match the canonicalized record payload',
          recordCount,
          firstRecord,
          lastRecord,
        );
      }

      const isValidSignature = await verifySignature(
        record.recordHash,
        record.signature,
        agent.publicKey,
      );
      if (!isValidSignature) {
        return buildFailureResult(
          record.id,
          'Signature verification failed',
          recordCount,
          firstRecord,
          lastRecord,
        );
      }

      expectedPreviousHash = record.recordHash;
    }

    cursor = records[records.length - 1]?.id;
  }
}

export async function queryAuditRecords(
  input: QueryAuditRecordsInput,
): Promise<QueryAuditRecordsResult> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_QUERY_LIMIT, 1), MAX_QUERY_LIMIT);
  const conditions: Prisma.Sql[] = [PrismaNamespace.sql`"agent_id" = ${input.agentId}`];

  if (input.from) {
    conditions.push(PrismaNamespace.sql`"created_at" >= ${input.from}`);
  }
  if (input.to) {
    conditions.push(PrismaNamespace.sql`"created_at" <= ${input.to}`);
  }
  if (input.action) {
    conditions.push(PrismaNamespace.sql`"record_json"->>'action' = ${input.action}`);
  }
  if (input.policyDecision) {
    conditions.push(
      PrismaNamespace.sql`"record_json"->>'policyDecision' = ${input.policyDecision}`,
    );
  }
  if (input.cursor !== undefined) {
    conditions.push(PrismaNamespace.sql`"id" < ${input.cursor}`);
  }

  const whereClause = PrismaNamespace.sql`WHERE ${PrismaNamespace.join(conditions, ' AND ')}`;
  const rows = await prisma.$queryRaw<AuditRecordRow[]>(PrismaNamespace.sql`
    SELECT
      "id",
      "agent_id" AS "agentId",
      "record_json" AS "recordJson",
      "record_hash" AS "recordHash",
      "signature",
      "signer_key_fingerprint" AS "signerKeyFingerprint",
      "previous_hash" AS "previousHash",
      "created_at" AS "createdAt"
    FROM "audit_records"
    ${whereClause}
    ORDER BY "id" DESC
    LIMIT ${limit + 1}
  `);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map((row) => serializeRecord(row));
  const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

  return {
    records: page,
    nextCursor,
  };
}
