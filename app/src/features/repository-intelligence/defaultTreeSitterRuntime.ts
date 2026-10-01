import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
import runtimeWasmUrl from 'web-tree-sitter/web-tree-sitter.wasm?url';
import javascriptWasmUrl from '@repomix/tree-sitter-wasms/out/tree-sitter-javascript.wasm?url';
import pythonWasmUrl from '@repomix/tree-sitter-wasms/out/tree-sitter-python.wasm?url';
import rustWasmUrl from '@repomix/tree-sitter-wasms/out/tree-sitter-rust.wasm?url';
import tsxWasmUrl from '@repomix/tree-sitter-wasms/out/tree-sitter-tsx.wasm?url';
import typescriptWasmUrl from '@repomix/tree-sitter-wasms/out/tree-sitter-typescript.wasm?url';
import jsonWasmUrl from 'tree-sitter-json/tree-sitter-json.wasm?url';
import {
  createWebTreeSitterParserPort,
  type WebTreeSitterParserOptions,
} from './webTreeSitterParser';

export type DefaultTreeSitterAssetManifest = Readonly<
  Pick<WebTreeSitterParserOptions, 'runtimeWasmUrl' | 'grammarUrls'>
>;

export const DEFAULT_TREE_SITTER_ASSETS: DefaultTreeSitterAssetManifest = Object.freeze({
  runtimeWasmUrl,
  grammarUrls: Object.freeze({
    typescript: typescriptWasmUrl,
    tsx: tsxWasmUrl,
    javascript: javascriptWasmUrl,
    jsx: javascriptWasmUrl,
    rust: rustWasmUrl,
    python: pythonWasmUrl,
    json: jsonWasmUrl,
  }),
});

export function createDefaultTreeSitterRuntime(
  overrides: Partial<
    Pick<WebTreeSitterParserOptions, 'countTokens' | 'maximumFileBytes'>
  > = {},
) {
  return createWebTreeSitterParserPort({
    ...DEFAULT_TREE_SITTER_ASSETS,
    countTokens: overrides.countTokens ?? (async (text) => countTokens(text)),
    maximumFileBytes: overrides.maximumFileBytes ?? 128 * 1024,
  });
}
