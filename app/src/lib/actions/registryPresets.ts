/**
 * Expanded Jarvis action catalogue — preset shortcuts the AI and user can
 * invoke without authoring a custom tool first.
 *
 * Merged into `getBuiltinActions()` alongside the hand-authored core set.
 */
import {
  Bot,
  Calendar,
  Files,
  HardDriveDownload,
  Keyboard,
  Layers,
  Mic,
  Moon,
  Palette,
  Phone,
  PlayCircle,
  Sparkles,
  Terminal as TerminalIcon,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useUIStore, type Route } from '@/stores/ui';
import { enqueueTerminalCommand } from '@/features/terminals/terminalCommandQueue';
import type { ActionDef } from './types';
import type { SettingsTab } from '@/features/settings/settingsPrefetch';

const ok = (summary: string, data?: unknown) => ({ ok: true as const, summary, data });

function navigateTo(route: Route): void {
  useUIStore.getState().setRoute(route);
}

function dispatchAfterCommit(name: string, detail?: unknown): void {
  setTimeout(() => window.dispatchEvent(new CustomEvent(name, { detail })), 0);
}

function makeNavAction(id: string, label: string, route: Route, icon: LucideIcon): ActionDef {
  return {
    id,
    category: 'navigation',
    label,
    description: `Switch the workspace canvas to the ${route} page.`,
    icon,
    params: [],
    run: async () => {
      navigateTo(route);
      return ok(`Opened ${label.replace(/^Open\s+/i, '')}.`);
    },
  };
}

function makeSettingsTabAction(id: string, label: string, tab: SettingsTab, icon: LucideIcon): ActionDef {
  return {
    id,
    category: 'settings',
    label,
    description: `Open Settings on the ${label.replace(/^Open Settings → /, '')} tab.`,
    icon,
    params: [],
    run: async () => {
      useUIStore.getState().setSettingsOpen(true);
      dispatchAfterCommit('jarvis:settings:tab', { tab });
      return ok(`Opened Settings → ${tab}.`);
    },
  };
}

function makeTerminalCommandAction(
  id: string,
  label: string,
  command: string,
  description: string,
): ActionDef {
  return {
    id,
    category: 'terminal',
    label,
    description,
    icon: PlayCircle,
    destructive: true,
    params: [
      {
        key: 'cwd',
        label: 'Working directory',
        type: 'string',
        help: 'Optional folder to cd into before running the command.',
      },
    ],
    run: async (params) => {
      const cwd = typeof params.cwd === 'string' ? params.cwd.trim() : undefined;
      enqueueTerminalCommand({ command, label: command.split(/\s+/)[0] ?? command, cwd });
      navigateTo('terminal');
      return ok(`Queued ${label.toLowerCase()}${cwd ? ` in ${cwd}` : ''}.`);
    },
  };
}

/** Routes missing from the core navigation table. */
export const EXTRA_NAVIGATION_ACTIONS: ActionDef[] = [
  makeNavAction('nav.schedule', 'Open Schedule', 'schedule', Calendar),
  makeNavAction('nav.agents', 'Open Agents', 'agents', Bot),
  makeNavAction('nav.files', 'Open Files', 'files', Files),
  makeNavAction('nav.account', 'Open Account', 'account', Sparkles),
];

/** One-click Settings tabs beyond providers/plans. */
export const EXTRA_SETTINGS_ACTIONS: ActionDef[] = [
  makeSettingsTabAction('settings.account', 'Open Settings → Account', 'account', Sparkles),
  makeSettingsTabAction('settings.plugins', 'Open Settings → Plugins', 'plugins', Wrench),
  makeSettingsTabAction('settings.localmodels', 'Open Settings → Local Models', 'localmodels', HardDriveDownload),
  makeSettingsTabAction('settings.appearance', 'Open Settings → Appearance', 'appearance', Palette),
  makeSettingsTabAction('settings.voice', 'Open Settings → Voice', 'voice', Mic),
  makeSettingsTabAction('settings.phone', 'Open Settings → Phone & Voice', 'phone', Phone),
  makeSettingsTabAction('settings.ambient', 'Open Settings → Ambient', 'ambient', Moon),
  makeSettingsTabAction('settings.notifications', 'Open Settings → Notifications', 'notifications', Sparkles),
  makeSettingsTabAction('settings.accessibility', 'Open Settings → Accessibility', 'accessibility', Sparkles),
  makeSettingsTabAction('settings.hotkeys', 'Open Settings → Hotkeys', 'hotkeys', Keyboard),
  makeSettingsTabAction('settings.about', 'Open Settings → About', 'about', Sparkles),
];

