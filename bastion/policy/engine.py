"""Orchestrates the full policy decision flow for one tool call.

Phase 3: code policies only. Subsequent phases plug in:
  - Phase 4: an LLM judge for natural-language policies and `defer` outcomes.
  - Phase 5: a HITL gate for `escalate` outcomes.

The engine accepts a list of policies (mixed code + NL) and optional
judge / HITL handler callables. NL policies are detected by isinstance
against the future NLPolicy type; until that exists this is a no-op.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

from bastion.policy.schema import Decision, Policy

JudgeFn = Callable[[list[Policy], str, dict[str, Any]], Decision]
HITLFn = Callable[[Decision, str, dict[str, Any]], Decision]


class PolicyEngine:
    def __init__(
        self,
        policies: list[Policy],
        judge: JudgeFn | None = None,
        hitl: HITLFn | None = None,
    ) -> None:
        # NL policies are recognized by an opt-in flag so we don't need to
        # import nl_policy here (avoids a circular dep before Phase 4 lands).
        self.code_policies: list[Policy] = []
        self.nl_policies: list[Policy] = []
        for p in policies:
            if getattr(p, "is_nl_policy", False):
                self.nl_policies.append(p)
            else:
                self.code_policies.append(p)
        self.judge = judge
        self.hitl = hitl

    def evaluate(self, tool_name: str, input_data: dict[str, Any]) -> Decision:
        start = time.perf_counter()
        deferred = False
        triggering_policy_id: str | None = None

        for policy in self.code_policies:
            decision = policy.evaluate(tool_name, input_data)

            if decision.outcome == "deny":
                return self._maybe_hitl(self._stamp(decision, start), tool_name, input_data, start)

            if decision.outcome == "escalate":
                triggering_policy_id = decision.policy_id
                escalation = self._stamp(decision, start)
                return self._maybe_hitl(escalation, tool_name, input_data, start)

            if decision.outcome == "defer":
                deferred = True
                triggering_policy_id = decision.policy_id

        needs_judge = (deferred or self.nl_policies) and self.judge is not None
        if needs_judge:
            judge_decision = self.judge(self.nl_policies, tool_name, input_data)
            stamped = self._stamp(judge_decision, start)
            if stamped.outcome in ("deny", "escalate"):
                return self._maybe_hitl(stamped, tool_name, input_data, start)
            return stamped

        if deferred and self.judge is None:
            return self._stamp(
                Decision(
                    outcome="allow",
                    source="code_policy",
                    policy_id=triggering_policy_id or "default.allow",
                    reason="deferred but no judge configured; defaulting to allow",
                ),
                start,
            )

        return self._stamp(
            Decision(
                outcome="allow",
                source="code_policy",
                policy_id="default.allow",
                reason="no code policy matched",
            ),
            start,
        )

    def _stamp(self, decision: Decision, start: float) -> Decision:
        decision.latency_ms = max(1, int((time.perf_counter() - start) * 1000))
        return decision

    def _maybe_hitl(
        self,
        decision: Decision,
        tool_name: str,
        input_data: dict[str, Any],
        start: float,
    ) -> Decision:
        if decision.outcome != "escalate" or self.hitl is None:
            return decision
        resolution = self.hitl(decision, tool_name, input_data)
        # The HITL handler returns its own decision (source='human').
        # Engine doesn't re-stamp latency on the HITL result; that decision
        # carries its own meaning and the wait time is human-driven.
        return resolution
