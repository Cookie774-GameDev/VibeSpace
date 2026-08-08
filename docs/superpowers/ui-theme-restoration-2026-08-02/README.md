# VibeSpace UI Theme Restoration — Documentation Pack

**Goal ID:** `VS-PR31-UI-THEME-RESTORATION-20260802`  
**Repository:** `Cookie774-GameDev/VibeSpace`  
**Target branch / PR:** `agent/pr30-fixes-and-updates` / PR `#31`  
**Execution:** one agent only; one up-front plan; no approval pauses; visual-first implementation  
**Scope:** UI restoration for MonoChrome, Sakura, Origami/VibeSpace, Warm/Default, Codex-style chat output, sidebar token animation, and the taskbar AI usage module

## Why this pack exists

The current app contains multiple theme-specific regressions and several global scale problems. The current-state screenshots attached to the source request show oversized text, oversized cards, weak hierarchy, mascot overlap, generic panel treatment, and settings surfaces that do not match the intended art direction. Their observations are transcribed in `REFERENCE_MANIFEST.md`.

The goal is not to create another interpretation of the themes. The goal is to restore each appearance from its supplied reference material, preserve working product behavior, and make the result visually polished enough to be compared directly against the references.

## Document map

Read these files in order before editing:

1. [`MASTER_GOAL.md`](./MASTER_GOAL.md) — outcome, boundaries, completion definition.
2. [`REFERENCE_MANIFEST.md`](./REFERENCE_MANIFEST.md) — authoritative local reference folders, current-state screenshots, and precedence rules.
3. [`SCALE_TYPOGRAPHY_DENSITY.md`](./SCALE_TYPOGRAPHY_DENSITY.md) — global sizing contract that fixes the repeated text/card problem at the root.
4. [`DESIGN_SHARED_FOUNDATIONS.md`](./DESIGN_SHARED_FOUNDATIONS.md) — shared theme architecture and component rules.
5. Theme specifications:
   - [`DESIGN_MONOCHROME.md`](./DESIGN_MONOCHROME.md)
   - [`DESIGN_SAKURA.md`](./DESIGN_SAKURA.md)
   - [`DESIGN_ORIGAMI.md`](./DESIGN_ORIGAMI.md)
   - [`DESIGN_WARM.md`](./DESIGN_WARM.md)
6. Feature specifications:
   - [`DESIGN_CODEX_CHAT.md`](./DESIGN_CODEX_CHAT.md)
   - [`DESIGN_USAGE_MODULE.md`](./DESIGN_USAGE_MODULE.md)
7. [`SKILL_UI_VISUAL_RESTORATION.md`](./SKILL_UI_VISUAL_RESTORATION.md) — inspection, asset, browser, and comparison methods.
8. [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) — the **single implementation plan** for the entire goal.
9. [`VISUAL_ACCEPTANCE.md`](./VISUAL_ACCEPTANCE.md) — browser visualization matrix and stop conditions.
10. [`PROMPT_ARCHITECTURE.md`](./PROMPT_ARCHITECTURE.md) — how the official GPT-5.6 Sol prompting guidance is applied.
11. [`MASTER_PROMPT.md`](./MASTER_PROMPT.md) — compact copy/paste execution prompt that points to the detailed contracts above.

## Non-negotiable operating rule

There is exactly one plan for this goal: `IMPLEMENTATION_PLAN.md`. Do not create theme-by-theme plans, planning tickets, approval gates, or sub-agent slices. After the initial reconnaissance and plan confirmation, implement continuously and use the visual loop until the acceptance bar is met.

## Prompting structure

The execution prompt is intentionally lean. Detailed requirements live in the design and skill files instead of being repeated inside the prompt. This follows the GPT-5.6 guidance to state each instruction once, define autonomy boundaries, preserve hard constraints, and specify measurable success criteria.
