// ── Health ──────────────────────────────────────────────────────────────────

export interface HealthResponse {
  status: string;
  timestamp: string;
  version: string;
}

// ── Agents ─────────────────────────────────────────────────────────────────

export interface Agent {
  id: string;
  name: string;
  description: string | null;
  callbackUrl: string | null;
  publicKey: string;
  keyFingerprint: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentWithSecret extends Agent {
  agentSecret: string;
}

export interface CreateAgentInput {
  name: string;
  description?: string;
  callbackUrl?: string;
}

export interface UpdateAgentInput {
  name?: string;
  description?: string;
  callbackUrl?: string;
  isActive?: boolean;
}

// ── Credentials ────────────────────────────────────────────────────────────

export type CredentialType = 'API_KEY' | 'OAUTH2' | 'CUSTOM';

export interface Credential {
  id: string;
  name: string;
  type: CredentialType;
  agentId: string;
  metadata: Record<string, unknown> | null;
  scopes: string[];
  expiresAt: string | null;
  isRevoked: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCredentialInput {
  name: string;
  type: CredentialType;
  value: string;
  agentId: string;
  metadata?: Record<string, unknown>;
  scopes?: string[];
  expiresAt?: string;
}

// ── Policies ───────────────────────────────────────────────────────────────

export interface TimeWindow {
  days: string[];
  hours: { start: string; end: string };
  timezone: string;
}

export interface RateLimit {
  maxRequests: number;
  windowSeconds: number;
}

export interface IntentReviewConstraint {
  enabled: boolean;
  mode?: 'escalate_on_risk';
  instructions?: string;
}

export interface PolicyConstraints {
  maxAmountPerTransaction?: number;
  maxDailySpend?: number;
  timeWindow?: TimeWindow;
  rateLimit?: RateLimit;
  ipAllowlist?: string[];
  intentReview?: IntentReviewConstraint;
}

export interface Policy {
  id: string;
  agentId: string;
  credentialId: string;
  allowedActions: string[];
  deniedActions: string[];
  constraints: PolicyConstraints | null;
  requiresApprovalAbove: number | null;
  expiresAt: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePolicyInput {
  agentId: string;
  credentialId: string;
  allowedActions?: string[];
  deniedActions?: string[];
  constraints?: PolicyConstraints;
  requiresApprovalAbove?: number;
  expiresAt?: string;
}

export interface UpdatePolicyInput {
  allowedActions?: string[] | null;
  deniedActions?: string[] | null;
  constraints?: PolicyConstraints | null;
  requiresApprovalAbove?: number | null;
  expiresAt?: string | null;
  isActive?: boolean;
}

export type PolicyDecision = 'ALLOW' | 'DENY' | 'ESCALATE';

export interface PolicyEvaluateInput {
  agentId: string;
  credentialId: string;
  action: string;
  params?: { amount?: number; ip?: string };
}

export interface PolicyEvaluateResult {
  decision: PolicyDecision;
  policyId: string | null;
  reason: string;
}

// ── Proxy ──────────────────────────────────────────────────────────────────

export interface ProxyTarget {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface InjectionConfig {
  location: 'header' | 'query' | 'body';
  key: string;
}

export interface ProxyExecuteInput {
  credentialId: string;
  action: string;
  params?: { amount?: number; ip?: string };
  target: ProxyTarget;
  injection?: InjectionConfig;
  timeout?: number;
}

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface ProxyMeta {
  credentialId: string;
  action: string;
  policyDecision: 'ALLOW';
  policyId: string | null;
  durationMs: number;
  hitlRequestId?: string;
}

export interface ProxyExecuteResult {
  upstream: UpstreamResponse;
  meta: ProxyMeta;
}

export interface ProxyFetchInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  params?: { amount?: number; ip?: string };
  action?: string;
  credentialId?: string;
  injection?: InjectionConfig;
  timeout?: number;
}

// ── HITL ───────────────────────────────────────────────────────────────────

export interface IntentJudgeVerdict {
  decision: 'SAFE' | 'NEEDS_APPROVAL';
  riskLevel: 'low' | 'medium' | 'high';
  confidence: number;
  reasons: string[];
  provider: string;
  model: string;
  promptVersion: string;
}

export interface PendingRequest {
  requestId: string;
  status: 'pending' | 'approved' | 'denied';
  agentId: string;
  credentialId: string;
  action: string;
  params: { amount?: number; ip?: string };
  target: ProxyTarget;
  injection?: InjectionConfig;
  timeout?: number;
  policyId: string | null;
  reason: string;
  intentReview?: IntentJudgeVerdict;
  createdAt: string;
  resolvedBy?: string;
  denialReason?: string;
}

export interface HitlResolution {
  requestId: string;
  status: 'approved' | 'denied';
  message: string;
}

// ── Audit ──────────────────────────────────────────────────────────────────

export interface AuditRecordDocument {
  agentId: string;
  action: string;
  targetUrl: string;
  targetMethod: string;
  credentialId: string;
  policyDecision: PolicyDecision;
  policyId: string | null;
  reason: string;
  params: { amount?: number; ip?: string };
  durationMs: number;
  previousHash: string;
  timestamp: string;
  hitlRequestId?: string;
  intentReview?: IntentJudgeVerdict;
  upstreamStatus?: number;
  outcome?: string;
  error?: string;
}

export interface AuditRecord {
  id: string;
  agentId: string;
  recordJson: AuditRecordDocument;
  recordHash: string;
  signature: string;
  signerKeyFingerprint: string;
  previousHash: string;
  createdAt: string;
}

export interface AuditQueryParams {
  agentId: string;
  from?: string;
  to?: string;
  action?: string;
  policyDecision?: PolicyDecision;
  cursor?: string;
  limit?: number;
}

export interface AuditQueryResult {
  records: AuditRecord[];
  nextCursor: string | null;
}

export interface VerifyChainResult {
  valid: boolean;
  recordCount: number;
  firstRecord: string | null;
  lastRecord: string | null;
  brokenAt?: string;
  reason?: string;
}
