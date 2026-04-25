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
  agentSecret?: string; // only returned on create
}

export interface Credential {
  id: string;
  name: string;
  type: 'API_KEY' | 'OAUTH2' | 'CUSTOM';
  agentId: string;
  metadata: Record<string, unknown> | null;
  scopes: string[];
  expiresAt: string | null;
  isRevoked: boolean;
  createdAt: string;
  updatedAt: string;
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

export interface PolicyConstraints {
  maxAmountPerTransaction?: number;
  maxDailySpend?: number;
  timeWindow?: {
    days: string[];
    hours: { start: string; end: string };
    timezone: string;
  };
  rateLimit?: {
    maxRequests: number;
    windowSeconds: number;
  };
  ipAllowlist?: string[];
  intentReview?: {
    enabled: boolean;
    mode?: 'escalate_on_risk';
    instructions?: string;
  };
}

export interface IntentJudgeVerdict {
  decision: 'SAFE' | 'NEEDS_APPROVAL';
  riskLevel: 'low' | 'medium' | 'high';
  confidence: number;
  reasons: string[];
  provider: string;
  model: string;
  promptVersion: string;
}

export interface HitlRequest {
  requestId: string;
  status: 'pending' | 'approved' | 'denied';
  agentId: string;
  credentialId: string;
  action: string;
  params: { amount?: number; ip?: string };
  target: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: unknown;
  };
  injection?: { location: string; key: string };
  timeout?: number;
  policyId: string | null;
  reason: string;
  intentReview?: IntentJudgeVerdict;
  createdAt: string;
  resolvedBy?: string;
  denialReason?: string;
}

export interface AuditRecordDocument {
  agentId: string;
  action: string;
  targetUrl: string;
  targetMethod: string;
  credentialId: string;
  policyDecision: 'ALLOW' | 'DENY' | 'ESCALATE';
  policyId: string | null;
  reason: string;
  params: { amount?: number; ip?: string };
  durationMs: number;
  previousHash: string;
  timestamp: string;
  hitlRequestId?: string;
  intentReview?: IntentJudgeVerdict;
  upstreamStatus?: number;
  outcome?: 'executed' | 'denied' | 'failed';
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
  policyDecision?: 'ALLOW' | 'DENY' | 'ESCALATE';
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

export interface HealthResponse {
  status: string;
  timestamp: string;
  version: string;
}
