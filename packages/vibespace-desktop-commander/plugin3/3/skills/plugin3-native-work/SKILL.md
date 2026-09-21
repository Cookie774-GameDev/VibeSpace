# VibeSpace Desktop Link operating guide

This shared service provides bounded repository reads, workspace leases, durable jobs, guarded edits, agent mailboxes, and an explicit browser session surface through MCP.

## Before repository work

1. Register the absolute workspace root with `workspace_open`.
2. Inspect `workspace_status` and read only the files needed for the request.
3. Use `lease_claim` for exact files before editing. Keep each lease owned by one agent.
4. Prefer `read_batch` and `query_repo` for bounded reads. Ignore dependency and `.git` internals.

## Edits and jobs

Use `edit_plan` with a manifest containing expected hashes, inspect the planned validation, then call `edit_apply` only for the same owned plan. Poll `edit_status` until `planned`, `applied`, `rolled_back`, `failed`, or `uncertain`. An interrupted edit is uncertain and must be inspected before another mutation; never replay it automatically.

Use `job_start` with an executable and explicit argument array. Read output with `job_read` or `job_wait`. Jobs are bounded and durable; a timeout or lost connection does not prove that work did not happen. Inspect the recorded job before retrying.

## Browser sessions

Use `browser_observe` for discovery and read-only inspection. Use `browser_session` only with an explicit session owner and an authorized target. Verify the target URL and title before attaching. Reuse the returned session ID. After a partial action result, inspect the page and continue only the unfinished action; never replay a successful mutation.

## Recovery and reporting

Technical failures, host permission denials, and model behavior are separate signals. Report the exact layer and preserve successful prior actions. Do not claim a model, browser, agent, or native window was launched without observed evidence. The host controls access to native applications and external services.

Keep credentials out of prompts, manifests, logs, workspace files, and tool arguments. Use the host's approved credential store and report only redacted status. Stop at an explicit policy denial, an uncertain mutation, or a workspace ownership conflict.
