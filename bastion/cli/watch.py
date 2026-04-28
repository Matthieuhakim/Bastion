"""`bastion watch <agent_id>`: live Textual dashboard."""

from __future__ import annotations

import json
from pathlib import Path

import typer
from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import DataTable, Footer, Static

from bastion import paths
from bastion.audit.signer import fingerprint, load_public_key
from bastion.audit.store import AuditStore
from bastion.audit.verifier import verify_chain
from bastion.cli import app

console = typer.echo  # alias

BANNER = (
    "██████╗  █████╗ ███████╗████████╗██╗ ██████╗ ███╗   ██╗\n"
    "██╔══██╗██╔══██╗██╔════╝╚══██╔══╝██║██╔═══██╗████╗  ██║\n"
    "██████╔╝███████║███████╗   ██║   ██║██║   ██║██╔██╗ ██║\n"
    "██╔══██╗██╔══██║╚════██║   ██║   ██║██║   ██║██║╚██╗██║\n"
    "██████╔╝██║  ██║███████║   ██║   ██║╚██████╔╝██║ ╚████║\n"
    "╚═════╝ ╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝ ╚═════╝ ╚═╝  ╚═══╝"
)


def _decision_style(value: str) -> str:
    return {
        "allow": "green",
        "deny": "red",
        "escalate": "yellow",
        "success": "green",
        "failure": "red",
    }.get(value, "white")


def _short_time(ts: str) -> str:
    if "T" not in ts:
        return ts
    _, hms = ts.split("T", 1)
    return hms.rstrip("Z")


