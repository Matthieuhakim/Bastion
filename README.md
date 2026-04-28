# Bastion

**Trust layer for AI agents: policy enforcement, human-in-the-loop escalation, and a tamper-evident signed audit chain. Local-only, no server.**

Bastion sits at the tool-call boundary of an AI agent and does three things on every call: enforces policies, escalates ambiguous decisions to a human, and writes a cryptographically signed record of the decision into a hash-chained audit log. Each piece exists somewhere else; the combination is what's defensible.

## Why it exists

Agents make mistakes. Prompt injection routes them to the wrong tool. A typo runs the wrong shell command. A loop on a paid API quietly drains a budget. After the fact, no one can reconstruct what the agent decided or why. Bastion is the prevention layer (policies + HITL) and the proof layer (signed chain) for those four failure modes.

It is not a network proxy. The SDK runs in the agent's process, so a malicious agent that wants to bypass it can. Bastion protects against accidents, prompt injection, cost runaway, and the absence of evidence — not against an adversarial agent author.

## Decision flow

Every tool call goes through this:

```text
Tool call
   |
   v
[ Code policies ] -- deny ----------------------> DENY (signed)
   |
   |-- escalate ---+
   |               |
   |-- defer ------+
   |               v
   |         [ LLM judge ]  (only if defer or NL policies exist)
   |               |
   |               |-- deny ------------------> DENY (signed)
   |               |-- escalate --+
   |               |              v
   v               v        [ HITL gate ]
   |               |              |
   |               |              |-- deny ---> DENY (signed)
   |               |              |-- approve+
   |               |                          |
   v               v                          v
ALLOW (signed)
   |
   v
Tool executes
   |
   v
[ tool_outcome record signed and chained ]
```

