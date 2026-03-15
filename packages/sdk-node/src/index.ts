export interface BastionClientConfig {
  baseUrl: string;
  apiKey: string;
}

export class BastionClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(config: BastionClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
  }

  async health(): Promise<{ status: string; timestamp: string; version: string }> {
    const res = await fetch(`${this.baseUrl}/health`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`Health check failed: ${res.status}`);
    }
    return res.json() as Promise<{ status: string; timestamp: string; version: string }>;
  }
}
