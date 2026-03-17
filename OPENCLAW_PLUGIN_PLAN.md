# OpenClaw Plugin for Bastion — Implementation Plan

## Context

Bastion's MVP is complete (credential vault, ABAC policy engine, HITL gate, signed audit chain). The next priority is an OpenClaw plugin that makes Bastion's security layer transparent to AI agents running in OpenClaw.

**Problem:** OpenClaw's own threat model (T-EXFIL-003, P0) identifies critical security gaps — no per-tool credential scoping, no audit trail for credential usage, no policy system for tool-credential access, credentials not encrypted at rest. Bastion fills all of these.

**Solution:** An OpenClaw plugin (`@bastion-ai/bastion`) that intercepts tool calls via before-call hooks, routes them through a Bastion server for policy evaluation + credential injection + upstream execution + audit, and returns results transparently to the agent.

**Key decisions:**

- Plugin always requires a Bastion server (self-hosted or Cloud)
- Intercepts at tool call level (not raw HTTP)
- Bastion makes the upstream call (credential never leaves server)
- Fail closed when Bastion is unreachable
- Explicit rule mapping in plugin config (tool + URL pattern -> credential + action)
- No OSS API changes needed — existing `POST /v1/proxy/execute` is sufficient

---

## Package: `packages/openclaw-plugin/`

### Directory Structure

```text
packages/openclaw-plugin/
  src/
    index.ts              -- Entry point, exports register() + types
    plugin.ts             -- Core register(api) implementation
    ruleEngine.ts         -- URL pattern matching, rule resolution
    bastionBridge.ts      -- Wraps @bastion-ai/sdk for proxy calls
    secretRef.ts          -- Resolves agentSecret from env/file/exec
    responseAdapter.ts    -- Bastion response -> OpenClaw tool result
    types.ts              -- All plugin-specific types
    errors.ts             -- BastionUnreachableError, BastionBlockedError
    __test__/
      ruleEngine.test.ts
      bastionBridge.test.ts
      secretRef.test.ts
      responseAdapter.test.ts
      plugin.test.ts
  openclaw.plugin.json    -- Plugin manifest (ships with npm package)
  package.json
  tsconfig.json
  vitest.config.ts
  README.md
```

### package.json

```json
{
  "name": "@bastion-ai/bastion",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
  },
  "files": ["dist", "openclaw.plugin.json"],
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@bastion-ai/sdk": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

**Monorepo:** Add `"packages/openclaw-plugin"` to root `package.json` workspaces array. Update lint/format globs to include `packages/openclaw-plugin/src/**/*.ts`.

---

## User Configuration

Users configure the plugin in their `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "bastion": {
        "config": {
          "serverUrl": "http://localhost:3000",
          "agentSecret": { "$env": "BASTION_AGENT_SECRET" },
          "rules": [
            {
              "tool": "web_fetch",
              "urlPattern": "https://api.stripe.com/**",
              "credentialId": "cred_abc123",
              "action": "stripe.charges",
              "injection": { "location": "header", "key": "Authorization" }
            },
            {
              "tool": "web_fetch",
              "urlPattern": "https://api.github.com/**",
              "credentialId": "cred_def456",
              "action": "github.*"
            }
          ],
          "timeout": 30000
        }
      }
    }
  }
}
```

### Config Types (`types.ts`)

```typescript
export type SecretValue = string | { $env: string } | { $file: string } | { $exec: string };

export interface InjectionConfig {
  location: 'header' | 'query' | 'body';
  key: string;
}

export interface ParamsMapping {
  amount?: string; // Dot-path into tool args (e.g., "body.amount")
  ip?: string;
}

export interface InterceptionRule {
  tool: string; // Tool name to match (e.g., "web_fetch")
  urlPattern: string; // Glob pattern (e.g., "https://api.stripe.com/**")
  credentialId: string; // Bastion credential ID
  action: string; // Bastion action name (e.g., "stripe.charges")
  injection?: InjectionConfig; // Override default credential injection
  params?: ParamsMapping; // Extract policy params from tool args
}

