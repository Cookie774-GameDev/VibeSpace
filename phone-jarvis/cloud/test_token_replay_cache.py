"""Stdlib-only contracts for the exact production replay-cache boundary.

Extract the complete class AST, not a duplicate implementation, so optional
Twilio/Pipecat SDKs and settings are never initialized by these pure controls.
Route/SDK integration still belongs to test_phone_readiness_routes.py.
"""
from __future__ import annotations

import ast
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import threading
import unittest


def _production_store_type():
    path = Path(__file__).with_name("security.py")
    source = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    classes = [
        node for node in source.body
        if isinstance(node, ast.ClassDef) and node.name == "OneTimeTokenStore"
    ]
    if len(classes) != 1:
        raise AssertionError("Expected the single complete production OneTimeTokenStore")
    namespace = {"threading": threading}
    exec(compile(ast.Module(body=classes, type_ignores=[]), str(path), "exec"), namespace)
    return namespace["OneTimeTokenStore"]


OneTimeTokenStore = _production_store_type()


class TokenReplayCacheTests(unittest.TestCase):
    def test_first_use_succeeds_and_same_nonce_is_refused(self):
        store = OneTimeTokenStore(max_entries=2)
        self.assertTrue(store.consume("first", 200, 100))
        self.assertFalse(store.consume("first", 200, 101))

    def test_capacity_refuses_new_admission_instead_of_evicting_consumed_nonce(self):
        store = OneTimeTokenStore(max_entries=2)
        self.assertTrue(store.consume("first", 200, 100))
        self.assertTrue(store.consume("second", 201, 101))
        self.assertFalse(store.consume("overflow", 202, 102))
        self.assertFalse(store.consume("first", 200, 103))
        self.assertFalse(store.consume("second", 201, 103))

    def test_capacity_pressure_never_reenables_an_unexpired_replay(self):
        store = OneTimeTokenStore(max_entries=2)
        self.assertTrue(store.consume("first", 200, 100))
        self.assertTrue(store.consume("second", 201, 101))
        store.consume("overflow", 202, 102)
        self.assertFalse(store.consume("first", 200, 103))

    def test_expiry_reclaims_only_expired_entries(self):
        store = OneTimeTokenStore(max_entries=2)
        self.assertTrue(store.consume("expires", 101, 100))
        self.assertTrue(store.consume("live", 200, 100))
        self.assertTrue(store.consume("replacement", 201, 102))
        self.assertFalse(store.consume("live", 200, 102))
        self.assertFalse(store.consume("replacement", 201, 102))

    def test_exact_expiry_boundary_is_retained_until_strictly_expired(self):
        store = OneTimeTokenStore(max_entries=1)
        self.assertTrue(store.consume("first", 101, 100))
        self.assertFalse(store.consume("first", 101, 101))
        self.assertFalse(store.consume("new", 201, 101))
        self.assertTrue(store.consume("new", 201, 102))

    def test_concurrent_duplicate_has_exactly_one_success(self):
        store = OneTimeTokenStore(max_entries=2)
        barrier = threading.Barrier(2)
        def consume(_):
            barrier.wait()
            return store.consume("same", 200, 100)
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(consume, range(2))), [False, True])

    def test_concurrent_unique_admission_cannot_exceed_capacity(self):
        store = OneTimeTokenStore(max_entries=2)
        barrier = threading.Barrier(8)
        def consume(index):
            barrier.wait()
            return store.consume(str(index), 200, 100)
        with ThreadPoolExecutor(max_workers=8) as pool:
            self.assertEqual(sum(pool.map(consume, range(8))), 2)


if __name__ == "__main__":
    unittest.main()
