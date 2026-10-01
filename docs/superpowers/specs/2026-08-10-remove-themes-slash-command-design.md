# Remove the `/themes` Slash Command

## Goal

Remove the duplicate global-appearance command `/themes`.

## Command contract

- `/appearance` remains the only slash command that opens the global appearance picker.
- `/theme` remains the separate chat-console profile command.
- `/themes` is absent from slash-command discovery.
- Entering `/themes` is not intercepted as an appearance command.
- Appearance help text references only `/appearance`.

## Scope

Update only the chat slash-command registry, appearance-command recognition, composer handling and copy, and their focused tests. Do not change theme assets, appearance settings, `/theme` behavior, or unrelated dirty benchmark/news files.

## Verification

Use a failing regression test to prove `/themes` is still registered before the production edit. Then run the focused slash-command, composer theme/path, and appearance-picker tests, followed by TypeScript validation.
