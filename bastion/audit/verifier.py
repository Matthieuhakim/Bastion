"""Walks the chain and validates hashes, signatures, and links."""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from cryptography.hazmat.primitives.asymmetric import ed25519

from bastion.audit.chain import canonical_json, sha256
from bastion.audit.signer import verify
from bastion.audit.store import GENESIS_HASH, AuditStore


@dataclass
class VerificationFailure:
    record_id: int
    reason: str


@dataclass
class VerificationReport:
    total: int = 0
    valid: int = 0
    failures: list[VerificationFailure] = field(default_factory=list)

    @property
    def is_clean(self) -> bool:
        return not self.failures

    @property
    def first_failure_id(self) -> int | None:
        return self.failures[0].record_id if self.failures else None


def verify_chain(
    store: AuditStore, public_key: ed25519.Ed25519PublicKey
) -> VerificationReport:
    """Verify every record in the chain.

    Stops accumulating failures after the first per-record problem (so the
    failure list has at most one entry per record), but continues to the next
    record so the report shows total counts.
    """
    report = VerificationReport()
    expected_previous_hash = GENESIS_HASH

    for stored in store.iter_records():
        report.total += 1

        try:
            body = json.loads(stored.record_json)
        except json.JSONDecodeError as e:
            report.failures.append(
                VerificationFailure(stored.id, f"invalid JSON in body: {e}")
            )
            expected_previous_hash = stored.record_hash
            continue

        recomputed = sha256(canonical_json(body))
        if recomputed != stored.record_hash:
            report.failures.append(
                VerificationFailure(stored.id, "record hash mismatch (body tampered)")
            )
            expected_previous_hash = stored.record_hash
            continue

        if not verify(public_key, stored.record_hash, stored.signature):
            report.failures.append(
                VerificationFailure(stored.id, "signature verification failed")
            )
            expected_previous_hash = stored.record_hash
            continue

        if stored.previous_hash != expected_previous_hash:
            report.failures.append(
                VerificationFailure(
                    stored.id, "previous_hash chain link broken"
                )
            )
            expected_previous_hash = stored.record_hash
            continue

        body_prev_hex = body.get("previous_hash")
        if body_prev_hex != stored.previous_hash.hex():
            report.failures.append(
                VerificationFailure(
                    stored.id, "body previous_hash inconsistent with column"
                )
            )
            expected_previous_hash = stored.record_hash
            continue

        report.valid += 1
        expected_previous_hash = stored.record_hash

    return report
