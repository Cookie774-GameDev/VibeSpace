import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TREE_SITTER_ASSETS,
  createDefaultTreeSitterRuntime,
} from './defaultTreeSitterRuntime';

describe('default Tree-sitter runtime', () => {
  it('binds every initial language to a bundled local WASM asset', () => {
    expect(Object.keys(DEFAULT_TREE_SITTER_ASSETS.grammarUrls).sort()).toEqual([
      'javascript',
      'json',
      'jsx',
      'python',
      'rust',
      'tsx',
      'typescript',
    ]);
    for (const url of [
      DEFAULT_TREE_SITTER_ASSETS.runtimeWasmUrl,
      ...Object.values(DEFAULT_TREE_SITTER_ASSETS.grammarUrls),
    ]) {
      expect(url).toMatch(/\.wasm(?:\?|$)/u);
      expect(url).not.toMatch(/^(?:https?:)?\/\//iu);
      expect(url).not.toMatch(/^data:/iu);
    }
  });

  it('constructs lazily without loading a runtime or downloading a grammar', () => {
    const runtime = createDefaultTreeSitterRuntime({
      countTokens: async (text) => text.length,
    });
    expect(runtime).toMatchObject({ parse: expect.any(Function) });
  });
});
