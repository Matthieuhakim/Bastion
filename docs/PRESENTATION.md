# Presentation outline

Bullet points only — slides will be built from these. Match the section headings the professor asked for.

## 1. The problem

- AI agents call tools. Tools have effects: shell commands, payments, file writes, API calls.
- Four failure modes that recur across every agent stack:
  - **Mistakes**: prompt injection routes the agent to the wrong tool.
  - **Accidents**: the agent calls a destructive tool with the wrong context.
  - **Cost runaway**: a loop on a paid API silently drains a budget.
  - **No proof**: after an incident, no one can reconstruct what the agent decided or why.
- Existing tools cover one of these, never all four together.

## 2. Why agentic systems make it worse

- Agents are non-deterministic. The same prompt produces different tool calls.
- Agents chain decisions. A small earlier mistake compounds.
- Tools execute with the agent's privileges. There is no "edit summary" to review.
- Auditing post-hoc means parsing transcripts and trusting them. Transcripts are mutable.
- The right control point is *between the agent's decision to call a tool and the tool actually running*.

## 3. Architecture

- **Three layers, one decision flow:**
  - Code policies (deterministic, microseconds)
  - LLM judge (Claude, for natural-language rules)
  - HITL gate (human approval at the terminal)
- **Every decision becomes a signed audit record.**
- **Append-only SQLite chain.** Each record's body embeds the previous record's hash; the body is canonicalized, hashed (SHA-256), and signed (Ed25519).
- **Local only.** No server. The SDK runs in the agent's process.
- See `README.md` for the full ASCII decision-flow diagram.

## 4. What was built

- 7 modules, ~2,000 LOC of Python, MIT licensed.
- 135+ tests across audit chain, code policies, NL policies (mocked), engine, HITL, SDK, CLI, dashboard, and adapters.
- CLI: `bastion init / verify / report / watch`.
- Adapters: Claude Agent SDK (default `can_use_tool`, fallback to `PreToolUse` hook), OpenAI Agents SDK (sketch).
- TUI dashboard (Textual): live event stream + policies hit-counts + stats panel.
- Demo agent: 4 in-process MCP tools driven through 5 canonical scenarios.

## 5. Experimental results

(See `EXPERIMENTS.md` for the full table.)

- **Decision latency**: 0.18 ms mean (full evaluate including signing). 7 µs for engine-only.
- **Audit chain size**: 538 bytes per record. ~15 MB for an 8-hour agent workday.
- **Verification**: ~195 µs per record. 200 ms to verify 1000 records.
- **Tampering detection**: 100% across 100 random single-record mutations.
- **LLM judge non-determinism**: clear cases reliable, borderline cases route to escalate by design.

## 6. What worked

- The signed chain is the rock. Pinpoints the tampered record every time, every test.
- The DSL (`policy.deny.tools(...)`, `@policy.deny`, `policy.nl(...)`) feels natural; users can express most policies in one line.
- Splitting code from NL policies cleanly: code is fast and deterministic; NL is for the cases where exact matching is impossible.
- HITL as a first-class outcome (not an afterthought) makes the dual-record audit shape (escalate + human resolution) clean.
- Claude Agent SDK's `can_use_tool` callback is a natural integration point.

## 7. What failed / what's fragile

- **Policy ordering matters.** With escalate before deny.above, large amounts escalate instead of denying. Documented and tested, but a real footgun.
- **`can_use_tool` reliability.** Known-issue territory in some CLI versions. Bastion ships a `PreToolUse` fallback but the user has to know about it.
- **LLM judge non-determinism.** Same prompt, different outcomes. We mitigate by routing borderline cases to HITL, but the unpredictability is real.
- **SQLite single-writer.** No concurrent agents per chain. Real deployments would need WAL discipline or a different store.
- **Threat model honesty.** Bastion can't stop a malicious agent author. We say so in the README; the slides should too.
- **Live integration tests skipped without API key.** The Phase 4/7/8 live checkpoints (NL judge + Claude agent + full demo) are sketched and unit-tested but not exercised end-to-end in this build session.

## 8. What's next

- **Network proxy variant** so a malicious agent can't bypass.
- **Pluggable storage**: Postgres, S3 with Merkle batching for multi-tenant audit.
- **Per-policy versioning**: when policies change, the chain should record which policy version a decision was made under.
- **OpenAI Agents SDK full integration.** The sketch shows the shape; the live wiring needs the SDK installed and tested.
- **Web UI** alongside the TUI for non-terminal users.
- **Policy library**: shareable policy packs (PII, payments, infra) so users don't write the same `policy.nl(...)` strings twice.

## Live-demo script (60 seconds)

1. `bastion init demo-agent` → polished panel
2. `python examples/run_demo.py` → 5 scenarios, watch decisions render
3. `bastion verify demo-agent` → green panel
4. `sqlite3 ~/.bastion/demo-agent.db "UPDATE audit_records SET record_json = REPLACE(record_json, 'allow', 'deny') WHERE id = 4;"`
5. `bastion verify demo-agent` → red panel pinpointing record #4
6. `bastion watch demo-agent` (in second terminal) ← already showing
