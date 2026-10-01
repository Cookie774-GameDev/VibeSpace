# Jarvis Activity Motion Implementation Plan

**Goal:** Make every live Jarvis activity state visually distinct, correctly sized, and theme-aware.

**Architecture:** Preserve the existing structured activity resolver. Wrap the reference-sized animation in a stable slot so the mini panel can scale it without altering its internal layout. Keep all visual behavior in the existing motion stylesheet.

**Tech Stack:** React, TypeScript, CSS animations, Vitest, Testing Library.

### Task 1: Lock the motion contract with failing tests

**Files:**
- Modify: `app/src/features/chat/agentic-console/AgentMotionIndicator.test.tsx`
- Create: `app/src/features/chat/agentic-console/agent-motion.test.ts`

Add assertions for the inner motion canvas, distinct category mapping, reference-scale geometry, compact scaling, four release-theme palettes, hidden-state pausing, and reduced-motion behavior. Run the focused tests and confirm the new assertions fail for the missing wrapper/palette contract.

### Task 2: Implement the reference-sized motion canvas

**Files:**
- Modify: `app/src/features/chat/agentic-console/AgentMotionIndicator.tsx`
- Modify: `app/src/features/chat/agentic-console/agent-motion.css`

Add the stable outer slot, retain data attributes on the slot, restore motion-lab proportions, and scale only the inner canvas for compact mode.

### Task 3: Add release-theme palettes and accessibility behavior

**Files:**
- Modify: `app/src/features/chat/agentic-console/agent-motion.css`

Define explicit Default, Monochrome, Jarvis One, and Warm palettes. Preserve hidden-window pausing and reduced-motion static rendering.

### Task 4: Verify real activity behavior

**Files:**
- Verify: `app/src/lib/ai/runtime.test.ts`
- Verify: `app/src/features/chat/agentic-console/AgentMotionIndicator.test.tsx`
- Verify: `app/src/features/chat/agentic-console/agent-motion.test.ts`

Run focused tests, TypeScript typecheck, diff validation, and live app inspection at standard and mini-panel sizes.
