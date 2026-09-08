# Prompt Forge evaluation contract

Evaluate actual provider outputs only. No generated output has yet been accepted against this rubric: the D profile does not currently expose the requested OpenCode Go model. Model-specific timing and scores remain pending.

Use a fixed 100-point rubric: original intent 25; every explicit constraint preserved 25; clear executable work 15; relevant, supported context 15; observable verification criteria 10; concise wording appropriate to task size 10. Any lost protected constraint or invented context prevents acceptance, regardless of total. A score over 90 is a qualitative review of that specific output, not a benchmark of all prompts or a guarantee of execution quality.

Native scenarios: (1) racing-game draft typed in the third terminal, upgrade, inspect and insert without Enter; (2) Chat manual upgrade, cancel/revert and confirm original draft; (3) add keyboard controls, restart, scoring and no external dependencies, regenerate and check that every addition and original requirement survives; (4) opt-in automatic mode upgrades then dispatches once; (5) cancel during upgrade dispatches nothing. Preserve the exact selected provider/connection/model identity and wall-clock start/completion times. Cold and warm runs must be measured separately.

The updater uses the existing tool-free Prompt Forge skill. A single permanent conversation shared between projects would accumulate unrelated instructions and context. Reusing the provider process while retaining scoped per-request context is preferable unless a bounded, isolated conversation implementation is verified.
