# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Bastion?

A trust proxy for AI agents. Sits between agents and the APIs they call. Four planned layers:

1. **Credential Vault** — envelope encryption (AES-256-GCM), agents never see raw secrets
2. **Policy Engine** — ABAC rules (amount limits, time windows, rate limits, action allowlists)
3. **HITL Gate** — pause high-stakes requests, notify human via Slack/webhook, wait for approval
4. **Signed Audit Chain** — Ed25519-signed, SHA-256 hash-chained records, tamper-evident

See `ROADMAP.md` for the phased implementation plan with dependencies and verification steps.

## Commands

Requires Node.js >= 22.

```bash
npm run dev          # Start API server (tsx watch mode on packages/api)
npm run build        # Build all TypeScript workspace packages
npm run lint         # ESLint 9 (flat config) across all packages
npm run format       # Prettier write
npm run format:check # Prettier check (CI-safe)
npm test             # Run unit tests (Vitest, fast, no DB needed)
npm run test:integration  # Run integration tests (needs Docker postgres + Redis)
npm run db:migrate   # Run Prisma migrations (packages/api)
npm run db:studio    # Open Prisma Studio GUI
docker compose up -d # Start PostgreSQL 17 + Redis 7
```

Build/lint/format target all workspaces via npm `--workspaces` flag. To target a single package:

```bash
npm run build --workspace=packages/api
npm run build --workspace=packages/sdk-node
```

Run a single test file or use watch mode (from repo root):

```bash
npx vitest run src/services/crypto.test.ts --config packages/api/vitest.config.ts
npm run test:watch --workspace=packages/api  # re-runs on file changes
npm run test:all --workspace=packages/api    # unit + integration in one go
```

## Architecture

Monorepo with npm workspaces. Three packages:

- **`packages/api/`** — Express 5 + TypeScript API server. This is the main codebase.
- **`packages/sdk-node/`** — TypeScript SDK. Zero runtime dependencies (uses global `fetch`).
- **`packages/sdk-python/`** — Python SDK using `httpx`. Not an npm workspace (managed with pip/hatch).

### API package structure

- **`src/index.ts`** — Entry point. Calls `createApp()` and starts the HTTP server.
- **`src/app.ts`** — Express app factory (`createApp()`). Composes middleware and routes. Side-effect-free for testability.
- **`src/config.ts`** — Loads `.env` via `import 'dotenv/config'` (must be the first import in the dependency chain). Exports a typed `config` object. Uses `requireEnv()` for mandatory vars.
- **`src/routes/index.ts`** — Route aggregator. Each feature gets its own router file, mounted here. Currently mounts: `/health`, `/v1/agents`, `/v1/credentials`, `/v1/policies`.
- **`src/middleware/`** — Express middleware. `errorHandler.ts` must be registered last (4-param signature). `requestId.ts` sets `X-Request-Id` on every response. `auth.ts` provides `requireAdmin` (timing-safe PROJECT_API_KEY check) and `requireAgent` (hash-based agent secret lookup; also checks `isActive` flag).
- **`src/errors.ts`** — Typed error classes (`AppError`, `ValidationError`, `UnauthorizedError`, `NotFoundError`, `ConflictError`). Thrown by services, caught by `errorHandler`.
- **`src/services/db.ts`** — Prisma client singleton (uses `globalThis` to survive tsx hot-reloads).
- **`src/services/redis.ts`** — Redis client singleton (`ioredis`, same `globalThis` pattern as `db.ts`). Rate limit helpers use an atomic Lua script for INCR + conditional EXPIRE. Daily spend tracking uses INCRBYFLOAT with 48h TTL keys.
- **`src/services/crypto.ts`** — Ed25519 keypair generation (`@noble/ed25519`), SHA-256 hashing (`@noble/hashes/sha2.js`), API secret generation (`bst_` prefix + 32 random hex bytes).
- **`src/services/encryption.ts`** — Envelope encryption (AES-256-GCM). Derives KEK from `MASTER_KEY` via HKDF. Each credential gets a random DEK, encrypted under the KEK. Plaintext buffers are zeroed after use.
- **`src/services/agents.ts`** — Agent CRUD business logic. `createAgent` generates keypair + hashed secret. `findAgentBySecret` hashes incoming token for DB lookup. Soft-delete via `isActive` flag.
- **`src/services/credentials.ts`** — Credential CRUD. Encrypts values on create, never returns raw values over the API. Stores a `_displayHint` in metadata (first 3 + last 4 chars). `decryptCredential()` for internal proxy use only (checks revoked/expired status).
- **`src/services/policies.ts`** — Policy CRUD. Validates that referenced agent and credential exist on create. Exports `PolicyConstraints` interface used by the evaluation engine. Soft-delete via `isActive` flag.
- **`src/services/policyEngine.ts`** — Policy evaluation engine. `evaluateRequest(agentId, credentialId, action, params, { dryRun? })` returns `ALLOW | DENY | ESCALATE` with reason. Fail-closed: no matching policy = DENY. Multiple policies use most-restrictive-wins (DENY > ESCALATE > ALLOW). Supports wildcard action matching (`transfers.*`), time windows via Luxon, rate limits and daily spend via Redis. `commitRateLimitAndSpend()` is exported for Phase 4 proxy to call after ALLOW.

