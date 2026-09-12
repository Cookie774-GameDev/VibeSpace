# PR #31 License Bundle

This directory is the distributable license bundle for dependencies newly
adopted by the PR #31 intelligence and Browser Agent program. Exact versions,
commits, integrity hashes, repository URLs, purposes, and distribution scopes
are recorded in `../dependency-lock.json`.

| Component | License text | Additional notice |
| --- | --- | --- |
| `gpt-tokenizer` 3.4.0 | `MIT-gpt-tokenizer.txt` | None in the pinned package |
| `@huggingface/tokenizers` 0.1.3 | `Apache-2.0.txt` | None in the pinned package |
| `web-tree-sitter` 0.26.11 | `MIT-tree-sitter.txt` | None in the pinned package |
| `@repomix/tree-sitter-wasms` 0.1.17 | `UNLICENSE.txt` | None in the pinned package |
| `tree-sitter-json` 0.24.8 | `MIT-tree-sitter-json.txt` | None in the pinned package |
| TypeScript / TSX grammar 0.23.2 | `MIT-tree-sitter-typescript.txt` | Compiled in the pinned WASM bundle |
| JavaScript / JSX grammar 0.25.0 | `MIT-tree-sitter-javascript.txt` | Compiled in the pinned WASM bundle |
| Rust grammar 0.24.0 | `MIT-tree-sitter-rust.txt` | Compiled in the pinned WASM bundle |
| Python grammar 0.25.0 | `MIT-tree-sitter-python.txt` | Compiled in the pinned WASM bundle |
| `@opentelemetry/api` 1.9.1 | `Apache-2.0.txt` | None in the pinned package |
| `@opentelemetry/sdk-trace-base` 2.10.0 | `Apache-2.0.txt` | None in the pinned package |
| `@modelcontextprotocol/sdk` 1.30.0 | `MIT-mcp-sdk.txt` | None in the pinned package |
| `playwright-core` 1.61.1 | `Apache-2.0-playwright.txt` | `NOTICE-playwright.txt` |
| `@playwright/test` 1.61.1 | `Apache-2.0-playwright.txt` | `NOTICE-playwright.txt` |
| `promptfoo` 0.121.20 | `MIT-promptfoo.txt` | Development/CI only |

The distribution packaging step must include this directory without rewriting
the texts. Dependencies that predate PR #31 remain governed by the existing
application-wide third-party notice process.
