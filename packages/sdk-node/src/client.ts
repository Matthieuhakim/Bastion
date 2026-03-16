import { throwForStatus } from './errors.js';
import type {
  HealthResponse,
  Agent,
  AgentWithSecret,
  CreateAgentInput,
  UpdateAgentInput,
  Credential,
  CreateCredentialInput,
  Policy,
  CreatePolicyInput,
  UpdatePolicyInput,
  PolicyEvaluateInput,
  PolicyEvaluateResult,
  ProxyExecuteInput,
  ProxyExecuteResult,
  PendingRequest,
  HitlResolution,
  AuditQueryParams,
  AuditQueryResult,
  VerifyChainResult,
} from './types.js';

export interface BastionClientConfig {
  /** Base URL of the Bastion API server (e.g. "http://localhost:3000") */
  baseUrl: string;
  /** Admin API key (PROJECT_API_KEY) or agent secret (bst_...) */
  apiKey: string;
}

interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

export class BastionClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: BastionClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
  }

  private buildQuery(params: Record<string, string | number | undefined>): string {
    const entries = Object.entries(params).filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined,
    );
    if (entries.length === 0) return '';
    const qs = new URLSearchParams(entries.map(([k, v]) => [k, String(v)]));
    return `?${qs.toString()}`;
  }

  private async request<T>(method: string, path: string, options?: RequestOptions): Promise<T> {
    const query = options?.query ? this.buildQuery(options.query) : '';
    const url = `${this.baseUrl}${path}${query}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (options?.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, {
      method,
      headers,
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    const body = (await res.json()) as T & { message?: string };

    if (!res.ok) {
      throwForStatus(res.status, { message: body?.message ?? res.statusText });
    }

    return body;
  }

  // ── Health ──────────────────────────────────────────────────────────────

  /** Check API server health. Works with any auth type. */
  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('GET', '/health');
  }

  // ── Agents (admin) ──────────────────────────────────────────────────────

  /** Create a new agent. Returns the agent with a one-time `agentSecret`. */
  async createAgent(input: CreateAgentInput): Promise<AgentWithSecret> {
    return this.request<AgentWithSecret>('POST', '/v1/agents', { body: input });
  }

  /** List all agents. */
  async listAgents(): Promise<Agent[]> {
    return this.request<Agent[]>('GET', '/v1/agents');
  }

  /** Get a single agent by ID. */
  async getAgent(id: string): Promise<Agent> {
    return this.request<Agent>('GET', `/v1/agents/${id}`);
  }

  /** Update an agent's name, description, callbackUrl, or isActive flag. */
  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    return this.request<Agent>('PATCH', `/v1/agents/${id}`, { body: input });
  }

  /** Soft-delete an agent (sets isActive to false). */
  async deleteAgent(id: string): Promise<{ id: string; isActive: boolean }> {
    return this.request<{ id: string; isActive: boolean }>('DELETE', `/v1/agents/${id}`);
  }

  // ── Credentials (admin) ─────────────────────────────────────────────────

  /** Store a new credential (encrypted at rest). The raw value is never returned. */
  async createCredential(input: CreateCredentialInput): Promise<Credential> {
    return this.request<Credential>('POST', '/v1/credentials', { body: input });
  }

  /** List credentials, optionally filtered by agentId. */
  async listCredentials(agentId?: string): Promise<Credential[]> {
    return this.request<Credential[]>('GET', '/v1/credentials', {
      query: { agentId },
    });
  }

  /** Get a single credential by ID (masked, no raw value). */
  async getCredential(id: string): Promise<Credential> {
    return this.request<Credential>('GET', `/v1/credentials/${id}`);
  }

  /** Revoke a credential (sets isRevoked to true). */
  async revokeCredential(id: string): Promise<{ id: string; isRevoked: boolean }> {
    return this.request<{ id: string; isRevoked: boolean }>('DELETE', `/v1/credentials/${id}`);
  }

  // ── Policies (admin) ────────────────────────────────────────────────────

  /** Create a new policy for an agent+credential pair. */
  async createPolicy(input: CreatePolicyInput): Promise<Policy> {
    return this.request<Policy>('POST', '/v1/policies', { body: input });
  }

  /** List policies, optionally filtered by agentId and/or credentialId. */
  async listPolicies(filters?: { agentId?: string; credentialId?: string }): Promise<Policy[]> {
    return this.request<Policy[]>('GET', '/v1/policies', {
      query: { agentId: filters?.agentId, credentialId: filters?.credentialId },
    });
  }

  /** Get a single policy by ID. */
  async getPolicy(id: string): Promise<Policy> {
    return this.request<Policy>('GET', `/v1/policies/${id}`);
  }

  /** Update a policy's rules, constraints, or status. */
  async updatePolicy(id: string, input: UpdatePolicyInput): Promise<Policy> {
    return this.request<Policy>('PATCH', `/v1/policies/${id}`, { body: input });
  }

  /** Deactivate a policy (sets isActive to false). */
  async deletePolicy(id: string): Promise<{ id: string; isActive: boolean }> {
    return this.request<{ id: string; isActive: boolean }>('DELETE', `/v1/policies/${id}`);
  }

  /** Dry-run policy evaluation without side effects. */
  async evaluatePolicy(input: PolicyEvaluateInput): Promise<PolicyEvaluateResult> {
    return this.request<PolicyEvaluateResult>('POST', '/v1/policies/evaluate', { body: input });
  }

  // ── Proxy (agent) ───────────────────────────────────────────────────────

  /**
   * Execute a proxied request. Bastion evaluates the policy, decrypts the
   * credential, injects it into the outbound request, and returns the upstream
   * response. If the policy evaluates to ESCALATE, the call blocks until a
   * human approves or denies (or it times out).
   */
  async execute(input: ProxyExecuteInput): Promise<ProxyExecuteResult> {
    return this.request<ProxyExecuteResult>('POST', '/v1/proxy/execute', { body: input });
  }

  // ── HITL (admin) ────────────────────────────────────────────────────────

  /** List all pending HITL requests. */
  async listPendingRequests(): Promise<PendingRequest[]> {
    return this.request<PendingRequest[]>('GET', '/v1/hitl/pending');
  }

  /** Get a single pending HITL request by ID. */
  async getPendingRequest(requestId: string): Promise<PendingRequest> {
    return this.request<PendingRequest>('GET', `/v1/hitl/${requestId}`);
  }

  /** Approve a pending HITL request, unblocking the agent's proxy call. */
  async approveRequest(requestId: string): Promise<HitlResolution> {
    return this.request<HitlResolution>('POST', `/v1/hitl/${requestId}/approve`);
  }

  /** Deny a pending HITL request with an optional reason. */
  async denyRequest(requestId: string, reason?: string): Promise<HitlResolution> {
    return this.request<HitlResolution>('POST', `/v1/hitl/${requestId}/deny`, {
      body: reason !== undefined ? { reason } : undefined,
    });
  }

  // ── Audit (admin) ───────────────────────────────────────────────────────

  /** Query audit records for an agent with optional filters and pagination. */
  async queryAuditRecords(params: AuditQueryParams): Promise<AuditQueryResult> {
    return this.request<AuditQueryResult>('GET', '/v1/audit', {
      query: {
        agentId: params.agentId,
        from: params.from,
        to: params.to,
        action: params.action,
        policyDecision: params.policyDecision,
        cursor: params.cursor,
        limit: params.limit,
      },
    });
  }

  /** Verify the integrity of an agent's audit chain. */
  async verifyChain(agentId: string): Promise<VerifyChainResult> {
    return this.request<VerifyChainResult>('GET', '/v1/audit/verify', {
      query: { agentId },
    });
  }
}
