# Bastion Roadmap

The trust proxy for AI agents. This roadmap covers two repositories:

- **Bastion (this repo)** `[OSS]` — open-core, self-hostable forever. The proxy, policy engine, HITL gate, signed audit chain, SDKs, and integrations.
- **Bastion Cloud** `[Cloud]` — separate private repo. Next.js SaaS platform with multi-tenancy, auth, billing, managed MCP gateway, and integration marketplace.

Organized by milestone. Each milestone is a meaningful, shippable deliverable.

---

## Completed: MVP (Phases 0–9)

All core functionality is implemented and tested:

- **Credential Vault** — envelope encryption (AES-256-GCM), agents never see raw secrets
- **Policy Engine** — ABAC rules (amount limits, time windows, rate limits, action allowlists)
- **HITL Gate** — pause high-stakes requests, notify via webhook, wait for approval
- **Signed Audit Chain** — Ed25519-signed, SHA-256 hash-chained, tamper-evident records
- **TypeScript + Python SDKs** — full client implementations
- **React Dashboard** — agents, credentials, HITL queue, audit log viewer, chain verification
- **Production Ready** — Docker deployment, CI/CD, structured logging, graceful shutdown, agent self-registration

---

## Milestone 1: MCP Server — Bastion as MCP Gateway `[OSS]`

**Goal:** Ship `packages/mcp-server/` that sits between AI agents and upstream MCP servers, routing every `tools/call` through Bastion's policy engine, HITL gate, and audit chain. The agent doesn't know its calls are being intercepted.

**Dependencies:** None (builds on completed MVP)

### 1.1 New Prisma model: `UpstreamServer`

Add to `packages/api/prisma/schema.prisma`:

- Fields: `id`, `name`, `transport` (stdio/sse/streamable-http), `connectionUri`, `args`, `env` (JSON), `isActive`, `credentialId?`
- Relation: `Credential? → UpstreamServer[]` — binds a credential to an upstream so the MCP server knows which credential to use per tool call
- Follow existing `@map`/`@@map` snake_case conventions

### 1.2 Upstream Server CRUD (API routes + service)

Standard admin CRUD following existing patterns (`agents.ts`, `credentials.ts`):

- `POST /v1/upstream-servers` — register upstream MCP server
- `GET /v1/upstream-servers` — list
- `GET /v1/upstream-servers/:id` — get single
- `PATCH /v1/upstream-servers/:id` — update
- `DELETE /v1/upstream-servers/:id` — soft delete (set `isActive = false`)

Files to create:

- `packages/api/src/services/upstreamServers.ts` — CRUD logic
- `packages/api/src/routes/upstreamServers.ts` — REST endpoints

Files to modify:

- `packages/api/src/routes/index.ts` — mount `/v1/upstream-servers` router

### 1.3 New package: `packages/mcp-server/`

Scaffold a new npm workspace package:

- `packages/mcp-server/package.json` — depends on `@modelcontextprotocol/sdk`, `@bastion-ai/sdk`
- `packages/mcp-server/tsconfig.json` — extends root config
- Add to root `package.json` workspaces

Architecture:

- Uses `@modelcontextprotocol/sdk` `Server` class to register as an MCP server (exposes `tools/list` and `tools/call`)
- Uses `@modelcontextprotocol/sdk` `Client` class to connect to each registered upstream MCP server
- On startup: fetches upstream server configs from Bastion API via SDK, connects to each, discovers tools via `tools/list`
- Merges all upstream tools into its own `tools/list` response, namespaced as `{serverName}.{toolName}`

### 1.4 Tool call interception flow

Core logic in `packages/mcp-server/src/handler.ts`. On `tools/call`:

1. Parse `serverName` + `toolName` from the namespaced tool name
2. Map to Bastion action: `{serverName}.{toolName}` (e.g., `stripe.create_charge`)
3. Extract `amount` from tool arguments if present (for policy evaluation params)
4. Call `evaluateRequest(agentId, credentialId, action, params)` — **reuse existing policy engine**
5. **DENY** → return MCP error result
6. **ESCALATE** → trigger HITL gate via `createPendingRequest()` + `waitForResolution()` — **reuse existing HITL**
7. **ALLOW** → forward `tools/call` to upstream MCP client, call `commitRateLimitAndSpend()`, call `appendAuditRecord()` — **reuse existing audit chain**
8. Return upstream tool result to the calling agent

**Key design decision:** The MCP server imports service functions directly (same process as Bastion API, shares DB/Redis). No HTTP serialization overhead. Runs as a sidecar to the API.

Files to create:

