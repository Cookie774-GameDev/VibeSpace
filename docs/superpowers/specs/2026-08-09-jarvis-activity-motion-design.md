# Jarvis Activity Motion Design

## Goal

Restore the seven distinct Jarvis activity animations from the supplied motion lab so a live turn visibly distinguishes thinking, reading files, writing, coordination, context work, learning, and response generation.

## Design

- Keep activity truth in the existing structured `activityCategory`/`activityKind` fields. Never infer a motion by parsing English status text.
- Render each activity with its own deterministic animation:
  thinking → cursor forge; reading/files → shifting stack; writing → code shimmer; coordination → nine-dot fold; context → twin loop; learning → breathing brackets; response → glyph current.
- Use a fixed outer slot and an inner reference-sized animation. The full activity console uses the reference scale; the mini panel scales the same animation into a compact slot without clipping or changing its geometry.
- Use CSS custom properties for palette selection. Default is copper/teal, Monochrome is neutral ink, Jarvis One is orange/gold, and Warm is terracotta/sage.
- Pause animation while the application is hidden and replace motion with a legible static state when reduced motion is requested.

## Acceptance

- All seven categories produce different motion identifiers.
- Standard and compact layouts render every motion without changing activity semantics.
- All four release themes define intentional primary and secondary motion colors.
- Existing completed/error/cancelled activities remain static.
- Focused component tests, runtime activity tests, typecheck, and a live app inspection pass.
