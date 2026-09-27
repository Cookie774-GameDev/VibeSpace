# Jarvis voice conversation continuity

Each opening of Jarvis voice creates one new provider-bound Jarvis chat. Turns within
that opening use the same chat. Closing voice stops microphone capture, playback,
and the active spoken Main Agent turn; it does not cancel child worker chats.
An old close completion must never clear a newer voice binding.

The existing persisted Jarvis interaction cards are the task index. A new voice
chat reads a bounded list of prior voice worker IDs, parent/child chat IDs,
provider labels, and actual statuses. It does not import full prior transcripts
or recreate workers. The current task sent to a worker receives this compact
context. A completed worker writes a concise receipt in its original chat and,
when a newer voice chat is open in the same account, a linked notice there.
Only the currently bound voice chat can request a spoken Main Agent result.

The voice task coordinator lives outside the modal. It retains in-flight task
completion and duplicate suppression while the modal unmounts, and returns a
confirmed launch receipt promptly so the next voice conversation is not held
by a long-running worker. Failed launch remains a failure, never a launch claim.

Every voice parent chat has an app-data folder keyed by its validated chat ID.
The local IndexedDB messages and persisted interaction cards remain authoritative;
the folder holds a refreshable JSON snapshot of transcript text and worker
references for user inspection and recovery. Folder failure is surfaced without
discarding the saved chat. No worker or project files are moved or deleted.

Checks: fresh chat after close/reopen, old close cannot clear new binding,
in-flight workers survive a modal unmount, no duplicate worker on repeated
transcript, compact prior-task context, same-account result notice, truthful
folder errors, and official native Playwright acceptance when an instance is
assigned by the user.