/** Shell shortcuts surfaced as first-class actions. */
export const SHELL_ACTIONS: ActionDef[] = [
  {
    id: 'actions.openPalette',
    category: 'host',
    label: 'Open actions palette',
    description: 'Open the Jarvis actions palette (same as Mod+Shift+A).',
    icon: Zap,
    params: [],
    run: async () => {
      useUIStore.getState().setActionsPaletteOpen(true);
      return ok('Opened the actions palette.');
    },
  },
  {
    id: 'tools.open',
    category: 'navigation',
    label: 'Open custom tools editor',
    description: 'Open the Custom Tools page where you author saved Jarvis commands.',
    icon: Wrench,
    params: [],
    run: async () => {
      navigateTo('tools');
      return ok('Opened Custom Tools.');
    },
  },
  {
    id: 'inspector.toggle',
    category: 'chat',
    label: 'Toggle inspector panel',
    description: 'Show or hide the right-hand inspector panel.',
    icon: Layers,
    params: [],
    run: async () => {
      const ui = useUIStore.getState();
      const next = !ui.inspectorOpen;
      useUIStore.setState({ inspectorOpen: next });
      return ok(next ? 'Opened inspector.' : 'Closed inspector.');
    },
  },
];

const TERMINAL_COMMAND_PRESETS: Array<{
  suffix: string;
  command: string;
  label: string;
  description: string;
}> = [
  { suffix: 'gitStatus', command: 'git status', label: 'Git status', description: 'Run git status in a new terminal pane.' },
  { suffix: 'gitPull', command: 'git pull', label: 'Git pull', description: 'Run git pull in a new terminal pane.' },
  { suffix: 'gitPush', command: 'git push', label: 'Git push', description: 'Run git push in a new terminal pane.' },
  { suffix: 'npmInstall', command: 'npm install', label: 'npm install', description: 'Install npm dependencies in a new terminal pane.' },
  { suffix: 'npmTest', command: 'npm test', label: 'npm test', description: 'Run npm test in a new terminal pane.' },
  { suffix: 'npmRunDev', command: 'npm run dev', label: 'npm run dev', description: 'Start the dev server in a new terminal pane.' },
  { suffix: 'npmRunBuild', command: 'npm run build', label: 'npm run build', description: 'Run the production build in a new terminal pane.' },
  { suffix: 'npmRunLint', command: 'npm run lint', label: 'npm run lint', description: 'Run the linter in a new terminal pane.' },
  { suffix: 'pnpmInstall', command: 'pnpm install', label: 'pnpm install', description: 'Install dependencies with pnpm.' },
  { suffix: 'pnpmDev', command: 'pnpm dev', label: 'pnpm dev', description: 'Start pnpm dev in a new terminal pane.' },
  { suffix: 'pnpmTest', command: 'pnpm test', label: 'pnpm test', description: 'Run pnpm test in a new terminal pane.' },
  { suffix: 'yarnDev', command: 'yarn dev', label: 'yarn dev', description: 'Start yarn dev in a new terminal pane.' },
  { suffix: 'bunDev', command: 'bun dev', label: 'bun dev', description: 'Start bun dev in a new terminal pane.' },
  { suffix: 'cargoTest', command: 'cargo test', label: 'cargo test', description: 'Run cargo test in a new terminal pane.' },
  { suffix: 'cargoRun', command: 'cargo run', label: 'cargo run', description: 'Run cargo run in a new terminal pane.' },
  { suffix: 'goTest', command: 'go test ./...', label: 'go test', description: 'Run go test ./... in a new terminal pane.' },
  { suffix: 'pytest', command: 'pytest', label: 'pytest', description: 'Run pytest in a new terminal pane.' },
  { suffix: 'pythonVenv', command: 'python --version', label: 'Check Python version', description: 'Print the Python version in a new terminal pane.' },
  { suffix: 'dockerPs', command: 'docker ps', label: 'docker ps', description: 'List running Docker containers.' },
  { suffix: 'dockerComposeUp', command: 'docker compose up', label: 'docker compose up', description: 'Start docker compose in a new terminal pane.' },
  { suffix: 'kubectlGetPods', command: 'kubectl get pods', label: 'kubectl get pods', description: 'List Kubernetes pods in a new terminal pane.' },
  { suffix: 'ollamaList', command: 'ollama list', label: 'ollama list', description: 'List installed Ollama models.' },
  { suffix: 'ollamaServe', command: 'ollama serve', label: 'ollama serve', description: 'Start the Ollama daemon in a new terminal pane.' },
  { suffix: 'codeDot', command: 'code .', label: 'Open VS Code here', description: 'Open Visual Studio Code in the current folder.' },
  { suffix: 'cursorDot', command: 'cursor .', label: 'Open Cursor here', description: 'Open Cursor in the current folder.' },
  { suffix: 'clear', command: 'clear', label: 'Clear terminal', description: 'Clear the screen in a new terminal pane.' },
  { suffix: 'ls', command: 'ls', label: 'List directory (ls)', description: 'List files in a new terminal pane.' },
  { suffix: 'dir', command: 'dir', label: 'List directory (dir)', description: 'List files on Windows in a new terminal pane.' },
  { suffix: 'pwsh', command: 'pwsh', label: 'Open PowerShell', description: 'Start PowerShell in a new terminal pane.' },
  { suffix: 'bash', command: 'bash', label: 'Open Bash', description: 'Start Bash in a new terminal pane.' },
  { suffix: 'htop', command: 'htop', label: 'htop', description: 'Launch htop in a new terminal pane.' },
  { suffix: 'npmAudit', command: 'npm audit', label: 'npm audit', description: 'Run npm audit in a new terminal pane.' },
  { suffix: 'npmOutdated', command: 'npm outdated', label: 'npm outdated', description: 'Check outdated npm packages.' },
  { suffix: 'tsc', command: 'npx tsc --noEmit', label: 'Typecheck (tsc)', description: 'Run TypeScript typecheck in a new terminal pane.' },
  { suffix: 'vitest', command: 'npx vitest run', label: 'Run vitest', description: 'Run vitest in a new terminal pane.' },
  { suffix: 'eslint', command: 'npx eslint .', label: 'Run eslint', description: 'Run eslint in a new terminal pane.' },
  { suffix: 'prettier', command: 'npx prettier --check .', label: 'Run prettier check', description: 'Run prettier --check in a new terminal pane.' },
  { suffix: 'gradleTest', command: './gradlew test', label: 'Gradle test', description: 'Run Gradle tests in a new terminal pane.' },
  { suffix: 'mavenTest', command: 'mvn test', label: 'Maven test', description: 'Run Maven tests in a new terminal pane.' },
  { suffix: 'composerInstall', command: 'composer install', label: 'composer install', description: 'Run composer install in a new terminal pane.' },
  { suffix: 'mixTest', command: 'mix test', label: 'mix test', description: 'Run Elixir mix test in a new terminal pane.' },
  { suffix: 'railsServer', command: 'bin/rails server', label: 'Rails server', description: 'Start the Rails server in a new terminal pane.' },
  { suffix: 'djangoRunserver', command: 'python manage.py runserver', label: 'Django runserver', description: 'Start Django runserver in a new terminal pane.' },
  { suffix: 'flutterRun', command: 'flutter run', label: 'flutter run', description: 'Run flutter run in a new terminal pane.' },
  { suffix: 'expoStart', command: 'npx expo start', label: 'Expo start', description: 'Start Expo in a new terminal pane.' },
  { suffix: 'terraformPlan', command: 'terraform plan', label: 'terraform plan', description: 'Run terraform plan in a new terminal pane.' },
  { suffix: 'ansiblePing', command: 'ansible all -m ping', label: 'ansible ping', description: 'Run ansible ping in a new terminal pane.' },
  { suffix: 'make', command: 'make', label: 'make', description: 'Run make in a new terminal pane.' },
  { suffix: 'cmake', command: 'cmake --build .', label: 'cmake build', description: 'Run cmake --build in a new terminal pane.' },
  { suffix: 'denoTask', command: 'deno task', label: 'deno task', description: 'Run deno task in a new terminal pane.' },
  { suffix: 'supabaseStart', command: 'npx supabase start', label: 'Supabase start', description: 'Start local Supabase in a new terminal pane.' },
  { suffix: 'vercelDev', command: 'npx vercel dev', label: 'Vercel dev', description: 'Start Vercel dev in a new terminal pane.' },
  { suffix: 'netlifyDev', command: 'npx netlify dev', label: 'Netlify dev', description: 'Start Netlify dev in a new terminal pane.' },
  { suffix: 'stripeListen', command: 'stripe listen', label: 'Stripe listen', description: 'Run stripe listen in a new terminal pane.' },
  { suffix: 'ghPrList', command: 'gh pr list', label: 'GitHub PR list', description: 'List open pull requests with gh.' },
  { suffix: 'ghIssueList', command: 'gh issue list', label: 'GitHub issue list', description: 'List GitHub issues with gh.' },
];

