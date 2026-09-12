# Focused Visual Refinements Design

## Scope

Refine only three existing surfaces:

1. Blend the Default, Jarvis One, and MonoChrome empty-chat illustrations into their theme backgrounds.
2. Remove the Kanban “Live workspace activity” section and let the checklist grid consume the released height.
3. Make the Warm Files waterfall artwork clearer without changing the editor or file-tree behavior.

## Design

The chat assets remain unchanged and optimized. Theme-scoped CSS supplies a quiet edge fade and palette-aware contrast so each image reads as part of its page rather than a rectangular card.

Kanban stops subscribing to the Inspector’s open-work feed. Its two existing checklist cards remain side by side at wide widths and naturally stretch through the remaining page height. No milestone or to-do behavior changes.

Files retains its existing scenic asset and page composition. The decorative layer receives more opacity and the editor wash becomes lighter so the waterfall, rocks, and foliage remain visible while content panels retain readable contrast.

## Acceptance

- No chat welcome art has a hard rectangular boundary.
- Default, Jarvis One, and MonoChrome retain distinct theme treatment.
- Kanban contains no “Live workspace activity” region or activity-feed subscription.
- The milestone card expands into the space formerly consumed by activity.
- Warm Files artwork is clearer while file text remains readable.
- Focused tests and the production Vite bundle pass.
