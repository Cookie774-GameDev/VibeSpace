# Model Foundry

Model Foundry is VibeSpace's local **Build Your Own AI** workflow. It creates a
versioned, integrity-checked local knowledge artifact and combines that
artifact with an installed Ollama base model at inference time. It does not
mislabel a system prompt as trained weights.

## Dedicated Local Studio

The top-bar brain control opens the dedicated Model Foundry studio. Its
Overview, Create, Data Studio, Train, Evaluate, and My Models workspaces share
one local job library. The responsive page reports measured CPU, GPU, RAM,
VRAM, and free storage and explains the source → prepare → train → verify
pipeline before any local work starts.

The studio never offers a cloud-GPU route. Source media stays on the user's
computer and original files are never modified. Image, video, audio, PDF,
DOCX, code, text, and structured-data preparation plans are bounded and
capability checked. A missing extractor or training backend is reported as an
unavailable local capability rather than silently uploading, converting, or
simulating work.

## Supported build path

The current production path is local retrieval knowledge:

1. The user selects local text, Markdown, source-code, JSON/JSONL, or CSV files.
2. The native runtime validates file type, regular-file status, and the 64 MB
   per-file limit.
3. Text is cleaned, deduplicated, chunked, and hashed locally.
4. The artifact is written atomically, reopened, schema-validated, and checked
   chunk-by-chunk before it becomes selectable.
5. At chat time, the native runtime retrieves a bounded set of relevant chunks.
   Retrieved text is marked as untrusted data and sent only to the selected
   local Ollama base model.

LoRA, QLoRA, and full fine-tuning become selectable only when the installed
hash-attested local worker explicitly reports that method and the measured
hardware fits it. VibeSpace ships an embedded, local-only worker boundary and
an explicit **Set up local worker** action. Setup installs only that audited
worker source into private app data; it does not silently install Python,
download packages, or contact a cloud service.

The worker now has three closed commands:

- `probe` reports only locally importable training libraries and capabilities;
- `validate` checks a bounded absolute-path JSON request and validates every
  JSONL example without loading a model;
- `train` performs offline Transformers full-weight, LoRA, or CUDA QLoRA
  training against a prepared local Transformers directory, disables Hub
  access and telemetry, rejects remote code, and writes to a new output
  directory.

The worker advertises `full` only when PyTorch, Transformers, Datasets, and
Accelerate are importable, `lora` only when PEFT is also importable, and
`qlora` only when PEFT, BitsAndBytes, and a CUDA device are all available.
Installed libraries alone never cause the app to claim that a model is ready.

The native job command now launches the worker as a separate bounded child
process, persists a closed request in the private job directory, drains capped
stdout/stderr logs, supports cancellation by exact job ID, and hashes every
regular artifact file into a versioned manifest before activation. Symlinks,
unexpected filesystem entries, post-training tampering, unknown methods,
unregistered model IDs, and non-JSONL weight-training datasets fail closed.

The manifest-driven trainable-base-model lifecycle is connected to the desktop
wizard. Downloads use revision-pinned official Hugging Face URLs, resume
partial files, report measured progress, verify every expected byte count and
SHA-256, and activate the complete directory atomically. Cancellation preserves
resumable partial data; repair uses rollback-safe replacement; removal is
confirmed, path-bounded, and denied while a download or training process is
active. The catalog status is marker-backed for inexpensive display, and the
full hashes are checked again before every training run.

Pinned Python-environment installation, training-checkpoint resume, and final
weight-artifact chat-runtime activation are not yet connected. The UI therefore
enables only capabilities the attested worker can execute and never invents
training or progress for the remaining gates.

Hardware-aware plans keep LoRA, QLoRA, and full-weight requirements distinct,
check VRAM/RAM/free storage conservatively, and never downgrade the selected
method to RAG or another training mode.

## Verified base-model catalog

Knowledge/RAG uses these exact Ollama runtime tags:

- `qwen2.5:1.5b-instruct-q4_K_M`
- `qwen2.5:7b-instruct-q4_K_M`
- `llama3.1:8b-instruct-q4_K_M`

`Q4_K_M` is identified in the UI as a 4-bit inference quantization. It is not
described as QLoRA training.

The catalog metadata was verified against the official Ollama model pages on
2026-08-02:

- <https://ollama.com/library/qwen2.5/tags>
- <https://ollama.com/library/llama3.1:8b-instruct-q4_K_M>

Model Foundry checks for the exact installed tag. A user-approved download uses
the shared Ollama lifecycle and progress flow; installation of Ollama itself
continues to require the explicit consent screen in Settings → Local Models.

Weight training uses a separate, embedded, fail-closed Transformers checkpoint
manifest. It never reuses the quantized Ollama inference files as trainable
weights. The current public Apache-2.0 choices are:

- `HuggingFaceTB/SmolLM2-135M-Instruct` at
  `12fd25f77366fa6b3b4b768ec3050bf629380bac`;
- `HuggingFaceTB/SmolLM2-360M-Instruct` at
  `a10cc1512eabd3dde888204e902eca88bddb4951`;
- `HuggingFaceTB/SmolLM2-1.7B-Instruct` at
  `31b70e2e869a7173562077fd711b654946d38674`;
- `Qwen/Qwen2.5-0.5B-Instruct` at
  `7ae557604adf67be50417f59c2c2f167def9a775`;
- `Qwen/Qwen2.5-1.5B-Instruct` at
  `989aa7980e4cf806f80c7fef2b1adb7bc71aa306`.

VibeSpace validates every catalog identifier, revision, license, filename,
byte count, and SHA-256 before exposing it through the native bridge. These
revisions, licenses, weight sizes, and weight hashes were revalidated against
the official Hugging Face API on 2026-08-08. An unknown, gated, unpinned,
path-bearing, duplicate, or hash-incomplete entry fails the entire catalog
closed.

The wizard shows the exact source, pinned revision, Apache-2.0 license URL,
download size, RAM/VRAM guidance, context limit, speed class, quality class,
CPU practicality, and current install/repair state. Trainable checkpoints are
kept separate from the Ollama inference catalog and never presented as
quantized Ollama tags.

## Persistence and recovery

Jobs and private retry records are stored below the app-data
`model-foundry/jobs` directory. The UI polls only while the hub is open.
Unexpectedly interrupted jobs are marked failed on the next startup and can be
retried as a new version. Active jobs support cancellation. Verified artifacts
support activation, rename, duplicate, export, retrain, and confirmed deletion.
The job records the measured artifact size, sends a local completion
notification after verification, and presents the newly completed artifact in
the Model Foundry reveal state when the hub is next opened.

Exports occur only after the user chooses a local destination. Model Foundry
does not upload source files or artifacts and has no cloud fallback.

## Security boundaries

- Artifact identifiers are path-safe and never accepted as arbitrary paths.
- Source files are canonicalized and size/type checked.
- Artifact JSON, schema, base-model allowlist, chunk content hashes, and final
  file SHA-256 are verified before activation.
- Retrieval queries and returned context are bounded.
- Retrieved context is explicitly treated as untrusted data, not instructions.
- Model Foundry cannot replace a protected Jarvis provider binding.
- Deletion is limited to terminal jobs inside the private Model Foundry root.
- The local training worker must match the source hash embedded in the desktop
  binary and attest to the current protocol and local-only operation.
- Browser preview cannot install or claim a native training worker.
