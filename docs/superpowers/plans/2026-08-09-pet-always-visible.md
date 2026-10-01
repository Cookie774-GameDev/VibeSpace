# Pet Always-Visible Implementation Plan

1. Change the pure panel lifecycle rule so an enabled, non-shutdown overlay remains visible regardless of panel state.
2. Update bridge and host tests to prove opening/focusing the mini panel never invokes overlay hide.
3. Remove panel-driven hiding and sprite suppression from `PetHost` while preserving explicit disable/shutdown hiding.
4. Run the focused pet lifecycle, bridge, panel-open, host, animation, and performance gates.
