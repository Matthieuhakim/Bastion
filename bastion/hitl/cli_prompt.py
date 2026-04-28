"""Blocking CLI prompt that asks the developer to approve or deny an escalated call.

Used as the default `hitl` callable on the engine. Returns a Decision whose
`source="human"`. On timeout, returns deny (fail-safe).
"""

from __future__ import annotations

import json
import queue
import threading
from typing import Any

from rich.console import Console
from rich.panel import Panel
from rich.text import Text

from bastion.policy.schema import Decision

DEFAULT_TIMEOUT_S = 60.0
INPUT_TRUNCATE_CHARS = 600


def _input_with_timeout(prompt: str, timeout: float) -> str | None:
    """input() with a wall-clock timeout. Returns None on timeout/EOF."""
    result_q: queue.Queue[str | None] = queue.Queue()

    def _read() -> None:
        try:
            result_q.put(input(prompt))
        except (EOFError, KeyboardInterrupt):
            result_q.put(None)

    thread = threading.Thread(target=_read, daemon=True)
    thread.start()
    try:
        return result_q.get(timeout=timeout)
    except queue.Empty:
        return None


def _format_input(input_data: dict[str, Any]) -> str:
    try:
        rendered = json.dumps(input_data, indent=2, sort_keys=True)
    except (TypeError, ValueError):
        rendered = repr(input_data)
    if len(rendered) > INPUT_TRUNCATE_CHARS:
        rendered = rendered[:INPUT_TRUNCATE_CHARS] + "\n... (truncated)"
    return rendered


class CLIPromptHandler:
    """Blocking terminal prompt for HITL approvals."""

    def __init__(
        self,
        timeout: float = DEFAULT_TIMEOUT_S,
        console: Console | None = None,
    ) -> None:
        self.timeout = timeout
        self.console = console or Console()

    def __call__(
        self,
        decision: Decision,
        tool_name: str,
        input_data: dict[str, Any],
    ) -> Decision:
        return self.request_approval(decision, tool_name, input_data)

    def request_approval(
        self,
        decision: Decision,
        tool_name: str,
        input_data: dict[str, Any],
    ) -> Decision:
        body = Text()
        body.append("Tool        ", style="dim")
        body.append(f"{tool_name}\n", style="bold cyan")
        body.append("Triggered   ", style="dim")
        body.append(f"{decision.policy_id}\n", style="yellow")
        body.append("Source      ", style="dim")
        body.append(f"{decision.source}\n")
        body.append("Reason      ", style="dim")
        body.append(f"{decision.reason}\n\n")
        body.append("Input:\n", style="dim")
        body.append(_format_input(input_data) + "\n")

        self.console.print(
            Panel(
                body,
                title="[bold yellow]HITL escalation[/bold yellow]",
                subtitle=f"[dim]timeout {int(self.timeout)}s[/dim]",
                border_style="yellow",
                padding=(1, 2),
            )
        )

        prompt = "  Approve [a] / Deny [d] > "
        response = _input_with_timeout(prompt, self.timeout)

        if response is None:
            self.console.print(
                "[red]No response within timeout. Denying (fail-safe).[/red]"
            )
            return Decision(
                outcome="deny",
                source="human",
                policy_id="human.timeout",
                reason=f"HITL timeout after {self.timeout}s",
            )

        normalized = response.strip().lower()
        if normalized in {"a", "approve", "y", "yes"}:
            self.console.print("[green]Approved.[/green]")
            return Decision(
                outcome="allow",
                source="human",
                policy_id="human.approved",
                reason="approved by user",
            )

        if normalized in {"d", "deny", "n", "no"}:
            self.console.print("[red]Denied by user.[/red]")
            return Decision(
                outcome="deny",
                source="human",
                policy_id="human.denied",
                reason="denied by user",
            )

        self.console.print(
            f"[red]Unrecognized response {normalized!r}. Denying.[/red]"
        )
        return Decision(
            outcome="deny",
            source="human",
            policy_id="human.invalid",
            reason=f"invalid HITL response: {normalized!r}",
        )
