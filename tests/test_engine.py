"""Tests for the PolicyEngine orchestration."""

from __future__ import annotations

import time

from bastion import policy
from bastion.policy.engine import PolicyEngine
from bastion.policy.schema import Decision, Policy


class _SpyPolicy(Policy):
    """Records that it was called, returns a configured decision."""

    def __init__(self, outcome: str, name: str = "spy"):
        self.outcome = outcome
        self.policy_id = f"spy.{name}"
        self.calls = 0

    def evaluate(self, tool_name, input_data):
        self.calls += 1
        return Decision(
            outcome=self.outcome,
            source="code_policy",
            policy_id=self.policy_id,
            reason=f"spy returned {self.outcome}",
        )


def test_default_allow_when_no_policies_match():
    engine = PolicyEngine([policy.deny.tools("nope")])
    d = engine.evaluate("Read", {"path": "/tmp/x"})
    assert d.outcome == "allow"
    assert d.latency_ms >= 1


def test_deny_short_circuits_remaining_policies():
    deny_policy = _SpyPolicy("deny", "first")
    later_policy = _SpyPolicy("allow", "later")
    engine = PolicyEngine([deny_policy, later_policy])
    d = engine.evaluate("X", {})
    assert d.outcome == "deny"
    assert deny_policy.calls == 1
    assert later_policy.calls == 0


def test_escalate_short_circuits_remaining_policies():
    esc = _SpyPolicy("escalate", "first")
    later = _SpyPolicy("deny", "later")
    engine = PolicyEngine([esc, later])
    d = engine.evaluate("X", {})
    assert d.outcome == "escalate"
    assert esc.calls == 1
    assert later.calls == 0


def test_deny_after_allow_takes_effect():
    a = _SpyPolicy("allow", "first")
    d = _SpyPolicy("deny", "second")
    engine = PolicyEngine([a, d])
    decision = engine.evaluate("X", {})
    assert decision.outcome == "deny"
    assert a.calls == 1
    assert d.calls == 1


def test_decision_includes_latency_and_metadata():
    engine = PolicyEngine([policy.deny.tools("Delete")])
    d = engine.evaluate("Delete", {})
    assert d.outcome == "deny"
    assert d.source == "code_policy"
    assert d.policy_id == "deny.tools:Delete"
    assert d.latency_ms >= 1
    assert "Delete" in d.reason


def test_full_dsl_combination():
    # Per the plan: deny short-circuits, escalate short-circuits. Policy
    # order matters; users put strictest checks first.
    engine = PolicyEngine([
        policy.deny.tools("delete_file"),
        policy.deny.paths("/etc/*", "*.env"),
        policy.deny.above("amount", 1000),
        policy.escalate.above("amount", 30),
    ])

    assert engine.evaluate("delete_file", {}).outcome == "deny"
    assert engine.evaluate("Write", {"path": "/etc/passwd"}).outcome == "deny"
    assert engine.evaluate("Write", {"target": "config.env"}).outcome == "deny"
    assert engine.evaluate("charge", {"amount": 5}).outcome == "allow"
    assert engine.evaluate("charge", {"amount": 50}).outcome == "escalate"
    assert engine.evaluate("charge", {"amount": 5000}).outcome == "deny"


def test_policy_order_matters_escalate_short_circuits_deny():
    # If escalate is listed first, a value that would also satisfy the deny
    # policy still escalates (not denies). This documents the ordering rule.
    engine = PolicyEngine([
        policy.escalate.above("amount", 30),
        policy.deny.above("amount", 1000),
    ])
    assert engine.evaluate("charge", {"amount": 5000}).outcome == "escalate"


def test_judge_invoked_when_code_defers():
    judge_called = {"n": 0}

    def fake_judge(nl_policies, tool_name, input_data):
        judge_called["n"] += 1
        return Decision(
            outcome="allow",
            source="llm_judge",
            policy_id="judge",
            reason="ok",
        )

    class _Defer(Policy):
        policy_id = "spy.defer"
        outcome = "defer"

        def evaluate(self, tool_name, input_data):
            return Decision(
                outcome="defer",
                source="code_policy",
                policy_id=self.policy_id,
                reason="defer",
            )

    engine = PolicyEngine([_Defer()], judge=fake_judge)
    d = engine.evaluate("X", {})
    assert d.outcome == "allow"
    assert d.source == "llm_judge"
    assert judge_called["n"] == 1


def test_hitl_invoked_on_escalate():
    captured = {}

    def fake_hitl(decision, tool_name, input_data):
        captured["decision"] = decision
        return Decision(
            outcome="allow",
            source="human",
            policy_id="human",
            reason="approved",
        )

    engine = PolicyEngine(
        [policy.escalate.above("amount", 30)],
        hitl=fake_hitl,
    )
    d = engine.evaluate("charge", {"amount": 200})
    assert d.outcome == "allow"
    assert d.source == "human"
    assert captured["decision"].outcome == "escalate"


def test_evaluate_chain_returns_two_records_for_hitl_escalation():
    def fake_hitl(decision, tool_name, input_data):
        return Decision(
            outcome="allow",
            source="human",
            policy_id="human.approved",
            reason="approved",
        )

    engine = PolicyEngine(
        [policy.escalate.above("amount", 30)],
        hitl=fake_hitl,
    )
    chain = engine.evaluate_chain("charge", {"amount": 200})
    assert len(chain) == 2
    assert chain[0].outcome == "escalate"
    assert chain[0].source == "code_policy"
    assert chain[1].outcome == "allow"
    assert chain[1].source == "human"


def test_evaluate_chain_returns_one_record_for_simple_deny():
    engine = PolicyEngine([policy.deny.tools("Bad")])
    chain = engine.evaluate_chain("Bad", {})
    assert len(chain) == 1
    assert chain[0].outcome == "deny"


def test_engine_returns_within_reasonable_time():
    engine = PolicyEngine([policy.deny.tools("Z") for _ in range(50)])
    start = time.perf_counter()
    engine.evaluate("X", {})
    elapsed_ms = (time.perf_counter() - start) * 1000
    assert elapsed_ms < 50  # 50 trivial policies should run in well under 50ms
