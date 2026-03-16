# Bastion Implementation Roadmap

Step-by-step build order for the MVP. Each phase builds on the previous one. Check off items as they're completed.

---

## Phase 0: Project Scaffolding

- [x] Monorepo setup (npm workspaces)
- [x] Express 5 API server with health endpoint
- [x] Prisma schema with Agent model
- [x] Docker Compose (PostgreSQL + Redis)
- [x] TypeScript SDK stub (`packages/sdk-node`)
- [x] Python SDK stub (`packages/sdk-python`)
- [x] ESLint 9 + Prettier config
- [x] README with setup instructions

---

## Phase 1: Agent Registration + Auth

**Goal:** Agents can register, authenticate, and each gets an Ed25519 keypair for audit signing.

**Depends on:** Phase 0

### Steps

- [x] **1.1 Expand Prisma schema for agents**
  - Add fields: `description`, `callbackUrl`, `publicKey`, `keyFingerprint`, `encryptedPrivateKey`
  - `apiKey` becomes a hashed value (store hash, not plaintext)
  - Add `isActive` flag for kill switch

- [x] **1.2 Ed25519 keypair generation**
  - Install `@noble/ed25519` (modern, audited, fast)
  - Service: `generateKeypair()` → returns `{ publicKey, privateKey, fingerprint }`
  - Fingerprint = SHA-256 of public key, hex-encoded
  - Private key will be envelope-encrypted (Phase 2), stored as hex for now

- [x] **1.3 Agent registration endpoint**
  - `POST /v1/agents` — creates agent, generates keypair, returns `agent_id`, `agent_secret` (shown once), `public_key`, `key_fingerprint`
  - `GET /v1/agents` — list agents (masked secrets)
  - `GET /v1/agents/:id` — get single agent
  - `PATCH /v1/agents/:id` — update name/description/callbackUrl/isActive
  - `DELETE /v1/agents/:id` — soft delete (set isActive = false)

- [x] **1.4 Agent authentication middleware**
  - Agents authenticate via `Authorization: Bearer <agent_secret>`
  - Middleware: extract token → hash → look up in DB → attach `agent` to `req`
  - Protect all `/v1/*` routes except health

- [x] **1.5 Project-level API key auth (admin routes)**
  - Separate auth for the developer managing agents/credentials/policies
  - For MVP: a single project API key set via env var `PROJECT_API_KEY`
  - Admin middleware checks `Authorization: Bearer <project_key>`
  - Agent CRUD routes use admin auth; proxy routes use agent auth

### Key files to create/modify

- `packages/api/prisma/schema.prisma` — expand Agent model
- `packages/api/src/services/crypto.ts` — Ed25519 + hashing utilities
- `packages/api/src/services/agents.ts` — agent CRUD logic
- `packages/api/src/routes/agents.ts` — agent REST endpoints
- `packages/api/src/middleware/auth.ts` — agent + admin auth middleware

### Verification

```bash
# Register an agent
curl -X POST http://localhost:3000/v1/agents \
  -H "Authorization: Bearer $PROJECT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Test Agent", "description": "My first agent"}'
# Should return agent_id, agent_secret, public_key, key_fingerprint

# Authenticate as agent
curl http://localhost:3000/health \
  -H "Authorization: Bearer <agent_secret>"
```

---

## Phase 2: Credential Vault

**Goal:** Encrypted credential storage with envelope encryption. Agents never see raw secrets.

**Depends on:** Phase 1 (agents must exist to own credentials)

### Steps

- [x] **2.1 Envelope encryption service**
  - Master KEK: derived from `MASTER_KEY` env var using HKDF (SHA-256)
  - Per-credential DEK: random 32 bytes, AES-256-GCM
  - `encrypt(plaintext)` → `{ encryptedBlob, encryptedDek, iv, authTag }`
  - `decrypt(encryptedBlob, encryptedDek, iv, authTag)` → plaintext
  - Zero out plaintext buffer after use (`Buffer.fill(0)`)
  - Use Node.js built-in `crypto` module (no external deps)

- [x] **2.2 Prisma schema for credentials**
  ```
  Credential {
    id, name, type (API_KEY | OAUTH2 | CUSTOM),
    encryptedBlob, encryptedDek, iv, authTag,
    metadata (JSON), scopes (String[]),
    expiresAt, isRevoked, createdAt, updatedAt,
    agentId → Agent (which agent owns this)
  }
  ```

