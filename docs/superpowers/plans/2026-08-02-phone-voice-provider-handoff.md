# Phone and Voice Provider Handoff Plan

1. Add focused failing tests for URL/readiness validation, outbound wizard
   validation and credit copy, provider reuse, error states, and explicit
   server credit fields.
2. Implement lightweight call-cloud readiness helpers and the outbound setup
   model.
3. Redesign Phone and Voice hierarchy around readiness, shared providers,
   outbound setup, security, and automation while preserving existing controls.
4. Convert Call Anyone to a validated progressive wizard and retain the
   server-authoritative approval/reservation/cancellation flow.
5. Prefer authoritative shared-credit response fields and run focused
   verification, formatting, type checking, and diff/secret checks.
