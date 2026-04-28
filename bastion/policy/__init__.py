"""Bastion policy DSL.

Usage:

    from bastion import policy

    policies = [
        policy.deny.tools("Delete"),
        policy.deny.paths("/etc/*", "*.env"),
        policy.deny.above("amount", 1000),
        policy.escalate.above("amount", 30),
        policy.nl("Don't access personal information or PII"),
    ]

    @policy.deny
    def no_destructive_bash(tool_name, input_data):
        return tool_name == "Bash" and "rm -rf" in input_data.get("command", "")

Code policies (deny.tools, deny.paths, deny.above, escalate.above,
@policy.deny, @policy.escalate) are deterministic and run first. NL
policies (policy.nl) are evaluated by the LLM judge if configured.
"""

from bastion.policy.code_policy import deny, escalate
from bastion.policy.nl_policy import NLPolicy, nl
from bastion.policy.schema import Decision, Policy

__all__ = ["Decision", "NLPolicy", "Policy", "deny", "escalate", "nl"]
