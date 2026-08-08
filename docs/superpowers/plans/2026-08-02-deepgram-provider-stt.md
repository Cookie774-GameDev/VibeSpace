# Deepgram Provider and STT Implementation Plan

1. Add failing pure tests for catalog selection, literal calculator math,
   rounding, stale-price labeling, streaming URL construction, and usage
   aggregation.
2. Add failing credential tests for canonical vault writes, low-cost
   validation, legacy vault migration, invalid/revoked behavior, removal, and
   secret-free status events.
3. Implement the bounded Deepgram catalog, calculator, local numeric usage, live
   project usage client, and central secure credential service.
4. Add a reusable Deepgram credential card and failing component tests for
   connect, replace, test, remove, recovery, and non-secret connected state.
5. Integrate the card and usage summary into Providers and Speech-to-Text. Add
   the official bundled logo and five-choice calculator UI.
6. Route the selected supported model through the existing Deepgram dictation
   stream and composer microphone path. Record numeric local usage on close.
7. Adapt Voice's existing Deepgram saves to the canonical service and status
   event. Migrate/remove Phone/Voice's legacy raw Deepgram JSON field while
   preserving every unrelated phone setting.
8. Run focused tests, scoped typecheck, formatting, diff checks, and secret
   scans. Perform a real end-to-end provider check only if a credential already
   exists in secure storage, without printing or exposing it.
