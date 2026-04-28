"""Public Bastion SDK class.

Single object that ties together: agent keys, audit DB, policy engine,
optional LLM judge, and HITL handler. Developers do:

    from bastion import Bastion, policy
    bastion = Bastion(
        agent_id="my-agent",
        policies=[policy.deny.tools("Delete"), policy.escalate.above("amount", 30)],
    )
    decision = bastion.evaluate("charge_card", {"amount": 200})
    if decision.outcome == "allow":
        result = run_tool(...)
        bastion.record_outcome(success=True, output_hash=hash_input(result))
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

from rich.table import Table

from bastion import paths
from bastion.audit.chain import append, hash_input
from bastion.audit.signer import (
    fingerprint,
    generate_keypair,
    load_private_key,
    load_public_key,
)
from bastion.audit.store import AuditStore
from bastion.audit.verifier import VerificationReport, verify_chain
from bastion.hitl import CLIPromptHandler
from bastion.policy.engine import PolicyEngine
from bastion.policy.llm_judge import DEFAULT_MODEL, LLMJudge
from bastion.policy.schema import Decision, Policy

HITLFn = Callable[[Decision, str, dict[str, Any]], Decision]


class Bastion:
    """The Bastion SDK entry point."""

    def __init__(
        self,
        agent_id: str,
        policies: list[Policy] | None = None,
        hitl_handler: HITLFn | None = None,
        db_path: str | Path | None = None,
        keys_dir: str | Path | None = None,
        judge_model: str = DEFAULT_MODEL,
        anthropic_api_key: str | None = None,
        auto_init: bool = True,
    ) -> None:
        if not paths.is_safe_agent_id(agent_id):
            raise ValueError(f"agent_id {agent_id!r} is not filesystem-safe")

        self.agent_id = agent_id
        self.db_path: Path = Path(db_path) if db_path else paths.agent_db_path(agent_id)

        if keys_dir is not None:
            self._keys_dir = Path(keys_dir)
            self._private_path = self._keys_dir / "private.pem"
            self._public_path = self._keys_dir / "public.pem"
        else:
            self._keys_dir = paths.agent_keys_dir(agent_id)
            self._private_path = paths.agent_private_key_path(agent_id)
            self._public_path = paths.agent_public_key_path(agent_id)

        self._ensure_keys(auto_init=auto_init)
        self._private_key = load_private_key(self._private_path.read_bytes())
        self._public_key = load_public_key(self._public_path.read_bytes())
        self.fingerprint = fingerprint(self._public_key)

        self.store = AuditStore(self.db_path)

        policies = list(policies or [])
        nl_count = sum(1 for p in policies if getattr(p, "is_nl_policy", False))

        self.judge: LLMJudge | None = None
        judge_fn = None
        if nl_count > 0:
            self.judge = LLMJudge(model=judge_model, api_key=anthropic_api_key)
            judge_fn = self.judge.evaluate

        self.hitl: HITLFn = hitl_handler if hitl_handler is not None else CLIPromptHandler()
        self.engine = PolicyEngine(policies, judge=judge_fn, hitl=self.hitl)

        self._last_decision_record_id: int | None = None
        self._closed = False

    # ----- key/db lifecycle -----

    def _ensure_keys(self, auto_init: bool) -> None:
        if self._private_path.exists() and self._public_path.exists():
            return
        if not auto_init:
            raise FileNotFoundError(
                f"Bastion agent '{self.agent_id}' is not initialized. "
                f"Run `bastion init {self.agent_id}` or pass auto_init=True."
            )
        self._keys_dir.mkdir(parents=True, exist_ok=True)
        priv_pem, pub_pem = generate_keypair()
        self._private_path.write_bytes(priv_pem)
        self._private_path.chmod(0o600)
        self._public_path.write_bytes(pub_pem)
        self._public_path.chmod(0o644)

    # ----- core API -----

    def evaluate(self, tool_name: str, input_data: dict[str, Any]) -> Decision:
        """Evaluate a tool call.

        Runs the policy engine, signs and chains every Decision in the
        resulting chain (escalations and HITL resolutions become separate
        records), and returns the final Decision. The id of the *last*
        decision record is stashed so a subsequent `record_outcome()` can
        link to it without the caller passing it explicitly.
        """
        chain = self.engine.evaluate_chain(tool_name, input_data)
        last_id = self._sign_decisions(chain, tool_name, input_data)
        self._last_decision_record_id = last_id
        return chain[-1]

    def record_outcome(
        self,
        success: bool,
        output_hash: str | None = None,
        error: str | None = None,
        decision_record_id: int | None = None,
        tool_name: str | None = None,
    ) -> int:
        """Append a tool_outcome record linked to a prior decision record."""
        link_id = (
            decision_record_id
            if decision_record_id is not None
            else self._last_decision_record_id
        )
        body = {
            "event": "tool_outcome",
            "agent_id": self.agent_id,
            "tool_name": tool_name,
            "links_decision_id": link_id,
            "success": bool(success),
            "output_hash": output_hash,
            "error": error,
            "decision_source": "tool_runtime",
        }
        record_id, _ = append(self.store, body, self._private_key)
        return record_id

    def verify(self) -> VerificationReport:
        return verify_chain(self.store, self._public_key)

    def report(self) -> Table:
        """Tabular summary of the current chain. Phase 9 expands this."""
        table = Table(
            title=f"Bastion audit log: {self.agent_id}",
            border_style="cyan",
            show_header=True,
            header_style="bold",
        )
        table.add_column("#", justify="right", style="dim")
        table.add_column("Time", style="dim")
        table.add_column("Event")
        table.add_column("Tool")
        table.add_column("Decision")
        table.add_column("Source")
        table.add_column("Latency")
        table.add_column("Reason", max_width=50)

        for stored in self.store.iter_records():
            body = json.loads(stored.record_json)
            decision = str(body.get("decision", body.get("success", "")))
            decision_style = {
                "allow": "green",
                "deny": "red",
                "escalate": "yellow",
                "True": "green",
                "False": "red",
            }.get(decision, "")
            table.add_row(
                str(stored.id),
                str(body.get("timestamp", "")),
                str(body.get("event", "")),
                str(body.get("tool_name", "-")),
                f"[{decision_style}]{decision}[/{decision_style}]" if decision_style else decision,
                str(body.get("decision_source", "")),
                f"{body.get('latency_ms', 0)}ms",
                str(body.get("reason", "")),
            )
        return table

    def close(self) -> None:
        if not self._closed:
            self.store.close()
            self._closed = True

    def __enter__(self) -> Bastion:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ----- internals -----

    def _sign_decisions(
        self,
        chain: list[Decision],
        tool_name: str,
        input_data: dict[str, Any],
    ) -> int | None:
        last_id: int | None = None
        input_hash = hash_input(input_data)
        for decision in chain:
            event = "hitl_decision" if decision.source == "human" else "policy_decision"
            body = {
                "event": event,
                "agent_id": self.agent_id,
                "tool_name": tool_name,
                "tool_input_hash": input_hash,
                "decision": decision.outcome,
                "decision_source": decision.source,
                "policy_id": decision.policy_id,
                "reason": decision.reason,
                "latency_ms": decision.latency_ms,
            }
            record_id, _ = append(self.store, body, self._private_key)
            last_id = record_id
        return last_id

    @property
    def last_decision_record_id(self) -> int | None:
        return self._last_decision_record_id
