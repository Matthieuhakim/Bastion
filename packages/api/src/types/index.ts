export interface HealthResponse {
  status: 'ok' | 'degraded';
  timestamp: string;
  version: string;
}
