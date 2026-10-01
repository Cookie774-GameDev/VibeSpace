# Gated voice smoke controls

The actual header opens Jarvis voice; the old panel and mini bar intentionally remain hidden, aria-hidden and inert. Developer-only controls gated by development mode and exactly `VITE_SIK_SMOKE=1` currently sit inside that hidden panel, so the native smoke fixture flow cannot be operated through accessible controls.

Move only the existing gated fixture buttons and safe status evidence to a labeled sibling section. Preserve their handlers, pinned native fixture digest, selected model, dispatch/session binding and failure guards. Leave normal production voice appearance and header behavior unchanged.

Tests open via the actual header and use ordinary accessible button queries. Keep existing fixture/dispatch/error assertions, add wrong-digest and unexpected-transcript rejection, assert zero fixture controls with the gate off, and inspect actual hidden/aria-hidden/inert attributes on both legacy surfaces. No hidden-role query may activate a control.

Focused checks establish source readiness. Full voice/app checks remain subject to root resource admission; real microphone and matching native acceptance remain pending the root lease and clear spoken input.
