# VibeSpace Backend Cloud Closeout Plan

**Scope:** Backend obligations found in the six owner-supplied
`VibeSpace-IDEAS!` folders only. Preserve all existing PR31 UI and feature
behavior.

## Verified baseline

- Migrations `0031`–`0037`, the Access/feature-plan Stripe functions, Call
  Anyone functions, profile persistence, and their focused tests already exist
  in the PR31 worktree.
- The network-free Supabase/Stripe suite passes on the preserved baseline.
- The connected Supabase project contains protected AccessRevamp `ar_*`
  objects, so it fails the owner-approved isolation gate and is read-only.
- The connected Stripe account is test mode, but its existing catalog is not
  independently proven as the VibeSpace catalog and remains read-only.

## Implementation

1. Add migration `0038_backend_advisor_hardening.sql` for the concrete
   VibeSpace security/performance advisor findings:
   - run `set_phone_pin` with invoker rights while preserving its existing
     self-user check and RLS behavior;
   - remove redundant `FOR ALL ... false` policies without enabling writes;
   - explicitly revoke client DML on server-owned usage/promo tables;
   - replace the per-row authenticated-role check with a role-scoped read
     policy;
   - add the missing covering index for admin grant attribution.
2. Add focused migration-contract and SQL catalog behavior tests.
3. Run the complete network-free Supabase function/migration suite once, then
   scoped formatting, diff, and secret checks.
4. Produce a no-secret operator handoff containing the exact remaining cloud
   actions and the isolation gate. Do not deploy to the mixed target.

## Rollback

Do not apply `0038` remotely until an isolated VibeSpace test project is
proven. If a later isolated test apply fails, restore the prior policies and
`SECURITY DEFINER` attribute in a new forward migration; never edit applied
migration history.
