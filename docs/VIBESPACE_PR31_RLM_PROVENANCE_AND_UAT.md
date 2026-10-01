# PR31 RLM provenance and native UAT ledger

Goal: `VS-PR31-RLM-OPENCODE-NATIVE-E2E-20260811`

## Upstream provenance

The VibeSpace implementation is an independent TypeScript implementation adapted to VibeSpace's
lossless Context Map authority, scope policy, OpenCode harness, and local Ollama child runtime. No
upstream source file was copied into the product.

| Authority                                                                 | Audited revision                                                        | License              | Adopted concept                                                                                               |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `alexzhang13/rlm`                                                         | `caf0bffa1acec17c062559433b4cd4ed92eee3d6` (`HEAD`, audited 2026-08-11) | MIT                  | Root model navigates external context, delegates narrow evidence to bounded recursive calls, then synthesizes |
| `alexzhang13/rlm-minimal`                                                 | `973f8d4acf3af2c86dc170af91607bf8b0c4d0ea` (`HEAD`, audited 2026-08-11) | MIT                  | Minimal root/child separation and fresh child contexts                                                        |
| Zhang, Kraska, and Khattab, “Recursive Language Models,” arXiv:2512.24601 | arXiv abstract and paper metadata audited 2026-08-11                    | research publication | External-context navigation beyond one model window and conservative recursion                                |

VibeSpace intentionally does not expose a host arbitrary-code REPL. Its equivalent is a fixed,
namespaced query surface (`describe`, `search`, `open`, `expand`, `related`, `timeline`, `sources`,
`checkpoint`, `investigate`) with scope checks, exact pointers, bounded output, and cancellation.

## Provider truth

| Route                                                                  | Native result                                                                    | Truthful status                                                                                               |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Qwen API → managed OpenCode 1.18.16 → `qwen/qwen3.7-max`               | Provider/model dispatch reached Alibaba Cloud, then returned `Incorrect API key` | BLOCKED — EXTERNAL credential rejection; no fallback                                                          |
| ChatGPT subscription → managed OpenCode 1.18.16 → `openai/gpt-5.6-sol` | OpenCode OAuth route selected the model, then refresh returned HTTP 401          | BLOCKED — EXTERNAL supported browser reauthorization required; no API-key substitution or Codex-token copying |
| VibeSpace RLM child → managed OpenCode → `ollama/llama3.2:latest`      | Native cross-source `investigate` ran two exact spans (711 bytes total) through one tool-disabled local child at depth 1 | VERIFIED — local route; child wording quality is reported separately |

Alibaba Cloud's official catalog did not expose a model named “Qwen 3.8” at audit time. The nearest
official current mainline found was `qwen3.7-max`; the product names it truthfully and does not
invent a `qwen3.8` identifier.

## Long-corpus evidence

Corpus root: `C:\Users\viper\VibeSpace-RLM-UAT`

| Measurement                | Result                                                             |
| -------------------------- | ------------------------------------------------------------------ |
| Source class               | 39 distinct Project Gutenberg public-domain story/book works       |
| Final shards               | 112 UTF-8 text files                                               |
| Tokenizer                  | `gpt-tokenizer@3.4.0` local `encode` measurement                   |
| Final token count          | 10,068,547                                                         |
| Final corpus bytes         | 41,088,462                                                         |
| Total acceptance footprint | 41,255,461 bytes (39.344 MiB)                                      |
| Corpus SHA-256             | `4790e1ea23c4e056e5eb7f7024dd92d2475e0faab43f91118c493762503f9d90` |
| Manifest SHA-256           | `edff653e2e59c33932dc81812a0499fad507e1a02ebd27e7308ea4009668d771` |
| Ground-truth SHA-256       | `8700115af3984109b7e61365974db8096c0e637613d9b33e26a0eb9c2dd74958` |
| Fresh ground-truth SHA-256 | `49386ffd4b861e752e2f89df5dbae82c02624023dbc83235bab63b9b01668f27` |
| Question positions         | A 5.4%; B 50.5%; C 94.6%                                           |
| Fresh question positions   | D 23.4%; E 71.2%; F 85.6%                                          |

The manifest records title, author, Project Gutenberg URL/ID, public-domain note, download timestamp,
downloaded and included byte lengths, SHA-256, virtual corpus byte range, shard files, and per-shard
token counts. Redundant raw downloads were never retained: each source was streamed, prose-extracted,
sharded, and released before the next download.

The final footprint remeasurement after removing the corpus-specific derivative index is
41,255,461 bytes (39.344 MiB): 41,252,718 bytes of current corpus/ground-truth artifacts plus
2,743 bytes of native index metadata. Exact-anchor RLM search uses bounded, hash-verified local
shard scans when the derivative index has no hit. It does not inject the corpus into a model prompt.

## Native 10M exact-recall results

