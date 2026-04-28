"""`bastion report <agent_id>`: print or export the audit table."""

from __future__ import annotations

from pathlib import Path

import typer
from rich.console import Console

from bastion import paths
from bastion.cli import app
from bastion.sdk import Bastion

console = Console()

VALID_FORMATS = ("table", "markdown", "html", "json")


@app.command()
def report(
    agent_id: str = typer.Argument(..., help="Agent ID to report on."),
    format: str = typer.Option(
        "table",
        "--format",
        "-f",
        help=f"Output format: one of {VALID_FORMATS}.",
    ),
    out: Path | None = typer.Option(
        None, "--out", "-o", help="Write to file instead of stdout."
    ),
    stats: bool = typer.Option(
        False,
        "--stats",
        "-s",
        help="Append a summary stats panel after the table (table format only).",
    ),
) -> None:
    """Print or export the audit log for an agent."""
    if format not in VALID_FORMATS:
        console.print(f"[red]invalid format {format!r}; expected one of {VALID_FORMATS}[/red]")
        raise typer.Exit(1)
    if not paths.is_safe_agent_id(agent_id):
        console.print("[red]invalid agent_id[/red]")
        raise typer.Exit(1)
    if not paths.agent_db_path(agent_id).exists():
        console.print(
            f"[red]No audit DB for agent '{agent_id}'.[/red] "
            f"Run [cyan]bastion init {agent_id}[/cyan] first."
        )
        raise typer.Exit(1)

    bastion = Bastion(agent_id=agent_id, policies=[], auto_init=False)
    try:
        rendered = bastion.report(format=format)

        if format == "table":
            console.print(rendered)
            if stats:
                _print_stats(bastion.summary_stats())
        else:
            text = rendered if isinstance(rendered, str) else str(rendered)
            if out:
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_text(text, encoding="utf-8")
                console.print(f"[green]wrote {len(text)} bytes to {out}[/green]")
            else:
                # Plain print so pipe redirects work cleanly.
                typer.echo(text)
    finally:
        bastion.close()


def _print_stats(stats: dict) -> None:
    from rich.panel import Panel
    from rich.text import Text

    body = Text()
    body.append("Total records   ", style="dim")
    body.append(f"{stats['total']}\n", style="bold")

    body.append("\nBy decision\n", style="dim")
    for key in sorted(stats["by_decision"]):
        body.append(f"  {key:<10}", style="dim")
        body.append(f"{stats['by_decision'][key]}\n")

    body.append("\nBy source\n", style="dim")
    for key in sorted(stats["by_source"]):
        body.append(f"  {key:<14}", style="dim")
        body.append(f"{stats['by_source'][key]}\n")

    body.append("\nAvg latency by source (ms)\n", style="dim")
    for key in sorted(stats["avg_latency_ms_by_source"]):
        body.append(f"  {key:<14}", style="dim")
        body.append(f"{stats['avg_latency_ms_by_source'][key]}\n")

    body.append("\nHITL\n", style="dim")
    body.append(f"  total      {stats['hitl_total']}\n")
    body.append(f"  approved   {stats['hitl_approved']}\n")
    body.append(f"  denied     {stats['hitl_denied']}")

    console.print(
        Panel(body, title="[bold]Summary stats[/bold]", border_style="cyan", padding=(1, 2))
    )