- `packages/mcp-server/src/index.ts` — entry point
- `packages/mcp-server/src/handler.ts` — `tools/call` interception + policy enforcement
- `packages/mcp-server/src/upstream.ts` — upstream MCP client management
- `packages/mcp-server/src/toolRegistry.ts` — merged tool list from all upstreams
- `packages/mcp-server/src/transports.ts` — stdio + SSE transport setup

### 1.5 Dashboard: Upstream Servers page

New page in `packages/dashboard/` for managing upstream MCP server registrations (CRUD + connection status).

### Verification: MCP Server

```bash
# Register an upstream MCP server
curl -X POST http://localhost:3000/v1/upstream-servers \
  -H "Authorization: Bearer $PROJECT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "stripe", "transport": "stdio", "connectionUri": "node stripe-mcp-server.js"}'

# Start Bastion MCP server (connects to all registered upstreams)
node packages/mcp-server/dist/index.js

# Agent connects via MCP client → calls tools/list → sees merged tools
# Agent calls tools/call → Bastion evaluates policy → forwards → audits → returns result
# Policy DENY → MCP error; ESCALATE → HITL gate blocks until approved

npm test && npm run test:integration
```

---

## Milestone 2: OpenClaw Plugin `[OSS]`

**Goal:** Ship a plugin for the OpenClaw agent framework that transparently wraps outbound HTTP calls through Bastion. The agent does not notice its requests are being intercepted.

**Dependencies:** None (can run in parallel with Milestone 1)

### 2.1 New package: `packages/openclaw-plugin/`

- npm package name: `@bastion-ai/bastion`
- peerDependency on `openclaw`, dependency on `@bastion-ai/sdk`
- Add to root `package.json` workspaces

### 2.2 Lightweight mode (default): HTTP interception

- Export `bastionPlugin(config)` returning an OpenClaw plugin object
- Hook into the agent's HTTP layer via OpenClaw's plugin lifecycle
- Intercept `fetch()` calls → convert to `POST /v1/proxy/execute` via the Bastion SDK
- Map target URL + method to a Bastion action string (e.g., `http.POST.api.stripe.com`)
- Configurable URL-to-credential mapping so the right credential is auto-selected per target domain
- Agent code is completely unchanged — all interception is transparent

Files to create:

- `packages/openclaw-plugin/src/index.ts` — plugin factory
- `packages/openclaw-plugin/src/interceptor.ts` — fetch interception logic
- `packages/openclaw-plugin/src/urlMapper.ts` — URL-to-action and URL-to-credential mapping
- `packages/openclaw-plugin/src/config.ts` — plugin configuration types

### 2.3 Full mode (opt-in): server-backed enforcement

When a Bastion server URL is configured:

- All HTTP calls route through Bastion proxy (full policy engine, HITL, signed audit chain, dashboard visibility)

When no server URL is configured:

- Local-only mode with basic action allowlist checking (no Redis-backed rate limits, no HITL, no audit chain)
- Useful for development and testing

Files to create:

- `packages/openclaw-plugin/src/localPolicy.ts` — lightweight local-only policy checks

### 2.4 Documentation and examples

- `packages/openclaw-plugin/README.md` — setup guide
- Example OpenClaw agent project with Bastion plugin configured

### Verification: OpenClaw Plugin

```bash
# Install plugin in an OpenClaw project
npm install @bastion-ai/bastion

# Agent makes normal HTTP calls — plugin transparently routes through Bastion
# Policy DENY → error returned to agent
# HITL escalation works in full mode
# Audit records created for every tool call
# Both lightweight and full modes work
```

---

## Milestone 3: SDK Enhancements + CLI `[OSS]`

**Goal:** Add MCP-aware methods to both SDKs and ship a CLI verification tool.

**Dependencies:** Milestone 1 (MCP server must exist)

### 3.1 TypeScript SDK: MCP methods

Add to `packages/sdk-node/src/client.ts`:

- `createUpstreamServer(input)`, `listUpstreamServers()`, `getUpstreamServer(id)`, `updateUpstreamServer(id, input)`, `deleteUpstreamServer(id)`
- `listMcpTools(upstreamServerId?)` — list discovered tools from MCP registry

Add corresponding types to `packages/sdk-node/src/types.ts`.

### 3.2 Python SDK: MCP methods

Mirror TypeScript additions in `packages/sdk-python/src/bastion_sdk/client.py` and `types.py`.

### 3.3 CLI tool: `packages/cli/`

New package with `bin` entry:

- `bastion verify-chain --agent-id <id>` — verify audit chain integrity, prints human-readable report
- `bastion list-agents` / `list-credentials` / `list-policies` — admin commands
- `bastion mcp list-tools` — list all MCP tools across upstream servers
- `bastion mcp test-call <tool> <args>` — test a tool call with dry-run policy evaluation

Configured via `BASTION_URL` and `BASTION_API_KEY` environment variables. Uses `@bastion-ai/sdk` internally.

