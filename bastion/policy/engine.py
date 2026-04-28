"""Orchestrates the full policy decision flow for one tool call.

Two entry points:
  - evaluate_chain(): returns every Decision that should be signed and
    appended to the audit chain (escalation followed by HITL resolution
    is two records, for example). Used by the Bastion SDK in Phase 6.
  - evaluate(): convenience that returns just the final Decision (the last
    element of the chain). Used in tests and any caller that only cares
    about the routing outcome.

Routing rules (per the plan):
  - Code policies run in order. deny short-circuits. escalate
    short-circuits. defer marks the call for the LLM judge but lets
    later code policies still deny.
  - After code policies, if any deferred or any NL policy is configured
    and a judge is wired, the judge runs.
  - If the resulting decision is escalate and a HITL handler is wired,
    the handler runs and its resolution is appended as a separate record.
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
        return self.evaluate_chain(tool_name, input_data)[-1]

    def evaluate_chain(
        self, tool_name: str, input_data: dict[str, Any]
    ) -> list[Decision]:
        start = time.perf_counter()
        chain: list[Decision] = []
        deferred = False

        for policy in self.code_policies:
            decision = policy.evaluate(tool_name, input_data)

            if decision.outcome == "deny":
                chain.append(self._stamp(decision, start))
                return chain

            if decision.outcome == "escalate":
                chain.append(self._stamp(decision, start))
                self._apply_hitl(chain, tool_name, input_data)
                return chain

            if decision.outcome == "defer":
                deferred = True

        needs_judge = (deferred or self.nl_policies) and self.judge is not None
        if needs_judge:
            judge_decision = self.judge(self.nl_policies, tool_name, input_data)
            chain.append(self._stamp(judge_decision, start))
            if judge_decision.outcome == "escalate":
                self._apply_hitl(chain, tool_name, input_data)
            return chain

        chain.append(
            self._stamp(
                Decision(
                    outcome="allow",
                    source="code_policy",
                    policy_id="default.allow",
                    reason="no code policy matched",
                ),
                start,
            )
        )
        return chain

    def _apply_hitl(
        self,
        chain: list[Decision],
        tool_name: str,
        input_data: dict[str, Any],
    ) -> None:
        if self.hitl is None:
            return
        resolution = self.hitl(chain[-1], tool_name, input_data)
        chain.append(resolution)

    def _stamp(self, decision: Decision, start: float) -> Decision:
        # Don't stomp latency that was already set (judge sets its own).
        if decision.latency_ms == 0:
            decision.latency_ms = max(1, int((time.perf_counter() - start) * 1000))
        return decision
