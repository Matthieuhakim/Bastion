import type { AddressInfo } from 'node:net';
import { createApp } from './app.js';
import { config } from './config.js';
import { prisma } from './services/db.js';
import { logger } from './services/logger.js';
import { redis } from './services/redis.js';

const app = createApp();
const shutdownTimeoutMs = 10_000;
let isShuttingDown = false;

const server = app.listen(config.port, '0.0.0.0', () => {
  const address = server.address() as AddressInfo | null;
  const port = address?.port ?? config.port;
  logger.info('Bastion API started', { port, nodeEnv: config.nodeEnv });
});

// HITL long-poll requests can block up to 15 minutes; extend Node's default 5-min timeout
server.requestTimeout = 16 * 60 * 1000;

async function closeServerWithinTimeout(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      server.closeAllConnections();
      finish(false);
    }, timeoutMs);
    timeout.unref();

    server.close((error) => {
      if (error) {
        clearTimeout(timeout);
        settled = true;
        reject(error);
        return;
      }
      finish(true);
    });

    server.closeIdleConnections();
  });
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  logger.info('Received shutdown signal', { signal });

  try {
    const drainedGracefully = await closeServerWithinTimeout(shutdownTimeoutMs);

    if (!drainedGracefully) {
      logger.warn('Server did not drain within timeout; forcing shutdown', {
        timeoutMs: shutdownTimeoutMs,
      });
    }

    await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
    process.exit(0);
  } catch (error) {
    logger.error('Graceful shutdown failed', error instanceof Error ? error : { error });
    await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
