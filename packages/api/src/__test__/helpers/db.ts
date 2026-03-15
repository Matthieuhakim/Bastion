import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function cleanDatabase(): Promise<void> {
  await prisma.agent.deleteMany();
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

export { prisma as testPrisma };
