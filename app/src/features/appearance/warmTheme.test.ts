import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../../styles/warm-theme.css'), 'utf8');
const main = readFileSync(resolve(__dirname, '../../main.tsx'), 'utf8');
const chatDecor = readFileSync(resolve(__dirname, '../chat/OrigamiChatDecor.tsx'), 'utf8');
const chatView = readFileSync(resolve(__dirname, '../chat/ChatView.tsx'), 'utf8');
const warmChatWelcome = readFileSync(resolve(__dirname, '../chat/WarmChatWelcome.tsx'), 'utf8');
const filesPage = readFileSync(resolve(__dirname, '../files/FilesPage.tsx'), 'utf8');
const historyPage = readFileSync(resolve(__dirname, '../history/HistoryPage.tsx'), 'utf8');
const kanbanPage = readFileSync(resolve(__dirname, '../kanban/KanbanPage.tsx'), 'utf8');
const schedulePage = readFileSync(resolve(__dirname, '../schedule/SchedulePage.tsx'), 'utf8');
const contextPage = readFileSync(resolve(__dirname, '../context/ContextPage.tsx'), 'utf8');
const benchmarksPage = readFileSync(resolve(__dirname, '../benchmarks/BenchmarksPage.tsx'), 'utf8');
const modelFoundryPage = readFileSync(
  resolve(__dirname, '../model-foundry/BuildYourOwnAIPage.tsx'),
  'utf8',
);
const accountPage = readFileSync(resolve(__dirname, '../account/AccountPage.tsx'), 'utf8');
const launcherDialog = readFileSync(resolve(__dirname, '../launcher/LauncherDialog.tsx'), 'utf8');
const settingsModal = readFileSync(resolve(__dirname, '../settings/SettingsModal.tsx'), 'utf8');
const topBar = readFileSync(resolve(__dirname, '../../components/layout/TopBar.tsx'), 'utf8');
const warmAssetRoot = resolve(__dirname, '../../../public/assets/themes/warm');
const warmReferenceAssetRoot = resolve(warmAssetRoot, 'reference');
const warmHistoryAssetRoot = resolve(warmAssetRoot, 'history');
const warmAgentsAssetRoot = resolve(warmAssetRoot, 'agents');
const warmToolsAssetRoot = resolve(warmAssetRoot, 'tools');
const warmQuickLaunchAssetRoot = resolve(warmAssetRoot, 'quick-launch');

const exactReferenceAssets = [
  ['brand-logo.png', 13_462, '7b992d8c46528baeb0d123fa9f635413e3aa73a77ec6e731d1ee299bfa31e1a9'],
  [
    'chat-notebook.png',
    100_027,
    '305213eef824a04b1ed8a83006dffc37d67fdfe2f75f39532fdb6397642b0f57',
  ],
  [
    'files-stationery.png',
    164_661,
    '9121cb53df4ed256c9260fc6e4064289d6005fd4188a775a701246ee69d15b73',
  ],
  [
    'scheduler-center.png',
    74_158,
    '03681b34b4587423547c23550c1044518031cfe6ca937488f06ca616f39710b3',
  ],
  [
    'scheduler-landscape.jpg',
    40_495,
    'fda60fb99315a1a2a4816a68a5361fe93c99b19ded39456706b0d62aef20b207',
  ],
  ['skills-corner.png', 85_477, '856aa9514f1858baff4f1f174592123d1e17ed7ba8b494656434a7810fedd625'],
  [
    'skills-landscape.jpg',
    69_551,
    '75133117307f3121b18bec4552abfb265957ba5a43f6e01b0550fcb6013d41b4',
  ],
  ['tools-corner.png', 22_968, '143311d2ad5e7e3026391a70062b2e43facf5f6a13a61f0170c08c84f653cb7e'],
  [
    'tools-landscape.jpg',
    39_529,
    '46d26bdfa226a1b56b3a9b3e265d692ae25c8636c2f2d95a4f9c813ffe7895dd',
  ],
  [
    'kanban-checklist.png',
    75_379,
    '7996c901da622357fa841d621a765cde9ef3898cd319a52456ee356f85f8c9e0',
  ],
  [
    'kanban-milestone.png',
    66_060,
    '541b113632edaaff7221349b14446bf47687b6f10f6ccf57b9d199f97bd5de80',
  ],
] as const;

