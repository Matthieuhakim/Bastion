# Bastion: Build Plan

This document is a complete instruction set for building Bastion. It is written to be handed to Claude Code (or any capable coding agent) as the primary build brief. Read the entire document before starting Phase 0. Keep it open while building. When in doubt, prefer the design decisions captured here over your own instincts, but flag any genuine conflicts back to the user before deviating.

---

## 1. Project brief

**Bastion is a Python SDK that sits at the tool-call boundary of an AI agent and does three things: enforces policies, escalates to a human when needed, and produces a tamper-evident signed record of every decision.**

It is open source, local-only, and has no server component. A developer installs Bastion, configures a few policies, plugs the SDK into their agent framework, and from that point on every tool call the agent makes is intercepted, evaluated against policy, optionally routed to a human for approval, executed, and logged into a cryptographically signed audit chain that anyone can verify offline.

The core differentiator is the combination of three things that no existing tool ships together: real-time attribute-based policy enforcement, human-in-the-loop escalation as a first-class primitive, and an Ed25519-signed hash-chained audit trail. Each piece exists in some form elsewhere. The combination is what's defensible.

The threat model is honest: Bastion is not a network proxy. The SDK runs in the agent's process, so it cannot prevent a malicious agent from bypassing it entirely. What Bastion protects against is mistakes (prompt injection that drives an agent to the wrong tool), accidents (a destructive command typed into the wrong context), cost runaway (an agent looping on a paid API), and the absence of evidence (proving what happened after the fact). The signed audit trail is the proof layer; the policy engine is the prevention layer.

---

## 2. Locked technical decisions

These are not negotiable without consulting the user.

- **Language**: Python 3.11+
- **Storage**: SQLite via the standard library `sqlite3` module. Single file. Append-only audit table. No external database.
- **Crypto**: `cryptography` library for Ed25519 signing and SHA-256 hashing. Do not use `tweetnacl` or `pynacl`.
- **Demo agent framework**: Anthropic's Claude Agent SDK (`claude-agent-sdk` on PyPI). Integration via `can_use_tool` callback and `PostToolUse` hook. There is a known issue where `can_use_tool` may not fire reliably in certain CLI versions; if you encounter this, fall back to `PreToolUse` hooks, which provide equivalent functionality.
- **LLM judge**: Anthropic API via the `anthropic` package. Default model `claude-sonnet-4-6` for the judge. Use the developer's `ANTHROPIC_API_KEY` from environment.
- **TUI framework**: Textual.
- **CLI polish**: `rich` for colored, formatted terminal output.
- **CLI framework**: Typer.
- **Data models**: Pydantic v2.
- **License**: MIT.
- **Package name on PyPI**: `bastion-sdk` (the import name remains `bastion`).
- **No em-dashes anywhere in user-facing strings, comments, or documentation.** This is a copy preference, hold the line.

---

## 3. System architecture

### 3.1 Decision flow

Every tool call the agent attempts goes through this flow. Each arrow that ends at a labeled outcome (DENY, ALLOW) results in a signed record being appended to the audit chain.

```
Tool call
   │
   ▼
┌──────────────────┐
│  Code policies   │  returns: allow / deny / escalate / defer
└──────────────────┘
   │
   ├── deny ──────────────────────────────────────► DENY (signed)
   │
   ├── escalate ───────────────────┐
   │                               │
   ├── allow ──┐                   │
   │           │                   │
   └── defer ──┼──┐                │
               │  │                │
               │  ▼                │
               │ ┌──────────────────┐
               │ │   LLM judge      │  evaluates NL policies, returns: allow / deny / escalate
               │ │  (runs only if   │
               │ │  defer OR NL     │
               │ │  policies exist) │
               │ └──────────────────┘
               │       │
               │       ├── deny ───────────────────► DENY (signed)
               │       ├── escalate ──┐
               │       └── allow ──┐  │
               │                   │  │
               │                   │  ▼
               │                   │ ┌──────────────┐
               │                   │ │  HITL gate   │  ◄── (escalations from any layer arrive here)
               │                   │ └──────────────┘
               │                   │       │
               │                   │       ├── deny ───────────────► DENY (signed)
               │                   │       └── approve ─┐
               ▼                   ▼                    │
               ▼ ◄─────────────────▼ ◄──────────────────┘
         ALLOW (signed)
               │
               ▼
         Tool executes
               │
               ▼
     [PostToolUse outcome signed and chained]
```

The mental model: each policy layer returns `allow`, `deny`, `escalate`, or `defer`. Escalations route to the HITL gate regardless of which layer raised them. The LLM judge runs only when code policies returned `defer` (had nothing decisive to say) or when natural-language policies are configured and need evaluation. After execution, a separate `tool_outcome` record is signed and chained, linking the decision to what actually happened.

### 3.2 Component map

