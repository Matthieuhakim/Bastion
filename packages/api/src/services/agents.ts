import type { Agent } from '@prisma/client';
import { prisma } from './db.js';
import { generateApiSecret, generateKeypair, hashApiKey } from './crypto.js';
import { NotFoundError } from '../errors.js';

export interface CreateAgentInput {
  name: string;
  description?: string;
  callbackUrl?: string;
}

export interface UpdateAgentInput {
  name?: string;
  description?: string;
  callbackUrl?: string;
  isActive?: boolean;
}

export async function createAgent(
  input: CreateAgentInput,
): Promise<{ agent: Agent; agentSecret: string }> {
  const agentSecret = generateApiSecret();
  const apiKeyHash = hashApiKey(agentSecret);
  const keypair = await generateKeypair();

  const agent = await prisma.agent.create({
    data: {
      name: input.name,
      description: input.description,
      callbackUrl: input.callbackUrl,
      apiKeyHash,
      publicKey: keypair.publicKey,
      keyFingerprint: keypair.fingerprint,
      encryptedPrivateKey: keypair.privateKey,
    },
  });

  return { agent, agentSecret };
}

export async function listAgents(): Promise<Agent[]> {
  return prisma.agent.findMany({ orderBy: { createdAt: 'desc' } });
}

export async function getAgent(id: string): Promise<Agent> {
  const agent = await prisma.agent.findUnique({ where: { id } });
  if (!agent) {
    throw new NotFoundError('Agent not found');
  }
  return agent;
}

export async function updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
  await getAgent(id);
  return prisma.agent.update({
    where: { id },
    data: input,
  });
}

export async function deleteAgent(id: string): Promise<Agent> {
  await getAgent(id);
  return prisma.agent.update({
    where: { id },
    data: { isActive: false },
  });
}

export async function findAgentBySecret(secret: string): Promise<Agent | null> {
  const apiKeyHash = hashApiKey(secret);
  return prisma.agent.findUnique({ where: { apiKeyHash } });
}
