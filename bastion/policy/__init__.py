"""Bastion policy DSL.

Usage:

    from bastion import policy

    policies = [
        policy.deny.tools("Delete"),
        policy.deny.paths("/etc/*", "*.env"),
        policy.escalate.above("amount", 30),
        policy.deny.above("amount", 1000),
    ]

    @policy.deny
    def no_destructive_bash(tool_name, input_data):
        return tool_name == "Bash" and "rm -rf" in input_data.get("command", "")

Natural-language policies (Phase 4) and `policy.nl(...)` will land here.
"""

from bastion.policy.code_policy import deny, escalate
from bastion.policy.schema import Decision, Policy

__all__ = ["Decision", "Policy", "deny", "escalate"]