- [x] **2.3 Credential CRUD endpoints**
  - `POST /v1/credentials` — encrypt + store credential (admin auth)
  - `GET /v1/credentials` — list credentials with masked values (admin auth)
  - `GET /v1/credentials/:id` — get single credential, masked (admin auth)
  - `DELETE /v1/credentials/:id` — revoke credential (set isRevoked = true)
  - Never return raw credential values over the API

- [x] **2.4 Credential decryption for proxy use (internal only)**
  - Internal service method: `decryptCredential(credentialId)` → raw value
  - Only called during proxy execution (Phase 4)
  - Plaintext buffers are zeroed inside the encryption helpers after use

### Key files to create/modify

- `packages/api/src/services/encryption.ts` — envelope encryption (AES-256-GCM + HKDF)
- `packages/api/src/services/credentials.ts` — credential CRUD logic
- `packages/api/src/routes/credentials.ts` — credential REST endpoints
- `packages/api/prisma/schema.prisma` — add Credential model
- `packages/api/src/services/encryption.test.ts` — encryption unit coverage
- `packages/api/src/__integration__/credentials.crud.test.ts` — credential integration coverage

### Verification

```bash
# Store a credential
curl -X POST http://localhost:3000/v1/credentials \
  -H "Authorization: Bearer $PROJECT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Stripe Test", "type": "API_KEY", "value": "sk_test_abc123", "agentId": "..."}'
# Should return a credential record with masked metadata (for example `_displayHint`)
# and should never return raw values or encrypted fields

# List credentials (should never show raw values)
curl http://localhost:3000/v1/credentials \
  -H "Authorization: Bearer $PROJECT_API_KEY"

# Automated coverage
npm run test:integration --workspace=packages/api -- src/__integration__/credentials.crud.test.ts
npx vitest run src/services/encryption.test.ts --config packages/api/vitest.config.ts
```

---

## Phase 3: Policy Engine (ABAC)

**Goal:** Fine-grained, attribute-based policy evaluation. Every request is checked before execution.

**Depends on:** Phase 1 (agents), Phase 2 (credentials referenced in policies)

### Steps

- [x] **3.1 Prisma schema for policies**
  ```
  Policy {
    id, agentId → Agent, credentialId → Credential,
    allowedActions (String[]), deniedActions (String[]),
    constraints (JSON) {
      maxAmountPerTransaction, maxDailySpend,
      timeWindow { days, hours { start, end }, timezone },
      rateLimit { maxRequests, windowSeconds },
      ipAllowlist
    },
    requiresApprovalAbove (Float),
    expiresAt, isActive, createdAt, updatedAt
  }
  ```

- [x] **3.2 Policy CRUD endpoints**
  - `POST /v1/policies` — create policy (admin auth)
  - `GET /v1/policies` — list policies, filterable by agentId/credentialId
  - `GET /v1/policies/:id` — get single policy
  - `PATCH /v1/policies/:id` — update policy rules
  - `DELETE /v1/policies/:id` — deactivate policy

- [x] **3.3 Policy evaluation engine**
  - `evaluateRequest(agentId, credentialId, action, params)` → `ALLOW | DENY | ESCALATE`
  - Evaluation order:
    1. Find all active policies for this agent + credential pair
    2. Check denied actions (wildcards supported: `transfers.*`)
    3. Check allowed actions
    4. Check constraints: amount, time window, rate limit
    5. Check `requiresApprovalAbove` threshold → ESCALATE
    6. Return decision + matched rule ID + reason

- [x] **3.4 Rate limit tracking (Redis)**
  - Install `ioredis`
  - Redis key: `rate:{agentId}:{credentialId}:{windowStart}`
  - Increment on each request, check against `rateLimit.maxRequests`
  - TTL = `windowSeconds`

- [x] **3.5 Time window evaluation**
  - Install `luxon` for timezone-aware time checks
  - Check current time against `days` array and `hours` range in specified timezone

### Key files to create/modify

- `packages/api/src/services/policies.ts` — policy CRUD logic
- `packages/api/src/services/policyEngine.ts` — evaluation engine
- `packages/api/src/services/redis.ts` — Redis client + rate limit helpers
- `packages/api/src/routes/policies.ts` — policy REST endpoints
- `packages/api/prisma/schema.prisma` — add Policy model

