"""Tests for AsyncBastionClient."""

import httpx
import pytest
import respx

from bastion_sdk import (
    AsyncBastionClient,
    BastionForbiddenError,
    BastionNotFoundError,
    BastionValidationError,
)

BASE_URL = "http://localhost:3000"
API_KEY = "test-api-key"


@pytest.fixture()
async def client():
    c = AsyncBastionClient(BASE_URL, API_KEY)
    yield c
    await c.close()


class TestHealth:
    @respx.mock
    async def test_health(self, client: AsyncBastionClient):
        body = {"status": "ok", "timestamp": "2026-03-16T00:00:00Z", "version": "0.1.0"}
        respx.get(f"{BASE_URL}/health").mock(return_value=httpx.Response(200, json=body))
        assert await client.health() == body


class TestAgents:
    @respx.mock
    async def test_create_agent(self, client: AsyncBastionClient):
        respx.post(f"{BASE_URL}/v1/agents").mock(
            return_value=httpx.Response(201, json={"id": "a1", "agentSecret": "bst_abc"})
        )
        result = await client.create_agent("Bot", description="Test bot")
        assert result["id"] == "a1"

    @respx.mock
    async def test_list_agents(self, client: AsyncBastionClient):
        respx.get(f"{BASE_URL}/v1/agents").mock(
            return_value=httpx.Response(200, json=[])
        )
        assert await client.list_agents() == []

    @respx.mock
    async def test_delete_agent(self, client: AsyncBastionClient):
        respx.delete(f"{BASE_URL}/v1/agents/a1").mock(
            return_value=httpx.Response(200, json={"id": "a1", "isActive": False})
        )
        result = await client.delete_agent("a1")
        assert result["isActive"] is False


class TestCredentials:
    @respx.mock
    async def test_create_credential(self, client: AsyncBastionClient):
        respx.post(f"{BASE_URL}/v1/credentials").mock(
            return_value=httpx.Response(201, json={"id": "c1"})
        )
        result = await client.create_credential(
            name="Stripe", type="API_KEY", value="sk_test", agent_id="a1"
        )
        assert result["id"] == "c1"

    @respx.mock
    async def test_revoke_credential(self, client: AsyncBastionClient):
        respx.delete(f"{BASE_URL}/v1/credentials/c1").mock(
            return_value=httpx.Response(200, json={"id": "c1", "isRevoked": True})
        )
        result = await client.revoke_credential("c1")
        assert result["isRevoked"] is True


class TestPolicies:
    @respx.mock
    async def test_create_policy(self, client: AsyncBastionClient):
        respx.post(f"{BASE_URL}/v1/policies").mock(
            return_value=httpx.Response(201, json={"id": "p1"})
        )
        result = await client.create_policy(agent_id="a1", credential_id="c1")
        assert result["id"] == "p1"

    @respx.mock
    async def test_evaluate_policy(self, client: AsyncBastionClient):
        respx.post(f"{BASE_URL}/v1/policies/evaluate").mock(
            return_value=httpx.Response(200, json={"decision": "DENY", "policyId": None, "reason": "denied"})
        )
        result = await client.evaluate_policy(
            agent_id="a1", credential_id="c1", action="transfers.create"
        )
        assert result["decision"] == "DENY"


class TestProxy:
    @respx.mock
    async def test_execute(self, client: AsyncBastionClient):
        respx.post(f"{BASE_URL}/v1/proxy/execute").mock(
            return_value=httpx.Response(200, json={
                "upstream": {"status": 200, "headers": {}, "body": {}},
                "meta": {"policyDecision": "ALLOW"},
            })
        )
        result = await client.execute(
            credential_id="c1",
            action="test",
            target={"url": "https://api.example.com"},
        )
        assert result["meta"]["policyDecision"] == "ALLOW"


class TestHitl:
    @respx.mock
    async def test_approve(self, client: AsyncBastionClient):
        respx.post(f"{BASE_URL}/v1/hitl/r1/approve").mock(
            return_value=httpx.Response(200, json={"requestId": "r1", "status": "approved", "message": "ok"})
        )
        result = await client.approve_request("r1")
        assert result["status"] == "approved"

    @respx.mock
    async def test_deny_with_reason(self, client: AsyncBastionClient):
        respx.post(f"{BASE_URL}/v1/hitl/r1/deny").mock(
            return_value=httpx.Response(200, json={"requestId": "r1", "status": "denied", "message": "ok"})
        )
        result = await client.deny_request("r1", "Not allowed")
        assert result["status"] == "denied"


class TestAudit:
    @respx.mock
    async def test_verify_chain(self, client: AsyncBastionClient):
        respx.get(f"{BASE_URL}/v1/audit/verify").mock(
            return_value=httpx.Response(200, json={"valid": True, "recordCount": 3})
        )
        result = await client.verify_chain("a1")
        assert result["valid"] is True

    @respx.mock
    async def test_query_audit_records(self, client: AsyncBastionClient):
        respx.get(f"{BASE_URL}/v1/audit").mock(
            return_value=httpx.Response(200, json={"records": [], "nextCursor": None})
        )
        result = await client.query_audit_records("a1", from_="2026-01-01")
        assert result["records"] == []


class TestErrors:
    @respx.mock
    async def test_forbidden(self, client: AsyncBastionClient):
        respx.get(f"{BASE_URL}/health").mock(
            return_value=httpx.Response(403, json={"message": "denied"})
        )
        with pytest.raises(BastionForbiddenError, match="denied"):
            await client.health()

    @respx.mock
    async def test_not_found(self, client: AsyncBastionClient):
        respx.get(f"{BASE_URL}/v1/agents/nope").mock(
            return_value=httpx.Response(404, json={"message": "not found"})
        )
        with pytest.raises(BastionNotFoundError):
            await client.get_agent("nope")

    @respx.mock
    async def test_validation_error(self, client: AsyncBastionClient):
        respx.post(f"{BASE_URL}/v1/agents").mock(
            return_value=httpx.Response(400, json={"message": "name required"})
        )
        with pytest.raises(BastionValidationError):
            await client.create_agent("")


class TestContextManager:
    @respx.mock
    async def test_async_context_manager(self):
        respx.get(f"{BASE_URL}/health").mock(
            return_value=httpx.Response(200, json={"status": "ok"})
        )
        async with AsyncBastionClient(BASE_URL, API_KEY) as c:
            result = await c.health()
            assert result["status"] == "ok"