Files to create:

- `packages/cli/package.json` — with `bin` field
- `packages/cli/src/index.ts` — CLI entry point
- `packages/cli/src/commands/verify.ts` — chain verification command
- `packages/cli/src/commands/mcp.ts` — MCP tool commands

### Verification: SDK + CLI

```bash
# Verify audit chain via CLI
bastion verify-chain --agent-id agt_123
# → Chain intact. 847 records verified. No tampering detected.

# List MCP tools
bastion mcp list-tools
# → stripe.create_charge, stripe.list_charges, github.create_issue, ...

npm run build && npm test
```

---

## Milestone 4: Bastion Cloud — Foundation `[Cloud]`

**Goal:** Bootstrap the Bastion Cloud repo with multi-tenant auth, project management, and hosted Bastion API.

**Dependencies:** None (can start in parallel with Milestones 1–3)

### 4.1 Repo scaffolding

- **Next.js 15** — App Router, server components
- **Prisma** — separate schema from OSS (users, orgs, subscriptions)
- **NextAuth.js v5** — GitHub + Google OAuth, email/password
- **Tailwind CSS v4**
- **Stripe SDK**

### 4.2 Cloud database schema

| Model          | Purpose                                                            |
| -------------- | ------------------------------------------------------------------ |
| `User`         | email, name, avatar, memberships                                   |
| `Organization` | name, slug, members, projects, subscription                        |
| `OrgMember`    | role (owner/admin/member), links user to org                       |
| `Project`      | name, slug, org, bastionApiUrl, encrypted API key + master key     |
| `Subscription` | Stripe customer/subscription IDs, tier, status, current period end |

### 4.3 Auth flow

- `/login` — email/password + OAuth (GitHub, Google)
- `/register` — create account + first org
- After auth → org/project selector → dashboard

### 4.4 Org/Project management

- `/settings/organization` — org name, members, invite, roles
- `/settings/project` — project name, API keys (read-only display)
- Project creation auto-provisions `PROJECT_API_KEY` + `MASTER_KEY`

### 4.5 Tenant provisioning

- **MVP:** all tenants share a single Bastion API instance, isolated by project API key
- Cloud proxies all `/v1/*` calls to the tenant's Bastion API, injecting `PROJECT_API_KEY` server-side — the user never sees the raw key
- **Later:** dedicated Bastion API containers per tenant (Kubernetes)

### 4.6 Dashboard pages

Re-implement OSS dashboard in Next.js with server components:

- Agents list/detail
- Credentials list/detail
- HITL approval queue
- Audit log viewer with chain verification
- Data fetched via `@bastion-ai/sdk` initialized per-tenant

### Verification: Cloud Foundation

- User registers, creates org, creates project
- Project provisioning generates API keys and configures Bastion instance
- Dashboard pages show agents/credentials/policies/audit from tenant's Bastion
- Multi-org membership works (user switches between orgs)
- Unauthenticated access is blocked

---

## Milestone 5: Bastion Cloud — Billing + Usage Enforcement `[Cloud]` + `[OSS]`

**Goal:** Stripe billing with tier-based usage limits enforced at the API level.

**Dependencies:** Milestone 4

### 5.1 `[Cloud]` Stripe integration

- Stripe Customer created on org registration
- Stripe Checkout for Pro tier upgrade ($49/mo)
- Stripe Customer Portal for subscription management
- Webhooks: `customer.subscription.created`, `updated`, `deleted`, `invoice.payment_failed`

### 5.2 `[Cloud]` Usage tracking

Track per-project: agent count, credential count, monthly request count, HITL escalation count.

### 5.3 `[Cloud]` Tier enforcement

Cloud proxy checks usage before forwarding to Bastion API:

| Limit            | Free         | Pro ($49/mo)    | Enterprise          |
| ---------------- | ------------ | --------------- | ------------------- |
| Agents           | 3            | 25              | Unlimited           |
| Credentials      | 5            | Unlimited       | Unlimited           |
| Requests/month   | 1,000        | 50,000          | Unlimited           |
| HITL channels    | Webhook only | Slack + webhook | All channels        |
| Audit chain      | Local verify | Hosted verify   | Anchoring + reports |
| Dashboard        | Basic        | Full            | Full + SSO/SAML     |

Returns `402 Payment Required` with upgrade URL when limits exceeded.

### 5.4 `[OSS]` Usage counter endpoint

Add `GET /v1/usage` to the OSS API (admin auth) — returns active agent count, credential count, monthly request count, HITL escalation count. Gives Cloud a single endpoint to check all usage metrics.

Files to create:

- `packages/api/src/routes/usage.ts`
- `packages/api/src/services/usage.ts`