### Verification

```bash
# Create a policy
curl -X POST http://localhost:3000/v1/policies \
  -H "Authorization: Bearer $PROJECT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "...",
    "credentialId": "...",
    "allowedActions": ["charges.create", "charges.read"],
    "deniedActions": ["transfers.*"],
    "constraints": {
      "maxAmountPerTransaction": 5000,
      "maxDailySpend": 15000,
      "rateLimit": {"maxRequests": 100, "windowSeconds": 3600}
    },
    "requiresApprovalAbove": 2000
  }'

# Test policy evaluation (internal/debug endpoint)
curl -X POST http://localhost:3000/v1/policies/evaluate \
  -H "Authorization: Bearer $PROJECT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agentId": "...", "credentialId": "...", "action": "charges.create", "params": {"amount": 3000}}'
# Should return: { "decision": "ESCALATE", "reason": "Amount 3000 exceeds approval threshold 2000" }
```

---

## Phase 4: Proxy Mode

**Goal:** The core flow. Agent sends a request, Bastion checks policy, decrypts credential, calls external API, returns result.

**Depends on:** Phase 1 (auth), Phase 2 (credential decrypt), Phase 3 (policy check)

### Steps

- [x] **4.1 Proxy execution endpoint**
  - `POST /v1/proxy/execute` (agent auth)
  - Request body: `{ credentialId, action, target: { url, method, headers, body } }`
  - Flow:
    1. Authenticate agent (middleware)
    2. Validate credential belongs to this agent
    3. Evaluate policy → ALLOW / DENY / ESCALATE
    4. If DENY → return 403 with reason
    5. If ESCALATE → return 202 with escalation info (HITL gate is Phase 5)
    6. If ALLOW → decrypt credential → inject into request → call external API
    7. Return external API response to agent
    8. Log audit record (Phase 6)

- [x] **4.2 Credential injection**
  - Based on credential type:
    - `API_KEY` → inject as `Authorization: Bearer <key>` or custom header
    - `OAUTH2` → inject as `Authorization: Bearer <access_token>`
  - Configurable injection point (header, query param, body field)

- [x] **4.3 External HTTP client**
  - Use Node.js built-in `fetch` for outbound calls
  - Timeout handling (default 30s, max 120s) via AbortController
  - Response body size limit (5MB)

- [x] **4.4 Request/response sanitization**
  - SSRF protection (blocks localhost, link-local, cloud metadata)
  - Credential never logged or returned to agent
  - Never log raw credential values

### Key files to create/modify

- `packages/api/src/services/proxy.ts` — proxy execution logic
- `packages/api/src/routes/proxy.ts` — proxy endpoint
- `packages/api/src/services/httpClient.ts` — outbound HTTP wrapper

### Verification

```bash
# Execute a proxied request (e.g., to httpbin for testing)
curl -X POST http://localhost:3000/v1/proxy/execute \
  -H "Authorization: Bearer <agent_secret>" \
  -H "Content-Type: application/json" \
  -d '{
    "credentialId": "...",
    "action": "test.get",
    "target": {"url": "https://httpbin.org/get", "method": "GET"}
  }'
```

---

## Phase 5: Human-in-the-Loop Gate

**Goal:** When policy says ESCALATE, pause the request, notify a human, wait for approval.

**Depends on:** Phase 3 (escalation triggers), Phase 4 (proxy must pause mid-flow)

### Steps

- [x] **5.1 Pending request storage (Redis)**
  - When ESCALATE triggers, store request in Redis with TTL (default 5 min)
  - Key: `hitl:{requestId}` → full request context as JSON
  - Status: `pending` | `approved` | `denied` | `expired`

- [x] **5.2 Webhook notification**
  - POST to agent's `callbackUrl` or a configured webhook URL
  - Payload: `{ requestId, agentId, action, params, reason, approveUrl, denyUrl }`

- [x] **5.3 Approval/denial endpoints**
  - `POST /v1/hitl/:requestId/approve` — approve pending request (admin auth)
  - `POST /v1/hitl/:requestId/deny` — deny pending request (admin auth)
  - `GET /v1/hitl/pending` — list pending requests (admin auth)
  - On approve: resume proxy execution from Phase 4
  - On deny: return 403 to waiting agent