| Set | Result | Correct shards | Native wall time |
| --- | --- | --- | --- |
| Original A/B/C | 3/3 exact deterministic retrieval | `0007-pg2600.txt`, `0057-pg1260.txt`, `0106-pg219.txt` | cold A 29.785 s; warm B 6.162 s; C 6.017 s |
| Fresh D/E/F | 3/3 exact deterministic retrieval | `0027-pg4300.txt`, `0080-pg8800.txt`, `0096-pg205.txt` | 6.046 s; 5.995 s; 6.044 s |

Every question returned exactly one correct shard, a current SHA-256-bound pointer, and an opened
span containing the deterministic answer. The forced native A investigation recorded mode `rlm`,
one hit, one 560-byte open, one `ollama/llama3.2:latest` child, depth 1, two tool calls, no budget
exhaustion, and a final supporting pointer. The small local child found the correct continuation but
over-explained instead of obeying the exact output format; deterministic root-side source validation
is therefore the exactness authority for this acceptance set.

Native cancellation returned `RlmRuntimeError(code=cancelled)` in 2.503 s and a new exact search
succeeded 6.198 s later with both the corpus and persisted-chat hits. The bounded child session is
deleted in `finally`; the managed OpenCode
connector remains alive as the shared service.

## Live OpenCode semantic-tool compatibility run — 2026-08-13

The native PR31 app was exercised through the visible chat composer with managed OpenCode
`1.18.16`, the dedicated least-privilege `vibespace` agent, and the local
`ollama/vibespace-llama3.2-16k:latest` route. Raw OpenCode session records—not visible prose
alone—were used as the execution authority.

| Evidence | OpenCode session | Result |
| --- | --- | --- |
| Exact corpus search | `ses_006406855ffe24sLH2iK4TdU6J` | `vibespace_context` completed with `ok=true`; first result was `0007-pg2600.txt`, bytes `226102..226654`, SHA-256 `840066cdbfe556d2463597a989ffb85d12089b6109dfdbf992e7f18d48c2a066` |
| Exact pointer open | `ses_00638d488ffeuoUdGYuSxKvYVe` | Local model serialized the pointer as bounded JSON text; gateway decoded it, reapplied strict pointer/hash validation, and returned `ok=true`, `status=current`, and the exact 552-byte span |
| Exact pointer open, object form | `ses_00636a0b5ffezNJBr0NVeapvbJ` | `vibespace_context` completed with `ok=true` using the full pointer object and current file authority |

The opened source starts with `talk ceased and all eyes were fixed on`, followed by
`Kutúzov who, wearing a white cap with a red band ...`. The exact eight whitespace-delimited
tokens immediately after the first `Kutúzov` are `who, wearing a white cap with a red`.

This run repaired three production defects found through the live trace:

- OpenCode schema materialization supplied `null`, irrelevant optional fields, and numeric strings.
  The gateway now canonicalizes only registered, operation-irrelevant placeholders while retaining
  exact-key, bounds, scope, and hash checks.
- Scoped history loading ordered messages by a nonexistent `updated_at` IndexedDB index. It now
  queries the existing `chat_id` index and sorts the bounded result in memory.
- Context Map record authority was memory-only, so a valid pointer could report `record_missing`
  after restart. Open now rehydrates persisted, scope-filtered records and rechecks the current
  source hash before returning bytes.

The 3B local model reliably executed real search/open tool calls but did not reliably perform the
final eight-token extraction even when the exact text was returned. Those incorrect prose answers
remain failure evidence and are not counted as successful answer-quality runs. Tool execution,
pointer durability, source identity, and deterministic exact extraction are separately verified.

A stronger `gemma4:latest` retry was selected through the visible model picker after reducing the
generated OpenCode limit to 16,384 tokens. Ollama's OpenAI-compatible route still loaded that model
at its model-native 131,072-token context, heavily offloaded it to CPU, and produced no assistant or
tool part within the bounded live interval. The run was cancelled through the visible app control.
Generic discovered Ollama models therefore no longer receive invented `tool_call`, context-limit,
or `num_ctx` claims. Only the separately created and live-verified
`vibespace-llama3.2-16k:latest` tag receives those explicit capability fields.

## Final native regression checks — 2026-08-13

- Oversized composer input: chat `cht_TMgkLPgGAPlmvQ1s` accepted exactly 128,001 characters and
  persisted message `msg_cE4um-7gD7eomtCk` as a managed `.txt` file reference. The native artifact
  was exactly 128,001 bytes and 128,001 characters, with SHA-256
  `a04320981b977b50bae137704104aebef7135d943007da3d9aecf5b21a8afde4`.
- Cross-chat concurrency: while chat `cht_TMgkLPgGAPlmvQ1s` had an active long generation, new chat
  `cht_mvhQTdN-VCgCrUoe` persisted independent message `msg_1PjQYJ7lP13dNUgI` and started its own
  run. The composer cleared and no queued-message banner appeared. Both runs were cancelled through
  supported app controls after evidence capture.
- Connector truth on final native binary: OpenAI subscription session
  `ses_0060f5b19ffeCW8Q6ZPHIcWNnz` reached the supported route and returned
  `Token refresh failed: 401`; Qwen session `ses_0060f42f8ffenHqsg267xr4Mpp` reached Alibaba and
  returned `Incorrect API key` with HTTP 401. Neither route silently fell back.
