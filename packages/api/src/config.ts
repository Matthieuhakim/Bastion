import 'dotenv/config';

interface Config {
  port: number;
  nodeEnv: string;
  databaseUrl: string;
  redisUrl: string;
  masterKey: string;
  projectApiKey: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config: Config = {
  port: parseInt(process.env['PORT'] ?? '3000', 10),
  nodeEnv: process.env['NODE_ENV'] ?? 'development',
  databaseUrl: requireEnv('DATABASE_URL'),
  redisUrl: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
  masterKey: process.env['MASTER_KEY'] ?? '',
  projectApiKey: requireEnv('PROJECT_API_KEY'),
};
