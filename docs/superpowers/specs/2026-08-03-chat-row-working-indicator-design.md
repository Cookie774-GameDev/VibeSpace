# Chat-row working indicator design

## Visual authority

The owner screenshots show an oversized gray-backed “AI is working” video and
an embedded Command Center inside the chat thread, while the intended home is
the right edge of each chat row under the left Pinned/Chats sections.

## Approved behavior

- Chat keeps canonical run discovery, approval navigation, agentic-console
  projection, task progress, memory, and agent activity behavior.
- Chat does not render the large working media or an embedded Command Center.
- Command Center remains available as its separate tool/application; this
  change removes only the chat-thread embedding.
- The existing account- and chat-scoped activity projection drives one
  indicator beside the matching chat row. Idle chats reserve the same compact
  width but show no mark.

## Visual system

The mark is a 16×13 px open V made from two illuminated strokes and one energy
core. It has no panel, fill, border, video, or raster background. Copper is the
primary energy color and cyan is the secondary light; theme-specific tokens
retain Sakura, Warm, Origami, and MonoChrome compatibility. One bounded
state-driven animation conveys queued, thinking, streaming, tool, completion,
and failure states. Hidden windows pause it and reduced-motion users receive a
static mark.

The visual signature is the tiny open V: it recalls the supplied loading mark
without shrinking a gray video tile into an unreadable sidebar artifact.

## Accessibility and performance

The decorative mark is `aria-hidden`; a screen-reader-only status reports the
truthful activity label. No background polling, video decoding, canvas, or new
runtime subscription is added. Existing run/event subscriptions and the
settling timeout remain authoritative.

## Verification

Focused tests prove real state mapping, stable idle geometry, active-only V
markup, absence of video, absence of the in-thread working/Command Center
surfaces, canonical scope preservation, and the existing approval isolation.
