# GPT-5.6 Sol Prompt Architecture Notes

## Purpose

This pack is structured for GPT-5.6 Sol using the official OpenAI model guidance. The master prompt stays compact while the repository files carry the durable product contracts.

Official guidance used:

```text
https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6#prompting-best-practices
```

## Applied principles

### 1. Lean execution prompt

The execution prompt does not repeat every design detail. Repeated instructions and oversized prompt stacks can reduce efficiency. Theme details live once in dedicated specifications.

### 2. Outcome first

The prompt names the finished product outcome:

- reference-faithful themes;
- repaired scale;
- inline Codex output;
- correctly placed token animation;
- working usage module.

The agent is free to choose the exact safe implementation within the repository's architecture.

### 3. Explicit autonomy boundary

The prompt authorizes:

- reading references and repository files;
- editing in-scope code/assets/docs;
- running the app;
- browser control and screenshots;
- focused non-destructive checks;
- a bounded native smoke.

It prohibits:

- destructive actions;
- release/deploy/merge;
- secrets;
- unrelated scope expansion.

This avoids unnecessary approval pauses while retaining a clear stopping boundary.

### 4. One instruction, one location

Requirements are separated by responsibility:

- mission and completion: `MASTER_GOAL.md`;
- source priority: `REFERENCE_MANIFEST.md`;
- scale: `SCALE_TYPOGRAPHY_DENSITY.md`;
- visual architecture: design files;
- operating technique: skill file;
- order of work: one implementation plan;
- verification: visual acceptance file.

The master prompt points to them instead of restating them.

### 5. Measurable success criteria

Each design file ends with acceptance criteria. `VISUAL_ACCEPTANCE.md` defines routes, states, viewports, scoring, and stop conditions. This gives the agent a concrete definition of “done.”

### 6. Preserve important ambiguity policy

The source request forbids questions. The pack resolves foreseeable ambiguity using reference precedence. If an optional reference is missing, the agent continues with the remaining evidence and reports the limitation rather than stopping.

### 7. Tool relevance

The expected tool set is intentionally narrow:

- repository/filesystem;
- browser control/visualization;
- image inspection/processing;
- focused build/type/test tools;
- one native smoke for the companion window.

No sub-agent or broad research tool is required during implementation.

### 8. Verification proportional to the task

The task is visual and quality-first. Browser comparison is primary. Automated checks are focused on changed contracts and compile safety rather than a long unrelated test campaign.

## Recommended model settings

Where the execution environment exposes them:

- model: GPT-5.6 Sol;
- reasoning: `high` or `xhigh` for the reference-analysis and difficult integration portions;
- verbosity: high for the final evidence report, normal during implementation;
- persisted reasoning/context: retain across the run because goals and constraints remain stable.

Use the strongest practical setting available, but do not equate higher reasoning with permission to expand scope.
