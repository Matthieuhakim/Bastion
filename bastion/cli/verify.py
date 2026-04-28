"""`bastion verify <agent_id>`: validate the signed audit chain."""

from __future__ import annotations

import typer
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from bastion import paths
from bastion.audit.signer import fingerprint, load_public_key
from bastion.audit.store import AuditStore
from bastion.audit.verifier import verify_chain
from bastion.cli import app

console = Console()


@app.command()
def verify(
    agent_id: str = typer.Argument(..., help="Agent ID to verify."),
) -> None:
    """Verify the signed audit chain for an agent."""
    if not paths.is_safe_agent_id(agent_id):
        console.print("[red]invalid agent_id[/red]")
        raise typer.Exit(1)

    public_path = paths.agent_public_key_path(agent_id)
    db_path = paths.agent_db_path(agent_id)

    if not public_path.exists():
        console.print(
            f"[red]No public key for agent '{agent_id}'.[/red] "
            f"Run [cyan]bastion init {agent_id}[/cyan] first."
        )
        raise typer.Exit(1)
    if not db_path.exists():
        console.print(
            f"[red]No audit DB for agent '{agent_id}'.[/red] "
            f"Run [cyan]bastion init {agent_id}[/cyan] first."
        )
        raise typer.Exit(1)

    public_key = load_public_key(public_path.read_bytes())
    store = AuditStore(db_path)
    report = verify_chain(store, public_key)
    fp = fingerprint(public_key)
    latest = store.latest_record()
    last_ts = latest.created_at if latest else "(empty chain)"
    store.close()

    if report.is_clean:
        body = Text()
        body.append("All ", style="")
        body.append(f"{report.valid}", style="bold green")
        body.append(" record(s) verified.\n\n")
        body.append("agent_id     ", style="dim")
        body.append(f"{agent_id}\n", style="cyan")
        body.append("fingerprint  ", style="dim")
        body.append(f"{fp}\n", style="green")
        body.append("records      ", style="dim")
        body.append(f"{report.total}\n")
        body.append("last record  ", style="dim")
        body.append(f"{last_ts}")

        console.print(
            Panel(
                body,
                title="[bold green]chain verified[/bold green]",
                border_style="green",
                padding=(1, 2),
            )
        )
        return

    table = Table(border_style="red", show_header=True, header_style="bold red")
    table.add_column("Record", justify="right")
    table.add_column("Reason")
    for failure in report.failures:
        table.add_row(str(failure.record_id), failure.reason)
    console.print(table)

    body = Text()
    body.append("Failures: ")
    body.append(f"{len(report.failures)}", style="bold red")
    body.append(" of ")
    body.append(f"{report.total}\n", style="bold")
    body.append("First failure at record ")
    body.append(f"#{report.first_failure_id}", style="bold red")
    body.append("\n\n")
    body.append("agent_id     ", style="dim")
    body.append(f"{agent_id}\n", style="cyan")
    body.append("fingerprint  ", style="dim")
    body.append(f"{fp}", style="green")

    console.print(
        Panel(
            body,
            title="[bold red]chain tampered[/bold red]",
            border_style="red",
            padding=(1, 2),
        )
    )
    raise typer.Exit(2)
