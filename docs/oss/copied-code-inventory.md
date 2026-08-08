# Copied and Adapted Code Inventory

This table covers code copied or materially adapted for the PR #31 intelligence
and browser program. Algorithmic inspiration without copied expression is
documented in the relevant design or source comments instead.

| Component | Repository | Pinned version/commit | License | VibeSpace paths | Modifications | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Repository selection and packing patterns | `yamadashy/repomix` | `c6f084be702fcba8527cb81ee5357bea472b6262` reference snapshot; no source copied | MIT | `app/src/features/repository-intelligence/**` | VibeSpace-owned typed ranking, exclusion, evidence, and token-budget contracts | Adapted concepts; no copied expression |
| Repository-map ranking patterns | `Aider-AI/aider` | `5dc9490bb35f9729ef2c95d00a19ccd30c26339c` reference snapshot; no source copied | Apache-2.0 | `app/src/features/repository-intelligence/**` | VibeSpace-owned reference/centrality scoring and deterministic packing | Adapted concepts; no copied expression |
| Temporal knowledge concepts | `getzep/graphiti` | `aab852df94413fd0d55cbea2b7886173020281d5` reference snapshot; no runtime installed | Apache-2.0 | `app/src/features/temporal-context/**` | Native current/stale/disputed/superseded states, validity, provenance, CAS persistence | Adapted concepts; no copied expression |
| Progressive skill disclosure | `agentskills/agentskills` | `27a9f0c075e876ad632fc2e88b8866c5dc8ca15c` reference snapshot; no source copied | Apache-2.0 / CC-BY-4.0 docs | Existing VibeSpace skill loader and future package compatibility | VibeSpace trust, capability, checksum, and approval extensions retained | Standard/pattern reference |
| Vector/full-text benchmark candidate | `lancedb/lancedb` | `f79dc017c4d189d000dd3d6aaffb8cc38eebd2ee` benchmark snapshot; no runtime installed | Apache-2.0 | No product path | Retained only as a future benchmark against Dexie and Tantivy | Deferred; no copied expression |
