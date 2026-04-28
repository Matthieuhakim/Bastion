"""`bastion init <agent_id>`: generate keypair and create audit DB."""

from __future__ import annotations

import typer
from rich.console import Console
from rich.panel import Panel
from rich.text import Text

from bastion import paths
from bastion.audit.signer import (
    fingerprint,
    generate_keypair,
    load_public_key,
)
from bastion.audit.store import AuditStore
from bastion.cli import app

console = Console()


@app.command()
def init(
    agent_id: str = typer.Argument(
        ..., help="Identifier for the agent (filesystem-safe)."
    ),
    force: bool = typer.Option(
        False, "--force", "-f", help="Overwrite existing key/DB if present."
    ),
) -> None:
    """Initialize keys and audit DB for a new agent."""
    if not paths.is_safe_agent_id(agent_id):
        console.print(
            "[red]agent_id must be filesystem-safe (no '/', '\\', '..', "
            "or leading dot).[/red]"
        )
        raise typer.Exit(1)

    keys_dir = paths.agent_keys_dir(agent_id)
    db_path = paths.agent_db_path(agent_id)
    private_path = paths.agent_private_key_path(agent_id)
    public_path = paths.agent_public_key_path(agent_id)

    if private_path.exists() and not force:
        console.print(
            f"[yellow]Agent '{agent_id}' is already initialized.[/yellow]\n"
            f"  keys: {keys_dir}\n"
            f"  db:   {db_path}\n"
            "Pass [cyan]--force[/cyan] to overwrite (this destroys the chain "
            "of trust)."
        )
        raise typer.Exit(1)

    keys_dir.mkdir(parents=True, exist_ok=True)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    private_pem, public_pem = generate_keypair()
    private_path.write_bytes(private_pem)
    private_path.chmod(0o600)
    public_path.write_bytes(public_pem)
    public_path.chmod(0o644)

    store = AuditStore(db_path)
    store.close()

    fp = fingerprint(load_public_key(public_pem))

    body = Text()
    body.append("agent_id     ", style="dim")
    body.append(f"{agent_id}\n", style="bold cyan")
    body.append("fingerprint  ", style="dim")
    body.append(f"{fp}\n", style="bold green")
    body.append("private key  ", style="dim")
    body.append(f"{private_path} (0600)\n")
    body.append("public key   ", style="dim")
    body.append(f"{public_path} (0644)\n")
    body.append("audit db     ", style="dim")
    body.append(f"{db_path}")

    console.print(
        Panel(
            body,
            title="[bold]Bastion agent initialized[/bold]",
            border_style="cyan",
            padding=(1, 2),
        )
    )
