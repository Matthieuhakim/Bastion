# Contributing to Bastion

Thanks for contributing to Bastion.

## Development Setup

Requirements:

- Node.js 22+
- Docker

Start a local development environment:

```bash
git clone https://github.com/Matthieuhakim/Bastion.git
cd Bastion
npm install
docker compose up -d
cp .env.example packages/api/.env
```

Set values in `packages/api/.env` for:

- `MASTER_KEY` as a 64-character hex string
- `PROJECT_API_KEY` as your admin key

Then run the app:

```bash
npm run db:migrate
npm run dev
```

If you want the dashboard in development, start it separately:

```bash
npm run dev:dashboard
```

## Running Tests

Run the default unit test suite:

```bash
npm test
```

Run API integration tests after PostgreSQL and Redis are up:

```bash
npm run test:integration
```

Run dashboard end-to-end tests:

```bash
npm run test:e2e
```

Before opening a PR, also run:

```bash
npm run lint
npm run build
```

## Code Conventions

- The repo uses ESM everywhere, so relative TypeScript imports must end in `.js`
- TypeScript is strict; avoid unused vars and prefix intentionally unused values with `_`
- Prisma models use snake_case database mappings with camelCase TypeScript fields
- Keep services focused on business logic and routes focused on HTTP validation/serialization
- Do not log secrets, decrypted credentials, or raw API keys

## Pull Requests

- Keep PRs focused and scoped to one change when possible
- Add or update tests when behavior changes
- Update docs when public APIs, config, or developer workflows change
- Include a short summary of what changed, why, and how you verified it
