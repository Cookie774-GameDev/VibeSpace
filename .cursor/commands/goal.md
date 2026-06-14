---
name: goal
description: >-
  STRICT /goal workflow — full detailed plan with milestones, complete each
  milestone with tests, full system test, charted summary with blockers and
  test output.
---

**Invoke the `strict-goal` skill. Follow it with ZERO deviation.**

This is the **/goal** workflow: plan → one milestone at a time → test each → full system test → final report with charts.

## User task
$ARGUMENTS

If no task was provided after `/goal`, ask: **"What should this goal accomplish? Be specific about what 'done' looks like."**

## Reminders (non-negotiable)
1. Phase 0: publish full detailed milestone plan before any edits
2. Phase 1: one milestone at a time; test after each; fix failures before continuing
3. Phase 3: full system test after all milestones
4. Phase 4: final report with mermaid pie + gantt, blockers table, test output, executive summary

Do not commit unless the user explicitly asked.
