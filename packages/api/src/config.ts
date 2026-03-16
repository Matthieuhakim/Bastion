import 'dotenv/config';

interface Config {
  port: number;
  nodeEnv: string;
  databaseUrl: string;
  redisUrl: string;
  masterKey: string;
  projectApiKey: string;
  baseUrl: string;
  corsOrigins: string | string[];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseUrl(value: string, name: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
}

function parseMasterKey(value: string): string {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error('MASTER_KEY must be a 64-character hex string');
  }
  return value;
}

function parseCorsOrigins(nodeEnv: string, baseUrl: string): string | string[] {
  const rawOrigins = process.env['CORS_ORIGINS']?.trim();
  if (!rawOrigins) {
    if (nodeEnv === 'production') {
      return parseUrl(baseUrl, 'BASE_URL').origin;
    }
    return '*';
  }

  const origins = rawOrigins
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (origins.length === 0) {
    throw new Error('CORS_ORIGINS must contain at least one origin');
  }

  if (origins.includes('*')) {
    return '*';
  }

  return origins.map((origin) => parseUrl(origin, 'CORS_ORIGINS').origin);
}

const port = parseInt(process.env['PORT'] ?? '3000', 10);
const nodeEnv = process.env['NODE_ENV'] ?? 'development';
const baseUrl = process.env['BASE_URL']?.trim() || `http://localhost:${port}`;
const normalizedBaseUrl = parseUrl(baseUrl, 'BASE_URL');

if (nodeEnv === 'production' && normalizedBaseUrl.hostname === 'localhost') {
  process.emitWarning('BASE_URL points to localhost while NODE_ENV=production');
}

export const config: Config = {
  port,
  nodeEnv,
  databaseUrl: requireEnv('DATABASE_URL'),
  redisUrl: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
  masterKey: parseMasterKey(requireEnv('MASTER_KEY')),
  projectApiKey: requireEnv('PROJECT_API_KEY'),
  baseUrl: normalizedBaseUrl.toString(),
  corsOrigins: parseCorsOrigins(nodeEnv, normalizedBaseUrl.toString()),
};
