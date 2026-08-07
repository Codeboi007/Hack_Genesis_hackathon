from __future__ import annotations

import hashlib
import hmac


class SignatureValidationError(Exception):
    pass


def validate_github_signature(raw_body: bytes, secret: str, signature_header: str | None) -> None:
    if not secret:
        return
    if not signature_header:
        raise SignatureValidationError("Missing X-Hub-Signature-256 header")

    expected = "sha256=" + hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature_header):
        raise SignatureValidationError("Invalid webhook signature")
