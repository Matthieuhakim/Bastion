import type { Agent } from '@prisma/client';

export interface HealthResponse {
  status: 'ok' | 'degraded';
  timestamp: string;
  version: string;
}

export type AuthenticatedAgent = Omit<Agent, 'apiKeyHash'>;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      agent?: AuthenticatedAgent;
    }
  }
}
