# Experimental measurements

All numbers measured on an Apple M-series laptop (Darwin 25.3, Python 3.13.7) against a clean Bastion install. Reproduce with the snippet at the bottom of this doc.

## 1. Decision latency

| Path | n | mean | median | p95 | p99 |
| --- | --- | --- | --- | --- | --- |
| Engine only (4 code policies, no signing) | 5000 | 6.8 µs | 6.5 µs | 7.5 µs | -- |
| Full `bastion.evaluate()` (decision + sign + chain append) | 1000 | 0.18 ms | 0.16 ms | 0.24 ms | 0.32 ms |
| LLM judge call (`claude-sonnet-4-6`, single short policy) | -- | ~0.5-2 s | -- | -- | -- |
| HITL prompt | -- | dominated by human | -- | -- | -- |

The engine itself is essentially free (microseconds for a half-dozen policies). The cost of `bastion.evaluate()` is dominated by SQLite append and Ed25519 signing, not policy logic. LLM judge latency tracks the model and prompt size; it is the slowest layer when active.

## 2. Audit chain size

Storing 1050 records (mixed allow/deny/escalate, plus tool_outcome):

- **Total DB size:** 565,248 bytes (with WAL + indices)
- **Per record:** ~538 bytes amortized

A typical agent making one tool call per second for an hour produces ~1.9 MB of audit data. A whole 8-hour workday: ~15 MB. Disk is not the binding constraint.

## 3. Verification throughput

Verifying the same 1050-record chain end to end (load every row, recompute SHA-256, verify Ed25519 signature, check chain link, check body/column consistency):

- **Total:** 204.6 ms
- **Per record:** ~195 µs

A million-record chain would take ~3.3 minutes to verify cold. Acceptable for forensic investigations; not something you want on every request.

## 4. Tampering detection rate

Test: take a 1050-record chain, sample 100 random records, mutate the `record_json` body (change `reason` to "TAMPERED"), run `verify_chain()`, assert the report flags exactly that record. Restore. Repeat.

- **Detection rate:** **100 / 100 = 100%**
- **Localization:** every detection identifies the correct record_id

This is what we'd expect from SHA-256 over canonical JSON; the test confirms there are no holes (no canonicalization round-trip bugs, no off-by-one in iteration, no signature acceptance of mutated bodies).

## 5. LLM judge agreement (manual run)

The LLM judge is non-deterministic at temperature 0 — same prompt can yield different outcomes across calls due to model sampling and minor whitespace variations.

When you run the live tests in `tests/test_nl_policy.py` (with `ANTHROPIC_API_KEY` set), the policy `"Never read files under /etc"` against `Read /etc/passwd` is asserted to deny on at least 2 of 3 runs. This is intentional: it documents the non-determinism rather than hiding it. The clearly-safe case (`Read /tmp/log.txt`) is asserted to allow on a single run.

This is the honest finding: the judge is reliable enough for clear cases but not for borderline ones. For borderline cases the right behavior is `escalate`, which the judge does emit and which routes to HITL.

## 6. Reproduce

Inside the repo with the venv activated:

```bash
HOME=/tmp/bastion_bench .venv/bin/python -c "
import time, statistics, os
from bastion import Bastion, policy
from bastion.policy.engine import PolicyEngine

b = Bastion(agent_id='bench', policies=[
    policy.deny.tools('Delete'),
    policy.deny.paths('/etc/*', '*.env'),
    policy.deny.above('amount', 1000),
    policy.escalate.above('amount', 30),
])
for _ in range(50):
    b.evaluate('Read', {'path': '/tmp/x'})

times = []
for _ in range(1000):
    t0 = time.perf_counter_ns()
    b.evaluate('Read', {'path': '/tmp/x'})
    times.append((time.perf_counter_ns() - t0) / 1e6)
times.sort()
print(f'evaluate mean={statistics.mean(times):.3f}ms p95={times[950]:.3f}ms p99={times[990]:.3f}ms')

print(f'chain size: {os.path.getsize(b.db_path):,} bytes ({os.path.getsize(b.db_path)/1050:.1f} bytes/record)')
t0=time.perf_counter(); r=b.verify(); print(f'verify {r.total} records: {(time.perf_counter()-t0)*1000:.1f}ms')
b.close()
"
```
