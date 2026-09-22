from __future__ import annotations

import asyncio
import json
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from .auth import JwtVerifier


def _rsa_jwk(public_key: object, kid: str) -> dict[str, str]:
    key = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(public_key))
    key.update({"kid": kid, "use": "sig", "alg": "RS256"})
    return key


def test_jwt_verifier_accepts_a_matching_rsa_jwk_without_python_jose() -> None:
    private_key = rsa.generate_private_key(public_exponent=65_537, key_size=2048)
    jwks = {"keys": [_rsa_jwk(private_key.public_key(), "bridge-key")]}
    token = jwt.encode(
        {
            "sub": "user-1",
            "aud": "authenticated",
            "exp": int(time.time()) + 300,
        },
        private_key,
        algorithm="RS256",
        headers={"kid": "bridge-key"},
    )

    verifier = JwtVerifier("https://example.test/jwks")

    async def fetch_jwks() -> dict:
        return jwks

    verifier._fetch_jwks = fetch_jwks  # type: ignore[method-assign]
    claims = asyncio.run(verifier.verify(token))

    assert claims["sub"] == "user-1"
    assert claims["aud"] == "authenticated"


def test_jwt_verifier_rejects_unknown_kid_before_signature_work() -> None:
    private_key = rsa.generate_private_key(public_exponent=65_537, key_size=2048)
    token = jwt.encode(
        {"sub": "user-1", "aud": "authenticated", "exp": int(time.time()) + 300},
        private_key,
        algorithm="RS256",
        headers={"kid": "missing-key"},
    )
    verifier = JwtVerifier("https://example.test/jwks")

    async def fetch_jwks() -> dict:
        return {"keys": []}

    verifier._fetch_jwks = fetch_jwks  # type: ignore[method-assign]
    try:
        asyncio.run(verifier.verify(token))
    except PermissionError as exc:
        assert str(exc) == "unknown_kid"
    else:
        raise AssertionError("unknown JWK kid must fail closed")


@pytest.mark.parametrize('failure', ['expired', 'no_expiry', 'no_subject', 'wrong_audience', 'tampered', 'hmac', 'algorithm_mismatch'])
def test_jwt_verifier_rejects_invalid_authority(failure: str) -> None:
    private_key = rsa.generate_private_key(public_exponent=65_537, key_size=2048)
    public_jwk = _rsa_jwk(private_key.public_key(), 'bridge-key')
    claims = {'sub': 'user-1', 'aud': 'authenticated', 'exp': int(time.time()) + 300}
    if failure == 'expired':
        claims['exp'] = int(time.time()) - 30
    elif failure == 'no_expiry':
        del claims['exp']
    elif failure == 'no_subject':
        del claims['sub']
    elif failure == 'wrong_audience':
        claims['aud'] = 'another-service'
    elif failure == 'algorithm_mismatch':
        public_jwk['alg'] = 'RS512'
    algorithm = 'HS256' if failure == 'hmac' else 'RS256'
    key = 'test-only-key-not-a-real-credential-32-bytes' if failure == 'hmac' else private_key
    token = jwt.encode(claims, key, algorithm=algorithm, headers={'kid': 'bridge-key'})
    if failure == 'tampered':
        parts = token.split('.')
        parts[2] = ('A' if parts[2][0] != 'A' else 'B') + parts[2][1:]
        token = '.'.join(parts)
    verifier = JwtVerifier('https://example.test/jwks')

    async def fetch_jwks() -> dict:
        return {'keys': [public_jwk]}

    verifier._fetch_jwks = fetch_jwks  # type: ignore[method-assign]
    with pytest.raises(PermissionError) as rejected:
        asyncio.run(verifier.verify(token))
    assert token not in str(rejected.value)
