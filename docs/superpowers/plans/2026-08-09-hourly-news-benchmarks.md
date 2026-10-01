# Hourly News and Benchmarks Implementation Plan

1. Remove the curated-top-50 provenance section and add a regression test.
2. Convert benchmark refresh policy to a single-flight hourly schedule and mount the host in the app.
3. Prefer live benchmark data with last-known-good fallback and truthful stale/error metadata.
4. Connect verified model-release news to an explicit unranked benchmark-pending surface.
5. Harden the Worker’s hourly cron, lease/fencing, source failure handling, and freshness telemetry.
6. Run app and Worker tests, deploy the Worker, verify the cron, issue one bounded refresh, and confirm fresh API output.