describe('Warm theme presentation contract', () => {
  it('matches the approved standalone Warm palette while preserving canonical shell geometry', () => {
    for (const token of [
      '--warm-shell-950: #2e2720',
      '--warm-shell-900: #332b24',
      '--warm-shell-850: #393129',
      '--warm-shell-800: #40372e',
      '--warm-canvas: #f7ecde',
      '--warm-canvas-mid: #f2e3d1',
      '--warm-canvas-deep: #eedcc8',
      '--warm-surface: #f8ebdd',
      '--warm-surface-raised: #fbf0e3',
      '--warm-text: #3e3026',
      '--warm-text-muted: #775f4c',
      '--warm-terracotta: #d66f49',
      '--warm-terracotta-deep: #c85f3e',
      '--warm-sage: #7e9d72',
      '--warm-gold: #c9984f',
      '--warm-shadow-soft: 0 9px 24px rgb(61 37 20 / 0.09)',
      '--warm-shadow-raised: 0 18px 46px rgb(62 38 22 / 0.12), 0 2px 8px rgb(62 38 22 / 0.08)',
    ]) {
      expect(css).toContain(token);
    }

    expect(css).not.toContain('body:has(');
    expect(css).toMatch(
      /\[data-monochrome-surface='app-shell'\]\s*\{[\s\S]*?var\(--warm-shell-850\)[\s\S]*?var\(--warm-shell-950\)/u,
    );
    expect(css).toMatch(
      /\[data-nav-pane='true'\]\s*\{[\s\S]*?var\(--warm-shell-900\)[\s\S]*?var\(--warm-shell-950\)/u,
    );
    expect(css).not.toMatch(/(?:-webkit-)?mask-image\s*:/u);
    expect(css).not.toMatch(/mix-blend-mode\s*:/u);

    expect(css).toContain('--warm-sidebar-w: 240px');
    expect(css).toContain('--warm-top-h: 40px');
    expect(css).toContain('--warm-tabs-h: 32px');
    expect(css).toMatch(
      /\[data-nav-pane='true'\]\[data-nav-state='expanded'\]\s*\{[\s\S]*?width:\s*var\(--warm-sidebar-w\)\s*!important/u,
    );
    expect(css).toMatch(
      /\[data-nav-pane='true'\]\[data-nav-state='collapsed'\]\s*\{[\s\S]*?width:\s*56px\s*!important/u,
    );
    expect(css).not.toContain('--warm-sidebar-w: 270px');
    expect(css).not.toContain('--warm-sidebar-w: 244px');
    expect(css).not.toContain('--warm-top-h: 62px');
    expect(css).not.toContain('width: min(280px, 30vw) !important');
    expect(css).not.toContain('width: min(260px, 72vw) !important');
    expect(css).not.toContain('height: 52px !important');
  });

  it('is imported once and scoped exclusively to the Warm document theme', () => {
    expect(main.match(/styles\/warm-theme\.css/g)).toHaveLength(1);
    expect(css).toContain("html[data-theme='warm']");
    expect(css).not.toMatch(
      /\[data-theme=['"](?:dark|default|jarvis|monochrome|sakura|vibespace)['"]\]/,
    );
  });

  it('defines the complete centralized Gold Master token foundation', () => {
    for (const token of [
      '--warm-sidebar-w',
      '--warm-top-h',
      '--warm-tabs-h',
      '--warm-dark',
      '--warm-dark-2',
      '--warm-dark-3',
      '--warm-cream',
      '--warm-cream-2',
      '--warm-cream-3',
      '--warm-paper',
      '--warm-ink',
      '--warm-muted',
      '--warm-line',
      '--warm-accent',
      '--warm-accent-2',
      '--warm-display',
      '--warm-sans',
      '--warm-shell-950',
      '--warm-shell-900',
      '--warm-shell-800',
      '--warm-canvas',
      '--warm-surface',
      '--warm-border',
      '--warm-text',
      '--warm-text-muted',
      '--warm-terracotta',
      '--warm-sage',
      '--warm-gold',
      '--warm-radius-card',
      '--warm-shadow-soft',
      '--warm-motion-fast',
    ]) {
      expect(css).toContain(`${token}:`);
    }
    expect(css).toContain('--warm-sidebar-w: 240px');
    expect(css).toContain('--warm-top-h: 40px');
    expect(css).toContain('--warm-tabs-h: 32px');
    expect(css).toContain('--warm-dark: #2e2720');
    expect(css).toContain('--warm-cream: #f7ecde');
    expect(css).toContain('--warm-accent: #d66f49');
  });

  it('covers every required shell, route, and Origami surface using semantic markers', () => {
    for (const marker of [
      "data-monochrome-surface='top-bar'",
      "data-nav-pane='true'",
      "data-monochrome-surface='tab-strip'",
      "data-vibespace-page='chat'",
      "data-monochrome-route='skills'",
      "data-monochrome-route='tools'",
      "data-monochrome-route='files'",
      "data-monochrome-route='kanban'",
      "data-monochrome-route='schedule'",
      "data-vibespace-owned-chrome='voice'",
      "data-monochrome-route='terminal'",
      "data-monochrome-route='benchmarks'",
      "data-monochrome-route='history'",
      "data-monochrome-route='agents'",
      "data-monochrome-route='agent-detail'",
      "data-monochrome-surface='page-router'",
      "data-monochrome-surface='inspector'",
      "data-tour='chat-composer'",
      "data-terminal-drop='pane'",
    ]) {
      expect(css).toContain(`[${marker}]`);
    }
  });

  it('uses only the route-specific Warm asset library and keeps every decorative layer inert', () => {
    for (const asset of [
      'reference/chat-notebook.png',
      'reference/files-stationery.png',
      'reference/kanban-checklist.png',
      'reference/kanban-milestone.png',
      'reference/scheduler-center.png',
      'reference/scheduler-landscape.jpg',
      'reference/skills-corner.png',
      'reference/skills-landscape.jpg',
      'reference/tools-corner.png',
      'reference/tools-landscape.jpg',
    ]) {
      const path = resolve(warmAssetRoot, asset);
      expect(existsSync(path), asset).toBe(true);
    }

    expect(css).toContain('/assets/themes/warm/reference/');
    expect(css).not.toContain('/assets/origami-chat/');
    expect(css).not.toMatch(/url\(\s*['"]?https?:\/\//);
    expect(css).toMatch(/\.warm-chat-welcome\s*\{[\s\S]*?pointer-events:\s*none/u);
    expect(css).toMatch(/feTurbulence/u);
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/u);
  });

  it('ships every supplied reference artwork byte-for-byte', () => {
    for (const [filename, expectedBytes, expectedSha256] of exactReferenceAssets) {
      const path = resolve(warmReferenceAssetRoot, filename);
      expect(existsSync(path), filename).toBe(true);
      const bytes = readFileSync(path);
      expect(bytes.byteLength, filename).toBe(expectedBytes);
      expect(createHash('sha256').update(bytes).digest('hex'), filename).toBe(expectedSha256);
    }
  });

  it('maps one restrained illustration vocabulary to each referenced route', () => {
    const routeAssets = {
      chat: 'reference/chat-notebook.png',
      files: 'final-redo/files-scene-v1.webp',
      kanban: ['reference/kanban-checklist.png', 'reference/kanban-milestone.png'],
      schedule: 'schedule/schedule-shell-scene-v2.webp',
      skills: 'final-redo/skills-scene-v1.webp',
      tools: 'tools/tools-upper-right-landscape-v1.webp',
      agents: 'agents/agents-editor-landscape-v1.webp',
    } as const;

    for (const [route, assets] of Object.entries(routeAssets)) {
      for (const asset of typeof assets === 'string' ? [assets] : assets) {
        expect(`${css}\n${chatDecor}\n${warmChatWelcome}`, `${route} must own ${asset}`).toContain(
          `/assets/themes/warm/${asset}`,
        );
      }
    }

    expect(css).not.toContain('right-flower.webp');
    expect(css).not.toContain('crane.webp');
    expect(css).not.toContain('bottom-mountains.svg');
  });

  it('keeps the Warm benchmark chart readable without route-specific profile scaling', () => {
    expect(css).toMatch(
      /\[data-warm-surface='benchmarks-chart'\]\s+h2\s*\{[\s\S]*?font-size:\s*25px/u,
    );
    expect(css).toMatch(
      /\[data-warm-surface='benchmarks-chart'\]\s+svg\s+text\s*\{[\s\S]*?font-size:\s*15\.6px/u,
    );
    expect(topBar).not.toContain('size={warmBenchmarks ? 36 : 24}');
    expect(topBar).toContain('size={24}');
  });

  it('keeps the Warm Files waterfall crisp behind readable editor surfaces', () => {
    expect(css).toMatch(
      /\[data-monochrome-route='files'\]::before\s*\{[\s\S]*?filter:\s*saturate\(1\.14\)\s+contrast\(1\.14\)/u,
    );
    expect(css).toMatch(
      /\[data-monochrome-route='files'\]\s+\[data-monochrome-surface='files-editor'\]\s*\{[\s\S]*?rgb\(248 235 221 \/ 0\.18\)[\s\S]*?backdrop-filter:\s*none/u,
    );
    expect(css).toMatch(
      /\[data-monochrome-route='files'\]\s+\[data-monochrome-surface='files-editor'\]\s+textarea\s*\{[\s\S]*?rgb\(255 250 243 \/ 0\.2\)[\s\S]*?backdrop-filter:\s*none/u,
    );
  });

  it('keeps the Skills artwork visible behind the existing centered card', () => {
    expect(css).toMatch(
      /\[data-monochrome-surface='skill-detail'\]\s*>\s*div\s*\{[\s\S]*?background:\s*transparent/u,
    );
    expect(css).toMatch(
      /\[data-monochrome-surface='skill-detail'\]\s*>\s*div\s*>\s*div\s*\{[\s\S]*?background:\s*var\(--warm-surface-raised\)/u,
    );
  });

  it('uses canonical solid paper surfaces instead of broad route-level glow gradients', () => {
    for (const selector of [
      'body',
      "main[aria-label='Workspace']",
      "[data-vibespace-page='chat']",
      "[data-monochrome-route='kanban']",
      "[data-monochrome-route='schedule']",
      "[data-monochrome-route='terminal']",
      '.mc7f-account-page',
    ]) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const block = css.match(
        new RegExp(`html\\[data-theme='warm'\\] ${escaped}\\s*\\{([\\s\\S]*?)\\}`, 'u'),
      );
      expect(block, selector).not.toBeNull();
      expect(block?.[1], selector).not.toContain('radial-gradient');
    }

    expect(css).toMatch(
      /html\[data-theme='warm'\]\s+main\[aria-label='Workspace'\]\s*\{[\s\S]*?background:\s*var\(--warm-canvas\)/u,
    );
    expect(css).toMatch(
      /\[data-monochrome-route='kanban'\]\s*\{[\s\S]*?background:\s*var\(--warm-canvas\)/u,
    );
    expect(css).toMatch(
      /\.mc7f-settings-modal\s+\[data-warm-surface='settings-canvas'\]\s*\{[\s\S]*?background:[\s\S]*?#f9edd9/u,
    );
    expect(css).toMatch(
      /\.bg-accent-gradient\s*\{[\s\S]*?background:\s*var\(--warm-terracotta\)\s*!important/u,
    );
  });

  it('limits empty-state artwork to truthful empty production states', () => {
    const historyLandscape = resolve(warmHistoryAssetRoot, 'history-replay-landscape-v1.webp');

    expect(filesPage).toContain("data-warm-state={selectedPath ? 'populated' : 'empty'}");
    expect(kanbanPage).toContain("data-warm-state={items.length === 0 ? 'empty' : 'populated'}");
    expect(schedulePage).toContain('data-warm-state=');
    expect(historyPage).toContain("data-warm-state={selectedChatId ? 'selected' : 'empty'}");
    expect(historyPage).toContain('data-warm-surface="history-replay"');
    expect(schedulePage).toContain("timelineView === 'jarvis'");
    expect(css).toContain("[data-monochrome-surface='files-editor'][data-warm-state='empty']");
    expect(css).toContain("[data-monochrome-surface='kanban-column'][data-warm-state='empty']");
    expect(css).toContain("[data-monochrome-surface='schedule-timeline'][data-warm-state='empty']");
    expect(css).toMatch(
      /\[data-warm-surface='history-replay'\]\s*\{[\s\S]*?history-replay-landscape-v1\.webp'\)\s+center\s+bottom\s*\/\s*100%\s+100%\s+no-repeat/u,
    );
    expect(existsSync(historyLandscape)).toBe(true);
    expect(
      existsSync(historyLandscape) ? readFileSync(historyLandscape).byteLength : 0,
    ).toBeLessThan(150_000);
    expect(
      existsSync(historyLandscape)
        ? createHash('sha256').update(readFileSync(historyLandscape)).digest('hex')
        : '',
    ).toBe('44b2648f47b4176cbcff30e1256e683feae6994c80898109937fc4449bd5cee4');
  });

  it('keeps Warm Kanban empty artwork intact above constrained copy', () => {
    expect(kanbanPage).toContain('data-warm-action="kanban-add"');
    expect(kanbanPage).toContain('data-warm-accent={accent}');
    expect(css).toMatch(
      /\[data-warm-action='kanban-add'\]\[data-warm-accent='copper'\]\s*\{[\s\S]*?background:\s*var\(--warm-terracotta\)\s*!important/u,
    );
    expect(css).toMatch(
      /\[data-warm-action='kanban-add'\]\[data-warm-accent='sage'\]\s*\{[\s\S]*?background:\s*var\(--warm-sage\)\s*!important/u,
    );
    expect(kanbanPage).toContain('data-warm-surface="kanban-empty-copy"');
    expect(css).toMatch(
      /\[data-monochrome-surface='kanban-column'\]\[data-warm-state='empty'\]:first-of-type\s*\{[\s\S]*?kanban-checklist\.png'\)\s+center\s+34%\s*\/\s*auto\s+clamp\(118px,\s*15vh,\s*146px\)\s+no-repeat/u,
    );
    expect(css).toMatch(
      /\[data-monochrome-surface='kanban-column'\]\[data-warm-state='empty'\]:last-of-type\s*\{[\s\S]*?kanban-milestone\.png'\)\s+center\s+34%\s*\/\s*auto\s+clamp\(118px,\s*15vh,\s*146px\)\s+no-repeat/u,
    );
    expect(css).toMatch(
      /\[data-warm-surface='kanban-empty-copy'\]\s*\{[\s\S]*?justify-content:\s*flex-end[\s\S]*?padding:\s*0\s+16px\s+38px[\s\S]*?max-width:\s*390px/u,
    );
    expect(css).toMatch(/\[data-monochrome-route='kanban'\]::before\s*\{[\s\S]*?content:\s*none/u);
    expect(css).not.toContain('final-redo/kanban-scene-v1.webp');
  });

  it('matches the approved Warm empty-chat welcome without the superseded session panel', () => {
    expect(chatView).toContain('Boolean(activeChatId)');
    expect(chatView).toContain('<WarmChatWelcome chatId={String(activeChatId)} />');
    expect(chatView).not.toContain('useChatMessages');
    expect(warmChatWelcome).toContain('Start a conversation');
    expect(warmChatWelcome).toContain('Ask anything, explore ideas, or delegate to an agent.');
    expect(warmChatWelcome).toContain('/assets/themes/warm/reference/chat-notebook.png');
    expect(warmChatWelcome.match(/\btitle:\s*'/gu)).toHaveLength(4);
    expect(warmChatWelcome).toContain("new CustomEvent('jarvis:composer:insert-text'");
    expect(warmChatWelcome).toContain("skillId: 'analyze'");
    expect(warmChatWelcome).toContain("skillId: 'build'");
    expect(warmChatWelcome).toContain("skillId: 'research'");
    expect(css).toMatch(
      /\[data-vibespace-page='chat'\]:has\(\.warm-chat-welcome\)\s+\[data-testid='jarvis-session-panel'\][\s\S]*?display:\s*none/u,
    );
    expect(css).toMatch(
      /\.warm-chat-welcome__art\s*\{[\s\S]*?width:\s*clamp\(190px,\s*16vw,\s*246px\)[\s\S]*?opacity:\s*1/u,
    );
    expect(css).toMatch(
      /\.warm-chat-welcome__content\s*\{[\s\S]*?transform:\s*translateY\(5\.5vh\)/u,
    );
    expect(css).toMatch(
      /\[data-warm-quick-prompt\]\s*\{[\s\S]*?grid-template-columns:\s*42px\s+minmax\(0,\s*1fr\)/u,
    );
    expect(css).toMatch(
      /\[data-tour='chat-composer'\]\s+button\[aria-label='Send message'\]\s*\{[\s\S]*?background:\s*var\(--warm-terracotta\)\s*!important/u,
    );
  });

  it('composes Schedule as one naturally scrolling illustrated shell without a repeated scene', () => {
    const landscape = resolve(warmAssetRoot, 'schedule/schedule-shell-scene-v2.webp');

    expect(existsSync(landscape)).toBe(true);
    expect(existsSync(landscape) ? readFileSync(landscape).byteLength : 0).toBeLessThan(180_000);
    expect(schedulePage).toContain('data-warm-surface="schedule-shell-header"');
    expect(schedulePage).toContain('data-warm-surface="schedule-grid"');
    expect(schedulePage).toContain('data-warm-element="schedule-conversation-chip"');
    expect(schedulePage).toContain('data-warm-surface="schedule-empty-content"');
    expect(schedulePage).toContain('data-warm-action="schedule-save"');
    expect(css).toMatch(
      /\[data-monochrome-route='schedule'\]::before\s*\{[\s\S]*?schedule-shell-scene-v2\.webp'\)\s+center\s*\/\s*cover\s+no-repeat/u,
    );
    const routeBlock = css.match(
      /html\[data-theme='warm'\]\s+\[data-monochrome-route='schedule'\]\s*\{([\s\S]*?)\}/u,
    );
    expect(routeBlock).not.toBeNull();
    expect(routeBlock?.[1]).not.toContain('overflow: hidden');
    expect(routeBlock?.[1]).toContain('overflow-y: auto');
    const scheduleCss = css.slice(
      css.indexOf("html[data-theme='warm'] [data-monochrome-route='schedule']"),
      css.indexOf('/* Jarvis voice'),
    );
    expect(scheduleCss).not.toContain('100% 100%');
    expect(scheduleCss).not.toMatch(
      /\[data-monochrome-surface='schedule-timeline'\]\[data-warm-state='empty'\]\s*\{[\s\S]*?url\(/u,
    );
    expect(css).toMatch(
      /\[data-warm-surface='schedule-grid'\]\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*7fr\)\s+minmax\(360px,\s*3fr\)[\s\S]*?overflow:\s*visible/u,
    );
    expect(css).toMatch(
      /\[data-warm-surface='schedule-empty-content'\]\s*\{[\s\S]*?justify-content:\s*center[\s\S]*?padding:\s*32px/u,
    );
    expect(css).toMatch(
      /\[data-warm-action='schedule-save'\]\s*\{[\s\S]*?background:\s*var\(--warm-terracotta\)\s*!important/u,
    );
    expect(css).toMatch(
      /\[data-monochrome-surface='schedule-editor'\]\s+\.text-accent-cyan\s*\{[\s\S]*?color:\s*var\(--warm-terracotta\)\s*!important/u,
    );
    expect(css).toContain('--warm-schedule-paper: rgb(255 247 236 / 0.55)');
    expect(css).toContain('--warm-schedule-paper-strong: rgb(255 248 238 / 0.62)');
  });

  it('keeps shared Warm chrome at canonical Default geometry without route-specific replacements', () => {
    expect(css).not.toContain("[data-warm-shell-route='benchmarks']");
    expect(css).not.toContain("[data-warm-brand-mark='true']");
    expect(css).toContain('--warm-top-h: 40px');
    expect(css).toContain('--warm-sidebar-w: 240px');
    expect(css).toContain('--warm-tabs-h: 32px');
  });

  it('uses translucent clear paper consistently throughout Warm Settings', () => {
    expect(css).toMatch(
      /\[data-sakura-surface='settings-content'\]\s*\{[\s\S]*?rgb\(251 243 231 \/ 0\.38\)[\s\S]*?backdrop-filter:\s*blur\(2px\)/u,
    );
    expect(css).toMatch(
      /\.mc7f-settings-modal\s+\[role='tabpanel'\]\s+section,[\s\S]*?background:\s*rgb\(255 249 239 \/ 0\.56\)[\s\S]*?backdrop-filter:\s*blur\(3px\)/u,
    );
    expect(css).toMatch(
      /\.mc7f-settings-appearance\s+\[class\*='bg-panel'\]\s*\{[\s\S]*?background-color:\s*rgb\(255 249 239 \/ 0\.52\)\s*!important[\s\S]*?backdrop-filter:\s*blur\(3px\)/u,
    );
  });

  it('composes the Context empty state from lightweight artwork without replacing real controls', () => {
    const contextAssets = [
      'context/context-folder-v1.webp',
      'context/context-file-v1.webp',
      'context/context-repository-v1.webp',
      'context/context-valley-v2.webp',
    ] as const;

    for (const asset of contextAssets) {
      const path = resolve(warmAssetRoot, asset);
      expect(existsSync(path), asset).toBe(true);
      expect(readFileSync(path).byteLength, asset).toBeLessThan(200_000);
      expect(contextPage).toContain(`/assets/themes/warm/${asset}`);
    }

    expect(contextPage).toContain('data-warm-surface="context-hero"');
    expect(contextPage).toContain('data-warm-surface="context-source-card"');
    expect(contextPage).toContain('data-warm-decoration="context-legacy-glow"');
    expect(contextPage).toContain('data-warm-action="context-create"');
    expect(contextPage).toContain('onClick={() => onOpenSource(card.kind)}');
    expect(contextPage).toContain('onClick={onGenerate}');
    expect(css).toMatch(
      /\[data-warm-surface='context-hero'\]\s*\{[\s\S]*?background:\s*var\(--warm-surface-raised\)/u,
    );
    expect(css).toMatch(
      /\[data-warm-action='context-create'\]\s*\{[\s\S]*?background:\s*var\(--warm-terracotta\)\s*!important/u,
    );
  });

  it('uses quiet embedded landscape plates while leaving Kanban scenery-free', () => {
    const plates = {
      files: 'final-redo/files-scene-v1.webp',
      schedule: 'schedule/schedule-shell-scene-v2.webp',
      skills: 'final-redo/skills-scene-v1.webp',
      benchmarks: 'benchmarks/continuation-v2/benchmark-scroll-composite-v2.webp',
      context: 'context/context-valley-v2.webp',
    } as const;

    for (const [route, assets] of Object.entries(plates)) {
      for (const asset of typeof assets === 'string' ? [assets] : assets) {
        const path = resolve(warmAssetRoot, asset);
        expect(existsSync(path), `${route}: ${path}`).toBe(true);
        expect(existsSync(path) ? readFileSync(path).byteLength : 0, route).toBeLessThan(300_000);
        expect(`${css}\n${contextPage}\n${benchmarksPage}`, route).toContain(
          `/assets/themes/warm/${asset}`,
        );
      }
    }

    expect(css).toMatch(
      /\[data-monochrome-route='files'\]::before\s*\{[\s\S]*?files-scene-v1\.webp/u,
    );
    expect(css).not.toContain('/assets/themes/warm/final-redo/kanban-scene-v1.webp');
    expect(css).toMatch(
      /\[data-monochrome-route='schedule'\]::before\s*\{[\s\S]*?schedule-shell-scene-v2\.webp/u,
    );
    expect(css).toMatch(
      /\[data-monochrome-surface='skill-detail'\]::before\s*\{[\s\S]*?skills-scene-v1\.webp/u,
    );
    expect(benchmarksPage).toContain('data-warm-decoration="benchmarks-scene"');
    expect(css).toMatch(
      /\[data-warm-decoration='benchmarks-scene'\]\s*>\s*img\s*\{[\s\S]*?width:\s*100%[\s\S]*?height:\s*auto/u,
    );
    expect(css).not.toMatch(
      /\[data-warm-page='benchmarks'\][\s\S]*?benchmarks-scene-v1\.webp'\)\s+center top\s*\/\s*100%\s+100%/u,
    );
  });

  it('composes Model Foundry as a parchment-owned surface with edge-weighted artwork', () => {
    const landscape = resolve(
      warmAssetRoot,
      'model-foundry/model-foundry-landscape-v3-selected.webp',
    );

    expect(existsSync(landscape)).toBe(true);
    expect(existsSync(landscape) ? readFileSync(landscape).byteLength : 0).toBeLessThan(150_000);
    expect(modelFoundryPage).toContain('data-warm-surface="model-foundry-canvas"');
    expect(modelFoundryPage).toContain('data-warm-surface="model-foundry-content"');
    expect(modelFoundryPage).toContain('data-warm-decoration="model-foundry-scene"');
    expect(css).toMatch(
      /\[data-warm-surface='model-foundry-canvas'\]\s*\{[\s\S]*?--warm-foundry-inset:\s*12px[\s\S]*?position:\s*relative[\s\S]*?padding:\s*var\(--warm-foundry-inset\)\s+var\(--warm-foundry-inset\)\s+0[\s\S]*?background:\s*var\(--warm-shell-950\)/u,
    );
    expect(css).toMatch(
      /\[data-warm-surface='model-foundry-content'\]\s*\{[\s\S]*?position:\s*relative[\s\S]*?isolation:\s*isolate[\s\S]*?overflow:\s*clip[\s\S]*?border-radius:\s*24px\s+24px\s+0\s+0[\s\S]*?background:\s*#f8ead7[\s\S]*?box-shadow:/u,
    );
    expect(css).toMatch(
      /\[data-warm-decoration='model-foundry-scene'\]\s*>\s*img\s*\{[\s\S]*?width:\s*100%[\s\S]*?height:\s*auto/u,
    );
    const modelFoundryArtwork = css.match(
      /\[data-warm-surface='model-foundry-content'\]::before\s*\{([\s\S]*?)\n\}/u,
    )?.[1];
    expect(modelFoundryArtwork).toContain('radial-gradient');
    expect(modelFoundryArtwork).not.toContain('url(');
    expect(modelFoundryArtwork).not.toMatch(/\scover\s/u);
    expect(css).toMatch(
      /\[data-warm-surface='model-foundry-content'\]\s*>\s*:not\(\[data-warm-decoration='model-foundry-scene'\]\)\s*\{[\s\S]*?position:\s*relative[\s\S]*?z-index:\s*2/u,
    );
    expect(css).toMatch(
      /\[data-warm-surface='model-foundry-canvas'\]\s+\[class\*='bg-card'\][\s\S]*?background-color:\s*rgb\(251 239 225 \/ 0\.97\)\s*!important[\s\S]*?backdrop-filter:\s*none/u,
    );
    expect(css).toMatch(
      /\[data-monochrome-surface='app-shell'\]\[data-shell-route='model-foundry'\]\s*\{[\s\S]*?--warm-shell-950:\s*#24150d[\s\S]*?--warm-shell-850:\s*#382317/u,
    );
    expect(css).toMatch(
      /:has\(\[data-warm-surface='model-foundry-canvas'\]\)\s+\[data-pet-overlay='true'\]\s*\{[\s\S]*?display:\s*none\s*!important/u,
    );
  });

  it('keeps the restrained Tools landscape scoped to Tools without fixed wallpaper', () => {
    expect(css).toMatch(
      /data-monochrome-route='tools'[\s\S]*?tools-upper-right-landscape-v1\.webp/u,
    );
    expect(css).not.toMatch(/position:\s*fixed/u);
  });

  it('extends the Warm grammar to settings and every non-reference production route', () => {
    for (const marker of [
      '.mc7f-settings-modal',
      "data-monochrome-route='terminal'",
      "data-monochrome-route='benchmarks'",
      "data-monochrome-route='history'",
      "data-monochrome-route='agents'",
      "data-monochrome-route='agent-detail'",
      "data-monochrome-surface='inspector'",
      "data-monochrome-surface='page-router'",
    ]) {
      expect(css).toContain(marker);
    }
    expect(css).not.toContain("data-monochrome-route='workbench'");
    expect(css).toMatch(
      /\[data-monochrome-surface='agent-editor'\]\s*\{[\s\S]*?agents-editor-landscape-v1\.webp/u,
    );
  });

  it('ships optimized, immutable Agents and Tools landscape plates', () => {
    const assets = [
      [
        resolve(warmAgentsAssetRoot, 'agents-editor-landscape-v1.webp'),
        100_000,
        '134370f3f87f5d44d611ed23ddf4144e2476cc94de7620ca11a7832c186b4e28',
      ],
      [
        resolve(warmToolsAssetRoot, 'tools-upper-right-landscape-v1.webp'),
        65_000,
        'dc9361efc20482acc2b3ff73b0a4ca2ec4c7c13f07eb1d3c5ec0f7c57e93ff7c',
      ],
    ] as const;

    for (const [path, maxBytes, expectedHash] of assets) {
      expect(existsSync(path), path).toBe(true);
      const bytes = readFileSync(path);
      expect(bytes.byteLength).toBeLessThan(maxBytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(expectedHash);
    }
  });

  it('keeps one stable approved scenic surface mounted across all five account tabs', () => {
    const sceneAsset = resolve(
      warmAssetRoot,
      'account-center/account-lake-panorama-v3-extended-selected.webp',
    );
    expect(existsSync(sceneAsset)).toBe(true);
    const sceneBytes = readFileSync(sceneAsset);
    expect(sceneBytes.byteLength).toBeLessThan(125_000);
    expect(createHash('sha256').update(sceneBytes).digest('hex')).toBe(
      '9bb27b8905f2903113f19f3db9b55a6fc0f31135d0b9fb7f5bc40369831feaa6',
    );

    expect(accountPage).toContain('data-warm-surface="account-scene-shell"');
    expect(accountPage).toContain('data-warm-decoration="account-shared-scene"');
    expect(accountPage).toContain('className="pointer-events-none absolute inset-0 hidden');
    expect(accountPage).toContain(
      '/assets/themes/warm/account-center/account-lake-panorama-v3-extended-selected.webp',
    );
    expect(accountPage).toContain('aria-hidden="true"');
    expect(accountPage).toContain('data-warm-account-tab={tab}');
    expect(css).toMatch(
      /\[data-warm-decoration='account-shared-scene'\]\s*>\s*img\s*\{[\s\S]*?width:\s*100%[\s\S]*?height:\s*100%[\s\S]*?object-fit:\s*cover[\s\S]*?object-position:\s*top center/u,
    );
    expect(css).not.toMatch(
      /\.mc7f-account-page\[data-warm-account-tab='pets'\]\s+\[data-sakura-surface='account-hero'\]\s*\{[\s\S]*?display:\s*none/u,
    );
    expect(css).toMatch(/\.mc7f-account-page\s+\[data-sakura-surface='account-hero'\]\s+(?:h1|p)/u);
    expect(css).toContain('.border-white\\/20');
    expect(accountPage).toContain('warmSurface="profile"');
    expect(accountPage).toContain('data-warm-surface={warmSurface}');
    expect(css).toMatch(
      /\[data-warm-surface='account-scene-shell'\]\s*\{[\s\S]*?width:\s*calc\(100%\s*-\s*56px\)[\s\S]*?max-width:\s*none[\s\S]*?isolation:\s*isolate/u,
    );
    expect(css).toMatch(
      /\.mc7f-account-page\s+\[data-sakura-surface='account-hero'\]\s*\{[\s\S]*?min-height:\s*198px[\s\S]*?border:\s*0/u,
    );
    expect(css).toMatch(
      /\.mc7f-account-page\s+\[data-sakura-surface='account-tabs'\]\s*\{[\s\S]*?min-height:\s*54px/u,
    );
  });

  it('keeps the Warm benchmark data compact and left-weighted so the right landscape stays visible', () => {
    expect(css).toMatch(
      /\[data-warm-surface='benchmarks-filters'\]\s*\{[\s\S]*?width:\s*min\(72%,\s*1040px\)/u,
    );
    expect(css).toMatch(
      /\[data-warm-surface='benchmarks-chart'\]\s*\{[\s\S]*?width:\s*min\(72%,\s*1040px\)/u,
    );
    expect(css).toMatch(
      /\[data-monochrome-surface='benchmarks-table'\]\s*\{[\s\S]*?width:\s*min\(72%,\s*1040px\)/u,
    );
    expect(css).toMatch(
      /\[data-monochrome-surface='benchmarks-table'\][\s\S]*?:is\(th,\s*td\)\s*\{[\s\S]*?height:\s*26px[\s\S]*?padding:\s*3px 9px/u,
    );
    expect(css).toMatch(
      /\[data-warm-table-mode='compact-scroll'\][\s\S]*?\[data-warm-region='benchmarks-table-scroll'\]\s*\{[\s\S]*?max-height:\s*min\(54vh,\s*520px\)/u,
    );
  });

  it('carries warm scenic-glass depth into account and settings cards', () => {
    expect(css).toMatch(
      /\.mc7f-account-page\s+\.sakura-account-panel\s*\{[\s\S]*?rgb\(255\s+249\s+239\s*\/\s*0\.76\)[\s\S]*?backdrop-filter:\s*blur\(10px\)/u,
    );
    expect(css).toMatch(
      /\.mc7f-settings-modal\s+\[data-sakura-surface='settings-content'\]\s+\[class\*='rounded-'\]\[class\*='border-border'\]\s*\{[\s\S]*?rgb\(255\s+249\s+239\s*\/\s*0\.52\)[\s\S]*?backdrop-filter:\s*blur\(3px\)/u,
    );
  });

  it('keeps the populated Quick Launch stationery unobstructed in a reserved grid slot', () => {
    expect(launcherDialog).toContain('data-warm-surface="quick-launch-dialog"');
    expect(launcherDialog).toContain('data-warm-surface="quick-launch-grid"');
    expect(launcherDialog).toContain('data-warm-surface="quick-launch-tile"');
    expect(launcherDialog).toContain('data-warm-surface="quick-launch-icon"');
    expect(launcherDialog).toContain('data-warm-surface="quick-launch-art-slot"');
    expect(launcherDialog).toContain('data-warm-surface="quick-launch-art"');
    expect(launcherDialog).toContain(
      '/assets/themes/warm/quick-launch/coffee-stationery-darker.png',
    );
    expect(css).toMatch(
      /\[data-warm-surface='quick-launch-dialog'\]\s*\{[\s\S]*?width:\s*min\(1240px,\s*calc\(100vw\s*-\s*var\(--warm-sidebar-w\)\s*-\s*48px\)\)[\s\S]*?height:\s*min\(770px,\s*calc\(100vh\s*-\s*120px\)\)/u,
    );
    expect(css).toMatch(
      /\[data-warm-surface='quick-launch-art-slot'\]\s*\{[\s\S]*?grid-column:\s*4\s*\/\s*span\s+2[\s\S]*?grid-row:\s*2\s*\/\s*span\s+2[\s\S]*?background:\s*transparent[\s\S]*?border-color:\s*transparent[\s\S]*?box-shadow:\s*none[\s\S]*?backdrop-filter:\s*none/u,
    );
    expect(css).toMatch(
      /\[data-warm-surface='quick-launch-art'\]\s*\{[\s\S]*?object-fit:\s*contain[\s\S]*?filter:\s*none/u,
    );
    expect(css).not.toMatch(
      /\[data-warm-surface='quick-launch-grid'\]\s*\{[\s\S]*?url\([^)]*files-stationery\.png/u,
    );
    expect(css).toMatch(
      /\[data-warm-surface='quick-launch-tile'\]\s*\{[\s\S]*?background:\s*var\(--warm-launcher-tile,\s*var\(--warm-surface-raised\)\)\s*!important/u,
    );
    expect(css).toMatch(
      /\[data-warm-surface='quick-launch-tile'\]\s+button\s*\{[\s\S]*?color:\s*var\(--warm-ink\)\s*!important/u,
    );

    const asset = readFileSync(resolve(warmQuickLaunchAssetRoot, 'coffee-stationery-darker.png'));
    expect(asset.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(asset.readUInt32BE(16)).toBeGreaterThanOrEqual(1000);
    expect(asset.readUInt32BE(20)).toBeGreaterThanOrEqual(1000);
    expect(asset[25]).toBe(6);
  });

  it('composes every Warm Settings page on one stable illustrated parchment shell', () => {
    const sceneAsset = resolve(warmAssetRoot, 'settings/settings-landscape-v4-selected.webp');
    expect(existsSync(sceneAsset)).toBe(true);
    const sceneBytes = readFileSync(sceneAsset);
    expect(sceneBytes.byteLength).toBeLessThan(125_000);
    expect(createHash('sha256').update(sceneBytes).digest('hex')).toBe(
      '1356231d64d39b2933979dcf7a2c71332667de510ac77959166c73e8d08a3c8e',
    );
    expect(settingsModal).toContain('data-warm-surface="settings-canvas"');
    expect(settingsModal).toContain('data-warm-decoration="settings-scene-left"');
    expect(settingsModal).toContain('data-warm-decoration="settings-scene-right"');
    expect(settingsModal).toContain('data-warm-decoration="settings-wash"');
    expect(settingsModal).toContain(
      '/assets/themes/warm/settings/settings-landscape-v4-selected.webp',
    );
    expect(settingsModal).toContain('data-warm-settings-tab={tab}');
    expect(settingsModal).toContain('onOpenAutoFocus={(event) =>');
    expect(settingsModal).toContain('document.getElementById(`settings-tab-${tab}`)?.focus()');
    expect(css).toMatch(
      /:has\(\.mc7f-settings-modal\)\s+\[data-pet-overlay='true'\]\s*\{[\s\S]*?display:\s*none\s*!important/u,
    );
    expect(css).toMatch(
      /\[data-warm-decoration='settings-scene-left'\]\s*>\s*img,\s*[\s\S]*?\[data-warm-decoration='settings-scene-right'\]\s*>\s*img\s*\{[\s\S]*?width:\s*1152px[\s\S]*?height:\s*auto/u,
    );
    expect(css).toMatch(
      /\[data-warm-surface='settings-canvas'\]\s*\{[\s\S]*?grid-template-columns:\s*255px\s+minmax\(0,\s*1fr\)[\s\S]*?background:[\s\S]*?#f9edd9/u,
    );
    expect(css).toMatch(
      /\[data-warm-decoration='settings-wash'\]\s*\{[\s\S]*?radial-gradient[\s\S]*?linear-gradient/u,
    );
    expect(css).toMatch(
      /\.mc7f-settings-modal\s+\[data-sakura-surface='settings-navigation'\]\s+nav\s+button\s*\{[\s\S]*?color:\s*var\(--warm-text-muted\)\s*!important/u,
    );
    expect(css).toMatch(
      /\.mc7f-settings-modal\s+\[data-sakura-surface='settings-navigation'\]\s+nav\s+button:hover\s*\{[\s\S]*?color:\s*var\(--warm-text-strong\)\s*!important/u,
    );
    expect(css).toMatch(
      /\[data-sakura-surface='settings-content'\]\s+\[role='tabpanel'\]\s+>\s+:first-child\s*\{[\s\S]*?max-width:\s*735px[\s\S]*?margin-inline:\s*0/u,
    );
  });

  it('preserves message and terminal payload readability', () => {
    expect(css).not.toMatch(
      /data-vibespace-page='chat'[^{,]*(?:\bp\b|\bpre\b|\bcode\b|\bblockquote\b|\btable\b)/u,
    );
    expect(css).not.toMatch(
      /data-monochrome-route='terminal'[^{,]*(?:\.xterm-rows|\.xterm-helper-textarea)/u,
    );
  });
});
