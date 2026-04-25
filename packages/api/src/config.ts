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
  intentJudge: IntentJudgeConfig;
}

interface IntentJudgeConfig {
  enabled: boolean;
  provider: 'openai';
  model: string;
  apiKey: string;
  endpoint: string;
  timeoutMs: number;
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

function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return defaultValue;
  }
  if (value === 'true' || value === '1') {
    return true;
  }
  if (value === 'false' || value === '0') {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

function parsePositiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return defaultValue;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseIntentJudgeConfig(): IntentJudgeConfig {
  const enabled = parseBooleanEnv('INTENT_JUDGE_ENABLED', false);
  const rawProvider = process.env['INTENT_JUDGE_PROVIDER']?.trim() || 'openai';
  if (rawProvider !== 'openai') {
    throw new Error('INTENT_JUDGE_PROVIDER must be openai');
  }

  const apiKey = process.env['INTENT_JUDGE_API_KEY']?.trim() ?? '';
  if (enabled && !apiKey) {
    throw new Error('INTENT_JUDGE_API_KEY is required when INTENT_JUDGE_ENABLED=true');
  }

  const endpoint =
    process.env['INTENT_JUDGE_ENDPOINT']?.trim() ||
    'https://api.openai.com/v1/chat/completions';

  return {
    enabled,
    provider: rawProvider,
    model: process.env['INTENT_JUDGE_MODEL']?.trim() || 'gpt-4o-mini',
    apiKey,
    endpoint: parseUrl(endpoint, 'INTENT_JUDGE_ENDPOINT').toString(),
    timeoutMs: parsePositiveIntEnv('INTENT_JUDGE_TIMEOUT_MS', 10_000),
  };
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
  intentJudge: parseIntentJudgeConfig(),
};
