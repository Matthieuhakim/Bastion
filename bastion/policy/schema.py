"""Pydantic models and the abstract Policy base."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict

DecisionOutcome = Literal["allow", "deny", "escalate", "defer"]
DecisionSource = Literal["code_policy", "llm_judge", "human", "tool_runtime"]


class Decision(BaseModel):
    """The result of evaluating a single policy or the engine as a whole."""

    model_config = ConfigDict(extra="forbid")

    outcome: DecisionOutcome
    source: DecisionSource
    policy_id: str
    reason: str
    latency_ms: int = 0


class Policy:
    """Abstract base for all policies.

    Concrete subclasses must set `policy_id` and implement `evaluate`.
    Subclasses should NOT inherit from Pydantic's BaseModel; that would
    interfere with the runtime mutability of internal fields.
    """

    policy_id: str = "policy"

    def evaluate(self, tool_name: str, input_data: dict) -> Decision:
        raise NotImplementedError
