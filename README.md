# Bastion

**The trust proxy for AI agents.** Bastion sits between your AI agents and the APIs they call — holding credentials, enforcing policies, and logging every decision.

> Your agent needs a Stripe key to process refunds. But a raw API key means it could charge $1M or delete every customer. Bastion gives agents access to APIs without giving them the keys.

## How It Works

```text
┌─────────────┐         ┌──────────────────────────────┐         ┌──────────────┐
│             │         │           Bastion             │         │              │
│  Your Agent │──req──▶ │  policy ─▶ decrypt ─▶ inject  │──req──▶ │ External API │
│             │◀─res──  │         ◀── response ◀──      │◀─res──  │ (Stripe etc) │
└─────────────┘         └──────────────────────────────┘         └──────────────┘
                            ▲             ▲
                        credential     policy rules
                        vault          (ABAC)
```

1. Your agent sends a request to Bastion: *"I want to charge $50 using credential X"*
2. Bastion checks the policy — is this agent allowed to do this, at this amount, at this time?
3. If **ALLOW**: Bastion decrypts the credential from the vault, injects it into the request, calls the external API, and returns the result
4. If **DENY**: the agent gets a 403 with the reason
5. If **ESCALATE**: the request is paused for human approval (coming soon)

The agent never sees the raw API key. Bastion handles it server-side and zeroes it from memory after use.

## Quickstart

### 1. Start Bastion

```bash
git clone https://github.com/Matthieuhakim/Bastion.git
cd Bastion
npm install

# Start PostgreSQL and Redis
docker compose up -d

# Configure environment
cp packages/api/.env.example packages/api/.env
# Edit .env: set MASTER_KEY (64 hex chars) and PROJECT_API_KEY (your admin key)

# Run migrations and start the server
npm run db:migrate
npm run dev
```

Bastion is now running at `http://localhost:3000`.

### 2. Set up an agent, credential, and policy

Use your `PROJECT_API_KEY` to manage Bastion (replace `$ADMIN_KEY` below):

```bash
# Register an agent
curl -s -X POST http://localhost:3000/v1/agents \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Support Bot"}' | jq

# Save the agentSecret from the response — it's shown only once.
```

```bash
# Store an API key in the vault (it gets encrypted at rest)
curl -s -X POST http://localhost:3000/v1/credentials \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Stripe Production",
    "type": "API_KEY",
    "value": "sk_live_your_stripe_key",
    "agentId": "<agent_id>"
  }' | jq
```

```bash
# Create a policy: allow charges, block transfers, require approval above $500
curl -s -X POST http://localhost:3000/v1/policies \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "<agent_id>",
    "credentialId": "<credential_id>",
    "allowedActions": ["charges.*"],
    "deniedActions": ["transfers.*"],
    "constraints": {
      "maxAmountPerTransaction": 1000,
      "maxDailySpend": 5000,
      "rateLimit": {"maxRequests": 100, "windowSeconds": 3600}
    },
    "requiresApprovalAbove": 500
  }' | jq
```

### 3. Integrate your agent

Your agent authenticates with its own secret and calls `POST /v1/proxy/execute`. Here's all it takes:

**Using fetch / any HTTP client:**

```typescript
const response = await fetch('http://localhost:3000/v1/proxy/execute', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${agentSecret}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    credentialId: '<credential_id>',
    action: 'charges.create',
    params: { amount: 50 },
    target: {
      url: 'https://api.stripe.com/v1/charges',
      method: 'POST',
      body: { amount: 5000, currency: 'usd' },
    },
  }),
});

const result = await response.json();
// result.upstream.status  → 200
// result.upstream.body    → Stripe's response
// result.meta.policyDecision → "ALLOW"
```

**Using curl:**

```bash
curl -X POST http://localhost:3000/v1/proxy/execute \
  -H "Authorization: Bearer <agent_secret>" \
  -H "Content-Type: application/json" \
  -d '{
    "credentialId": "<credential_id>",
    "action": "charges.create",
    "params": {"amount": 50},
    "target": {
      "url": "https://api.stripe.com/v1/charges",
      "method": "POST",
      "body": {"amount": 5000, "currency": "usd"}
    }
  }'
```

The request body has three parts:

- **`credentialId`** — which vault credential to use (the agent never sees the raw key)
- **`action`** + **`params`** — what the agent wants to do, evaluated against the policy
- **`target`** — the external API call Bastion will make on the agent's behalf

### Credential injection

By default, `API_KEY` and `OAUTH2` credentials are injected as `Authorization: Bearer <key>`. You can override this:

```json
{
  "injection": { "location": "header", "key": "X-Api-Key" }
}
```

Options: `header`, `query` (appends to URL), or `body` (adds a field to the request body).

## Features

**Credential Vault** — Envelope encryption (AES-256-GCM + HKDF). Each credential gets its own data encryption key. Raw values are never returned over the API or stored in logs.

**Policy Engine (ABAC)** — Fine-grained rules per agent and credential:

- Allowed/denied actions with wildcard matching (`charges.*`)
- Amount limits (per-transaction and daily spend)
- Rate limiting (Redis-backed)
- Time windows (timezone-aware)
- IP allowlists
- Approval thresholds (triggers ESCALATE)

**Proxy Mode** — The core flow: authenticate agent, evaluate policy, decrypt credential, inject it into the outbound request, call the external API, return the result. Includes SSRF protection (blocks localhost, cloud metadata endpoints).

**Fail closed** — No policy for an agent+credential pair = DENY. Bastion never silently allows a request.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the full plan. Coming next:

- **Human-in-the-Loop Gate** — pause ESCALATE requests, notify via Slack/webhook, approve or deny
- **Signed Audit Chain** — Ed25519-signed, SHA-256 hash-chained records for every decision
- **SDKs** — full TypeScript and Python client libraries
- **Dashboard** — web UI for monitoring agents, approving requests, viewing audit logs

## Project Structure

```text
packages/
  api/          Express 5 + TypeScript API server (the core)
  sdk-node/     TypeScript SDK (zero runtime deps)
  sdk-python/   Python SDK (httpx)
```

## Development

```bash
npm run dev              # Start API server (watch mode)
npm run build            # Build all packages
npm run lint             # ESLint
npm test                 # Unit tests (no DB needed)
npm run test:integration # Integration tests (needs Docker)
npm run db:migrate       # Run Prisma migrations
npm run db:studio        # Open Prisma Studio
```

## Tech Stack

| Component  | Technology                     |
| ---------- | ------------------------------ |
| API server | Express 5, TypeScript, Node 22 |
| Database   | PostgreSQL 17                  |
| Cache      | Redis 7                        |
| ORM        | Prisma 6                       |
| Encryption | AES-256-GCM, Ed25519           |

## License

[MIT](LICENSE)
