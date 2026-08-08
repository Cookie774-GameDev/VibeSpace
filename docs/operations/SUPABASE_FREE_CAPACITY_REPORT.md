# Supabase Free Capacity Evidence

Status: **IMPLEMENTED — EXTERNAL VERIFICATION REQUIRED**

This report covers the required 500, 2,000, 5,000, and 10,000 virtual-user
stages for a local Supabase stack or an explicitly confirmed, isolated
non-production Supabase project. It does not authorize production load testing.

## Current evidence

|  Stage | Execution status | Client latency | Throughput   | Error rate   | Operator metrics |
| -----: | ---------------- | -------------- | ------------ | ------------ | ---------------- |
|    500 | Not executed     | Not measured   | Not measured | Not measured | Not collected    |
|  2,000 | Not executed     | Not measured   | Not measured | Not measured | Not collected    |
|  5,000 | Not executed     | Not measured   | Not measured | Not measured | Not collected    |
| 10,000 | Not executed     | Not measured   | Not measured | Not measured | Not collected    |

No capacity result is claimed. On 2026-08-05, Supabase CLI 2.111.0 was run
against the committed local `VibeSpace` project only. A focused RED/GREEN
contract corrected the two active auth-template paths from nonexistent
repository-root files to the committed files under `supabase/templates`.
Configuration validation then succeeded.

The isolated stack still could not start. Docker Desktop exhausted the nearly
full system drive while extracting the local PostgreSQL image, returned an
overlayfs/containerd input/output error, and subsequently returned HTTP 500
from its container API. Removing the disposable verification target raised
free space from 2.26 GB to 6.59 GB, but the Docker backend remained stuck while
stopping after one bounded restart. No migration, request stage, connected
cloud call, or external mutation occurred.

The connected cloud project identity was also not proven to be an isolated
VibeSpace test target. Running load against that ambiguous target would be
unsafe.

The implemented probe:

- accepts only loopback by default;
- requires HTTPS, an exact host match, and two explicit non-production
  confirmations for staging;
- sends credentials only in request headers and never records response bodies;
- runs the exact required stages in ascending order;
- records status counts, p50/p95/p99/max latency, throughput, wall time, and
  error rate;
- stops subsequent stages after cancellation, timeout, or an error rate of at
  least 5%;
- records database connections, database CPU and memory, Edge invocations,
  egress, and Realtime peak connections only when an operator supplies those
  measurements;
- writes evidence with exclusive file creation so an existing result is not
  silently overwritten.

## Safe local execution

Start an isolated local Supabase stack first. Then run:

```powershell
$env:SUPABASE_CAPACITY_URL = 'http://127.0.0.1:54321'
$env:SUPABASE_CAPACITY_ANON_KEY = Read-Host 'Local Supabase anon key'
$env:SUPABASE_CAPACITY_EXECUTE = 'I_CONFIRM_CAPACITY_LOAD_ON_THIS_NON_PRODUCTION_TARGET'
node scripts/supabase-capacity-probe.mjs --execute --output .\supabase-capacity-local.json
Remove-Item Env:\SUPABASE_CAPACITY_ANON_KEY
Remove-Item Env:\SUPABASE_CAPACITY_EXECUTE
```

## Safe isolated-staging execution

Use only a disposable or capacity-test project whose ownership and
non-production status have been independently confirmed:

```powershell
$hostName = 'your-isolated-test-project.supabase.co'
$env:SUPABASE_CAPACITY_URL = "https://$hostName"
$env:SUPABASE_CAPACITY_CONFIRM_HOST = $hostName
$env:SUPABASE_CAPACITY_ALLOW_STAGING = '1'
$env:SUPABASE_CAPACITY_NON_PRODUCTION_CONFIRMATION = 'I_CONFIRM_THIS_IS_AN_ISOLATED_TEST_PROJECT'
$env:SUPABASE_CAPACITY_EXECUTE = 'I_CONFIRM_CAPACITY_LOAD_ON_THIS_NON_PRODUCTION_TARGET'
$env:SUPABASE_CAPACITY_ANON_KEY = Read-Host 'Isolated test-project anon key'
node scripts/supabase-capacity-probe.mjs --execute --output .\supabase-capacity-staging.json
Remove-Item Env:\SUPABASE_CAPACITY_ANON_KEY
Remove-Item Env:\SUPABASE_CAPACITY_EXECUTE
```

Optional timing controls are
`SUPABASE_CAPACITY_REQUEST_TIMEOUT_MS`,
`SUPABASE_CAPACITY_STAGE_TIMEOUT_MS`, and
`SUPABASE_CAPACITY_COOLDOWN_MS`. The request path defaults to a bounded
read-only profile query and may be changed with `SUPABASE_CAPACITY_PATH`.
Sensitive query-parameter names and header-injection characters are rejected.

## Operator metrics

Capture the following measurements from the isolated project dashboard during
the same run and supply them before producing the final evidence file:

```powershell
$env:SUPABASE_CAPACITY_DB_CONNECTIONS = '<peak count>'
$env:SUPABASE_CAPACITY_DB_CPU_PERCENT = '<peak percent>'
$env:SUPABASE_CAPACITY_DB_MEMORY_BYTES = '<peak bytes>'
$env:SUPABASE_CAPACITY_EDGE_INVOCATIONS = '<run count>'
$env:SUPABASE_CAPACITY_EGRESS_BYTES = '<run bytes>'
$env:SUPABASE_CAPACITY_REALTIME_PEAK_CONNECTIONS = '<peak count>'
```

The JSON evidence status is:

- `BLOCKED_TECHNICAL_NOT_EXECUTED` when no stage ran;
- `IMPLEMENTED_EXTERNAL_METRICS_REQUIRED` when client stages ran but operator
  measurements are incomplete;
- `LOCAL_OR_STAGING_EVIDENCE_CAPTURED` when both client and operator evidence
  are present.

These labels do not imply a production service-level agreement.

## Breaking-point interpretation

The first stage with any error or client p95 latency above 1,000 ms is marked
as the degradation stage. The first timed-out, cancelled, incomplete, or
5%-error stage is marked as the breaking point. Until the isolated run occurs,
both remain **not measured**.

Client results alone cannot prove database CPU, memory, connection, Edge,
egress, or Realtime capacity. They also do not replace the separate
authentication, RLS, billing, and account-isolation negative tests. Supabase
Free availability and limits are platform constraints, not a VibeSpace SLA.

## Verification and rollback

- Node contract tests: 8/8 passed.
- Local template and email-test config contract: 2/2 passed.
- Supabase CLI 2.111.0 validates the corrected configuration and reaches local
  container inspection.
- Local stack execution remains **BLOCKED — TECHNICAL** by the Docker Desktop
  containerd/API failure described above.
- CLI dry run: emitted the four exact stages with
  `BLOCKED_TECHNICAL_NOT_EXECUTED` and no credential material.
- No external request or cloud mutation was performed.

Rollback is limited to reverting the probe, its tests, and this report. The
slice changes no application runtime, migration, Edge Function, dependency, or
external environment.