export interface BastionPluginConfig {
  serverUrl: string;
  agentSecret: SecretValue;
  rules: InterceptionRule[];
  timeout?: number; // Default: 30000ms
  onUnreachable?: 'block'; // Always fail-closed (only option for now)
}
```

---

## Implementation Details

### Step 1: Package scaffolding

Create `packages/openclaw-plugin/` with `package.json`, `tsconfig.json`, `vitest.config.ts`. Add to root workspaces.

**Files:** `packages/openclaw-plugin/package.json`, `tsconfig.json`, `vitest.config.ts`

**Template:** Mirror `packages/sdk-node/` structure exactly

### Step 2: Types (`types.ts`)

Define all plugin types plus minimal OpenClaw API surface types:

```typescript
// Minimal OpenClaw plugin API types (replace when OpenClaw publishes official types)
export interface OpenClawPluginApi {
  on(event: string, handler: (...args: unknown[]) => unknown): void;
  registerService(service: { id: string; start?: () => void; stop?: () => void }): void;
  logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

export interface BeforeCallEvent {
  agentId: string;
  sessionKey: string;
  toolName: string;
  args: Record<string, unknown>;
}
```

Plus all config types listed above.

### Step 3: Secret resolution (`secretRef.ts`)

```typescript
export async function resolveSecret(ref: SecretValue): Promise<string>;
```

- Plain string -> return directly
- `{ $env: "VAR" }` -> `process.env.VAR`, throw if empty/missing
- `{ $file: "/path" }` -> `fs.readFile`, trim whitespace
- `{ $exec: "command" }` -> `child_process.execSync`, capture stdout

This follows OpenClaw's own SecretRef pattern (env/file/exec sources).

### Step 4: Rule engine (`ruleEngine.ts`)

```typescript
export interface CompiledRule extends InterceptionRule {
  urlRegex: RegExp;
}

export function compileRules(rules: InterceptionRule[]): CompiledRule[];
export function matchRule(
  toolName: string,
  toolArgs: Record<string, unknown>,
  rules: CompiledRule[],
): CompiledRule | null;
export function extractParams(
  args: Record<string, unknown>,
  mapping: ParamsMapping,
): { amount?: number; ip?: string };
```

**Matching logic:**

1. Filter by `rule.tool === toolName`
2. Extract URL from `args.url` (for `web_fetch`)
3. Match URL against `rule.urlRegex` (compiled from glob pattern at startup)
4. **First match wins** — users control priority by rule ordering
5. Return `null` if no match (tool proceeds normally)

**Glob -> regex conversion:**

- `*` matches any characters except `/` (single path segment)
- `**` matches anything (multiple segments)
- All other characters escaped for regex safety
- Patterns compiled once at startup, cached on each rule

**Params extraction:** Simple dot-path resolution (e.g., `"body.amount"` -> `args.body.amount`). No full JSONPath needed for MVP.

### Step 5: Response adapter (`responseAdapter.ts`)

```typescript
export function adaptResponse(
  result: ProxyExecuteResult,
  originalUrl: string,
): Record<string, unknown>;
```

Maps Bastion's `ProxyExecuteResult` to OpenClaw's `web_fetch` return format:

```typescript
{
  status: result.upstream.status,
  headers: result.upstream.headers,
  body: result.upstream.body,
  url: originalUrl,
  _bastion: {
    credentialId: result.meta.credentialId,
    action: result.meta.action,
    policyDecision: result.meta.policyDecision,
    durationMs: result.meta.durationMs,
    hitlRequestId: result.meta.hitlRequestId,
  }
}
```

### Step 6: Bastion bridge (`bastionBridge.ts`)

```typescript
export class BastionBridge {
  private client: BastionClient;

  constructor(serverUrl: string, agentSecret: string, defaultTimeout?: number);

