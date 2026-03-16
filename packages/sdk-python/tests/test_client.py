"""Tests for BastionClient (sync)."""

import httpx
import pytest
import respx

from bastion_sdk import (
    BastionClient,
    BastionBadGatewayError,
    BastionConflictError,
    BastionError,
    BastionForbiddenError,
    BastionNotFoundError,
    BastionUnauthorizedError,
    BastionValidationError,
)

BASE_URL = "http://localhost:3000"
API_KEY = "test-api-key"


@pytest.fixture()
def client():
    with BastionClient(BASE_URL, API_KEY) as c:
        yield c


class TestHealth:
    @respx.mock
    def test_health(self, client: BastionClient):
        body = {"status": "ok", "timestamp": "2026-03-16T00:00:00Z", "version": "0.1.0"}
        respx.get(f"{BASE_URL}/health").mock(return_value=httpx.Response(200, json=body))
        assert client.health() == body


class TestAgents:
    @respx.mock
    def test_create_agent(self, client: BastionClient):
        respx.post(f"{BASE_URL}/v1/agents").mock(
            return_value=httpx.Response(201, json={"id": "a1", "agentSecret": "bst_abc"})
        )
        result = client.create_agent("Bot", description="Test bot")
        assert result["id"] == "a1"
        assert result["agentSecret"] == "bst_abc"

    @respx.mock
    def test_list_agents(self, client: BastionClient):
        respx.get(f"{BASE_URL}/v1/agents").mock(
            return_value=httpx.Response(200, json=[])
        )
        assert client.list_agents() == []

    @respx.mock
    def test_get_agent(self, client: BastionClient):
        respx.get(f"{BASE_URL}/v1/agents/a1").mock(
            return_value=httpx.Response(200, json={"id": "a1"})
        )
        assert client.get_agent("a1")["id"] == "a1"

    @respx.mock
    def test_update_agent(self, client: BastionClient):
        respx.patch(f"{BASE_URL}/v1/agents/a1").mock(
            return_value=httpx.Response(200, json={"id": "a1", "name": "Updated"})
        )
        result = client.update_agent("a1", name="Updated")
        assert result["name"] == "Updated"

    @respx.mock
    def test_delete_agent(self, client: BastionClient):
        respx.delete(f"{BASE_URL}/v1/agents/a1").mock(
            return_value=httpx.Response(200, json={"id": "a1", "isActive": False})
        )
        result = client.delete_agent("a1")
        assert result["isActive"] is False


class TestCredentials:
    @respx.mock
    def test_create_credential(self, client: BastionClient):
        respx.post(f"{BASE_URL}/v1/credentials").mock(
            return_value=httpx.Response(201, json={"id": "c1", "name": "Stripe"})
        )
        result = client.create_credential(
            name="Stripe", type="API_KEY", value="sk_test", agent_id="a1"
        )
        assert result["id"] == "c1"

    @respx.mock
    def test_list_credentials_with_filter(self, client: BastionClient):
        route = respx.get(f"{BASE_URL}/v1/credentials").mock(
            return_value=httpx.Response(200, json=[])
        )
        client.list_credentials("a1")
        assert "agentId=a1" in str(route.calls[0].request.url)

    @respx.mock
    def test_list_credentials_no_filter(self, client: BastionClient):
        route = respx.get(f"{BASE_URL}/v1/credentials").mock(
            return_value=httpx.Response(200, json=[])
        )
        client.list_credentials()
        assert "agentId" not in str(route.calls[0].request.url)

    @respx.mock
    def test_revoke_credential(self, client: BastionClient):
        respx.delete(f"{BASE_URL}/v1/credentials/c1").mock(
            return_value=httpx.Response(200, json={"id": "c1", "isRevoked": True})
        )
        result = client.revoke_credential("c1")
        assert result["isRevoked"] is True


class TestPolicies:
    @respx.mock
    def test_create_policy(self, client: BastionClient):
        respx.post(f"{BASE_URL}/v1/policies").mock(
            return_value=httpx.Response(201, json={"id": "p1"})
        )
        result = client.create_policy(agent_id="a1", credential_id="c1")
        assert result["id"] == "p1"

    @respx.mock
    def test_list_policies_with_filters(self, client: BastionClient):
        route = respx.get(f"{BASE_URL}/v1/policies").mock(
            return_value=httpx.Response(200, json=[])
        )
        client.list_policies(agent_id="a1", credential_id="c1")
        url = str(route.calls[0].request.url)
        assert "agentId=a1" in url
        assert "credentialId=c1" in url

    @respx.mock
    def test_evaluate_policy(self, client: BastionClient):
        eval_result = {"decision": "ALLOW", "policyId": "p1", "reason": "ok"}
        respx.post(f"{BASE_URL}/v1/policies/evaluate").mock(
            return_value=httpx.Response(200, json=eval_result)
        )
        result = client.evaluate_policy(
            agent_id="a1", credential_id="c1", action="charges.create", params={"amount": 100}
        )
        assert result["decision"] == "ALLOW"

    @respx.mock
    def test_delete_policy(self, client: BastionClient):
        respx.delete(f"{BASE_URL}/v1/policies/p1").mock(
            return_value=httpx.Response(200, json={"id": "p1", "isActive": False})
        )
        result = client.delete_policy("p1")
        assert result["isActive"] is False


