# @bastion-ai/sdk

TypeScript SDK for the [Bastion](../../README.md) trust proxy. Zero runtime dependencies — uses the global `fetch` API.

## Installation

```bash
npm install @bastion-ai/sdk
```

Requires Node.js 22+ (for native `fetch`).

## Quick Start

```typescript
import { BastionClient } from '@bastion-ai/sdk';

const client = new BastionClient({
  baseUrl: 'http://localhost:3000',
  apiKey: process.env.PROJECT_API_KEY!, // admin key for management
});

// Check health
const health = await client.health();
```

## Admin Operations

Use the admin API key (`PROJECT_API_KEY`) to manage agents, credentials, and policies.

### Agents

```typescript
// Create an agent (returns one-time agentSecret)
const { id, agentSecret } = await client.createAgent({
  name: 'Support Bot',
  description: 'Handles refund requests',
  callbackUrl: 'https://example.com/webhook',
});

// List, get, update, delete
const agents = await client.listAgents();
const agent = await client.getAgent(id);
await client.updateAgent(id, { isActive: false });
await client.deleteAgent(id); // soft-delete
```

### Credentials

```typescript
// Store a credential (encrypted at rest, raw value never returned)
const credential = await client.createCredential({
  name: 'Stripe Production',
  type: 'API_KEY',
  value: 'sk_live_...',
  agentId: agent.id,
});

const credentials = await client.listCredentials(agent.id);
await client.revokeCredential(credential.id);
```

### Policies

```typescript
const policy = await client.createPolicy({
  agentId: agent.id,
  credentialId: credential.id,
  allowedActions: ['charges.*'],
  deniedActions: ['transfers.*'],
  constraints: {
    maxAmountPerTransaction: 1000,
    maxDailySpend: 5000,
    rateLimit: { maxRequests: 100, windowSeconds: 3600 },
  },
  requiresApprovalAbove: 500,
});

// Dry-run evaluation (no side effects)
const result = await client.evaluatePolicy({
  agentId: agent.id,
  credentialId: credential.id,
  action: 'charges.create',
  params: { amount: 750 },
});
// result.decision → "ESCALATE"
```

## Agent Operations

Use an agent secret (`bst_...`) for proxy execution.

```typescript
const agentClient = new BastionClient({
  baseUrl: 'http://localhost:3000',
  apiKey: agentSecret, // agent secret from createAgent
});

const result = await agentClient.execute({
  credentialId: credential.id,
  action: 'charges.create',
  params: { amount: 50 },
  target: {
    url: 'https://api.stripe.com/v1/charges',
    method: 'POST',
    body: { amount: 5000, currency: 'usd' },
  },
});

// result.upstream.status → 200
// result.upstream.body → Stripe's response
// result.meta.policyDecision → "ALLOW"
```

### Custom Credential Injection

```typescript
await agentClient.execute({
  credentialId: credential.id,
  action: 'test',
  target: { url: 'https://api.example.com' },
  injection: { location: 'header', key: 'X-Api-Key' },
});
```

## HITL (Human-in-the-Loop)

```typescript
const pending = await client.listPendingRequests();
await client.approveRequest(pending[0].requestId);
await client.denyRequest(requestId, 'Too risky');
```

## Audit

```typescript
const records = await client.queryAuditRecords({
  agentId: agent.id,
  from: '2026-01-01',
  policyDecision: 'DENY',
  limit: 10,
});

const verification = await client.verifyChain(agent.id);
// verification.valid → true
```

## Error Handling

All API errors throw typed exceptions:

```typescript
import { BastionForbiddenError, BastionNotFoundError } from '@bastion-ai/sdk';

try {
  await agentClient.execute({ ... });
} catch (err) {
  if (err instanceof BastionForbiddenError) {
    console.log('Policy denied:', err.message);
  }
}
```

| Error Class | Status | When |
| ------------ | ------ | ---- |
| `BastionValidationError` | 400 | Invalid input |
| `BastionUnauthorizedError` | 401 | Bad or missing auth |
| `BastionForbiddenError` | 403 | Policy DENY or HITL timeout |
| `BastionNotFoundError` | 404 | Resource not found |
| `BastionConflictError` | 409 | State conflict |
| `BastionBadGatewayError` | 502 | Upstream API failure |

## License

[MIT](../../LICENSE)
