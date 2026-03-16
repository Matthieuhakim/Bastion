import { Redis } from 'ioredis';
import { config } from '../config.js';

const globalForRedis = globalThis as unknown as { redis: Redis | undefined };

export const redis = globalForRedis.redis ?? new Redis(config.redisUrl);

if (process.env['NODE_ENV'] !== 'production') {
  globalForRedis.redis = redis;
}

// Lua script: atomically increment and set TTL only on first increment
const RATE_LIMIT_SCRIPT = `
  local current = redis.call('INCR', KEYS[1])
  if current == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
  end
  return current
`;

export async function incrementRateLimit(policyId: string, windowSeconds: number): Promise<number> {
  const windowStart = Math.floor(Date.now() / (windowSeconds * 1000));
  const key = `rate:${policyId}:${windowStart}`;
  const result = await redis.eval(RATE_LIMIT_SCRIPT, 1, key, windowSeconds);
  return result as number;
}

export async function getRateLimitCount(policyId: string, windowSeconds: number): Promise<number> {
  const windowStart = Math.floor(Date.now() / (windowSeconds * 1000));
  const key = `rate:${policyId}:${windowStart}`;
  const val = await redis.get(key);
  return val ? parseInt(val, 10) : 0;
}

export async function incrementDailySpend(
  policyId: string,
  amount: number,
  dateKey: string,
): Promise<number> {
  const key = `spend:${policyId}:${dateKey}`;
  const newTotalStr = await redis.incrbyfloat(key, amount);
  const ttl = await redis.ttl(key);
  if (ttl === -1) {
    await redis.expire(key, 172800); // 48h buffer for timezone edge cases
  }
  return parseFloat(newTotalStr);
}

export async function getDailySpend(policyId: string, dateKey: string): Promise<number> {
  const key = `spend:${policyId}:${dateKey}`;
  const val = await redis.get(key);
  return val ? parseFloat(val) : 0;
}

export function createSubscriberConnection(): Redis {
  return new Redis(config.redisUrl);
}