class TestProxy:
    @respx.mock
    def test_execute(self, client: BastionClient):
        proxy_result = {
            "upstream": {"status": 200, "headers": {}, "body": {"ok": True}},
            "meta": {"credentialId": "c1", "action": "test", "policyDecision": "ALLOW"},
        }
        respx.post(f"{BASE_URL}/v1/proxy/execute").mock(
            return_value=httpx.Response(200, json=proxy_result)
        )
        result = client.execute(
            credential_id="c1",
            action="test.create",
            target={"url": "https://api.example.com/test", "method": "POST"},
        )
        assert result["upstream"]["status"] == 200

    @respx.mock
    def test_execute_with_injection(self, client: BastionClient):
        respx.post(f"{BASE_URL}/v1/proxy/execute").mock(
            return_value=httpx.Response(200, json={"upstream": {}, "meta": {}})
        )
        client.execute(
            credential_id="c1",
            action="test",
            target={"url": "https://api.example.com"},
            injection={"location": "header", "key": "X-Api-Key"},
            timeout=5000,
        )


class TestHitl:
    @respx.mock
    def test_list_pending(self, client: BastionClient):
        respx.get(f"{BASE_URL}/v1/hitl/pending").mock(
            return_value=httpx.Response(200, json=[])
        )
        assert client.list_pending_requests() == []

    @respx.mock
    def test_approve(self, client: BastionClient):
        respx.post(f"{BASE_URL}/v1/hitl/r1/approve").mock(
            return_value=httpx.Response(
                200, json={"requestId": "r1", "status": "approved", "message": "ok"}
            )
        )
        result = client.approve_request("r1")
        assert result["status"] == "approved"

    @respx.mock
    def test_deny_with_reason(self, client: BastionClient):
        respx.post(f"{BASE_URL}/v1/hitl/r1/deny").mock(
            return_value=httpx.Response(
                200, json={"requestId": "r1", "status": "denied", "message": "ok"}
            )
        )
        result = client.deny_request("r1", "Too risky")
        assert result["status"] == "denied"

    @respx.mock
    def test_deny_without_reason(self, client: BastionClient):
        respx.post(f"{BASE_URL}/v1/hitl/r1/deny").mock(
            return_value=httpx.Response(
                200, json={"requestId": "r1", "status": "denied", "message": "ok"}
            )
        )
        client.deny_request("r1")


class TestAudit:
    @respx.mock
    def test_query_with_all_params(self, client: BastionClient):
        route = respx.get(f"{BASE_URL}/v1/audit").mock(
            return_value=httpx.Response(200, json={"records": [], "nextCursor": None})
        )
        client.query_audit_records(
            "a1", from_="2026-01-01", to="2026-12-31", action="charges.create",
            policy_decision="ALLOW", cursor="100", limit=25,
        )
        url = str(route.calls[0].request.url)
        assert "agentId=a1" in url
        assert "from=2026-01-01" in url
        assert "limit=25" in url

    @respx.mock
    def test_query_minimal(self, client: BastionClient):
        route = respx.get(f"{BASE_URL}/v1/audit").mock(
            return_value=httpx.Response(200, json={"records": [], "nextCursor": None})
        )
        client.query_audit_records("a1")
        url = str(route.calls[0].request.url)
        assert "agentId=a1" in url
        assert "from=" not in url

    @respx.mock
    def test_verify_chain(self, client: BastionClient):
        verify_result = {"valid": True, "recordCount": 5, "firstRecord": None, "lastRecord": None}
        respx.get(f"{BASE_URL}/v1/audit/verify").mock(
            return_value=httpx.Response(200, json=verify_result)
        )
        result = client.verify_chain("a1")
        assert result["valid"] is True


class TestErrors:
    ERROR_CASES = [
        (400, BastionValidationError),
        (401, BastionUnauthorizedError),
        (403, BastionForbiddenError),
        (404, BastionNotFoundError),
        (409, BastionConflictError),
        (502, BastionBadGatewayError),
    ]

    @respx.mock
    @pytest.mark.parametrize("status,error_cls", ERROR_CASES)
    def test_error_mapping(self, client: BastionClient, status: int, error_cls: type):
        respx.get(f"{BASE_URL}/health").mock(
            return_value=httpx.Response(status, json={"message": "test error"})
        )
        with pytest.raises(error_cls, match="test error"):
            client.health()

    @respx.mock
    def test_unknown_error(self, client: BastionClient):
        respx.get(f"{BASE_URL}/health").mock(
            return_value=httpx.Response(500, json={"message": "internal"})
        )
        with pytest.raises(BastionError) as exc_info:
            client.health()
        assert exc_info.value.status_code == 500


class TestAuth:
    @respx.mock
    def test_auth_header(self, client: BastionClient):
        route = respx.get(f"{BASE_URL}/health").mock(
            return_value=httpx.Response(200, json={})
        )
        client.health()
        assert route.calls[0].request.headers["authorization"] == f"Bearer {API_KEY}"
