# Tree-sitter Grammar License Inventory

Tree-sitter core and every language grammar have independent release and
license records. Do not infer a grammar's license from Tree-sitter core.

| Language | Packaged artifact | Upstream package version | License status | Packaged | Verification |
| --- | --- | --- | --- | --- | --- |
| TypeScript | `@repomix/tree-sitter-wasms/out/tree-sitter-typescript.wasm` | `tree-sitter-typescript` 0.23.2 / `f975a621f4e7f532fe322e13c4f79495e0a7b2e7` | MIT; exact text in `licenses/MIT-tree-sitter-typescript.txt` | Yes | Local parser fixture pending final program pass |
| TSX | `@repomix/tree-sitter-wasms/out/tree-sitter-tsx.wasm` | `tree-sitter-typescript` 0.23.2 / `f975a621f4e7f532fe322e13c4f79495e0a7b2e7` | MIT; exact text in `licenses/MIT-tree-sitter-typescript.txt` | Yes | Local parser fixture pending final program pass |
| JavaScript / JSX | `@repomix/tree-sitter-wasms/out/tree-sitter-javascript.wasm` | `tree-sitter-javascript` 0.25.0 / `44c892e0be055ac465d5eeddae6d3e194424e7de` | MIT; exact text in `licenses/MIT-tree-sitter-javascript.txt` | Yes | Local parser fixture pending final program pass |
| Rust | `@repomix/tree-sitter-wasms/out/tree-sitter-rust.wasm` | `tree-sitter-rust` 0.24.0 / `18b0515fca567f5a10aee9978c6d2640e878671a` | MIT; exact text in `licenses/MIT-tree-sitter-rust.txt` | Yes | Local parser fixture pending final program pass |
| Python | `@repomix/tree-sitter-wasms/out/tree-sitter-python.wasm` | `tree-sitter-python` 0.25.0 / `293fdc02038ee2bf0e2e206711b69c90ac0d413f` | MIT; exact text in `licenses/MIT-tree-sitter-python.txt` | Yes | Local parser fixture pending final program pass |
| JSON | `tree-sitter-json/tree-sitter-json.wasm` | `tree-sitter-json` 0.24.8 / `ee35a6ebefcef0c5c416c0d1ccec7370cfca5a24` | MIT; exact text in `licenses/MIT-tree-sitter-json.txt` | Yes | Local parser fixture pending final program pass |
| Markdown | None | None | Not selected | No | Keep the existing Markdown parser until a pinned WASM grammar passes license and quality review |

The packaged WASM aggregate is pinned at
`@repomix/tree-sitter-wasms` 0.1.17 / repository commit
`1876d74fb86d4e45efade2176b71d776f430e7e6`. JSON is pinned separately
at repository commit `ee35a6ebefcef0c5c416c0d1ccec7370cfca5a24`.