export const TERMINAL_PRESET_ACTIONS: ActionDef[] = TERMINAL_COMMAND_PRESETS.map((preset) =>
  makeTerminalCommandAction(
    `terminal.preset.${preset.suffix}`,
    preset.label,
    preset.command,
    preset.description,
  ),
);

/** Quick bulk-open aliases for common swarm sizes. */
export const TERMINAL_BULK_PRESETS: ActionDef[] = [2, 3, 4, 5, 6, 8, 10].map((count) => ({
  id: `terminal.bulkOpen.${count}`,
  category: 'terminal' as const,
  label: `Open ${count} terminal panes`,
  description: `Open ${count} new terminal panes in the active project context. Optionally run the same startup command in each.`,
  icon: TerminalIcon,
  destructive: true,
  params: [
    {
      key: 'command',
      label: 'Startup command',
      type: 'string' as const,
      help: 'Optional command for every new pane (e.g. opencode, claude, npm run dev).',
    },
    {
      key: 'cwd',
      label: 'Working directory',
      type: 'string' as const,
      help: 'Optional folder for every pane. Omit to use the chat project folder when known.',
    },
  ],
  run: async (params: Record<string, unknown>) => {
    const command = typeof params.command === 'string' ? params.command.trim() : '';
    const cwd = typeof params.cwd === 'string' ? params.cwd.trim() : undefined;
    for (let i = 0; i < count; i++) {
      enqueueTerminalCommand({
        command,
        label: command ? `${command} ${i + 1}` : `terminal ${i + 1}`,
        cwd,
      });
    }
    navigateTo('terminal');
    return ok(
      `Opening ${count} terminal pane${count === 1 ? '' : 's'}${command ? ` with ${command}` : ''}.`,
    );
  },
}));

export const PRESET_ACTIONS: ActionDef[] = [
  ...EXTRA_NAVIGATION_ACTIONS,
  ...EXTRA_SETTINGS_ACTIONS,
  ...SHELL_ACTIONS,
  ...TERMINAL_PRESET_ACTIONS,
  ...TERMINAL_BULK_PRESETS,
];

export const PRESET_ACTION_COUNT = PRESET_ACTIONS.length;