  async executeProxy(
    rule: CompiledRule,
    toolArgs: Record<string, unknown>,
  ): Promise<ProxyExecuteResult>;
  async healthCheck(): Promise<boolean>;
}
```

**`executeProxy` builds `ProxyExecuteInput` from rule + tool args:**

- `credentialId` -> from rule
- `action` -> from rule
- `target.url` -> from `toolArgs.url`
- `target.method` -> from `toolArgs.method` (default `"GET"`)
- `target.headers` -> from `toolArgs.headers` (default `{}`)
- `target.body` -> from `toolArgs.body`
- `injection` -> from rule (optional)
- `params` -> extracted via `extractParams(toolArgs, rule.params)`

Calls `this.client.execute(input)`. On network error -> throw `BastionUnreachableError`. On 403 -> propagate as `BastionBlockedError`.

**HITL handling:** Bastion blocks server-side for up to 5 minutes on ESCALATE. The plugin's HTTP call simply waits. Set a client-side `AbortController` timeout of 330 seconds (5.5 min) to handle edge cases.

### Step 7: Core plugin (`plugin.ts`)

```typescript
export default function bastionPlugin(api: OpenClawPluginApi): void;
```

Implementation:

1. Read config from `api` (OpenClaw passes plugin config to register function)
2. Validate config (throw early on missing `serverUrl`, empty `rules`, etc.)
3. Resolve `agentSecret` via `resolveSecret()`
4. Instantiate `BastionBridge`
5. Compile rules (glob -> regex)
6. Run health check (log warning if unreachable, don't block startup)
7. Register before-call hook:

```typescript
api.on('before_tool_call', async (event: BeforeCallEvent) => {
  const rule = matchRule(event.toolName, event.args, compiledRules);
  if (!rule) return; // No match — proceed normally

  try {
    const result = await bridge.executeProxy(rule, event.args);
    return { result: adaptResponse(result, event.args.url as string) };
  } catch (error) {
    if (error instanceof BastionBlockedError) {
      return { error: `Blocked by Bastion: ${error.message}` };
    }
    if (error instanceof BastionUnreachableError) {
      return { error: 'Bastion server unreachable. Tool call blocked (fail-closed).' };
    }
    return { error: `Bastion error: ${error instanceof Error ? error.message : String(error)}` };
  }
});
```

8. Register service for health monitoring:

```typescript
api.registerService({
  id: 'bastion-proxy',
  start: () => api.logger.info('Bastion proxy plugin active'),
  stop: () => api.logger.info('Bastion proxy plugin stopped'),
});
```

### Step 8: Entry point + manifest

**`index.ts`:**

```typescript
export { default } from './plugin.js';
export type { BastionPluginConfig, InterceptionRule, SecretValue } from './types.js';
```

**`openclaw.plugin.json`:**

```json
{
  "id": "bastion",
  "version": "0.1.0",
  "description": "Secure AI agent tool calls with Bastion — credential vault, policy engine, HITL gate, audit trail",
  "entry": "./dist/index.js",
  "configSchema": {
    "type": "object",
    "required": ["serverUrl", "agentSecret", "rules"],
    "properties": {
      "serverUrl": { "type": "string" },
      "agentSecret": {},
      "rules": { "type": "array" },
      "timeout": { "type": "number", "default": 30000 }
    }
  }
}
```

### Step 9: README.md

Setup guide covering:

1. Prerequisites (running Bastion server)
2. Installation (`openclaw plugins install @bastion-ai/bastion`)
3. Bastion setup (create agent, store credential, create policy)
4. Plugin configuration (openclaw.json example)
5. How it works (flow diagram)
6. Troubleshooting

### Step 10: Monorepo integration

- Add `"packages/openclaw-plugin"` to root `package.json` workspaces
- Verify `npm run build`, `npm run lint`, `npm run format:check`, `npm test` all pass
- Update CI if needed (the existing `npm run build --workspaces` and `npm test` scripts will automatically pick up the new workspace)

---

## OSS API Changes

**None required.** The existing API fully supports the plugin:

| Plugin need | Existing API |
| --- | --- |
| Authenticate as agent | `Authorization: Bearer bst_...` (requireAgent middleware) |
| Execute proxied call | `POST /v1/proxy/execute` (agent-authenticated) |
| Policy evaluation | Inline in proxy/execute (ALLOW/DENY/ESCALATE) |
| HITL blocking | Server-side in proxy/execute (blocks up to 5 min) |
| Audit recording | Automatic in proxy/execute (signed, hash-chained) |
| Health check | `GET /health` |

**Future consideration:** For auditing non-HTTP tool calls (e.g., `gmail_send`), a `POST /v1/audit/record` endpoint would be needed. Not required for MVP since the primary interception target is `web_fetch`.

---

## Testing Strategy

All tests use Vitest, same as existing packages. No external dependencies needed.

### Unit Tests

**`ruleEngine.test.ts`:**

- Exact URL match, glob `*` (single segment), glob `**` (multi-segment)
- No match returns null, non-matching tool name returns null
- First-match-wins ordering with multiple matching rules
- Missing/invalid URL in args returns null
- Params extraction from nested tool args

**`bastionBridge.test.ts`:**

- Mock `global.fetch` (same pattern as `packages/sdk-node/src/__test__/client.test.ts`)
- Verify correct `ProxyExecuteInput` construction from rule + tool args
- Network error -> `BastionUnreachableError`
- 403 response -> `BastionBlockedError`
- Successful proxy returns `ProxyExecuteResult`

**`secretRef.test.ts`:**

- `$env` reads from process.env, throws on missing
- `$file` reads from filesystem (mock fs)
- `$exec` executes command (mock child_process)
- Plain string passthrough
- Empty resolved value throws

**`responseAdapter.test.ts`:**

- Maps status/headers/body correctly
- Adds `_bastion` metadata
- Handles missing body

**`plugin.test.ts`:**

- Mock `OpenClawPluginApi` to capture registered hooks
- Matched tool call -> returns Bastion response
- Unmatched tool call -> returns undefined (proceeds normally)
- Unreachable Bastion -> returns error (fail-closed)
- Invalid config -> throws during registration

---

## Interception Flow (End to End)

```text
Agent calls web_fetch("https://api.stripe.com/v1/charges", { method: "POST", body: {...} })
  |
  v
OpenClaw Gateway fires before_tool_call hook
  |
  v
Bastion plugin: matchRule("web_fetch", args, rules)
  |
  |-- No match -> return undefined -> tool proceeds normally
  |
  +-- Match found (rule: stripe, credentialId: cred_abc, action: stripe.charges)
      |
      v
      BastionBridge.executeProxy(rule, args)
        |
        v
        POST /v1/proxy/execute
        {
          credentialId: "cred_abc123",
          action: "stripe.charges",
          params: { amount: 5000 },
          target: { url: "https://api.stripe.com/v1/charges", method: "POST", body: {...} },
          injection: { location: "header", key: "Authorization" }
        }
          |
          v
        Bastion server:
          1. Validate credential ownership
          2. Evaluate policy -> ALLOW / DENY / ESCALATE
          3. If ALLOW: decrypt credential, inject into request, call Stripe API
          4. Append signed audit record
          5. Return { upstream: { status, headers, body }, meta: {...} }
          |
          v
      adaptResponse(result) -> { status: 200, body: {...}, _bastion: {...} }
        |
        v
      Return to agent as web_fetch result (agent doesn't know Bastion was involved)
```

---

## Edge Cases

| Edge case | Handling |
| --- | --- |
| Tool has no URL in args | `matchRule` returns null, tool proceeds normally |
| Multiple rules match | First-match-wins (documented, user controls order) |
| ESCALATE (HITL gate) | Server blocks up to 5 min. Plugin waits with 330s client timeout |
| HITL denied/timeout | 403 from server -> plugin returns error to agent |
| Bastion unreachable at startup | Log warning, continue. Fail at call time |
| Bastion unreachable at call time | Return error, block tool call (fail-closed) |
| Invalid credential (revoked/expired) | Bastion returns 403, plugin surfaces error |
| Config missing required fields | `register()` throws during plugin initialization |

---

## Credential Strategy

OpenClaw manages its own credentials for LLM providers, channels, and non-sensitive tools. Bastion manages credentials for external APIs that agents access via `web_fetch`:

- **Stored in Bastion:** Stripe API key, GitHub token, Slack bot token, etc. (encrypted at rest, never exposed to agent)
- **Stays in OpenClaw:** Anthropic API key, OpenAI key, channel tokens (these don't go through Bastion)
- **Plugin config maps:** `web_fetch` calls to specific URLs -> Bastion credential IDs

This means agents don't need to change. They call `web_fetch` as usual. The plugin transparently intercepts matching calls and routes them through Bastion, which handles credential injection. The agent never sees the actual API key.

---

## Do We Need Bastion Cloud First?

**No.** The plugin works with self-hosted Bastion today (`docker compose up`). Cloud would improve onboarding (no Docker setup) but is not a prerequisite. The plugin is server-agnostic — it only needs a `serverUrl` and `agentSecret`.

---

## Critical Files

| File | Why |
| --- | --- |
| `packages/sdk-node/src/client.ts` | `BastionClient.execute()` — the method the bridge wraps |
| `packages/sdk-node/src/types.ts` | `ProxyExecuteInput`, `ProxyExecuteResult`, `InjectionConfig` — exact contract |
| `packages/sdk-node/src/errors.ts` | Error types the bridge catches |
| `packages/sdk-node/package.json` | Template for the new package structure |
| `packages/sdk-node/src/__test__/client.test.ts` | Testing pattern to follow (mock global.fetch) |
| `packages/api/src/services/proxy.ts` | Server-side proxy flow (for understanding the full pipeline) |
| `packages/api/src/middleware/auth.ts` | Agent authentication (requireAgent middleware) |
| `package.json` (root) | Workspaces array to update |

---

## Verification

After implementation:

1. `npm run build` — all workspaces compile (including new plugin)
2. `npm test` — all unit tests pass (including new plugin tests)
3. `npm run lint` && `npm run format:check` — clean
4. Manual test: start Bastion server (`docker compose up && npm run dev`), create agent + credential + policy, configure OpenClaw with plugin, make a `web_fetch` call matching a rule -> verify it routes through Bastion, audit record is created, credential is injected
5. Manual test: make a `web_fetch` call NOT matching any rule -> verify it proceeds normally
6. Manual test: stop Bastion server, make a matching `web_fetch` call -> verify fail-closed error
