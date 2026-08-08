import { ExternalLink } from 'lucide-react';

export type OpenSourceCreditStatus =
  | 'production dependency'
  | 'optional feature pack'
  | 'adapted patterns'
  | 'development tooling'
  | 'deferred benchmark';

export interface OpenSourceCredit {
  name: string;
  repository: string;
  license: string;
  version: string;
  status: OpenSourceCreditStatus;
  contribution: string;
}

export const OPEN_SOURCE_CREDITS: readonly Readonly<OpenSourceCredit>[] = Object.freeze([
  {
    name: 'Tree-sitter',
    repository: 'https://github.com/tree-sitter/tree-sitter',
    license: 'MIT',
    version: 'web-tree-sitter 0.26.11',
    status: 'production dependency',
    contribution: 'Incremental syntax parsing and source-backed repository structure.',
  },
  {
    name: 'Repomix Tree-sitter WASMs',
    repository: 'https://github.com/repomix/tree-sitter-wasms',
    license: 'Unlicense',
    version: '0.1.17',
    status: 'production dependency',
    contribution: 'Pinned local TypeScript, TSX, JavaScript, Rust, and Python grammar assets.',
  },
  {
    name: 'Tree-sitter JSON',
    repository: 'https://github.com/tree-sitter/tree-sitter-json',
    license: 'MIT',
    version: '0.24.8',
    status: 'production dependency',
    contribution: 'Pinned local JSON grammar asset for structural repository evidence.',
  },
  {
    name: 'gpt-tokenizer',
    repository: 'https://github.com/niieani/gpt-tokenizer',
    license: 'MIT',
    version: '3.4.0',
    status: 'production dependency',
    contribution: 'Exact local token counting for explicitly supported OpenAI model families.',
  },
  {
    name: 'Hugging Face Tokenizers',
    repository: 'https://github.com/huggingface/tokenizers.js',
    license: 'Apache-2.0',
    version: '0.1.3',
    status: 'production dependency',
    contribution: 'Local token counting from trusted Qwen, DeepSeek, Llama, and Mistral assets.',
  },
  {
    name: 'OpenTelemetry JavaScript',
    repository: 'https://github.com/open-telemetry/opentelemetry-js',
    license: 'Apache-2.0',
    version: 'API 1.9.1 · trace 2.10.0',
    status: 'production dependency',
    contribution: 'Privacy-safe local traces for request timing, token usage, and failures.',
  },
  {
    name: 'MCP TypeScript SDK',
    repository: 'https://github.com/modelcontextprotocol/typescript-sdk',
    license: 'MIT',
    version: '1.30.0',
    status: 'production dependency',
    contribution:
      'Pinned protocol and transport foundation behind the VibeSpace-owned MCP gateway.',
  },
  {
    name: 'Microsoft Playwright',
    repository: 'https://github.com/microsoft/playwright',
    license: 'Apache-2.0',
    version: '1.61.1',
    status: 'optional feature pack',
    contribution:
      'Isolated browser execution and deterministic browser fixtures without bundling browsers into the default app.',
  },
  {
    name: 'Repomix',
    repository: 'https://github.com/yamadashy/repomix',
    license: 'MIT',
    version: 'c6f084b reference',
    status: 'adapted patterns',
    contribution: 'Git-aware selection, token budgets, structural packing, and inclusion receipts.',
  },
  {
    name: 'Aider',
    repository: 'https://github.com/Aider-AI/aider',
    license: 'Apache-2.0',
    version: '5dc9490 reference',
    status: 'adapted patterns',
    contribution: 'Repository-map ranking, reference centrality, and symbol relevance patterns.',
  },
  {
    name: 'Agent Skills',
    repository: 'https://github.com/agentskills/agentskills',
    license: 'Apache-2.0 / CC-BY-4.0 docs',
    version: '27a9f0c standard reference',
    status: 'adapted patterns',
    contribution: 'Portable SKILL.md packages and progressive disclosure.',
  },
  {
    name: 'Promptfoo',
    repository: 'https://github.com/promptfoo/promptfoo',
    license: 'MIT',
    version: '0.121.20',
    status: 'development tooling',
    contribution: 'Prompt, retrieval, constraint, and injection regression evaluation.',
  },
  {
    name: 'Graphiti',
    repository: 'https://github.com/getzep/graphiti',
    license: 'Apache-2.0',
    version: 'aab852d reference',
    status: 'adapted patterns',
    contribution: 'Temporal current, stale, disputed, and superseded knowledge concepts.',
  },
  {
    name: 'LanceDB',
    repository: 'https://github.com/lancedb/lancedb',
    license: 'Apache-2.0',
    version: 'f79dc01 benchmark reference',
    status: 'deferred benchmark',
    contribution: 'Optional retrieval benchmark; Dexie and Tantivy remain authoritative.',
  },
]);

export function OpenSourceCredits() {
  return (
    <section className="max-w-xl rounded-2xl border border-border bg-elevated/70 p-5 shadow-soft">
      <h3 className="text-ui-strong text-foreground">Open-source credits</h3>
      <p className="mt-1 text-secondary text-muted-foreground">
        VibeSpace keeps its own authority boundaries and adopts only the useful parts of these
        projects. Shipped licenses and exact pins are recorded in the distribution notices.
      </p>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {OPEN_SOURCE_CREDITS.map((credit) => (
          <li key={credit.name} className="rounded-lg border border-border/70 bg-background/40 p-3">
            <a
              href={credit.repository}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center justify-between gap-2 font-medium text-foreground hover:text-accent-cyan"
            >
              {credit.name}
              <ExternalLink className="h-3.5 w-3.5 opacity-70" aria-hidden="true" />
            </a>
            <p className="mt-1 text-metadata text-muted-foreground">{credit.contribution}</p>
            <p className="mt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {credit.status} · {credit.license} · {credit.version}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