```
bastion/
├── __init__.py              # Public exports: Bastion, policy
├── sdk.py                   # Bastion class (public surface)
│
├── audit/
│   ├── __init__.py
│   ├── store.py             # SQLite schema, append-only insert, queries
│   ├── signer.py            # Ed25519 keypair lifecycle, sign, verify
│   ├── chain.py             # Canonical JSON, hashing, prev_hash linkage, append
│   └── verifier.py          # Walk chain, validate hashes + signatures + links
│
├── policy/
│   ├── __init__.py          # Re-exports the policy DSL
│   ├── schema.py            # Pydantic models: Policy, Decision, DecisionSource
│   ├── code_policy.py       # policy.deny.*, policy.escalate.*, decorators
│   ├── nl_policy.py         # policy.nl(...) factory
│   ├── llm_judge.py         # Calls Anthropic API, parses JSON decision
│   └── engine.py            # PolicyEngine.evaluate() orchestrating the flow above
│
├── hitl/
│   ├── __init__.py
│   └── cli_prompt.py        # Blocking input prompt with timeout
│
├── adapters/
│   ├── __init__.py
│   ├── claude_agent_sdk.py  # can_use_tool + PostToolUse hook
│   └── openai_agents.py     # Sketch only, ~50 lines, not demoed live
│
└── cli/
    ├── __init__.py          # Typer entry point
    ├── init.py              # bastion init <agent_id>
    ├── verify.py            # bastion verify <agent_id>
    ├── report.py            # bastion report <agent_id>
    └── watch.py             # bastion watch <agent_id> (Textual TUI)

examples/
├── demo_agent.py            # Claude Agent SDK demo with 4 tools
├── run_demo.py              # Scripted scenarios for the presentation
└── openai_sketch.py         # Minimal OpenAI Agents SDK example

tests/
├── test_audit_chain.py
├── test_signer.py
├── test_code_policy.py
├── test_nl_policy.py
├── test_engine.py
├── test_hitl.py
├── test_sdk_api.py
└── test_claude_adapter.py

docs/
└── (placeholder, populated late)
```

### 3.3 Audit record schema

Every record appended to the chain is a JSON object with this shape, canonicalized (keys sorted, no whitespace) before hashing:

```json
{
  "record_id": 42,
  "timestamp": "2026-04-28T14:23:07.412Z",
  "agent_id": "my-shopping-agent",
  "event": "policy_decision",
  "tool_name": "charge_card",
  "tool_input_hash": "e5a1...3f07",
  "decision": "escalate",
  "decision_source": "code_policy",
  "policy_id": "escalate.above:amount:30",
  "reason": "amount 200 exceeds threshold 30",
  "latency_ms": 3,
  "previous_hash": "b7d3...91fa"
}
```

`event` is one of: `policy_decision`, `hitl_decision`, `tool_outcome`. `decision_source` is one of: `code_policy`, `llm_judge`, `human`, `tool_runtime`. The full input data is hashed (not stored in plaintext) to keep the chain compact and avoid leaking sensitive payloads. Each record is signed with the agent's Ed25519 key after canonicalization and hashing. The signature and `record_hash` live in the SQLite row alongside the JSON body.

### 3.4 Public API surface

This is what developers see. The whole point is that it should feel like five minutes from `pip install bastion-sdk` to working guardrails.

```python
from bastion import Bastion, policy

bastion = Bastion(
    agent_id="my-shopping-agent",
    policies=[
        # Code policies (fast, deterministic)
        policy.deny.tools("Delete", "DropTable"),
        policy.deny.paths("/etc/*", "*.env", "~/.ssh/*"),
        policy.escalate.above("amount", 30),
        policy.deny.above("amount", 1000),
        
        # NL policies (LLM judge, ambiguous cases)
        policy.nl("Don't access personal information or PII"),
        policy.nl("Don't make changes that affect production data"),
    ],
)

# For full power, drop into a function
@policy.deny
def no_destructive_bash(tool_name, input_data):
    return tool_name == "Bash" and any(
        bad in input_data.get("command", "")
        for bad in ["rm -rf", "DROP TABLE", "format"]
    )
```

Wiring into a Claude Agent SDK agent is one line:

```python
from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient
from bastion.adapters.claude_agent_sdk import wire

options = ClaudeAgentOptions(
    allowed_tools=["Bash", "Read", "Write"],
    **wire(bastion),
)
```

`wire(bastion)` returns a dict with `can_use_tool` and `hooks` set up correctly, merged into whatever the developer passes to `ClaudeAgentOptions`.

---

## 4. Working principles

These apply to every phase. Internalize them before writing code.

**Test continuously, not eventually.** Every phase has a checkpoint with explicit pass criteria. Write the test or validation script for a phase before or alongside the implementation. Do not move to the next phase until the current phase's checkpoint passes cleanly. If you find yourself thinking "I'll add tests later," stop and add them now.