Files to modify:

- `packages/api/src/routes/index.ts` — mount `/v1/usage`

### Verification: Cloud Billing

```bash
# Free tier: cannot create more than 3 agents → 402
# Upgrade to Pro via Stripe Checkout → limits increase
# Usage dashboard shows real-time metrics
# Stripe webhook handles cancellation → downgrade to free
curl http://localhost:3000/v1/usage \
  -H "Authorization: Bearer $PROJECT_API_KEY"
# → { "agents": 2, "credentials": 3, "monthlyRequests": 487, "hitlEscalations": 12 }
```

---

## Milestone 6: Bastion Cloud — MCP Gateway + Marketplace + Advanced `[Cloud]` + `[OSS]`

**Goal:** Ship premium Cloud features: managed MCP gateway, integration marketplace, live event stream, anomaly detection, and compliance reports.

**Dependencies:** Milestones 1 + 5

### 6.1 `[Cloud]` Managed MCP Gateway

Each Cloud project gets a hosted MCP gateway URL (e.g., `mcp.bastion.sh/{project-slug}`). This is a managed instance of `packages/mcp-server/` from the OSS repo.

- Upstream MCP servers registered via the Cloud dashboard
- All tool calls flow through policy engine, HITL, audit chain
- Pages: `/mcp/servers`, `/mcp/tools`, `/mcp/logs`

### 6.2 `[Cloud]` Integration marketplace

Pre-built upstream MCP server configurations for popular services:

- Stripe, GitHub, Slack, Notion, Linear, Google Workspace, etc.
- Each entry: name, description, required credential type, default policy template, upstream server config
- One-click install: creates upstream server + credential + default policy in one step

New Cloud model: `MarketplaceIntegration` (slug, name, category, credentialType, serverConfig, policyTemplate)

Pages: `/marketplace`, `/marketplace/{integration}`

### 6.3 `[OSS + Cloud]` Live event stream

- **`[OSS]`**: After `appendAuditRecord()` in `auditChain.ts`, publish to `audit:{agentId}` Redis pub/sub channel
- **`[Cloud]`**: SSE endpoint at `/api/events/stream` subscribes to Redis channel, streams audit records in real-time. Dashboard live feed at `/events`

### 6.4 `[Cloud]` Anomaly detection (basic)

Rule-based alerting:

- Request volume spike (>2x 7-day average)
- Unseen actions (action not previously observed from this agent)
- High denial rate (>20% of requests denied in last hour)
- Off-hours activity (requests outside configured time window)

Alerts via email + in-dashboard notification bell.

### 6.5 `[Cloud]` Compliance reports

PDF-exportable reports for auditors:

- Agent activity summary (per-agent request counts, actions, decisions over time range)
- Audit chain integrity report (verification results + metadata)
- HITL review report (all escalated requests, reviewer, decision, time to resolve)

Pages: `/reports`, `/reports/{id}` with PDF download

### 6.6 `[Cloud]` Enhanced HITL channels (Pro/Enterprise)

- **Pro:** Slack app with interactive approve/deny buttons
- **Enterprise:** Email with secure magic links, SMS via Twilio

### Verification: Cloud Advanced

- Managed MCP gateway works end-to-end for a Cloud project
- Marketplace integration installs in one click (creates server + credential + policy)
- Live event stream shows real-time tool calls in dashboard
- Anomaly detection fires alerts on simulated request spike
- Compliance report generates valid PDF
- Slack HITL integration sends interactive approve/deny buttons

---

## Dependency Graph

```text
Milestone 1 (MCP Server) [OSS] ─────────────────┐
        │                                         │
        v                                         │
Milestone 3 (SDK + CLI) [OSS]                    │
                                                  │
Milestone 2 (OpenClaw Plugin) [OSS] ── independent│
                                                  │
Milestone 4 (Cloud Foundation) [Cloud] ──────────┐│
        │                                         ││
        v                                         ││
Milestone 5 (Cloud Billing) [Cloud+OSS] ────────┐││
        │                                        │││
        v                                        vvv
Milestone 6 (Cloud Advanced) [Cloud+OSS]
```

**Parallelism:** Milestones 1, 2, and 4 can all start simultaneously. Milestone 3 depends on 1. Milestone 5 depends on 4. Milestone 6 depends on 1 + 5.

---

## npm Packages to Install (by milestone)

| Milestone | Package                       | Purpose                        | Repo |
| --------- | ----------------------------- | ------------------------------ | ---- |
| 1         | `@modelcontextprotocol/sdk`   | MCP server + client SDK        | OSS  |
| 2         | (peer) `openclaw`             | OpenClaw plugin integration    | OSS  |
| 3         | `commander` or `citty`        | CLI framework                  | OSS  |
