import type {
  Agent,
  Credential,
  HitlRequest,
  AuditQueryParams,
  AuditQueryResult,
  VerifyChainResult,
  HealthResponse,
} from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class BastionApiClient {
  constructor(private apiKey: string) {}

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        ...options?.headers,
      },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(
        res.status,
        (body as { error?: { message?: string } }).error?.message ?? 'Request failed',
      );
    }
    return res.json() as Promise<T>;
  }

  // Health
  checkHealth() {
    return this.request<HealthResponse>('/health');
  }

  // Agents
  listAgents() {
    return this.request<Agent[]>('/v1/agents');
  }

  getAgent(id: string) {
    return this.request<Agent>(`/v1/agents/${id}`);
  }

  toggleAgent(id: string, isActive: boolean) {
    return this.request<Agent>(`/v1/agents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive }),
    });
  }

  // Credentials
  listCredentials(agentId?: string) {
    const params = agentId ? `?agentId=${agentId}` : '';
    return this.request<Credential[]>(`/v1/credentials${params}`);
  }

  revokeCredential(id: string) {
    return this.request<{ id: string; isRevoked: boolean }>(`/v1/credentials/${id}`, {
      method: 'DELETE',
    });
  }

  // HITL
  listPending() {
    return this.request<HitlRequest[]>('/v1/hitl/pending');
  }

  getPendingRequest(requestId: string) {
    return this.request<HitlRequest>(`/v1/hitl/${requestId}`);
  }

  approve(requestId: string) {
    return this.request<{ requestId: string; status: string; message: string }>(
      `/v1/hitl/${requestId}/approve`,
      { method: 'POST' },
    );
  }

  deny(requestId: string, reason?: string) {
    return this.request<{ requestId: string; status: string; message: string }>(
      `/v1/hitl/${requestId}/deny`,
      {
        method: 'POST',
        body: JSON.stringify({ reason }),
      },
    );
  }

  // Audit
  queryAudit(params: AuditQueryParams) {
    const searchParams = new URLSearchParams();
    searchParams.set('agentId', params.agentId);
    if (params.from) searchParams.set('from', params.from);
    if (params.to) searchParams.set('to', params.to);
    if (params.action) searchParams.set('action', params.action);
    if (params.policyDecision) searchParams.set('policyDecision', params.policyDecision);
    if (params.cursor) searchParams.set('cursor', params.cursor);
    if (params.limit) searchParams.set('limit', String(params.limit));
    return this.request<AuditQueryResult>(`/v1/audit?${searchParams.toString()}`);
  }

  verifyChain(agentId: string) {
    return this.request<VerifyChainResult>(`/v1/audit/verify?agentId=${agentId}`);
  }
}
