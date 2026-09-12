# OpenCode-Only Harness Final Verification Plan

## Task 1: Run complete automated regression

1. Run the full frontend Vitest suite.
2. Run TypeScript typecheck and production build.
3. Run the full native library test suite and Rust formatting/check gates.
4. Run dedicated harness and installer tests if they are not already included.

## Task 2: Exercise bounded end-to-end and desktop evidence

1. Re-run deterministic native harness lifecycle/smoke coverage.
2. Attempt the available Windows desktop automation path without mutating the
   user's global OpenCode installation or requiring account credentials.
3. Record fixture-only versus live evidence exactly; document unavailable
   credentials, models, network states, and automation blockers.

## Task 3: Audit architecture and security

1. Prove the ordinary router has one OpenCode dispatch and no ordinary native
   provider or external CLI executor imports.
2. Prove loopback binding, server authentication, secret redaction, verified
   download/extraction, owned-process cleanup, permission gateway, and absence
   of a generic native-command tool through tests and source scans.
3. Verify phase ownership and preserve all unrelated dirty work.

## Task 4: Produce and release evidence

1. Write the final evidence report with architecture, runtime installation,
   provider/local-model matrices, feature parity, exact commands/results,
   blockers, and security evidence.
2. Re-run report/working-tree checks.
3. Release the Phase 17 lock and commit only the plan, report, and lock record.
4. Do not merge, push, deploy, or publish.
