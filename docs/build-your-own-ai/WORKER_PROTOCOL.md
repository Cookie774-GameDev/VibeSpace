# VibeModel Foundry worker protocol v1

Status: implementation contract

Transport: UTF-8 newline-delimited JSON over an isolated child process's stdin/stdout. Stderr is diagnostic-only, size bounded, redacted, and never parsed as protocol data.

## Compatibility

- Protocol version is the integer `1`.
- The supervisor rejects unknown major versions before a job starts.
- Every message is one JSON object on one line, with a maximum encoded size enforced by the supervisor and worker.
- Unknown fields are ignored only within version 1. Missing required fields or unknown message/operation types are terminal protocol errors.
- Timestamps are RFC 3339 UTC strings. Durable ordering uses integer `sequence`, not wall-clock time.

## Supervisor command

```json
{
  "protocolVersion": 1,
  "type": "command",
  "requestId": "req_01",
  "jobId": "job_01",
  "operation": "train",
  "manifestPath": "C:\\...\\model-foundry\\jobs\\job_01\\training-manifest.json",
  "options": {
    "stopAfterCheckpoint": false
  }
}
```

Allowed operations are `handshake`, `validate`, `train`, `resume`, `cancel`, `stop_after_checkpoint`, and `health`. There is no generic executable, argument, environment, path, Python expression, module, URL, or shell command field.

The manifest path is created by the supervisor inside the fixed Foundry app-data root. The worker canonicalizes it again and rejects any path outside the job directory.

## Worker event

```json
{
  "protocolVersion": 1,
  "type": "event",
  "requestId": "req_01",
  "jobId": "job_01",
  "sequence": 7,
  "phase": "training",
  "progress": 0.42,
  "timestamp": "2026-07-13T18:00:00.000Z",
  "message": "Epoch 1 of 3",
  "resource": {
    "ramBytes": 4294967296,
    "vramBytes": null,
    "diskFreeBytes": 85899345920
  }
}
```

`progress` is either null or a finite value from 0 through 1. It never decreases within one phase. Resource fields are nullable when unknown and are real samples; the fixture backend never emits hardware samples.

Phases are `handshake`, `validating`, `preparing`, `loading_model`, `loading_dataset`, `training`, `validating_model`, `checkpointing`, `finalizing`, `completed`, `cancelled`, `failed`, and `interrupted`.

## Heartbeat

A heartbeat is an event with phase unchanged and `kind: "heartbeat"`. The worker emits it within the configured interval while active. Missed heartbeats cause the supervisor to mark the process unhealthy, request graceful cancellation, then terminate the process tree after the fixed grace period. A timeout is recorded as `interrupted` when a valid checkpoint can be resumed and `failed` otherwise.

## Terminal result

Exactly one terminal result is allowed per request:

```json
{
  "protocolVersion": 1,
  "type": "result",
  "requestId": "req_01",
  "jobId": "job_01",
  "sequence": 19,
  "state": "completed",
  "timestamp": "2026-07-13T18:10:00.000Z",
  "artifactManifestPath": "C:\\...\\artifact-manifest.json",
  "checkpointPath": "C:\\...\\checkpoint-0003",
  "error": null
}
```

Terminal states are `completed`, `cancelled`, `failed`, and `interrupted`. A result after a terminal result, a decreasing/repeated sequence, mismatched request/job ID, invalid artifact path, or malformed line is a protocol violation.

## Error envelope

```json
{
  "code": "worker.oom",
  "message": "Training stopped because the worker exhausted available accelerator memory.",
  "recoverable": true,
  "correlationId": "req_01",
  "phase": "training",
  "details": {
    "lastCheckpoint": "checkpoint-0002",
    "suggestions": ["lower_batch_size", "shorter_sequence", "increase_gradient_accumulation"]
  }
}
```

Messages and details are allowlisted and redacted. They must not include dataset content, prompts, environment dumps, credentials, authorization headers, session tokens, full private paths in exported diagnostics, or raw third-party exceptions.

## Cancellation and recovery

- Graceful cancel is idempotent. The worker finishes the current atomic write, records whether the latest checkpoint is valid, and returns `cancelled`.
- Emergency stop is implemented by the supervisor, not as an arbitrary worker command. It terminates the process tree and persists `interrupted` or `failed`.
- `stop_after_checkpoint` is used where true pause is unsupported. The UI must not label it Pause.
- Resume validates checkpoint checksum, base revision/checksum, dataset version/fingerprint, training configuration, worker compatibility, and free storage before process start.
- After application restart, a durable `running` snapshot becomes `interrupted`; the UI offers resume only after validation.

## Security invariants

- The worker environment starts from an allowlist and contains no provider, Supabase, Stripe, signing, GitHub, or user-shell secrets.
- User data enters through an immutable manifest/file or stdin protocol, never executable arguments.
- Output is restricted to the job's staging directory and promoted only after checksum/size/schema validation.
- Python remote model code is forbidden. `trust_remote_code` is always false.
- The supervisor enforces one active training job per project and configured global concurrency/resource limits.