**Iterate in small loops.** Write a small piece, run it, observe the actual behavior, adjust. Do not write 500 lines and then run for the first time. Especially for crypto and chain logic: write 30 lines, run, verify, then write the next 30. Bugs in this category compound.

**Validate against reality, not assumptions.** Especially for the Claude Agent SDK adapter: run a tiny script the moment you have any code wired up. The `can_use_tool` callback has known issues in certain CLI versions. Test the integration in the first hour you start Phase 7, not after writing the whole adapter.

**Use subagents when work is parallelizable.** You have the option to spawn subagents for tasks that don't depend on each other. Examples where this might help: investigating an unfamiliar API while continuing implementation; writing tests for a completed module while working on the next module; preparing the README while the core is being polished. Use your own judgment on when to delegate and when to do it inline. Don't over-decompose; subagent overhead is real.

**Commit after every passing checkpoint.** Each phase ends with a commit. Use the suggested commit message format in the phase description, or write your own as long as it accurately reflects the change. Commits within a phase are encouraged for non-trivial intermediate progress. After the phase passes its checkpoint, push to the remote.

**Push to GitHub at every checkpoint.** This is a public open source project. The repo should reflect honest, incremental progress. Do not squash phases together. Do not force-push over real history. If you make a mistake, fix it forward.

**Ask the user before deviating from this plan.** If you discover that something here is wrong, infeasible, or would be much better done differently, surface it. Do not silently change the architecture or stack. Small implementation choices (variable names, internal helpers, test structure) are yours to make. Architectural shifts require a check-in.

**Be honest about what doesn't work.** If a phase passes its checkpoint but you noticed something fragile, write it down. The presentation will include a "what failed" section, and real findings are more valuable than a polished demo that hides problems.

---

## 5. Pre-flight setup

Before starting Phase 0:

1. Confirm you have Python 3.11+ available.
2. Confirm `git` is configured with a name and email.
3. Ask the user for the GitHub repository URL. The user should create an empty public repo named `bastion` (or similar) on GitHub before you begin. If the user has the `gh` CLI available and prefers, you can create the repo programmatically with `gh repo create bastion --public --description "Trust layer for AI agents: policy enforcement, HITL, signed audit"`.
4. Confirm `ANTHROPIC_API_KEY` is set in the environment. The judge and the demo agent both need it.
5. Confirm a working terminal that supports Textual rendering (most modern terminals do, but check before Phase 10).

---

## 6. Build phases

Each phase below has: a goal, the files involved, implementation notes, what to test, the checkpoint criteria, and a suggested commit message. Work through them in order.

### Phase 0: Repository bootstrap

**Goal:** A clean, runnable Python package skeleton pushed to GitHub.

