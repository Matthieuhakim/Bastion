# bastion-sdk

Python SDK for the [Bastion](../../README.md) trust proxy. Supports both sync and async usage.

## Installation

```bash
pip install bastion-sdk
```

Requires Python 3.10+.

## Quick Start

```python
from bastion_sdk import BastionClient

with BastionClient("http://localhost:3000", api_key="your-project-api-key") as client:
    print(client.health())
```

### Async

```python
from bastion_sdk import AsyncBastionClient

async with AsyncBastionClient("http://localhost:3000", api_key="your-key") as client:
    print(await client.health())
```

## Admin Operations

Use the admin API key (`PROJECT_API_KEY`) to manage agents, credentials, and policies.

### Agents

```python
# Create an agent (returns one-time agentSecret)
agent = client.create_agent("Support Bot", description="Handles refund requests")
agent_secret = agent["agentSecret"]  # save this — shown only once

# List, get, update, delete
agents = client.list_agents()
agent = client.get_agent(agent["id"])
client.update_agent(agent["id"], isActive=False)
client.delete_agent(agent["id"])  # soft-delete
```

### Credentials

```python
# Store a credential (encrypted at rest, raw value never returned)
credential = client.create_credential(
    name="Stripe Production",
    type="API_KEY",
    value="sk_live_...",
    agent_id=agent["id"],
)

credentials = client.list_credentials(agent_id=agent["id"])
client.revoke_credential(credential["id"])
```

### Policies

```python
policy = client.create_policy(
    agent_id=agent["id"],
    credential_id=credential["id"],
    allowed_actions=["charges.*"],
    denied_actions=["transfers.*"],
    constraints={
        "maxAmountPerTransaction": 1000,
        "maxDailySpend": 5000,
        "rateLimit": {"maxRequests": 100, "windowSeconds": 3600},
    },
    requires_approval_above=500,
)

# Dry-run evaluation (no side effects)
result = client.evaluate_policy(
    agent_id=agent["id"],
    credential_id=credential["id"],
    action="charges.create",
    params={"amount": 750},
)
# result["decision"] → "ESCALATE"
```

## Agent Operations

Use an agent secret (`bst_...`) for proxy execution.

```python
agent_client = BastionClient("http://localhost:3000", api_key=agent_secret)

result = agent_client.execute(
    credential_id=credential["id"],
    action="charges.create",
    target={
        "url": "https://api.stripe.com/v1/charges",
        "method": "POST",
        "body": {"amount": 5000, "currency": "usd"},
    },
    params={"amount": 50},
)

# result["upstream"]["status"] → 200
# result["upstream"]["body"] → Stripe's response
# result["meta"]["policyDecision"] → "ALLOW"
```

### Custom Credential Injection

```python
agent_client.execute(
    credential_id=credential["id"],
    action="test",
    target={"url": "https://api.example.com"},
    injection={"location": "header", "key": "X-Api-Key"},
)
```

## HITL (Human-in-the-Loop)

```python
pending = client.list_pending_requests()
client.approve_request(pending[0]["requestId"])
client.deny_request(request_id, "Too risky")
```

## Audit

```python
records = client.query_audit_records(
    agent["id"],
    from_="2026-01-01",
    policy_decision="DENY",
    limit=10,
)

verification = client.verify_chain(agent["id"])
# verification["valid"] → True
```

## Error Handling

All API errors raise typed exceptions:

```python
from bastion_sdk import BastionForbiddenError, BastionNotFoundError

try:
    agent_client.execute(...)
except BastionForbiddenError as e:
    print(f"Policy denied: {e.message}")
```

| Error Class | Status | When |
|------------|--------|------|
| `BastionValidationError` | 400 | Invalid input |
| `BastionUnauthorizedError` | 401 | Bad or missing auth |
| `BastionForbiddenError` | 403 | Policy DENY or HITL timeout |
| `BastionNotFoundError` | 404 | Resource not found |
| `BastionConflictError` | 409 | State conflict |
| `BastionBadGatewayError` | 502 | Upstream API failure |

## License

[MIT](../../LICENSE)
