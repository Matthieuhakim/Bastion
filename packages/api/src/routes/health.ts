import { Router } from 'express';
import { prisma } from '../services/db.js';
import { redis } from '../services/redis.js';

export const healthRouter = Router();

healthRouter.get('/live', (_req, res) => {
  res.json({ status: 'ok' });
});

healthRouter.get('/', async (_req, res) => {
  const [databaseResult, redisResult] = await Promise.allSettled([
    prisma.$queryRaw`SELECT 1`,
    redis.ping(),
  ]);

  const checks = {
    database: databaseResult.status === 'fulfilled' ? 'ok' : 'error',
    redis: redisResult.status === 'fulfilled' ? 'ok' : 'error',
  };
  const status = checks.database === 'ok' && checks.redis === 'ok' ? 'ok' : 'degraded';

  res.status(status === 'ok' ? 200 : 503).json({
    status,
    checks,
    timestamp: new Date().toISOString(),
    version: process.env['npm_package_version'] ?? '0.1.0',
  });
});
