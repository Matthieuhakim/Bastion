"""Tests for Ed25519 signer wrappers."""

from __future__ import annotations

import pytest

from bastion.audit.signer import (
    generate_keypair,
    load_private_key,
    load_public_key,
    public_key_bytes,
    sign,
    verify,
)


def test_keypair_roundtrip_via_pem():
    private_pem, public_pem = generate_keypair()
    private_key = load_private_key(private_pem)
    public_key = load_public_key(public_pem)
    msg = b"hello bastion"
    sig = sign(private_key, msg)
    assert len(sig) == 64
    assert verify(public_key, msg, sig)


def test_signature_does_not_verify_under_different_key():
    priv1, _ = generate_keypair()
    _, pub2 = generate_keypair()
    sig = sign(load_private_key(priv1), b"x")
    assert verify(load_public_key(pub2), b"x", sig) is False


def test_signature_does_not_verify_after_message_mutation():
    priv, pub = generate_keypair()
    sig = sign(load_private_key(priv), b"original")
    assert verify(load_public_key(pub), b"original", sig)
    assert verify(load_public_key(pub), b"mutated", sig) is False


def test_public_key_bytes_is_32_bytes():
    _, public_pem = generate_keypair()
    raw = public_key_bytes(load_public_key(public_pem))
    assert len(raw) == 32


def test_load_private_key_rejects_non_ed25519():
    with pytest.raises(Exception):
        load_private_key(b"-----BEGIN PRIVATE KEY-----\ngarbage\n-----END PRIVATE KEY-----")
