"""Bastion API client — sync and async variants."""

from __future__ import annotations

from typing import Any

import httpx

from .errors import raise_for_status


class BastionClient:
    """Synchronous client for the Bastion trust proxy API."""

    def __init__(self, base_url: str, api_key: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self._client = httpx.Client(
            base_url=self.base_url,
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=httpx.Timeout(connect=10.0, read=360.0, write=10.0, pool=10.0),
        )

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any | None = None,
        params: dict[str, Any] | None = None,
    ) -> Any:
        filtered = {k: v for k, v in (params or {}).items() if v is not None}
        response = self._client.request(
            method,
            path,
            json=json,
            params=filtered or None,
        )
        raise_for_status(response)
        return response.json()

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._client.close()

    def __enter__(self) -> BastionClient:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

    # ── Health ──────────────────────────────────────────────────────────────

    def health(self) -> dict:
        """Check the health of the Bastion API."""
        return self._request("GET", "/health")

    # ── Agents (admin) ──────────────────────────────────────────────────────

    def create_agent(
        self,
        name: str,
        *,
        description: str | None = None,
        callback_url: str | None = None,
    ) -> dict:
        """Create a new agent. Returns the agent with a one-time agentSecret."""
        body: dict[str, Any] = {"name": name}
        if description is not None:
            body["description"] = description
        if callback_url is not None:
            body["callbackUrl"] = callback_url
        return self._request("POST", "/v1/agents", json=body)

    def list_agents(self) -> list[dict]:
        """List all agents."""
        return self._request("GET", "/v1/agents")

    def get_agent(self, agent_id: str) -> dict:
        """Get a single agent by ID."""
        return self._request("GET", f"/v1/agents/{agent_id}")

    def update_agent(self, agent_id: str, **kwargs: Any) -> dict:
        """Update an agent. Pass name, description, callbackUrl, or isActive."""
        return self._request("PATCH", f"/v1/agents/{agent_id}", json=kwargs)

    def delete_agent(self, agent_id: str) -> dict:
        """Soft-delete an agent (sets isActive to false)."""
        return self._request("DELETE", f"/v1/agents/{agent_id}")

    # ── Credentials (admin) ─────────────────────────────────────────────────

    def create_credential(
        self,
        *,
        name: str,
        type: str,
        value: str,
        agent_id: str,
        metadata: dict[str, Any] | None = None,
        scopes: list[str] | None = None,
        expires_at: str | None = None,
    ) -> dict:
        """Store a new credential (encrypted at rest)."""
        body: dict[str, Any] = {
            "name": name,
            "type": type,
            "value": value,
            "agentId": agent_id,
        }
        if metadata is not None:
            body["metadata"] = metadata
        if scopes is not None:
            body["scopes"] = scopes
        if expires_at is not None:
            body["expiresAt"] = expires_at
        return self._request("POST", "/v1/credentials", json=body)

    def list_credentials(self, agent_id: str | None = None) -> list[dict]:
        """List credentials, optionally filtered by agent_id."""
        return self._request("GET", "/v1/credentials", params={"agentId": agent_id})

    def get_credential(self, credential_id: str) -> dict:
        """Get a single credential by ID (masked, no raw value)."""
        return self._request("GET", f"/v1/credentials/{credential_id}")

    def revoke_credential(self, credential_id: str) -> dict:
        """Revoke a credential (sets isRevoked to true)."""
        return self._request("DELETE", f"/v1/credentials/{credential_id}")

    # ── Policies (admin) ────────────────────────────────────────────────────

    def create_policy(
        self,
        *,
        agent_id: str,
        credential_id: str,
        allowed_actions: list[str] | None = None,
        denied_actions: list[str] | None = None,
        constraints: dict[str, Any] | None = None,
        requires_approval_above: float | None = None,
        expires_at: str | None = None,
    ) -> dict:
        """Create a new policy for an agent+credential pair."""
        body: dict[str, Any] = {
            "agentId": agent_id,
            "credentialId": credential_id,
        }
        if allowed_actions is not None:
            body["allowedActions"] = allowed_actions
        if denied_actions is not None:
            body["deniedActions"] = denied_actions
        if constraints is not None:
            body["constraints"] = constraints
        if requires_approval_above is not None:
            body["requiresApprovalAbove"] = requires_approval_above
        if expires_at is not None:
            body["expiresAt"] = expires_at
        return self._request("POST", "/v1/policies", json=body)

    def list_policies(
        self,
        *,
        agent_id: str | None = None,
        credential_id: str | None = None,
    ) -> list[dict]:
        """List policies, optionally filtered by agent_id and/or credential_id."""
        return self._request(
            "GET",
            "/v1/policies",
            params={"agentId": agent_id, "credentialId": credential_id},
        )

    def get_policy(self, policy_id: str) -> dict:
        """Get a single policy by ID."""
        return self._request("GET", f"/v1/policies/{policy_id}")

    def update_policy(self, policy_id: str, **kwargs: Any) -> dict:
        """Update a policy's rules, constraints, or status."""
        return self._request("PATCH", f"/v1/policies/{policy_id}", json=kwargs)

    def delete_policy(self, policy_id: str) -> dict:
        """Deactivate a policy (sets isActive to false)."""
        return self._request("DELETE", f"/v1/policies/{policy_id}")

    def evaluate_policy(
        self,
        *,
        agent_id: str,
        credential_id: str,
        action: str,
        params: dict[str, Any] | None = None,
    ) -> dict:
        """Dry-run policy evaluation without side effects."""
        body: dict[str, Any] = {
            "agentId": agent_id,
            "credentialId": credential_id,
            "action": action,
        }
        if params is not None:
            body["params"] = params
        return self._request("POST", "/v1/policies/evaluate", json=body)

    # ── Proxy (agent) ───────────────────────────────────────────────────────

    def execute(
        self,
        *,
        credential_id: str,
        action: str,
        target: dict[str, Any],
        params: dict[str, Any] | None = None,
        injection: dict[str, str] | None = None,
        timeout: int | None = None,
    ) -> dict:
        """Execute a proxied request through Bastion."""
        body: dict[str, Any] = {
            "credentialId": credential_id,
            "action": action,
            "target": target,
        }
        if params is not None:
            body["params"] = params
        if injection is not None:
            body["injection"] = injection
        if timeout is not None:
            body["timeout"] = timeout
        return self._request("POST", "/v1/proxy/execute", json=body)

    # ── HITL (admin) ────────────────────────────────────────────────────────

    def list_pending_requests(self) -> list[dict]:
        """List all pending HITL requests."""
        return self._request("GET", "/v1/hitl/pending")

    def get_pending_request(self, request_id: str) -> dict:
        """Get a single pending HITL request by ID."""
        return self._request("GET", f"/v1/hitl/{request_id}")

    def approve_request(self, request_id: str) -> dict:
        """Approve a pending HITL request."""
        return self._request("POST", f"/v1/hitl/{request_id}/approve")

    def deny_request(self, request_id: str, reason: str | None = None) -> dict:
        """Deny a pending HITL request with an optional reason."""
        body = {"reason": reason} if reason is not None else None
        return self._request("POST", f"/v1/hitl/{request_id}/deny", json=body)

    # ── Audit (admin) ───────────────────────────────────────────────────────

    def query_audit_records(
        self,
        agent_id: str,
        *,
        from_: str | None = None,
        to: str | None = None,
        action: str | None = None,
        policy_decision: str | None = None,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> dict:
        """Query audit records for an agent with optional filters."""
        return self._request(
            "GET",
            "/v1/audit",
            params={
                "agentId": agent_id,
                "from": from_,
                "to": to,
                "action": action,
                "policyDecision": policy_decision,
                "cursor": cursor,
                "limit": limit,
            },
        )

    def verify_chain(self, agent_id: str) -> dict:
        """Verify the integrity of an agent's audit chain."""
        return self._request("GET", "/v1/audit/verify", params={"agentId": agent_id})


class AsyncBastionClient:
    """Asynchronous client for the Bastion trust proxy API."""

    def __init__(self, base_url: str, api_key: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            headers={"Authorization": f"Bearer {self.api_key}"},
        )

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any | None = None,
        params: dict[str, Any] | None = None,
    ) -> Any:
        filtered = {k: v for k, v in (params or {}).items() if v is not None}
        response = await self._client.request(
            method,
            path,
            json=json,
            params=filtered or None,
        )
        raise_for_status(response)
        return response.json()

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        await self._client.aclose()

    async def __aenter__(self) -> AsyncBastionClient:
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()

    # ── Health ──────────────────────────────────────────────────────────────

    async def health(self) -> dict:
        """Check the health of the Bastion API."""
        return await self._request("GET", "/health")

    # ── Agents (admin) ──────────────────────────────────────────────────────

    async def create_agent(
        self,
        name: str,
        *,
        description: str | None = None,
        callback_url: str | None = None,
    ) -> dict:
        """Create a new agent. Returns the agent with a one-time agentSecret."""
        body: dict[str, Any] = {"name": name}
        if description is not None:
            body["description"] = description
        if callback_url is not None:
            body["callbackUrl"] = callback_url
        return await self._request("POST", "/v1/agents", json=body)

    async def list_agents(self) -> list[dict]:
        """List all agents."""
        return await self._request("GET", "/v1/agents")

    async def get_agent(self, agent_id: str) -> dict:
        """Get a single agent by ID."""
        return await self._request("GET", f"/v1/agents/{agent_id}")

    async def update_agent(self, agent_id: str, **kwargs: Any) -> dict:
        """Update an agent. Pass name, description, callbackUrl, or isActive."""
        return await self._request("PATCH", f"/v1/agents/{agent_id}", json=kwargs)

    async def delete_agent(self, agent_id: str) -> dict:
        """Soft-delete an agent (sets isActive to false)."""
        return await self._request("DELETE", f"/v1/agents/{agent_id}")

    # ── Credentials (admin) ─────────────────────────────────────────────────

    async def create_credential(
        self,
        *,
        name: str,
        type: str,
        value: str,
        agent_id: str,
        metadata: dict[str, Any] | None = None,
        scopes: list[str] | None = None,
        expires_at: str | None = None,
    ) -> dict:
        """Store a new credential (encrypted at rest)."""
        body: dict[str, Any] = {
            "name": name,
            "type": type,
            "value": value,
            "agentId": agent_id,
        }
        if metadata is not None:
            body["metadata"] = metadata
        if scopes is not None:
            body["scopes"] = scopes
        if expires_at is not None:
            body["expiresAt"] = expires_at
        return await self._request("POST", "/v1/credentials", json=body)

    async def list_credentials(self, agent_id: str | None = None) -> list[dict]:
        """List credentials, optionally filtered by agent_id."""
        return await self._request("GET", "/v1/credentials", params={"agentId": agent_id})

    async def get_credential(self, credential_id: str) -> dict:
        """Get a single credential by ID (masked, no raw value)."""
        return await self._request("GET", f"/v1/credentials/{credential_id}")

    async def revoke_credential(self, credential_id: str) -> dict:
        """Revoke a credential (sets isRevoked to true)."""
        return await self._request("DELETE", f"/v1/credentials/{credential_id}")

    # ── Policies (admin) ────────────────────────────────────────────────────

    async def create_policy(
        self,
        *,
        agent_id: str,
        credential_id: str,
        allowed_actions: list[str] | None = None,
        denied_actions: list[str] | None = None,
        constraints: dict[str, Any] | None = None,
        requires_approval_above: float | None = None,
        expires_at: str | None = None,
    ) -> dict:
        """Create a new policy for an agent+credential pair."""
        body: dict[str, Any] = {
            "agentId": agent_id,
            "credentialId": credential_id,
        }
        if allowed_actions is not None:
            body["allowedActions"] = allowed_actions
        if denied_actions is not None:
            body["deniedActions"] = denied_actions
        if constraints is not None:
            body["constraints"] = constraints
        if requires_approval_above is not None:
            body["requiresApprovalAbove"] = requires_approval_above
        if expires_at is not None:
            body["expiresAt"] = expires_at
        return await self._request("POST", "/v1/policies", json=body)

    async def list_policies(
        self,
        *,
        agent_id: str | None = None,
        credential_id: str | None = None,
    ) -> list[dict]:
        """List policies, optionally filtered by agent_id and/or credential_id."""
        return await self._request(
            "GET",
            "/v1/policies",
            params={"agentId": agent_id, "credentialId": credential_id},
        )

    async def get_policy(self, policy_id: str) -> dict:
        """Get a single policy by ID."""
        return await self._request("GET", f"/v1/policies/{policy_id}")

    async def update_policy(self, policy_id: str, **kwargs: Any) -> dict:
        """Update a policy's rules, constraints, or status."""
        return await self._request("PATCH", f"/v1/policies/{policy_id}", json=kwargs)

    async def delete_policy(self, policy_id: str) -> dict:
        """Deactivate a policy (sets isActive to false)."""
        return await self._request("DELETE", f"/v1/policies/{policy_id}")

    async def evaluate_policy(
        self,
        *,
        agent_id: str,
        credential_id: str,
        action: str,
        params: dict[str, Any] | None = None,
    ) -> dict:
        """Dry-run policy evaluation without side effects."""
        body: dict[str, Any] = {
            "agentId": agent_id,
            "credentialId": credential_id,
            "action": action,
        }
        if params is not None:
            body["params"] = params
        return await self._request("POST", "/v1/policies/evaluate", json=body)

    # ── Proxy (agent) ───────────────────────────────────────────────────────

    async def execute(
        self,
        *,
        credential_id: str,
        action: str,
        target: dict[str, Any],
        params: dict[str, Any] | None = None,
        injection: dict[str, str] | None = None,
        timeout: int | None = None,
    ) -> dict:
        """Execute a proxied request through Bastion."""
        body: dict[str, Any] = {
            "credentialId": credential_id,
            "action": action,
            "target": target,
        }
        if params is not None:
            body["params"] = params
        if injection is not None:
            body["injection"] = injection
        if timeout is not None:
            body["timeout"] = timeout
        return await self._request("POST", "/v1/proxy/execute", json=body)

    # ── HITL (admin) ────────────────────────────────────────────────────────

    async def list_pending_requests(self) -> list[dict]:
        """List all pending HITL requests."""
        return await self._request("GET", "/v1/hitl/pending")

    async def get_pending_request(self, request_id: str) -> dict:
        """Get a single pending HITL request by ID."""
        return await self._request("GET", f"/v1/hitl/{request_id}")

    async def approve_request(self, request_id: str) -> dict:
        """Approve a pending HITL request."""
        return await self._request("POST", f"/v1/hitl/{request_id}/approve")

    async def deny_request(self, request_id: str, reason: str | None = None) -> dict:
        """Deny a pending HITL request with an optional reason."""
        body = {"reason": reason} if reason is not None else None
        return await self._request("POST", f"/v1/hitl/{request_id}/deny", json=body)

    # ── Audit (admin) ───────────────────────────────────────────────────────

    async def query_audit_records(
        self,
        agent_id: str,
        *,
        from_: str | None = None,
        to: str | None = None,
        action: str | None = None,
        policy_decision: str | None = None,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> dict:
        """Query audit records for an agent with optional filters."""
        return await self._request(
            "GET",
            "/v1/audit",
            params={
                "agentId": agent_id,
                "from": from_,
                "to": to,
                "action": action,
                "policyDecision": policy_decision,
                "cursor": cursor,
                "limit": limit,
            },
        )

    async def verify_chain(self, agent_id: str) -> dict:
        """Verify the integrity of an agent's audit chain."""
        return await self._request("GET", "/v1/audit/verify", params={"agentId": agent_id})