**Implementation:**
- Create the project directory structure shown in section 3.2 with empty `__init__.py` files. Skip the implementation files for now; just empty placeholders.
- Write `pyproject.toml` declaring the package, its dependencies, the CLI entry point (`bastion = "bastion.cli:app"`), and dev dependencies (pytest, ruff).
- Write `.gitignore` (Python standard, plus `*.db`, `*.bastion.db`, `agent_keys/`, `.bastion/`, `.venv/`).
- Write `README.md` with a one-paragraph description and a "status: in development" note. Full README comes later.
- Write `LICENSE` (MIT, with the user's name).
- Initialize git, make the first commit, add the remote, push.
- Create and activate a virtualenv. Run `pip install -e ".[dev]"`.

**Test:** `python -c "import bastion"` runs without error. `pytest` runs (and finds no tests, which is fine). `bastion --help` prints something (even if Typer just shows the empty app for now).

**Checkpoint:** The repo exists on GitHub with a working install. The CI is not required yet.

**Commit:** `Phase 0: project skeleton and tooling`

---

### Phase 1: Audit chain core

**Goal:** A working append-only signed hash chain in SQLite, with verification.

**Implementation:**
- `bastion/audit/store.py`: Create the SQLite schema. Use `sqlite3` from the standard library. Schema:
  ```sql
  CREATE TABLE IF NOT EXISTS audit_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_json TEXT NOT NULL,
      record_hash BLOB NOT NULL,
      signature BLOB NOT NULL,
      previous_hash BLOB NOT NULL,
      created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_created_at ON audit_records(created_at);
  ```
  Provide functions: `init_db(path)`, `append_record(...)`, `get_record(id)`, `iter_records(agent_id=None)`, `latest_record()`, `latest_hash() -> bytes` (returns the genesis hash if empty).
- `bastion/audit/signer.py`: Ed25519 keypair generation using `cryptography.hazmat.primitives.asymmetric.ed25519`. Functions: `generate_keypair() -> (private_pem, public_pem)`, `load_private_key(pem)`, `load_public_key(pem)`, `sign(private_key, message: bytes) -> bytes`, `verify(public_key, message: bytes, signature: bytes) -> bool`.
- `bastion/audit/chain.py`: Canonical JSON serialization (`json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()`). SHA-256 hashing. The high-level `append(record_dict, agent_private_key, store)` function that: looks up the previous hash, injects it into the record, canonicalizes, hashes, signs, and appends to the store. Returns the new record's hash.
- `bastion/audit/verifier.py`: `verify_chain(store, agent_public_key) -> VerificationReport`. Walks the chain in order. For each record: re-canonicalize the body, recompute SHA-256, check it matches the stored hash; verify the signature against the stored hash and the public key; check that `previous_hash` matches the prior record's `record_hash`. Returns a report listing total records, valid records, and the index of the first failure if any.

**Genesis hash:** Use 32 zero bytes (`b"\x00" * 32`) as the previous_hash for the very first record.

**Test:** Write `tests/test_audit_chain.py`:
1. Generate a keypair.
2. Append 100 distinct records, each with a fake agent_id and tool_name.
3. Run the verifier. All 100 should pass.
4. Manually mutate the `record_json` of row 42 in the SQLite file (e.g., change the tool_name).
5. Run the verifier again. It should report tampering at exactly record 42.
6. Restore record 42, verify clean again.
7. Mutate record 42's `previous_hash`. Verify should detect chain link failure.

Run the test. If it doesn't pass cleanly, debug before moving on.

**Checkpoint:** Tampering is detected at the exact record, every time, for both content and chain link mutations.

**Commit:** `Phase 1: signed append-only audit chain with verification`

---

### Phase 2: CLI for keys and verify

**Goal:** A polished CLI with `bastion init` and `bastion verify` commands.

**Implementation:**
- `bastion/cli/__init__.py`: Typer app, registers subcommands.
- `bastion/cli/init.py`: `bastion init <agent_id>`. Generates a keypair, stores private key at `~/.bastion/agent_keys/<agent_id>/private.pem` (mode 0600), public key at `public.pem` (mode 0644). Initializes a SQLite file at `~/.bastion/<agent_id>.db`. Prints a polished `rich` confirmation with the agent_id, the public key fingerprint (first 16 hex chars of SHA-256 of the public key bytes), and the database path.
- `bastion/cli/verify.py`: `bastion verify <agent_id>`. Loads the public key, opens the database, runs the verifier, prints results. Use `rich` for a clean output: green checkmark per valid record (or a single summary line for large chains), red X with location for tampering. Include a final summary panel showing total records, agent_id, key fingerprint, last record timestamp.

**Test:** End-to-end manual test:
1. `bastion init demo-agent` — confirm files created with correct permissions.
2. Run a Python script that uses the audit chain to append 10 records.
3. `bastion verify demo-agent` — confirm clean output.
4. Edit one record manually. `bastion verify demo-agent` — confirm clear error output.

**Checkpoint:** A user can run two commands and see polished, accurate output. Tampering is detected and clearly reported.

**Commit:** `Phase 2: CLI for key generation and chain verification`

---

### Phase 3: Code policy engine

**Goal:** The full code policy DSL, working without any LLM or HITL.

**Implementation:**
- `bastion/policy/schema.py`: Pydantic models:
  - `Decision`: `outcome` (Literal `"allow" | "deny" | "escalate" | "defer"`), `source` (Literal `"code_policy" | "llm_judge" | "human"`), `policy_id` (str), `reason` (str), `latency_ms` (int).
  - `Policy`: abstract base with `evaluate(tool_name, input_data) -> Decision`.
- `bastion/policy/code_policy.py`: Implement the DSL.
  - `policy.deny.tools("Delete", "DropTable")` returns a `ToolNamePolicy` that denies if `tool_name` matches.
  - `policy.deny.paths("/etc/*", "*.env")` returns a `PathPolicy` using fnmatch on any string field that looks like a path. Smart: it scans `input_data` for path-like strings, doesn't require the field to be named "path".
  - `policy.deny.above("amount", 1000)`, `policy.escalate.above("amount", 30)` return `ThresholdPolicy` that checks numeric fields.
  - `@policy.deny` and `@policy.escalate` decorators that wrap a function `(tool_name, input_data) -> bool` into a `Policy`.
- `bastion/policy/engine.py`: `PolicyEngine` class. Holds a list of policies. `evaluate(tool_name, input_data)`:
  - Run each code policy in order.
  - Track outcomes. If any returns `deny`, that's the final decision (short-circuit).
  - If any returns `escalate`, that's the final decision (short-circuit).
  - If any returns `defer`, mark the result as "needs LLM judge" but keep evaluating remaining code policies (they could still deny).
  - If all return `allow` and none deferred, return `allow`.
- Each policy gets a `policy_id` automatically generated from its class and parameters (e.g. `escalate.above:amount:30`). This goes into the `Decision`.

**Test:** Write `tests/test_code_policy.py`:
- `policy.deny.tools("Delete")` denies `("Delete", {})` and allows `("Read", {})`.
- `policy.deny.paths("/etc/*")` denies `("Write", {"path": "/etc/passwd"})` and allows `("Write", {"path": "/tmp/x"})`.
- `policy.escalate.above("amount", 30)` returns escalate for `{"amount": 50}` and allow for `{"amount": 20}`.
- `policy.deny.above("amount", 1000)` denies for `{"amount": 5000}`.
- A function-based `@policy.deny` decorator works.
- The engine short-circuits correctly: if `policy[0]` denies, `policy[1]` is not evaluated.
- Latency is measured and populated in the `Decision`.

**Checkpoint:** All policy primitives work correctly in isolation and through the engine. Decisions carry accurate metadata.

**Commit:** `Phase 3: code policy engine with composable DSL`

---

### Phase 4: Natural-language policy and LLM judge

**Goal:** NL policies evaluated by Claude, integrated into the engine on the right path.

**Implementation:**
- `bastion/policy/nl_policy.py`: `policy.nl("...")` returns an `NLPolicy` object that just stores the text. NL policies don't evaluate themselves; they're passed to the judge.
- `bastion/policy/llm_judge.py`: `LLMJudge` class. Takes a list of NL policies. Method: `evaluate(tool_name, input_data) -> Decision`. Builds a prompt:
  ```
  You are a security policy judge for an AI agent's tool calls.
  
  Policies (the agent must obey all of them):
  - {policy_1.text}
  - {policy_2.text}
  - ...
  
  The agent is requesting:
    Tool: {tool_name}
    Input: {json.dumps(input_data)}
  
  Decide one of: allow, deny, escalate.
  - allow: the request clearly does not violate any policy.
  - deny: the request clearly violates at least one policy.
  - escalate: the request is ambiguous or borderline; a human should decide.
  
  Respond ONLY with valid JSON in this exact shape:
  {"decision": "allow"|"deny"|"escalate", "reason": "brief explanation", "policy_violated": "the policy text or null"}
  ```
  Use the Anthropic SDK with `claude-sonnet-4-6`, low temperature (0.0), max_tokens 256. Parse the JSON response. Wrap into a `Decision` with `source="llm_judge"`.
- Update `bastion/policy/engine.py`: After code policies, if any returned `defer` OR if NL policies are configured at all, run the LLM judge. Apply the same outcome routing (deny short-circuits, escalate short-circuits, allow continues).

**Important:** Be honest about non-determinism. The LLM judge may give different results on different runs. Document this. Don't try to hide it.

**Test:** Write `tests/test_nl_policy.py`:
- `policy.nl("Never access /etc")` denies `("Write", {"path": "/etc/passwd"})` reliably (run 3 times, expect deny each time).
- A clearly safe call like `("Read", {"path": "/tmp/log.txt"})` against the same policy returns allow.
- An ambiguous case (path that's borderline) returns escalate or one of the binary outcomes; whichever, log it.

These tests cost API calls. Mark them with `@pytest.mark.llm` so they can be skipped in fast test runs (`pytest -m "not llm"`).

**Checkpoint:** The judge works end-to-end. The engine routes correctly. Tests pass on a clear positive case and a clear negative case.

**Commit:** `Phase 4: natural-language policies with Claude as judge`

---

### Phase 5: Human-in-the-loop via CLI prompt

**Goal:** When any policy returns `escalate`, the engine pauses and asks the developer to approve or deny via the terminal.

**Implementation:**
- `bastion/hitl/cli_prompt.py`: `CLIPromptHandler` class. Method: `request_approval(decision: Decision, tool_name: str, input_data: dict) -> Decision`. Prints a `rich`-formatted prompt showing the tool, the input (truncated if large), the policy that escalated, and the reason. Then blocks on `input()` waiting for `a` (approve), `d` (deny), or timeout. Default timeout 60 seconds. On timeout, treat as deny and log it. On approve, return a new `Decision` with `outcome="allow"`, `source="human"`, `reason="approved by user"`. On deny, return a `Decision` with `outcome="deny"`, `source="human"`.
- Update `bastion/policy/engine.py`: When any layer returns `escalate`, call the configured HITL handler. The handler's response becomes the final decision. Both the original escalation and the human's resolution are signed and recorded as separate audit records (event types `policy_decision` and `hitl_decision`).

**Test:** Write `tests/test_hitl.py`:
- Mock `input()` to return `"a"`. Trigger an escalation. Confirm allow with `source="human"`.
- Mock `input()` to return `"d"`. Confirm deny.
- Mock `input()` to hang past the timeout. Confirm deny on timeout.

**Manual test:** Run a small script that triggers an escalation. See the prompt. Approve. See the run continue. Run again, deny, see it fail.

**Checkpoint:** The HITL flow works end-to-end with both responses and timeout. Both records are signed and chained.

**Commit:** `Phase 5: HITL gate via CLI prompt`

---

### Phase 6: Public SDK surface

**Goal:** The `Bastion` class that ties everything together and that developers actually use.

**Implementation:**
- `bastion/sdk.py`: `Bastion` class.
  - Constructor: `agent_id`, `policies` (list), `hitl_handler` (defaults to CLI prompt), `db_path` (defaults to `~/.bastion/<agent_id>.db`), `judge_model` (defaults to `claude-sonnet-4-6`).
  - On init: load or create keypair, load or create database, build policy engine, instantiate LLM judge if any NL policies, instantiate HITL handler.
  - `evaluate(tool_name, input_data) -> Decision`: orchestrates code policies + LLM judge + HITL, signs and records the final decision, returns it.
  - `record_outcome(decision_record_id, success: bool, output_hash: str | None, error: str | None)`: appends a `tool_outcome` record linked to the prior decision.
  - `verify() -> VerificationReport`: shortcut to the chain verifier.
  - `report() -> Table`: returns a `rich.Table` of all tool calls in the current chain with timestamp, tool, decision, source, latency. Also accepts `format="markdown" | "json" | "html"` for export.
- `bastion/__init__.py`: re-export `Bastion` and the `policy` module.

**Test:** Write `tests/test_sdk_api.py`:
- Create a `Bastion` with a couple of code policies, no NL.
- Call `evaluate` on an allowed action. Confirm allow.
- Call `evaluate` on a denied action. Confirm deny.
- Call `record_outcome` after a successful tool call. Confirm both records are in the chain.
- Call `verify()`. Confirm it passes.
- Call `report()` and check the output structure.

**Checkpoint:** A pure-Python script (no agent framework) can use the Bastion class end to end and the audit chain reflects everything correctly.

**Commit:** `Phase 6: public Bastion SDK surface`

---

### Phase 7: Claude Agent SDK adapter

**Goal:** A one-line wiring helper that plugs Bastion into a Claude Agent SDK agent.

**Implementation:**
- `bastion/adapters/claude_agent_sdk.py`:
  - `wire(bastion: Bastion) -> dict`: returns a dict with `can_use_tool` and `hooks` keys, ready to spread into `ClaudeAgentOptions`.
  - The `can_use_tool` callback signature is `async def(tool_name, input_data, context) -> PermissionResultAllow | PermissionResultDeny`. Inside: call `bastion.evaluate(tool_name, input_data)`, return `PermissionResultAllow()` if allow, `PermissionResultDeny(message=decision.reason)` otherwise.
  - The `PostToolUse` hook signature is per the Claude Agent SDK docs: `async def(input_data, tool_use_id, context) -> dict`. Inside: call `bastion.record_outcome(...)` linking back to the decision. The hook is registered via a `HookMatcher(matcher="*", hooks=[...])` so it fires for every tool.

**Critical first test:** Before writing the full adapter, write a 30-line script that just uses `can_use_tool` with a hardcoded callback that always denies. Run it against a Claude Agent SDK agent. Confirm the callback actually fires and tools are blocked. If it does not fire, this is the known issue. Switch to `PreToolUse` hooks immediately and update the adapter accordingly. Document what you observed in the README under "known issues."

**Test:** Write `tests/test_claude_adapter.py` (may need to be a manual integration test rather than unit, depending on what's mockable):
- A Claude agent configured with `tools=["Bash"]` and a Bastion policy denying `Bash` calls containing `rm`. Issue a prompt that should trigger such a call. Confirm it's blocked, the agent gets the deny message, and the audit chain has a `policy_decision` record with `outcome="deny"`.

**Checkpoint:** Bastion blocks tool calls in a real Claude Agent SDK agent, end to end.

**Commit:** `Phase 7: Claude Agent SDK adapter`

---

### Phase 8: Demo agent and scenario script

**Goal:** A working demo that shows allow / deny / escalate / NL-catch / verify / tamper-detect / report.

**Implementation:**
- `examples/demo_agent.py`: Define 4 in-process MCP tools using the Claude Agent SDK's `@tool` decorator and `create_sdk_mcp_server`:
  - `read_file(path)`: returns the contents of a file (sandboxed to a demo directory).
  - `write_file(path, content)`: writes a file.
  - `delete_file(path)`: deletes a file (this one will mostly be denied).
  - `charge_card(amount, currency)`: a fake Stripe-like tool that just returns a fake transaction id.
  
  Configure a `Bastion` instance with policies:
  ```python
  policies = [
      policy.deny.tools("delete_file"),
      policy.deny.paths("/etc/*", "~/.ssh/*", "*.env"),
      policy.escalate.above("amount", 30),
      policy.deny.above("amount", 1000),
      policy.nl("Don't access files containing personal information like SSNs, passwords, or financial records"),
  ]
  ```
  Wire Bastion into the agent options.

- `examples/run_demo.py`: A script that drives the agent through these scenarios with hard-coded prompts:
  1. "Read the file at /tmp/demo/notes.txt." → ALLOW
  2. "Delete the file /tmp/demo/notes.txt." → DENY
  3. "Charge the card $25 in USD." → ALLOW
  4. "Charge the card $200 in USD." → ESCALATE → user approves at terminal → ALLOW
  5. "Read /tmp/demo/ssn_records.txt." → NL judge denies
  After all scenarios, the script:
  - Prints `bastion.report()`.
  - Calls `bastion.verify()` and prints the result.
  - Optionally pauses and tells the user to "tamper with row 4 in `~/.bastion/demo-agent.db` and press enter."
  - Calls `bastion.verify()` again, showing the tampering detection.

- Iterate on the prompts until the agent reliably calls the expected tools. LLM agents are non-deterministic; you may need to tune the prompt or add explicit instructions ("call the delete_file tool with path /tmp/demo/notes.txt") to make the demo reproducible.

**Test:** Run `examples/run_demo.py` end to end at least three times. Confirm each scenario produces the expected outcome reliably. If any scenario fails inconsistently, fix it before moving on.

**Checkpoint:** The demo runs cleanly three times in a row with the expected outcomes.

**Commit:** `Phase 8: demo agent with end-to-end scenarios`

---

### Phase 9: Post-run report

**Goal:** Developers can call `bastion.report()` after a run or `bastion report <agent_id>` from the CLI to see a clear table of every tool call.

**Implementation:**
- `bastion/sdk.py`: implement the `report()` method on `Bastion`. Returns a `rich.Table` by default. Columns: `#`, `Time`, `Tool`, `Decision`, `Source`, `Latency`, `Reason`. Color the `Decision` column (green allow, red deny, amber escalate, blue human-approved).
- `bastion/cli/report.py`: `bastion report <agent_id>` reads the chain for the agent and prints the same table. Support `--format markdown|json|html` for export. For HTML, use `rich.console.Console.export_html()`.
- Add a method `bastion.summary_stats()` returning total calls, breakdown by decision and source, average latency per source, count of HITL escalations and their resolutions. Useful for the slides.

**Test:** Run the demo, then `bastion report demo-agent`. Confirm the table is accurate, colored, and readable. Try the markdown export and confirm it's valid.

**Checkpoint:** The report is informative, accurate, and visually polished.

**Commit:** `Phase 9: post-run reporting (table, markdown, html, json)`

---

### Phase 10: TUI dashboard

**Goal:** A visually amazing live dashboard launched with `bastion watch <agent_id>`.

This phase deserves real polish. The TUI is the visual centerpiece. Spend the time.

**Implementation:**
- `bastion/cli/watch.py`: Textual app `BastionDashboard`.
- Layout (use Textual's CSS-like styling):
  - Header bar: large `BASTION` title in an accent color, agent_id and key fingerprint on the right.
  - Main row, ~60% height:
    - Live audit feed (Textual `RichLog` or `DataTable` set to auto-scroll). Each new record streams in. Color-code by decision: green allow, red deny, amber escalate, blue human-approved. Show timestamp, tool name, decision, source, reason (truncated).
  - Bottom row, split into two panels:
    - Active policies (left, ~50%): a `DataTable` listing each configured policy and its hit count (denies + escalates triggered). Update counts in real time.
    - Stats (right, ~50%): a panel with total calls, breakdown by decision (with bar visualization or simple counts), average latency by source, count of LLM judge calls, count of HITL prompts.
  - Footer: keyboard shortcuts: `v` verify chain, `r` open report, `q` quit.
- Polling strategy: the dashboard re-queries SQLite every 200ms for new records. Cheap and simple. If the chain has more than say 10,000 records, switch to incremental loading (only fetch since last seen `id`).
- Visual polish: use Unicode box-drawing characters, generous padding, a coherent color scheme (suggest: dark background, cyan/green accent, amber/red for warnings). Look at examples in the Textual showcase repo for inspiration. Make the title bar feel like a real product, not a debugging tool.
- Add a small "ASCII art" banner for `BASTION` rendered in the header on startup (use `pyfiglet` if you want, or hand-roll).

**Test:** Run the demo with `bastion watch demo-agent` open in a second terminal. Watch each event stream in. Try the keyboard shortcuts. Resize the terminal and confirm the layout adapts. Test with an empty chain (just-initialized agent) and confirm it still renders without errors.

This is the phase where you might consider a subagent to research Textual best practices or generate variations on the layout while you implement the polling layer. Use your judgment.

**Checkpoint:** Open the TUI, run the demo, watch events stream, hit the keyboard shortcuts, see everything work cleanly. The TUI looks like something you'd want to show off.

**Commit:** `Phase 10: live TUI dashboard with policy and stats panels`

---

### Phase 11: OpenAI Agents SDK adapter sketch

**Goal:** A short, clean adapter file proving the core is framework-agnostic.

**Implementation:**
- `bastion/adapters/openai_agents.py`: ~50 lines. Implement a function-tool guardrail that wraps a tool function with `bastion.evaluate()`. The OpenAI Agents SDK supports input/output guardrails per tool. Show how to plug Bastion in.
- `examples/openai_sketch.py`: ~30 lines. A minimal OpenAI Agents SDK agent with one tool and one Bastion policy. Doesn't need to run end-to-end with a real OpenAI API call (you may not have a key, or may not want to spend on it). Just enough to compile and demonstrate the integration shape.
- Add a docstring at the top of the adapter file: "Sketch demonstrating the framework-agnostic core. Full integration is future work."

**Test:** Confirm the file imports cleanly (`python -c "from bastion.adapters import openai_agents"`). If you have an OpenAI key available, test it for real; if not, just static check.

**Checkpoint:** The sketch exists, is readable, and demonstrates the same `bastion.evaluate()` core being called from a different framework.

**Commit:** `Phase 11: OpenAI Agents SDK adapter sketch`

---

### Phase 12: README and presentation materials

**Goal:** A README that makes the project clear to anyone landing on the repo, and structured material that supports the class presentation.

**Implementation:**
- `README.md`: rewrite from the placeholder. Sections:
  - One-paragraph hook: what Bastion is and why.
  - The architecture diagram (the decision flow from section 3.1, ASCII).
  - 5-minute quickstart: `pip install`, `bastion init`, write 10 lines of policy + agent, run.
  - The four demo scenarios (with output snippets).
  - "How verification works" — a short explanation of the signed chain.
  - "What this is not" — be honest about the threat model: not a network proxy, doesn't prevent malicious agents.
  - Known issues (the `can_use_tool` thing if it bit you).
  - License.
- `docs/EXPERIMENTS.md` (for the slides): collect concrete measurements from the build:
  - Latency overhead per call (code policy only, with LLM judge, with HITL).
  - LLM judge agreement rate across 3 runs of the same prompt (shows non-determinism honestly).
  - Audit chain size after the demo (records, bytes).
  - Tampering detection rate (should be 100% for any single-record mutation).
- A `slides/` directory or a separate doc with bullets for each presentation section the professor asked for: problem, why agentic, architecture, what was built, experimental results, what worked, what failed, what's next. Don't generate slide images; just the content. The user will build the actual slides.

**Test:** Have someone who hasn't seen the project read the README and try the quickstart. If they get stuck, fix the README.

**Checkpoint:** A new visitor to the repo can understand what Bastion is and run the demo within 10 minutes of arriving.

**Commit:** `Phase 12: README, experiment notes, and presentation materials`

---

## 7. Acceptance criteria for the whole project

Before declaring the build done, all of these must be true:

1. `pip install -e .` works on a fresh clone.
2. `bastion init`, `bastion verify`, `bastion report`, `bastion watch` all work.
3. The full demo (`python examples/run_demo.py`) runs cleanly through all five scenarios on at least three consecutive runs.
4. `bastion verify` confirms a clean chain after the demo.
5. Manually tampering with one record causes `bastion verify` to detect it at the correct location.
6. The TUI dashboard renders correctly and updates live during a run.
7. The audit chain contains separate records for policy decisions, HITL decisions, and tool outcomes, all properly linked.
8. Every phase has at least one test, and `pytest -m "not llm"` passes cleanly.
9. The README is accurate and someone unfamiliar with the project can run the quickstart.
10. The repo on GitHub reflects honest incremental commits, one or more per phase.

If any of these fail, the project is not done. Fix forward, don't paper over.

---

## 8. When to ask the user

Ask the user before:
- Adding a dependency not listed in section 2.
- Changing the public API surface in section 3.4.
- Skipping a phase or merging two phases.
- Substituting a different agent framework, language, or storage backend.
- Anything that would change the demo flow described in Phase 8.

Don't ask the user for:
- Internal implementation details.
- Variable names, helper functions, file organization within a module.
- Test structure.
- Choice of `rich` styling, color palettes, layout proportions in the TUI.
- Bug fixes that don't change the public surface.

When you do need to ask, batch your questions if possible. Don't interrupt the user every five minutes.

---

## 9. A note on the build itself

You're building a security tool. Treat it like one. Don't rush past the crypto. Don't guess about hash canonicalization. Don't assume tests pass without running them. Don't commit code you haven't executed. If you find yourself uncertain about whether something is correct, stop and verify it.

The tampering-detection demo is the emotional peak of the presentation. If it doesn't work flawlessly, the rest of the project loses its impact. Make sure that one is rock solid.

Good luck. Build something the user will be proud to show.