- [x] **5.4 Request hold + resume mechanism**
  - Agent's proxy request is held open (long poll) while awaiting approval
  - Configurable timeout (default 5 min, max 15 min)
  - On timeout: auto-deny (fail closed)
  - On approve: continue proxy flow → decrypt → call API → return result
  - On deny: return 403 with denial reason

- [ ] **5.5 Slack integration (stretch)**
  - Slack Incoming Webhook for notifications
  - Slack Interactive Components for approve/deny buttons
  - Requires Slack App setup (OAuth + webhook URL)

### Key files to create/modify

- `packages/api/src/services/hitl.ts` — HITL gate logic (store, notify, resolve)
- `packages/api/src/routes/hitl.ts` — approval/denial endpoints
- `packages/api/src/services/notifications.ts` — webhook + Slack sender

### Verification

```bash
# Trigger an escalation (request above approval threshold)
curl -X POST http://localhost:3000/v1/proxy/execute \
  -H "Authorization: Bearer <agent_secret>" \
  -H "Content-Type: application/json" \
  -d '{"credentialId": "...", "action": "charges.create", "target": {...}, "params": {"amount": 3000}}'
# Request hangs, waiting for approval...

# In another terminal — approve it
curl -X POST http://localhost:3000/v1/hitl/<requestId>/approve \
  -H "Authorization: Bearer $PROJECT_API_KEY"
# Original request completes and returns the API response
```

---

## Phase 6: Signed Audit Chain

**Goal:** Every decision is cryptographically signed into a tamper-evident hash chain.

**Depends on:** Phase 1 (agent keys), Phase 4 (proxy generates audit events)

### Steps

- [x] **6.1 Prisma schema for audit chain**
  ```
  AuditRecord {
    id (BigInt autoincrement),
    recordJson (JSON),
    recordHash (Bytes),
    signature (Bytes),
    signerKeyFingerprint (String),
    previousHash (Bytes),
    createdAt
  }
  ```
  - Append-only: Bastion service account has INSERT + SELECT only

- [x] **6.2 Canonical JSON serialization**
  - Deterministic JSON: keys sorted alphabetically, no whitespace
  - Use `JSON.stringify(obj, Object.keys(obj).sort())` or a canonical JSON lib
  - This ensures the same record always produces the same hash

- [x] **6.3 Hash chain construction**
  - For each audit record:
    1. Get `previousHash` from the last record in the chain (or genesis hash for first)
    2. Build record JSON including `previousHash`
    3. Canonicalize → SHA-256 hash → `recordHash`
    4. Sign `recordHash` with agent's Ed25519 private key → `signature`
    5. INSERT into audit_chain table

- [x] **6.4 Audit record creation (integrated into proxy)**
  - After every proxy request (regardless of outcome), create a signed audit record
  - Record includes: agent_id, action, target, method, policy_decision, matched_rule, request_metadata, credential_used, timestamp
  - Also log DENY and ESCALATE decisions (not just ALLOWs)

- [x] **6.5 Chain verification endpoint**
  - `GET /v1/audit/verify?agentId=...` — verify entire chain for an agent
  - Walk chain from first to last record:
    1. Recompute SHA-256 of canonical JSON → matches `recordHash`?
    2. Verify Ed25519 signature with agent's public key
    3. Check `previousHash` links to prior record
  - Return: `{ valid: true, recordCount: N, lastRecord: timestamp }` or `{ valid: false, brokenAt: recordId, reason: "..." }`

- [x] **6.6 Audit log query endpoint**
  - `GET /v1/audit?agentId=...&from=...&to=...&action=...` — query audit records
  - Paginated, filterable by agent, time range, action, decision

### Key files to create/modify

- `packages/api/src/services/auditChain.ts` — hash chain + signing logic
- `packages/api/src/services/canonicalize.ts` — deterministic JSON serialization
- `packages/api/src/routes/audit.ts` — audit query + verification endpoints
- `packages/api/prisma/schema.prisma` — add AuditRecord model

### Verification

```bash
# After making several proxy requests, verify the chain
curl http://localhost:3000/v1/audit/verify?agentId=... \
  -H "Authorization: Bearer $PROJECT_API_KEY"
# { "valid": true, "recordCount": 5, "lastRecord": "2026-03-15T..." }

# Tamper with a record in the DB, then verify again
# Should detect tampering
```

