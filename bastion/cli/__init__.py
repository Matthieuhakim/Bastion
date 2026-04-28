"""Bastion CLI entry point.

Subcommands are registered as Typer apps in the sibling modules.
"""

import typer

from bastion import __version__

app = typer.Typer(
    name="bastion",
    help="Bastion: policy enforcement, HITL, and signed audit for AI agents.",
    no_args_is_help=True,
    add_completion=False,
)


@app.callback()
def _root() -> None:
    """Bastion CLI."""


@app.command()
def version() -> None:
    """Print the Bastion version."""
    typer.echo(f"bastion {__version__}")


def main() -> None:
    app()


if __name__ == "__main__":
    main()
