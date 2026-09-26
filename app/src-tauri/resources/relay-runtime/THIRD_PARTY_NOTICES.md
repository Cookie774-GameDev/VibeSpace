# Relay runtime third-party notices

This packaged Node runtime includes the exact dependency closure recorded in
`relay-runtime-lock.json` and `runtime.zip`. The npm package lock pins each
version, resolved tarball, and integrity value. Existing package license and
notice files are retained inside `node_modules` in the archive.

The following six packages omit SPDX license metadata in their published npm
package records. Their upstream source repositories declare Apache License
2.0; the full license text is provided as `LICENSE-APACHE-2.0.txt`.

- `@agent-relay/sdk@12.4.1` — Agent Workforce Inc.;
  https://github.com/AgentWorkforce/relay
- `@relaycast/a2a@8.12.0`, `@relaycast/engine@8.12.0`,
  `@relaycast/mcp@8.12.0`, `@relaycast/sdk@8.12.0`,
  `@relaycast/types@8.12.0` — Agent Workforce Inc.;
  https://github.com/AgentWorkforce/relaycast

`drizzle-orm@0.45.3` declares Apache-2.0 in its package metadata but does not
ship a license text in its npm archive. Its upstream project is
https://github.com/drizzle-team/drizzle-orm; the Apache 2.0 text and this
attribution are included here.

All other packages retain their upstream license/NOTICE files in the archived
dependency closure. See `relay-runtime-lock.json` for the complete package
inventory and per-package license metadata.