- Final running native executable SHA-256:
  `2f4ee5ef6b46f4e73cf5f4ca12390fea67011a76aede4d4d2db68b0d4e5f6b27`.
- Storage recovery removed only the accidental generated C: Rust target cache (3.46 GB); C: free
  space increased from 5.42 GB to 8.40 GB. Corpus, source, chats, and evidence were preserved.

## Native cross-source result

A message containing the exact A anchor was created through the visible native chat composer.
The production RLM repository then returned two scoped, hash-bound authorities for the same query:

- `file_version`: `0007-pg2600.txt`, byte range `226102..226662`, SHA-256
  `840066cdbfe556d2463597a989ffb85d12089b6109dfdbf992e7f18d48c2a066`;
- `chat_message`: message `msg_HLz_T1LOnWod1URU`, byte range `56..207`, SHA-256
  `fa96df356aca8b5eb3c2a5d17968355b36f4abcdb2f3a383b65bd89396dc19a3`.

The forced native investigation recorded run `rlm-msq80esd-rmpz1wq3`, exact-anchor search with two
hits, two exact opens, one `ollama/llama3.2:latest` child with two evidence spans, depth 1, three
tool operations, 711 opened bytes, 14.034 seconds wall time, and `budgetExhausted=false`. The child
printed a pseudo-shell fragment as prose, but its OpenCode request had `tools: { "*": false,
vibespace_context: false }`; no child tool or host command executed. Root synthesis retained both
validated source pointers.

Managed OpenCode evidence: executable
`C:\Users\viper\AppData\Local\ai.jarvis.desktop\runtimes\opencode\1.18.16\opencode.exe`, version
`1.18.16`, SHA-256
`dadee463adc9eaeeab9b79d5c5b4557a372a33af70b2742fff76d5507fccc0ac`.

## Native acceptance ledger

| UAT | Required route                               | Status             | Evidence / blocker                                                                 |
| --- | -------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| A   | Qwen OpenCode HTML game                      | BLOCKED — EXTERNAL | Alibaba rejects configured Qwen credential; model dispatch verified, no fallback   |
| B   | VibeSpace local Llama 3.2 child              | VERIFIED           | Native root → exact bounded evidence → tool-disabled `ollama/llama3.2:latest` child → synthesis trace |
| C   | GPT-5.6 Sol Medium via OpenCode subscription | BLOCKED — EXTERNAL | Supported native OpenCode OAuth refresh returns 401                                |
| D   | Conversational Schedule / Agent / Skill      | VERIFIED           | Native objects saved and rechecked after restart: schedule, `RLM UAT Agent — Llama32`, and `RLM UAT Skill — File Inspector` |
| E   | 10M exact recall, original and fresh 3/3     | PARTIAL — ROOT EXTERNAL | Native lossless path is 3/3 + 3/3 and forced local RLM trace passes; mandatory Qwen/GPT OpenCode root routes remain externally blocked |
| F   | Cross-source RLM                             | VERIFIED           | Visible persisted `chat_message` + 10M `file_version`; two exact pointers; one bounded native Ollama child; scoped root synthesis |
| G   | Cancellation                                 | VERIFIED           | Native active run cancelled at 2.503 s; post-cancel two-source search passed at 6.198 s; automated race coverage green |
| H   | Restart/persistence                          | VERIFIED           | Native process restart preserved chats, saved agent/skill/schedule, corpus maps, exact model selection, and exact corpus recall |

## Final verification gates

- Full frontend: 1,102 test files, 23 deterministic shards, exit 0.
- Focused Context/RLM: 24/24 after federation, plus 3/3 malformed-history regression group.
- Rust context search: 19 passed, 1 explicitly ignored release benchmark, 0 failed.
- Rust managed OpenCode harness: 54/54.
- Release/security Node battery: 86/86; updater manifest rerun: 44/44.
- Added-line secret scan: CLEAN across 55 tracked and 15 intended untracked files; the final
  scanner-emitted input binding remains in the verification command output.
- Production TypeScript/Vite build: exit 0. Production dependency audit at high severity: exit 0.
- Post-live-fix focused frontend suite: 275/275 passed across Context/RLM, OpenCode harness,
  gateway protocol/runtime, protected prompt compilation, runtime dispatch, and provider catalog.
- Post-live-fix TypeScript typecheck and production Vite build: exit 0.
- Cargo check: exit 0 (existing dead-code warnings only).
- Supported tray Exit completed its persistence flush and terminated the original process. Relaunch
  used the same verified native executable; cross-source evidence and fresh D/E/F remained exact,
  and the exact agent, schedule, skill, and corpus maps were reopened from persistence.

All locally executable rows are now verified. UAT A, UAT C, and the corresponding external-root
portion of UAT E remain explicitly blocked only by provider-owned authentication state after all
supported non-bypass repair paths were exhausted.
