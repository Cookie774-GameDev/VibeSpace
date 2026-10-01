# Build Your Own AI Local Studio Design

## Product boundary

VibeSpace exposes Build Your Own AI as a first-class route for every user.
Processing and training remain local. Original sources are never modified and
no source, checkpoint, or artifact is uploaded. Future cloud execution may use
the same typed plan contract but is disabled in this release.

## Experience

The page uses a quiet laboratory layout rather than the former modal: workflow
navigation on the left, the current model blueprint and work surface in the
center, and measured hardware/privacy/job status on the right. The top-right
BrainCircuit control opens the route directly and moves into the existing
overflow menu in compact chrome.

The workflow contains Overview, Create, Data Studio, Train, Evaluate, and My
Models. It preserves existing verified RAG jobs and makes unsupported training
methods visible with measured reasons. Every VibeSpace theme remains isolated,
and the page supports narrow windows, 200% zoom, keyboard use, screen readers,
high contrast, and reduced motion.

## Local capability model

The frontend consumes a capability-driven training plan. Knowledge/RAG remains
available when its existing requirements pass. LoRA, QLoRA, and full-weight
methods require an attested isolated worker and a hardware plan that fits the
selected model. VibeSpace never relabels RAG, prompt configuration, or
quantized inference as weight training.

Images, video, audio, PDF, and DOCX sources receive explicit local preparation
plans. A source is usable only when the required extractor or compatible
multimodal worker is attested. Video plans are bounded by frame and duration
budgets; audio plans require local transcription or a compatible native-audio
model. Source files remain untouched.

## Safety

Preflight reserves disk, bounds memory, validates the model manifest and
license, rejects untrusted remote code, and keeps training outside the renderer.
Jobs remain cancellable and restart-safe. Verified artifacts alone may become
selectable in Agents or Chat.
