import type { Node as SyntaxNode } from 'web-tree-sitter';
import type {
  StructuralParseResult,
  StructuralParserPort,
  StructuralRepositoryFile,
} from './structuralRepositoryService';
import type { RepositorySymbolFact } from './contracts';

export const VIBESPACE_TREE_SITTER_LANGUAGES = Object.freeze([
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'rust',
  'python',
  'json',
] as const);

export type VibeSpaceTreeSitterLanguage = (typeof VIBESPACE_TREE_SITTER_LANGUAGES)[number];

export interface WebTreeSitterParserOptions {
  runtimeWasmUrl: string;
  grammarUrls: Readonly<Record<VibeSpaceTreeSitterLanguage, string>>;
  countTokens(text: string): Promise<number>;
  maximumFileBytes?: number;
}

const SYMBOL_TYPES: Readonly<Record<string, RepositorySymbolFact['kind']>> = Object.freeze({
  function_declaration: 'function',
  function_definition: 'function',
  function_item: 'function',
  class_declaration: 'class',
  class_definition: 'class',
  class_specifier: 'class',
  method_definition: 'method',
  method_declaration: 'method',
  interface_declaration: 'type',
  type_alias_declaration: 'type',
  type_item: 'type',
  struct_item: 'type',
  enum_item: 'type',
  trait_item: 'type',
  const_item: 'constant',
});

const IMPORT_TYPES = new Set([
  'import_statement',
  'import_declaration',
  'use_declaration',
  'use_wildcard',
]);

function assertLocalAsset(label: string, value: string): void {
  if (!value || /^(?:https?:)?\/\//i.test(value) || /^data:/i.test(value)) {
    throw new Error(`${label} must be a bundled local asset.`);
  }
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function signatureFor(node: SyntaxNode): string {
  const text = node.text.trim();
  const brace = text.indexOf('{');
  const colonLine = text.indexOf(':\n');
  const boundary = [brace, colonLine].filter((value) => value >= 0).sort((a, b) => a - b)[0];
  return (boundary === undefined ? text.split(/\r?\n/, 1)[0]! : text.slice(0, boundary)).trim();
}

function isExported(node: SyntaxNode): boolean {
  let parent = node.parent;
  while (parent) {
    if (parent.type === 'export_statement') return true;
    if (!['decorated_definition', 'public_field_definition'].includes(parent.type)) break;
    parent = parent.parent;
  }
  return /\b(?:export|pub)\b/.test(node.text.slice(0, 80));
}

function collectFacts(root: SyntaxNode): {
  symbols: RepositorySymbolFact[];
  signatures: string[];
  imports: number;
} {
  const symbols: RepositorySymbolFact[] = [];
  const signatures: string[] = [];
  let imports = 0;
  const visit = (node: SyntaxNode): void => {
    if (IMPORT_TYPES.has(node.type)) imports += 1;
    const kind = SYMBOL_TYPES[node.type];
    if (kind) {
      const name = node.childForFieldName('name')?.text.trim();
      if (name) {
        const resolvedKind =
          kind === 'function' && /^[A-Z]/.test(name) && /(?:jsx|tsx)/.test(root.tree.language.name ?? '')
            ? 'component'
            : kind;
        symbols.push({
          name,
          kind: resolvedKind,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: isExported(node),
        });
        signatures.push(signatureFor(node));
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return { symbols, signatures, imports };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export function createWebTreeSitterParserPort(
  options: WebTreeSitterParserOptions,
): Omit<StructuralParserPort, 'parse'> & {
  parse(file: Readonly<StructuralRepositoryFile>, signal?: AbortSignal): Promise<StructuralParseResult>;
} {
  assertLocalAsset('Tree-sitter runtime', options.runtimeWasmUrl);
  for (const language of VIBESPACE_TREE_SITTER_LANGUAGES) {
    assertLocalAsset(`${language} grammar`, options.grammarUrls[language]);
  }
  const maximumFileBytes = options.maximumFileBytes ?? 2_000_000;
  let runtime: Promise<typeof import('web-tree-sitter')> | undefined;
  const languages = new Map<VibeSpaceTreeSitterLanguage, Promise<import('web-tree-sitter').Language>>();

  const loadRuntime = (): Promise<typeof import('web-tree-sitter')> => {
    runtime ??= import('web-tree-sitter').then(async (module) => {
      await module.Parser.init({ locateFile: () => options.runtimeWasmUrl });
      return module;
    });
    return runtime;
  };

  const loadLanguage = async (language: VibeSpaceTreeSitterLanguage) => {
    let pending = languages.get(language);
    if (!pending) {
      pending = loadRuntime().then(({ Language }) => Language.load(options.grammarUrls[language]));
      languages.set(language, pending);
    }
    return pending;
  };

  return {
    async parse(file, signal) {
      abortIfNeeded(signal);
      if (!VIBESPACE_TREE_SITTER_LANGUAGES.includes(file.language as VibeSpaceTreeSitterLanguage)) {
        throw new Error(`Unsupported Tree-sitter language ${file.language}.`);
      }
      if (new TextEncoder().encode(file.content).byteLength > maximumFileBytes) {
        throw new Error(`Repository file ${file.path} exceeds the structural parse limit.`);
      }
      const module = await loadRuntime();
      const language = await loadLanguage(file.language as VibeSpaceTreeSitterLanguage);
      abortIfNeeded(signal);
      const parser = new module.Parser();
      parser.setLanguage(language);
      const tree = parser.parse(file.content, null, {
        progressCallback: () => signal?.aborted === true,
      });
      if (!tree) {
        parser.delete();
        abortIfNeeded(signal);
        throw new Error(`Tree-sitter could not parse ${file.path}.`);
      }
      try {
        const facts = collectFacts(tree.rootNode);
        const signatureText = facts.signatures.join('\n');
        const metadataText = `${file.path}\n${file.language}\n${facts.symbols
          .map((symbol) => `${symbol.kind}:${symbol.name}`)
          .join('\n')}`;
        const [signatureTokens, metadataTokens, astHash] = await Promise.all([
          options.countTokens(signatureText),
          options.countTokens(metadataText),
          sha256(tree.rootNode.toString()),
        ]);
        abortIfNeeded(signal);
        return {
          path: file.path,
          language: file.language,
          contentHash: file.contentHash,
          signatureTokens: Math.max(metadataTokens, signatureTokens),
          metadataTokens,
          symbols: Object.freeze(facts.symbols),
          incomingReferences: 0,
          outgoingReferences: facts.imports,
          parserId: `web-tree-sitter:${file.language}`,
          parserVersion: String(language.abiVersion),
          astHash,
        };
      } finally {
        tree.delete();
        parser.delete();
      }
    },
  };
}
