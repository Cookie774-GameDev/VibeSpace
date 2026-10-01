# Prompt Forge Inline Review Implementation Plan

1. Characterize the current modal review and composer hook with failing inline-preview tests.
2. Convert the review surface into an embedded compact region with Accept, Redo, Add context, and Restore original.
3. Apply each generated draft to the composer immediately while retaining the original for restore.
4. Ensure Accept closes review without sending; Redo and contextual regeneration replace the composer preview; Restore returns the exact original.
5. Verify normal and compact pet-panel layouts, keyboard labels, recovery, and existing Prompt Forge execution contracts.
