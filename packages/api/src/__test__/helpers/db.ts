import { PrismaClient } from '@prisma/client';
import { redis } from '../../services/redis.js';

const prisma = new PrismaClient();

export async function cleanDatabase(): Promise<void> {
  await prisma.auditRecord.deleteMany();
  await prisma.policy.deleteMany();
  await prisma.credential.deleteMany();
  await prisma.agent.deleteMany();
}

export async function cleanRedis(): Promise<void> {
  await redis.flushdb();
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  redis.disconnect();
}

export { prisma as testPrisma };
