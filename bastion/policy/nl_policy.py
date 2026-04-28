"""Natural-language policies, evaluated by the LLM judge."""

from __future__ import annotations

import hashlib

from bastion.policy.schema import Decision, Policy


def _short_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:8]


class NLPolicy(Policy):
    """A natural-language policy.

    The PolicyEngine recognizes these via the `is_nl_policy = True` marker,
    collects them into a separate list, and hands them to the LLM judge
    after all code policies have run.
    """

    is_nl_policy = True

    def __init__(self, text: str) -> None:
        if not isinstance(text, str) or not text.strip():
            raise ValueError("nl policy text must be a non-empty string")
        self.text = text.strip()
        self.policy_id = f"nl:{_short_hash(self.text)}"

    def evaluate(self, tool_name: str, input_data: dict) -> Decision:
        # Should never be called by the engine (NL policies are routed to the
        # judge), but defined for type uniformity. Returns `defer` so any
        # accidental direct call still funnels into the judge if invoked.
        return Decision(
            outcome="defer",
            source="code_policy",
            policy_id=self.policy_id,
            reason="natural-language policy: defer to LLM judge",
        )


def nl(text: str) -> NLPolicy:
    """Create a natural-language policy."""
    return NLPolicy(text)
