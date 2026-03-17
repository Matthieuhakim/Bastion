# @bastion-ai/openclaw-plugin

OpenClaw plugin for [Bastion](https://github.com/Matthieuhakim/Bastion).

It ships a `bastion_fetch` tool that sends outbound HTTP requests through Bastion, so Bastion can enforce policy, inject credentials, handle HITL approval, and append audit records. It can also block direct calls to protected URLs on built-in tools like `web_fetch`.

## Compatibility

- OpenClaw `2026.3.13+`
- Node.js `22+`
- A running Bastion server

This plugin targets the current released OpenClaw runtime by registering an explicit tool. It does not rely on unreleased transparent result-injection hooks.

## Installation

### From npm

```bash
openclaw plugins install @bastion-ai/openclaw-plugin
```

The installed plugin ID is `bastion-fetch`, so configure it under `plugins.entries["bastion-fetch"]`.

### Local development / pre-publish

From the Bastion repo root:

```bash
npm run build --workspace=packages/openclaw-plugin
openclaw plugins install -l ./packages/openclaw-plugin
```

Or install a packed tarball:

```bash
npm pack --workspace=packages/openclaw-plugin
openclaw plugins install ./packages/openclaw-plugin/bastion-ai-openclaw-plugin-0.1.0.tgz
```

## Bastion Setup

1. Create an agent and save the returned `agentSecret` (`bst_...`):

```bash
curl -X POST http://localhost:3000/v1/agents \
  -H "Authorization: Bearer $PROJECT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-openclaw-agent"}'
```

2. Store the upstream credential Bastion should inject:

```bash
curl -X POST http://localhost:3000/v1/credentials \
  -H "Authorization: Bearer $PROJECT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Stripe API Key", "type": "API_KEY", "value": "sk_live_...", "agentId": "<agentId>"}'
```

3. Create a policy that allows the action:

```bash
curl -X POST http://localhost:3000/v1/policies \
  -H "Authorization: Bearer $PROJECT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agentId": "<agentId>", "credentialId": "<credentialId>", "allowedActions": ["stripe.*"]}'
```

## OpenClaw Configuration

Add this to `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "bastion-fetch": {
        "enabled": true,
        "config": {
          "serverUrl": "http://localhost:3000",
          "agentSecret": { "$env": "BASTION_AGENT_SECRET" },
          "rules": [
            {
              "tool": "web_fetch",
              "urlPattern": "https://api.stripe.com/**",
              "credentialId": "cred_abc123",
              "action": "stripe.charges"
            },
            {
              "tool": "web_fetch",
              "urlPattern": "https://api.github.com/**",
              "credentialId": "cred_def456",
              "action": "github.api",
              "injection": { "location": "header", "key": "Authorization" }
            }
          ],
          "timeout": 30000
        }
      }
    }
  }
}
```

Set your agent secret:

```bash
export BASTION_AGENT_SECRET=bst_...
```

## How Users Implement It

Agents should call `bastion_fetch` for protected outbound API requests.

Example tool call:

```json
{
  "tool": "bastion_fetch",
  "params": {
    "url": "https://api.stripe.com/v1/charges",
    "method": "POST",
    "body": {
      "amount": 5000,
      "currency": "usd"
    }
  }
}
```

The plugin matches the request URL against the configured rules, resolves the Bastion credential/action pair, calls Bastion's `/v1/proxy/execute`, and returns a structured tool result containing:

- `status`
- `headers`
- `body`
- `url`
- `_bastion` metadata (`credentialId`, `action`, `policyDecision`, `durationMs`, optional `hitlRequestId`)

If a rule includes `tool`, the plugin also blocks direct calls to that tool for matching URLs. For example, `tool: "web_fetch"` prevents the model from bypassing Bastion for those domains.

## Prompting Guidance

In your agent instructions, tell the model:

```text
Use `bastion_fetch` for requests to protected APIs such as Stripe or GitHub. Do not use `web_fetch` for those domains.
```

That keeps the workflow deterministic and lets the plugin enforce policy cleanly.

## `agentSecret` formats

| Format | Example |
|--------|---------|
| Plain string | `"bst_abc123..."` |
| Environment variable | `{ "$env": "BASTION_AGENT_SECRET" }` |
| File | `{ "$file": "/run/secrets/bastion_secret" }` |
| Command | `{ "$exec": "vault read -field=secret secret/bastion" }` |

## Rule Options

| Field | Required | Description |
|-------|----------|-------------|
| `tool` | No | Built-in tool to block for matching URLs, e.g. `web_fetch` |
| `urlPattern` | Yes | Glob pattern. `*` matches one path segment, `**` matches any depth |
| `credentialId` | Yes | Bastion credential ID |
| `action` | Yes | Action name for Bastion policy evaluation |
| `injection` | No | Override credential injection (`header` / `query` / `body`) |
| `params` | No | Dot-paths to extract Bastion policy params, e.g. `{ "amount": "body.amount" }` |

Rules are evaluated in order. Put more specific patterns before broader wildcards.

## Troubleshooting

**Plugin logs "server is unreachable"**  
Bastion is not running or not reachable from OpenClaw. Start it with `docker compose up -d && npm run dev`.

**`bastion_fetch` returns "Blocked by Bastion policy"**  
The agent's policy denied the action. Check Bastion policies or audit entries.

**`bastion_fetch` hangs for minutes**  
The request hit a HITL rule and Bastion is waiting for approval. Review pending requests via `GET /v1/hitl/pending`.

**Direct `web_fetch` calls are blocked**  
That is expected when a matching rule defines `tool: "web_fetch"`. Use `bastion_fetch` instead.