class BastionDashboard(App[None]):
    """Live dashboard streaming Bastion audit events."""

    CSS = """
    Screen {
        background: #0a0e14;
    }

    #header_panel {
        height: 9;
        background: #0d1117;
        color: #79b8ff;
        padding: 0 2;
        border-bottom: heavy #1f6feb;
    }

    #header_left {
        width: 60%;
        color: #79b8ff;
    }

    #header_right {
        width: 40%;
        color: #b5cea8;
        text-align: right;
        padding: 1 2;
    }

    #event_log {
        height: 60%;
        border: round #1f6feb;
        background: #0d1117;
        color: white;
        scrollbar-size: 1 1;
    }

    #bottom_row {
        height: 1fr;
    }

    #policies_panel {
        width: 50%;
        border: round #56b6c2;
        background: #0d1117;
    }

    #stats_panel {
        width: 50%;
        border: round #f6c177;
        background: #0d1117;
        padding: 1 2;
        color: white;
    }

    Footer {
        background: #0d1117;
        color: #79b8ff;
    }

    DataTable > .datatable--header {
        background: #1f2937;
        color: #79b8ff;
    }
    """

    BINDINGS = [
        Binding("q", "quit", "quit"),
        Binding("v", "verify", "verify chain"),
        Binding("c", "clear_log", "clear log"),
    ]

    def __init__(self, agent_id: str) -> None:
        super().__init__()
        self.agent_id = agent_id
        self.db_path = paths.agent_db_path(agent_id)
        self.public_key_path = paths.agent_public_key_path(agent_id)
        self.store: AuditStore | None = None
        self.public_key = None
        self.fingerprint_str = ""
        self._last_seen_id = 0

    def compose(self) -> ComposeResult:
        with Horizontal(id="header_panel"):
            yield Static(BANNER, id="header_left")
            yield Static(self._header_right_text(), id="header_right")
        yield DataTable(id="event_log", zebra_stripes=True, cursor_type="row")
        with Horizontal(id="bottom_row"):
            yield DataTable(id="policies_panel", zebra_stripes=True)
            yield Static("(loading)", id="stats_panel")
        yield Footer()

    def on_mount(self) -> None:
        if not self.public_key_path.exists() or not self.db_path.exists():
            self.exit(message=f"agent {self.agent_id!r} is not initialized.")
            return

        self.public_key = load_public_key(self.public_key_path.read_bytes())
        self.fingerprint_str = fingerprint(self.public_key)
        self.store = AuditStore(self.db_path)

        log = self.query_one("#event_log", DataTable)
        log.add_columns("#", "Time", "Event", "Tool", "Decision", "Source", "Reason")

        policies = self.query_one("#policies_panel", DataTable)
        policies.border_title = "policies (hits)"
        policies.add_columns("policy_id", "hits")

        stats = self.query_one("#stats_panel", Static)
        stats.border_title = "stats"

        log.border_title = "live audit feed"

        self.query_one("#header_right", Static).update(self._header_right_text())

        self.set_interval(0.2, self._refresh)
        self._refresh()

    # ----- refresh -----

    def _refresh(self) -> None:
        if self.store is None:
            return

        bodies_with_id = [
            (r.id, json.loads(r.record_json)) for r in self.store.iter_records()
        ]

        # Append new rows to the log (incremental).
        log = self.query_one("#event_log", DataTable)
        for record_id, body in bodies_with_id:
            if record_id <= self._last_seen_id:
                continue
            decision = body.get("decision")
            if decision is None and "success" in body:
                decision = "success" if body["success"] else "failure"
            decision = str(decision) if decision is not None else ""
            log.add_row(
                str(record_id),
                _short_time(str(body.get("timestamp", ""))),
                str(body.get("event", "")),
                str(body.get("tool_name") or "-"),
                Text(decision, style=_decision_style(decision)),
                str(body.get("decision_source", "")),
                str(body.get("reason", ""))[:80],
            )
            self._last_seen_id = record_id
        if log.row_count > 0:
            log.scroll_end(animate=False)

        # Recompute panels (cheap up to ~10k records).
        self._refresh_policies(bodies_with_id)
        self._refresh_stats(bodies_with_id)

    def _refresh_policies(self, bodies_with_id: list) -> None:
        counts: dict[str, int] = {}
        for _, body in bodies_with_id:
            pid = body.get("policy_id")
            if not pid or pid == "default.allow":
                continue
            decision = body.get("decision", "")
            if decision in ("allow",):
                continue
            counts[pid] = counts.get(pid, 0) + 1

        table = self.query_one("#policies_panel", DataTable)
        table.clear()
        for pid in sorted(counts, key=lambda k: -counts[k]):
            table.add_row(pid, str(counts[pid]))

    def _refresh_stats(self, bodies_with_id: list) -> None:
        total = len(bodies_with_id)
        by_decision: dict[str, int] = {}
        latencies: list[int] = []
        hitl_total = judge_total = 0
        for _, body in bodies_with_id:
            decision = body.get("decision")
            if decision is None and "success" in body:
                decision = "success" if body["success"] else "failure"
            decision = str(decision) if decision is not None else ""
            by_decision[decision] = by_decision.get(decision, 0) + 1
            latencies.append(int(body.get("latency_ms", 0) or 0))
            source = body.get("decision_source", "")
            if source == "human":
                hitl_total += 1
            elif source == "llm_judge":
                judge_total += 1

        avg_latency = sum(latencies) / len(latencies) if latencies else 0

        text = Text()
        text.append("Total records  ", style="dim")
        text.append(f"{total}\n\n", style="bold")
        text.append("By decision\n", style="dim")
        for k in sorted(by_decision):
            text.append(f"  {k:<10}", style="dim")
            text.append(f"{by_decision[k]}\n", style=_decision_style(k))
        text.append("\nHITL prompts   ", style="dim")
        text.append(f"{hitl_total}\n", style="bold")
        text.append("LLM judge calls ", style="dim")
        text.append(f"{judge_total}\n", style="bold")
        text.append("Avg latency    ", style="dim")
        text.append(f"{avg_latency:.1f}ms", style="bold")

        self.query_one("#stats_panel", Static).update(text)

    # ----- bindings -----

    def action_verify(self) -> None:
        if self.store is None or self.public_key is None:
            return
        report = verify_chain(self.store, self.public_key)
        if report.is_clean:
            self.notify(
                f"clean: {report.valid}/{report.total} records",
                title="verify",
                severity="information",
                timeout=4,
            )
        else:
            self.notify(
                f"TAMPERED at #{report.first_failure_id}: {report.failures[0].reason}",
                title="verify",
                severity="error",
                timeout=8,
            )

    def action_clear_log(self) -> None:
        log = self.query_one("#event_log", DataTable)
        log.clear()

    def on_unmount(self) -> None:
        if self.store is not None:
            self.store.close()
            self.store = None

    # ----- helpers -----

    def _header_right_text(self) -> Text:
        text = Text()
        text.append("agent_id      ", style="dim")
        text.append(f"{self.agent_id}\n", style="bold #79b8ff")
        text.append("fingerprint   ", style="dim")
        text.append(f"{self.fingerprint_str}\n", style="bold #b5cea8")
        text.append("db            ", style="dim")
        text.append(f"{self.db_path}", style="dim")
        return text


@app.command()
def watch(
    agent_id: str = typer.Argument(..., help="Agent ID to watch."),
) -> None:
    """Live dashboard streaming Bastion events as they happen."""
    if not paths.is_safe_agent_id(agent_id):
        typer.echo("invalid agent_id", err=True)
        raise typer.Exit(1)
    if not paths.agent_db_path(agent_id).exists():
        typer.echo(
            f"No audit DB for agent {agent_id!r}. Run `bastion init {agent_id}` first.",
            err=True,
        )
        raise typer.Exit(1)
    if not paths.agent_public_key_path(agent_id).exists():
        typer.echo(
            f"No public key for agent {agent_id!r}. Run `bastion init {agent_id}` first.",
            err=True,
        )
        raise typer.Exit(1)

    BastionDashboard(agent_id).run()
