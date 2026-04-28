"""Bastion: trust layer for AI agents.

Public API:
    Bastion: the SDK class developers instantiate.
    policy: the policy DSL (deny.tools, escalate.above, nl, decorators).
"""

from bastion import policy
from bastion.sdk import Bastion

__version__ = "0.1.0"
__all__ = ["Bastion", "policy"]
