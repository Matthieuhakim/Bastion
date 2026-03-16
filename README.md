# Bastion

**The trust proxy for AI agents.** Enforce real-time policies on every credentialed action an AI agent takes, with human-in-the-loop escalation and a cryptographically signed audit trail.

> Keep your AI agents under control. Prove it.

## What Bastion Does

Bastion sits between your AI agents and the APIs they call. It:

1. **Holds credentials** — agents never touch raw API keys or tokens
2. **Enforces policies** — attribute-based access control (ABAC) on every request (amount limits, time windows, rate limits, allowed actions)
3. **Escalates to humans** — pauses high-stakes requests and notifies you via Slack/webhook for approval
4. **Proves everything** — every decision is Ed25519-signed into a tamper-evident hash chain that anyone can independently verify

## Current Status

**Early development.** The project scaffolding and API server are in place. Core features (credential vault, policy engine, HITL gate, signed audit chain) are being built incrementally.

### What's working now

- Express 5 API server with health check endpoint
- **Agent registration** with Ed25519 keypair generation (`POST /v1/agents`)
- **Agent CRUD** — list, get, update, soft-delete agents
- **Admin auth** — `PROJECT_API_KEY` protects management routes (timing-safe comparison)
- **Agent auth middleware** — agents authenticate via `Bearer <agent_secret>` (SHA-256 hashed, never stored plaintext)
- **Credential Vault** — envelope encryption (AES-256-GCM + HKDF), per-credential DEKs, raw values never returned over the API
- **Credential CRUD** — store, list, get, and revoke credentials (`/v1/credentials`)
- **Policy Engine (ABAC)** — attribute-based access control with wildcard action matching, amount limits, rate limits (Redis), timezone-aware time windows (Luxon), IP allowlists, and approval thresholds
- **Policy CRUD** — create, list, get, update, and deactivate policies (`/v1/policies`)
- **Policy evaluation** — dry-run endpoint (`POST /v1/policies/evaluate`) returns ALLOW / DENY / ESCALATE with reason; fail-closed (no policy = deny)
- Prisma schema with Agent, Credential, and Policy models
- TypeScript and Python SDK stubs
- Local dev environment via Docker Compose (PostgreSQL + Redis)

## Project Structure

```text
packages/
  api/          → Express 5 + TypeScript API server
  sdk-node/     → TypeScript SDK (zero runtime dependencies)
  sdk-python/   → Python SDK (httpx)
```

## Getting Started

### Prerequisites

- Node.js >= 22
- Docker and Docker Compose
- Python >= 3.10 (for the Python SDK)

### Setup

```bash
# Clone the repo
git clone https://github.com/Matthieuhakim/Bastion.git
cd Bastion

# Install dependencies
npm install

# Start PostgreSQL and Redis
docker compose up -d

# Set up environment
cp packages/api/.env.example packages/api/.env

# Run database migrations
npm run db:migrate

# Start the dev server
npm run dev
```

### Verify

```bash
curl http://localhost:3000/health
# {"status":"ok","timestamp":"...","version":"0.1.0"}
```

### Python SDK (optional)

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e packages/sdk-python
```

## Scripts

| Command                    | Description                        |
| -------------------------- | ---------------------------------- |
| `npm run dev`              | Start the API server in watch mode |
| `npm run build`            | Build all TypeScript packages      |
| `npm run lint`             | Run ESLint                         |
| `npm run format`           | Format code with Prettier          |
| `npm test`                 | Run unit tests (Vitest)            |
| `npm run test:integration` | Run integration tests (needs DB)   |
| `npm run db:migrate`       | Run Prisma migrations              |
| `npm run db:studio`        | Open Prisma Studio                 |

## Tech Stack

| Component  | Technology                         |
| ---------- | ---------------------------------- |
| API server | Express 5, TypeScript, Node.js     |
| Database   | PostgreSQL 17                      |
| Cache      | Redis 7                            |
| ORM        | Prisma 6                           |
| SDKs       | TypeScript (fetch), Python (httpx) |

## License

[MIT](LICENSE)
