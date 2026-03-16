"""Type definitions for Bastion SDK request/response shapes."""

from __future__ import annotations

from typing import Any, NotRequired, TypedDict


# ── Agents ─────────────────────────────────────────────────────────────────


class CreateAgentInput(TypedDict):
    name: str
    description: NotRequired[str]
    callback_url: NotRequired[str]


class UpdateAgentInput(TypedDict, total=False):
    name: str
    description: str | None
    callbackUrl: str | None
    isActive: bool


# ── Credentials ────────────────────────────────────────────────────────────


class CreateCredentialInput(TypedDict):
    name: str
    type: str
    value: str
    agentId: str
    metadata: NotRequired[dict[str, Any]]
    scopes: NotRequired[list[str]]
    expiresAt: NotRequired[str]


# ── Policies ───────────────────────────────────────────────────────────────


class TimeWindow(TypedDict):
    days: list[str]
    hours: dict[str, str]
    timezone: str


class RateLimit(TypedDict):
    maxRequests: int
    windowSeconds: int


class PolicyConstraints(TypedDict, total=False):
    maxAmountPerTransaction: float
    maxDailySpend: float
    timeWindow: TimeWindow
    rateLimit: RateLimit
    ipAllowlist: list[str]


class CreatePolicyInput(TypedDict):
    agentId: str
    credentialId: str
    allowedActions: NotRequired[list[str]]
    deniedActions: NotRequired[list[str]]
    constraints: NotRequired[PolicyConstraints]
    requiresApprovalAbove: NotRequired[float]
    expiresAt: NotRequired[str]


class UpdatePolicyInput(TypedDict, total=False):
    allowedActions: list[str] | None
    deniedActions: list[str] | None
    constraints: PolicyConstraints | None
    requiresApprovalAbove: float | None
    expiresAt: str | None
    isActive: bool


class PolicyEvaluateInput(TypedDict):
    agentId: str
    credentialId: str
    action: str
    params: NotRequired[dict[str, Any]]


# ── Proxy ──────────────────────────────────────────────────────────────────


class ProxyTarget(TypedDict):
    url: str
    method: NotRequired[str]
    headers: NotRequired[dict[str, str]]
    body: NotRequired[Any]


class InjectionConfig(TypedDict):
    location: str
    key: str


class ProxyExecuteInput(TypedDict):
    credentialId: str
    action: str
    target: ProxyTarget
    params: NotRequired[dict[str, Any]]
    injection: NotRequired[InjectionConfig]
    timeout: NotRequired[int]


# ── Audit ──────────────────────────────────────────────────────────────────


class AuditQueryParams(TypedDict, total=False):
    agentId: str
    from_: str
    to: str
    action: str
    policyDecision: str
    cursor: str
    limit: int
