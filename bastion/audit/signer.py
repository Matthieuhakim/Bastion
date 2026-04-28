"""Ed25519 keypair lifecycle and signing for the audit chain."""

from __future__ import annotations

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.exceptions import InvalidSignature


def generate_keypair() -> tuple[bytes, bytes]:
    """Generate an Ed25519 keypair, returned as (private_pem, public_pem)."""
    private_key = ed25519.Ed25519PrivateKey.generate()
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_pem = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return private_pem, public_pem


def load_private_key(pem: bytes) -> ed25519.Ed25519PrivateKey:
    """Load a private key from PEM bytes."""
    key = serialization.load_pem_private_key(pem, password=None)
    if not isinstance(key, ed25519.Ed25519PrivateKey):
        raise ValueError("expected an Ed25519 private key")
    return key


def load_public_key(pem: bytes) -> ed25519.Ed25519PublicKey:
    """Load a public key from PEM bytes."""
    key = serialization.load_pem_public_key(pem)
    if not isinstance(key, ed25519.Ed25519PublicKey):
        raise ValueError("expected an Ed25519 public key")
    return key


def public_key_bytes(public_key: ed25519.Ed25519PublicKey) -> bytes:
    """Raw 32-byte public key (for fingerprinting)."""
    return public_key.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )


def sign(private_key: ed25519.Ed25519PrivateKey, message: bytes) -> bytes:
    """Sign bytes with Ed25519. Returns a 64-byte signature."""
    return private_key.sign(message)


def verify(
    public_key: ed25519.Ed25519PublicKey,
    message: bytes,
    signature: bytes,
) -> bool:
    """Verify an Ed25519 signature. Returns True iff valid."""
    try:
        public_key.verify(signature, message)
        return True
    except InvalidSignature:
        return False
