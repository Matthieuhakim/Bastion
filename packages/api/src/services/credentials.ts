import type { Credential } from '@prisma/client';
import { prisma } from './db.js';
import { encrypt, decrypt } from './encryption.js';
import { NotFoundError } from '../errors.js';

export interface CreateCredentialInput {
  name: string;
  type: 'API_KEY' | 'OAUTH2' | 'CUSTOM';
  value: string;
  agentId: string;
  metadata?: Record<string, unknown>;
  scopes?: string[];
  expiresAt?: Date;
}

function toPrismaBytes(value: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value);
}

function generateDisplayHint(value: string): string {
  if (value.length >= 8) {
    return value.slice(0, 3) + '...' + value.slice(-4);
  }
  return '***';
}

export async function createCredential(input: CreateCredentialInput): Promise<Credential> {
  // Validate agent exists
  const agent = await prisma.agent.findUnique({ where: { id: input.agentId } });
  if (!agent) {
    throw new NotFoundError('Agent not found');
  }

  const encrypted = encrypt(input.value);
  const displayHint = generateDisplayHint(input.value);

  const metadata = {
    ...(input.metadata ?? {}),
    _displayHint: displayHint,
  };

  return prisma.credential.create({
    data: {
      name: input.name,
      type: input.type,
      encryptedBlob: toPrismaBytes(encrypted.encryptedBlob),
      encryptedDek: toPrismaBytes(encrypted.encryptedDek),
      iv: toPrismaBytes(encrypted.iv),
      authTag: toPrismaBytes(encrypted.authTag),
      metadata,
      scopes: input.scopes ?? [],
      expiresAt: input.expiresAt,
      agentId: input.agentId,
    },
  });
}

export async function listCredentials(agentId?: string): Promise<Credential[]> {
  return prisma.credential.findMany({
    where: agentId ? { agentId } : undefined,
    orderBy: { createdAt: 'desc' },
  });
}

export async function getCredential(id: string): Promise<Credential> {
  const credential = await prisma.credential.findUnique({ where: { id } });
  if (!credential) {
    throw new NotFoundError('Credential not found');
  }
  return credential;
}

export async function revokeCredential(id: string): Promise<Credential> {
  await getCredential(id);
  return prisma.credential.update({
    where: { id },
    data: { isRevoked: true },
  });
}

export async function decryptCredential(id: string): Promise<string> {
  const credential = await getCredential(id);

  if (credential.isRevoked) {
    throw new NotFoundError('Credential is revoked');
  }

  if (credential.expiresAt && credential.expiresAt < new Date()) {
    throw new NotFoundError('Credential has expired');
  }

  return decrypt({
    encryptedBlob: Buffer.from(credential.encryptedBlob),
    encryptedDek: Buffer.from(credential.encryptedDek),
    iv: Buffer.from(credential.iv),
    authTag: Buffer.from(credential.authTag),
  });
}
