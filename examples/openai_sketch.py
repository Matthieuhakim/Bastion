"""Minimal OpenAI Agents SDK sketch using the Bastion adapter.

This file is illustrative. It does not import the openai-agents SDK
(which isn't a Bastion runtime dependency) and it does not call any
OpenAI API. The point is to show the integration shape: define a tool,
wrap it with bastion_guard, and pass the wrapped tool to your agent.
"""

from __future__ import annotations

import os
from pathlib import Path

from bastion import Bastion, policy
from bastion.adapters.openai_agents import BastionPermissionError, bastion_guard


def main() -> None:
    os.environ.setdefault("BASTION_HOME", str(Path(__file__).resolve().parent / ".bastion"))

    bastion = Bastion(
        agent_id="oai-sketch",
        policies=[
            policy.deny.tools("delete_file"),
            policy.escalate.above("amount", 30),
        ],
    )

    # In a real OpenAI Agents SDK app:
    #   from agents import function_tool
    #   @bastion_guard(bastion, tool_name="delete_file")
    #   @function_tool
    #   def delete_file(path: str) -> str: ...
    #
    # Here we skip the @function_tool decorator and directly call the
    # bastion-wrapped function so the sketch works without that dep.

    @bastion_guard(bastion, tool_name="delete_file")
    def delete_file(path: str) -> str:
        return f"would delete {path}"

    @bastion_guard(bastion, tool_name="charge_card")
    def charge_card(amount: float, currency: str) -> str:
        return f"charged {amount:.2f} {currency.upper()}"

    print("Calling delete_file (should deny):")
    try:
        delete_file(path="/tmp/x")
    except BastionPermissionError as e:
        print(f"  blocked: {e}")

    print("\nCalling charge_card $5 (should allow):")
    print(f"  result: {charge_card(amount=5, currency='usd')}")

    print(f"\nAudit chain length: {bastion.store.count()}")
    bastion.close()


if __name__ == "__main__":
    main()
