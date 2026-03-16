const API_BASE = 'http://localhost:3000';
const ADMIN_KEY = 'test-admin-key-change-me';

export { ADMIN_KEY };

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ADMIN_KEY}`,
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${options?.method ?? 'GET'} ${path} failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<T>;
}

interface Agent {
  id: string;
  name: string;
  agentSecret?: string;
  isActive: boolean;
}

interface Credential {
  id: string;
  name: string;
}

interface Policy {
  id: string;
}

export interface TestData {
  agent: Agent;
  agentSecret: string;
  credential: Credential;
  policy: Policy;
}

export async function seedTestData(): Promise<TestData> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Create an agent
  const agent = await apiRequest<Agent>('/v1/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: `E2E Agent ${suffix}`,
      description: 'Created by Playwright E2E tests',
      callbackUrl: 'https://example.com/webhook',
    }),
  });

  const agentSecret = agent.agentSecret!;

  // Store a credential
  const credential = await apiRequest<Credential>('/v1/credentials', {
    method: 'POST',
    body: JSON.stringify({
      name: `E2E Credential ${suffix}`,
      type: 'API_KEY',
      value: 'sk_test_e2e_fake_key_1234567890',
      agentId: agent.id,
    }),
  });

  // Create a policy with an approval threshold to enable HITL testing
  const policy = await apiRequest<Policy>('/v1/policies', {
    method: 'POST',
    body: JSON.stringify({
      agentId: agent.id,
      credentialId: credential.id,
      allowedActions: ['charges.*', 'test.*'],
      deniedActions: ['transfers.*'],
      constraints: {
        maxAmountPerTransaction: 10000,
        rateLimit: { maxRequests: 1000, windowSeconds: 3600 },
      },
      requiresApprovalAbove: 500,
    }),
  });

  return { agent, agentSecret, credential, policy };
}

export async function triggerEscalation(agentSecret: string, credentialId: string): Promise<void> {
  // Fire-and-forget a proxy request that will escalate (amount > 500)
  // This will block waiting for HITL approval, so we don't await the response
  fetch(`${API_BASE}/v1/proxy/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${agentSecret}`,
    },
    body: JSON.stringify({
      credentialId,
      action: 'charges.create',
      params: { amount: 1000 },
      target: {
        url: 'https://httpbin.org/post',
        method: 'POST',
        body: { amount: 1000 },
      },
    }),
  }).catch(() => {
    // Expected — this will either hang waiting for HITL or fail on timeout
  });
}

export async function triggerAllowedRequest(
  agentSecret: string,
  credentialId: string,
): Promise<void> {
  // Make a proxy request that will be ALLOWED (amount < 500 threshold)
  await fetch(`${API_BASE}/v1/proxy/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${agentSecret}`,
    },
    body: JSON.stringify({
      credentialId,
      action: 'test.read',
      params: { amount: 10 },
      target: {
        url: 'https://httpbin.org/get',
        method: 'GET',
      },
    }),
  });
}
