import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  createWebTreeSitterParserPort,
  VIBESPACE_TREE_SITTER_LANGUAGES,
} from './webTreeSitterParser';

const require = createRequire(import.meta.url);

describe('web Tree-sitter parser contract', () => {
  it('pins the initial production language rollout without claiming unsupported grammars', () => {
    expect(VIBESPACE_TREE_SITTER_LANGUAGES).toEqual([
      'typescript',
      'tsx',
      'javascript',
      'jsx',
      'rust',
      'python',
      'json',
    ]);
  });

  it('loads the pinned local WASM runtime and extracts source-backed symbols', async () => {
    const grammarRoot = join(
      dirname(require.resolve('@repomix/tree-sitter-wasms/package.json')),
      'out',
    );
    const grammar = (name: string) => join(grammarRoot, `tree-sitter-${name}.wasm`);
    const parser = createWebTreeSitterParserPort({
      runtimeWasmUrl: require.resolve('web-tree-sitter/web-tree-sitter.wasm'),
      grammarUrls: {
        typescript: grammar('typescript'),
        tsx: grammar('tsx'),
        javascript: grammar('javascript'),
        jsx: grammar('javascript'),
        rust: grammar('rust'),
        python: grammar('python'),
        json: require.resolve('tree-sitter-json/tree-sitter-json.wasm'),
      },
      countTokens: async (text) => Math.max(1, text.split(/\s+/).filter(Boolean).length),
    });

    await expect(
      parser.parse({
        path: 'src/auth.ts',
        language: 'typescript',
        content: 'export function authenticate(user: string): boolean { return !!user; }',
        contentHash: 'hash-1',
        fullTokens: 30,
        trusted: true,
        ignored: false,
        generated: false,
        secretRisk: false,
      }),
    ).resolves.toMatchObject({
      path: 'src/auth.ts',
      parserId: 'web-tree-sitter:typescript',
      symbols: [{ name: 'authenticate', kind: 'function', exported: true }],
    });
  });
});
