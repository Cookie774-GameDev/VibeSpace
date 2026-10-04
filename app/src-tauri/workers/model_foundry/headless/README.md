# Model Foundry headless supervisor

This CLI runs the production Python worker through the same Rust supervisor,
catalog verification, completion validation, and artifact checksums used by the
desktop Foundry. It does not start the native app. Paths, model selection, and
the compute device come from arguments and request files.

From the repository root:

```powershell
cargo build --manifest-path app/src-tauri/workers/model_foundry/headless/Cargo.toml
cargo test --manifest-path app/src-tauri/workers/model_foundry/headless/Cargo.toml
```

The executable is `foundry-headless.exe` under that crate's `target/debug` folder,
or under an explicit `CARGO_TARGET_DIR`. Prepare a local Foundry Python runtime
with the locked training dependencies and a model from `training-models.json`.
The CLI checks the worker source against the version compiled into the executable
and checks every catalog model file against its pinned size and SHA-256. Rebuild
after changing the worker source.

## Run a clean training job

Provide absolute paths to the Python executable, current `worker.py`, an isolated
runtime/cache folder, and the schema-v2 training request. The output directory
must be new and nested inside the request's private job directory. Training and
validation JSONL must both contain usable records. The worker supports raw `text`
or supervised `prompt`/`response` pairs; the latter use the model's chat template
and train on response tokens.

```powershell
& $foundryExe train `
  --python $pythonExe --worker $workerPy `
  --runtime-root $runtimeRoot --request $trainingRequest `
  --model-id smollm2-135m-instruct --job-id debater-r1 `
  --compute-device gpu --timeout-seconds 3600
```

These PowerShell variables are user-selected paths; no machine-specific paths
are embedded in the CLI. Set `trainingConfig.computeDevice` to `gpu` in the
request as well. A conflicting CLI device is rejected. GPU execution requires
CUDA and keeps model parameters and optimizer moments on CUDA. CPU scalar
optimizer step counters are permitted. CUDA unavailability or mixed CPU/GPU
parameter placement fails the job.

The request supplies the LoRA/full method, batch size, gradient accumulation,
sequence length, learning rate, seed, epochs, and optional maximum steps. The
headless training command accepts a clean run only; it rejects checkpoint resume.
Check available RAM, commit headroom, VRAM, and disk space before launching, using
the selected model and training configuration. The CLI does not reserve system
resources for other processes.

Completion requires a successful worker exit, an exact matching receipt, finite
measured training and validation loss, consistent effective configuration, and
device evidence. It then writes and re-verifies `.vibespace-artifact.json`.
`vibespace-training.json` records the configuration, dataset hashes, losses,
parameter/optimizer devices, GPU identity, and peak allocated CUDA memory.
The CLI prints one JSON result to stdout and returns a nonzero exit on failure.

## Reload and infer

Use an inference request in the same private job directory, referencing the
verified artifact and base model. Choose a fresh response file in that directory.
Its filename must follow `inference-<id>.response.json`; existing files and other
filename patterns are rejected before the worker starts.

```powershell
& $foundryExe infer `
  --python $pythonExe --worker $workerPy `
  --runtime-root $runtimeRoot --request $inferenceRequest `
  --model-id smollm2-135m-instruct --job-id debater-r1-infer `
  --compute-device gpu --timeout-seconds 600
```

Every invocation loads the model and adapter in a fresh worker process. Artifact
checksums are verified before loading. A newly trained artifact keeps its declared
compute device on reload: a GPU artifact fails if CUDA is unavailable. The
supervisor verifies nonempty inference output and matching device/offload
evidence before printing its JSON result. Legacy desktop artifacts that predate
device evidence retain their earlier compatibility path.

## Process ownership and logs

Training defaults to a 3,600-second deadline; inference defaults to 600 seconds.
`--timeout-seconds` accepts 1 through 86,400. On Windows, the shared supervisor
starts the worker suspended, assigns it to a kill-on-close Job Object, then
resumes it. Cancellation and timeout apply to that owned process tree, including
Python launcher descendants. Root process exit is complete only when the job
contains no live processes.

The supervisor drains both streams concurrently and retains at most 256 KiB per
stream. It writes `worker.stdout.log` / `worker.stderr.log` for training and
`inference.stdout.log` / `inference.stderr.log` for inference beside the request.
Preserve these logs and the request when diagnosing a failed run. An incomplete
output is not a successful artifact; before a clean retry, remove only that
job's owned incomplete output after its worker tree has stopped.