Each arrow that ends in DENY or ALLOW writes one signed record to the chain. HITL produces two records (the original escalation and the human's resolution). After a tool runs, a `tool_outcome` record is appended and linked to the prior decision.

## Quickstart

```bash
pip install -e .
bastion init my-agent
```

```python
from bastion import Bastion, policy

bastion = Bastion(
    agent_id="my-agent",
    policies=[
        policy.deny.tools("delete_file"),
        policy.deny.paths("/etc/*", "*.env", "~/.ssh/*"),
        policy.deny.above("amount", 1000),
        policy.escalate.above("amount", 30),
        policy.nl("Don't access files containing PII like SSNs or passwords."),
    ],
)

decision = bastion.evaluate("charge_card", {"amount": 200, "currency": "USD"})
# -> escalate -> CLI prompt -> Decision(outcome='allow', source='human', ...)

if decision.outcome == "allow":
    result = my_tool_function(...)
    bastion.record_outcome(success=True, output_hash="...", tool_name="charge_card")
```

`bastion verify my-agent` walks the chain and confirms every record's hash, signature, and link. `bastion report my-agent` prints a colored table; pass `--format markdown|html|json` for export. `bastion watch my-agent` opens a live Textual dashboard.

By default, Bastion stores local state in `.bastion/` at the nearest enclosing git repository root. Set `BASTION_HOME=/path/to/.bastion` to pin state somewhere else.

## Wiring into Claude Agent SDK

```python
from claude_agent_sdk import ClaudeAgentOptions, query
from bastion import Bastion, policy
from bastion.adapters.claude_agent_sdk import wire

bastion = Bastion(agent_id="demo", policies=[policy.deny.tools("delete_file")])
options = ClaudeAgentOptions(
    allowed_tools=["Bash", "Read", "Write"],
    **wire(bastion),  # adds can_use_tool + PostToolUse hook
)
```

`wire(bastion, mode="pre_tool_use_hook")` falls back to a PreToolUse hook with `permissionDecision` if `can_use_tool` doesn't fire in your CLI version (see Known Issues).

## Demo scenarios

The full demo at `examples/run_demo.py` exercises:

| Scenario | Tool call | Bastion outcome |
| --- | --- | --- |
| Read a normal file | `read_file("/tmp/bastion-demo/notes.txt")` | ALLOW |
| Delete a file | `delete_file(...)` | DENY (`deny.tools:delete_file`) |
| Charge $25 | `charge_card(amount=25)` | ALLOW |
| Charge $200 | `charge_card(amount=200)` | ESCALATE → HITL prompt |
| Read PII file | `read_file("/tmp/bastion-demo/ssn_records.txt")` | DENY (LLM judge) |

Run with `ANTHROPIC_API_KEY` set: `python examples/run_demo.py`. The demo pins its audit DB and keys under `examples/.bastion/`; use `BASTION_HOME=examples/.bastion bastion verify demo-agent` for CLI commands against that demo state.

## How verification works

Every record's body is canonicalized (sorted keys, no whitespace, UTF-8) and SHA-256 hashed. The hash is signed with the agent's Ed25519 private key. The body also embeds the previous record's hash, so any tampering produces a hash mismatch at exactly the mutated record.

```text
record N:
  body  = { record_id, timestamp, agent_id, event, ..., previous_hash: hash(N-1) }
  hash  = SHA-256(canonical(body))
  sig   = Ed25519_sign(private_key, hash)
```

Verification re-computes everything for each record:

1. SHA-256 of the canonical body must equal the stored hash.
2. The Ed25519 signature must verify against the stored hash with the public key.
3. The stored `previous_hash` must equal the prior record's `record_hash`.
4. The body's embedded `previous_hash` (hex) must equal the column.

Mutating the body breaks check 1. Forging a signature without the private key fails check 2. Re-ordering or splicing records breaks check 3. Genesis is 32 zero bytes for the first record.

## What this is not

- **Not a network proxy.** Bastion runs in-process. An agent that doesn't call `bastion.evaluate()` is not gated.
- **Not protection against a malicious agent author.** Anyone with write access to your agent code can bypass Bastion. The threat model is mistakes, prompt injection, cost runaway, and forensic gaps — not Mallory.
- **Not a key-management product.** Keys live unencrypted under `.bastion/agent_keys/`. For a real deployment you'd plug into a secrets store.
- **Not a multi-tenant audit service.** One file per agent, single writer. Concurrent writes from multiple processes are not supported.

## Known issues

- The Claude Agent SDK's `can_use_tool` callback **requires streaming-mode prompts** (`AsyncIterable[dict]`). If you call `query(prompt="...")` with a plain string and `can_use_tool` is set, you'll see `ValueError: can_use_tool callback requires streaming mode`. Use `wire(bastion, mode="pre_tool_use_hook")` instead — that wires Bastion via a PreToolUse hook, which works with both string and streaming prompts. The bundled demo (`examples/demo_agent.py`) uses this mode for that reason.
- The default LLM judge model is `claude-sonnet-4-6`. If your account doesn't have access, pass `judge_model=...` to `Bastion(...)`.
- The CLI HITL prompt uses Python `input()` with a thread-based timeout. If you Ctrl-C during a prompt the input thread leaks until the next stdin read.
- `python-dotenv` is only loaded in `examples/run_demo.py`; the SDK itself does not auto-load `.env`. If you embed Bastion in your own app and want NL policies, either `export ANTHROPIC_API_KEY` in your shell or load your own `.env` before constructing `Bastion(...)`.

## Performance

On an Apple M-series laptop, measured over 1000 calls (see `docs/EXPERIMENTS.md`):

- **Decision (engine only):** ~7 µs mean
- **Full evaluate (decision + sign + chain append):** 0.18 ms mean, 0.32 ms p99
- **Verify 1000 records:** ~200 ms
- **Chain size:** ~540 bytes per record
- **Tampering detection:** 100% across 100 random single-record mutations

The LLM judge adds ~500 ms to ~2 s per call depending on the model and prompt size; HITL latency is dominated by the human.

## Project layout

```text
bastion/
├── sdk.py                   # Bastion class
├── audit/                   # store, signer, chain, verifier
├── policy/                  # schema, code_policy, nl_policy, llm_judge, engine
├── hitl/                    # cli_prompt
├── adapters/                # claude_agent_sdk, openai_agents
└── cli/                     # init, verify, report, watch

examples/
├── demo_agent.py            # Claude Agent SDK demo with 4 tools
├── run_demo.py              # 5-scenario script
└── openai_sketch.py         # OpenAI Agents SDK shape

tests/   135 cases, including headless Textual tests
docs/    EXPERIMENTS.md, presentation outline
```

## License

MIT.
