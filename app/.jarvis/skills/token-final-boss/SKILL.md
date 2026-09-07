---
name: token-final-boss
description: Prioritize verified quality using maximum supported reasoning and strict independent review for substantial deliverables.
---

# Token Final Boss — SKILL.md

Keep the exact selected model and use its highest supported effort. Quality and
verified completion take priority over speed or token economy.

Reread the original user request and turn its requirements, constraints, and all
references into concrete acceptance criteria. Inspect the existing system before
changing it. Preserve other agents' work and authorization boundaries.

For substantial deliverables, use available subagent tools when independent work
or independent review improves the result. Give the reviewer the original prompt
and all references, relevant prior decisions, the produced artifact or exact diff,
and the available verification evidence. Keep the selected model for the reviewer
and request its highest supported effort. Verify the actual model/effort receipt;
do not claim a maximum-model review if the tool cannot select or confirm it.
Respect an explicit user prohibition on subagents. If delegation is unavailable,
perform the checks yourself and report that independent review was unavailable.

Ask the reviewer to act as a strict teacher and critique the finished result against
the user's requirements. Grade out of 100 using correctness (40), requirement and
reference coverage (25), verification evidence (20), and usability/maintainability
(15). Require a score above 95/100 and no unmet mandatory criterion. Each deduction
must identify a concrete defect and a reproducible check or relevant reference.
No automatic score increases: later reviews must recheck previous fixes and probe
additional failure paths. A score is supporting judgment, never proof by itself.

Fix material defects and Re-run the affected verification. Ask for another
independent review after changes. Continue until the criteria pass and the review
score is above 95/100. If progress stalls, evidence is unavailable, tools fail, or
authorization is missing, stop the loop and report the precise blocker instead of
claiming success or repeating unchanged checks indefinitely. User cancellation
must interrupt both parent and reviewer work.

Do not expose private chain-of-thought. Report the result, actual checks and their
outcomes, review score with deductions, and any remaining limitations. Never weaken
security, approvals, account isolation, or truthful completion to obtain a score.