### Express middleware chain (order matters)

`helmet` → `cors` → `express.json` → `requestId` → `router` → `errorHandler`

### Request → Route → Service pattern

Routes validate input and handle HTTP concerns, then delegate to service functions. Services contain business logic and throw typed errors (`ValidationError`, `NotFoundError`, etc.) which `errorHandler` catches and serializes into JSON responses. Routes use `serializeAgent()` / `serializeCredential()` helpers to strip sensitive fields (hashes, encrypted blobs) before returning JSON. Express `Request` is augmented with an optional `agent` property (`src/types/index.ts`) — set by `requireAgent` middleware for agent-authenticated routes.

### Database

Prisma 6 with PostgreSQL. Schema at `packages/api/prisma/schema.prisma`. Three models: `Agent`, `Credential`, `Policy`. Relations: Agent → Credentials (1:N), Agent → Policies (1:N), Credential → Policies (1:N). Prisma models use `@map` for snake_case column names and `@@map` for table names, while TypeScript uses camelCase. New models must follow this convention.

### Policy evaluation semantics

- **Fail closed**: no active policy for an agent+credential pair = DENY
- **Most restrictive wins**: when multiple policies match, any DENY → DENY, any ESCALATE (no DENY) → ESCALATE, all ALLOW → ALLOW
- **Evaluation order per policy**: denied actions → allowed actions → IP allowlist → time window → max amount per transaction → rate limit → daily spend → approval threshold
- **Wildcard actions**: `transfers.*` matches `transfers.create`, `transfers.read`, etc. (prefix match)
- **Dry-run**: `POST /v1/policies/evaluate` reads Redis counters without incrementing

### Testing

Two-tier test setup in `packages/api/`:

- **Unit tests** — collocated as `*.test.ts` next to source files. No DB/Redis needed. Run with `npm test`.
- **Integration tests** — in `src/__integration__/`. Require Docker postgres + Redis running. Use a separate `bastion_test` database (created automatically by the global setup file).

Both tiers use `supertest` against `createApp()` directly — no HTTP server is started. Setup files (`src/__test__/setup.ts`, `setup.integration.ts`) configure env vars. Integration tests clean the DB and Redis between runs via `src/__test__/helpers/db.ts` (`cleanDatabase()` respects FK ordering: policies → credentials → agents; `cleanRedis()` flushes the test Redis DB).

## Code Conventions

- **ESM everywhere**: all `package.json` files have `"type": "module"`. All relative imports **must** use `.js` extensions (e.g., `import { config } from './config.js'`). TypeScript does not rewrite import paths.
- **TypeScript**: strict mode, ES2024 target, Node16 module resolution. `noUnusedLocals` and `noUnusedParameters` are enforced.
- **Formatting**: single quotes, semicolons, trailing commas, 100 char print width (see `.prettierrc`).
- **Unused variables/params**: prefix with `_` (e.g., `_req`, `_next`) — the ESLint config allows `argsIgnorePattern: '^_'` and `varsIgnorePattern: '^_'`.
- **Crypto**: `@noble/ed25519` and `@noble/hashes` for signing/hashing. Node.js built-in `crypto` for AES-256-GCM and HKDF. No other crypto libraries.
- **API secrets**: prefixed with `bst_` (+ 32 random hex bytes) for easy identification.
- **Fail closed**: if Bastion is down or policy evaluation fails, requests are denied, never silently allowed.
- **Soft deletes**: Agents and Policies use `isActive` flag; Credentials use `isRevoked` flag. No hard deletes.
- **Prisma JSON fields**: use `Prisma.InputJsonValue` cast for writes and `Prisma.JsonNull` for null values (e.g., policy `constraints`).
- **ioredis import**: use named import `import { Redis } from 'ioredis'` (not default import) for Node16 module resolution compatibility.

## Environment Variables

Defined in `.env.example`. Copy to `packages/api/.env` for local dev.

- `DATABASE_URL` — PostgreSQL connection string (required)
- `REDIS_URL` — Redis connection string (default: `redis://localhost:6379`)
- `PORT` — API server port (default: `3000`)
- `NODE_ENV` — `development` or `production`
- `MASTER_KEY` — 32-byte hex string for envelope encryption KEK (generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
- `PROJECT_API_KEY` — Admin API key for managing agents/credentials/policies (required)