---

## Phase 7: SDK Completion

**Goal:** Flesh out the TypeScript and Python SDK stubs with real functionality.

**Depends on:** Phase 4 (proxy endpoint to call), Phase 6 (audit to query)

### Steps

- [x] **7.1 TypeScript SDK**
  - `client.execute({ credential, action, target })` — proxy mode
  - `client.listAgents()`, `client.getAgent(id)`
  - `client.listCredentials()`, `client.storeCredential(...)`
  - `client.listPolicies()`, `client.createPolicy(...)`
  - `client.verifyChain(agentId)` — audit verification
  - Error handling: typed errors for DENY, ESCALATE_TIMEOUT, etc.

- [x] **7.2 Python SDK**
  - Mirror the TypeScript SDK methods
  - Both sync (`httpx.Client`) and async (`httpx.AsyncClient`) variants
  - `client.execute(credential, action, target)` — proxy mode
  - `client.verify_chain(agent_id)` — audit verification

- [x] **7.3 SDK documentation**
  - Inline docstrings/JSDoc
  - Usage examples in each SDK README

### Key files to modify

- `packages/sdk-node/src/index.ts` — full client implementation
- `packages/sdk-python/src/bastion_sdk/client.py` — full client implementation

---

## Phase 8: Dashboard (Minimal)

**Goal:** Web UI for monitoring agents, approving HITL requests, viewing audit logs.

**Depends on:** All previous phases

### Steps

- [x] **8.1 Vite + React project setup**
  - `packages/dashboard/` — Vite + React SPA
  - Tailwind CSS v4 for styling
  - TanStack Query for data fetching + polling
  - React Router v7 for client-side routing
  - Vite dev proxy to API server

- [x] **8.2 Pages**
  - Agent list (with kill switch toggle)
  - Credential list (masked values, revoke button with confirmation)
  - HITL pending queue (approve/deny buttons, 5s polling)
  - Audit log viewer (filterable by agent/action/decision/date, cursor pagination)
  - Chain verification status (per-agent verify button)

- [ ] **8.3 Real-time updates (stretch)**
  - WebSocket connection for live audit feed
  - HITL notification badges
  - Policy list with inline editing

---

## Phase 9: Demo + Polish

**Goal:** End-to-end demo scenario, documentation, video.

**Depends on:** All previous phases

### Steps

- [ ] **9.1 Demo scenario setup**
  - Agent 1: "Shopping Assistant" with Stripe test mode
  - Agent 2: "Research Agent" with GitHub API
  - Pre-configured policies with various constraints

- [ ] **9.2 Demo script**
  - ALLOW → DENY → ESCALATE → approve → verify chain → tamper → detect

- [ ] **9.3 CLI verification tool**
  - `npx bastion verify --agent <id>` — standalone chain verifier
  - Pretty-printed output with colors

- [ ] **9.4 Documentation**
  - Quickstart guide
  - API reference
  - Architecture overview with diagrams

---

## Dependency Graph

```text
Phase 0 (Scaffolding) ✅
    │
    v
Phase 1 (Agents + Auth) ✅
    │
    ├──────────────────┐
    v                  v
Phase 2 (Vault) ✅ Phase 6 (Audit Chain) ←── can start schema/signing early
    │                  │
    v                  │
Phase 3 (Policies) ✅  │
    │                  │
    v                  │
Phase 4 (Proxy) ✅ ────┤ ←── audit integrated into proxy
    │                  │
    v                  │
Phase 5 (HITL) ✅ ─────┘
    │
    v
Phase 7 (SDKs) ✅
    │
    v
Phase 8 (Dashboard) ✅
    │
    v
Phase 9 (Demo)
```

---

## npm Packages to Install (by phase)

| Phase | Package                | Purpose                          |
| ----- | ---------------------- | -------------------------------- |
| 1     | `@noble/ed25519`       | Ed25519 keypair gen + signing    |
| 1     | `@noble/hashes`        | SHA-256 hashing                  |
| 3     | `ioredis`              | Redis client for rate limits     |
| 3     | `luxon`                | Timezone-aware time window eval  |
| 5     | `@slack/web-api`       | Slack notifications (stretch)    |

All other crypto (AES-256-GCM, HKDF) uses Node.js built-in `crypto` module.
