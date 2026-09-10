import { APP_ROUTES, type Route } from '@/features/navigation/routeSchema';
import type { SettingsTab } from '@/features/settings/settingsPrefetch';
import type {
  CatalogMatch,
  CatalogParseResult,
  CommandAvailability,
  CommandSafety,
} from '../catalogTypes';
import {
  CONNECT_PROVIDER_FOCUS_IDS,
  parseProviderConnectionTarget,
} from '../providerConnectionEntrypoint';

export type NavigationCommandInput = Readonly<{
  id: string;
  aliases: readonly string[];
  authority: string;
  safety: CommandSafety;
  availability: CommandAvailability;
  slotGrammar?: 'none' | 'remainder';
  parseSlots?: (match: CatalogMatch, source: string) => CatalogParseResult;
}>;

const ROUTE_ALIASES = {
  chat: ['open chat', 'open chat page', 'go to chat'],
  canvas: ['open canvas', 'open canvas page', 'open whiteboard'],
  workbench: ['open workbench', 'open workbench page'],
  preview: ['open preview', 'open preview page'],
  browser: ['open browser', 'open browser page'],
  terminal: ['open terminal page', 'open terminals'],
  kanban: ['open kanban', 'open kanban page', 'open tasks board'],
  schedule: ['open schedule', 'open schedule page', 'open calendar'],
  ade: ['open ADE', 'open ADE page', 'open agent development environment'],
  agents: ['open agents', 'open agents page'],
  'model-foundry': ['open model foundry', 'open model foundry page'],
  'agent-detail': ['open selected agent', 'open agent detail page'],
  'project-detail': ['open selected project', 'open project detail page'],
  context: ['open context', 'open context page', 'open context gateway'],
  skills: ['open skills', 'open skills page'],
  benchmarks: ['open benchmarks', 'open benchmarks page'],
  history: ['open history', 'open history page'],
  tools: ['open tools', 'open tools page'],
  files: ['open files', 'open files page'],
  notes: ['open notes', 'open notes page', 'go to notes'],
  account: ['open account', 'open account page'],
} as const satisfies Readonly<Record<Route, readonly string[]>>;

export const PAGE_TARGET_ALIASES: Readonly<Record<Route, readonly string[]>> = Object.freeze(
  Object.fromEntries(
    APP_ROUTES.map((route) => {
      const supportsTargetlessSlash =
        route !== 'agent-detail' && route !== 'project-detail' && route !== 'notes';
      return [
        route,
        Object.freeze([...ROUTE_ALIASES[route], ...(supportsTargetlessSlash ? [`/${route}`] : [])]),
      ];
    }),
  ) as Record<Route, readonly string[]>,
);

const SECTION_LABELS = {
  general: ['general'],
  plans: ['plans'],
  providers: ['provider', 'providers'],
  connections: ['connections'],
  allaboutme: ['all about me'],
  plugins: ['plugin', 'plugins'],
  localmodels: ['local model', 'local models'],
  browseragent: ['browser agent'],
  appearance: ['appearance', 'theme'],
  voice: ['voice'],
  composerstt: ['composer speech to text', 'composer STT'],
  phone: ['phone', 'phone and voice'],
  ambient: ['ambient'],
  notifications: ['notification', 'notifications'],
  telemetry: ['telemetry'],
  accessibility: ['accessibility'],
  hotkeys: ['hotkey', 'hotkeys'],
  jarvisactions: ['Jarvis actions'],
  about: ['about'],
} as const satisfies Partial<Readonly<Record<SettingsTab, readonly string[]>>>;

export const SETTINGS_SECTION_ALIASES: Readonly<Partial<Record<SettingsTab, readonly string[]>>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(SECTION_LABELS).map(([section, labels]) => [
        section,
        Object.freeze(
          labels.flatMap((label) => [`open ${label} settings`, `open settings ${label}`]),
        ),
      ]),
    ),
  );

const routeByAlias = new Map(
  Object.entries(PAGE_TARGET_ALIASES).flatMap(([route, aliases]) =>
    aliases.map((alias) => [alias.toLocaleLowerCase(), route] as const),
  ),
);

// Keep the catalog bounded without dropping established phrases. A redundant
// "open … page" phrase can use its existing shorter alias plus an exact suffix.
// Keep phrases such as "open terminal page" whose shorter form has another owner.
const pageCommandAliases = Object.freeze(
  Object.entries(PAGE_TARGET_ALIASES).flatMap(([route, aliases]) =>
    aliases.filter(
      (alias) =>
        !alias.endsWith(' page') ||
        routeByAlias.get(alias.slice(0, -5).toLocaleLowerCase()) !== route,
    ),
  ),
);

const sectionByAlias = new Map(
  Object.entries(SETTINGS_SECTION_ALIASES).flatMap(([section, aliases]) =>
    (aliases ?? []).map((alias) => [alias.toLocaleLowerCase(), section] as const),
  ),
);

const fullscreenByAlias = new Map<string, boolean>([
  ['enter fullscreen', true],
  ['turn fullscreen on', true],
  ['enable fullscreen', true],
  ['exit fullscreen', false],
  ['turn fullscreen off', false],
  ['disable fullscreen', false],
]);

const NAVIGATION_ORDER = [
  'page.open',
  'page.back',
  'page.forward',
  'page.home',
  'settings.open',
  'settings.close',
  'settings.section.open',
  'palette.open',
  'launcher.open',
  'fullscreen.set',
  'connections.open',
] as const;

const navigationOrder = new Map(NAVIGATION_ORDER.map((id, index) => [id, index]));

export const NAVIGATION_COMMAND_INPUTS: readonly NavigationCommandInput[] = Object.freeze(
  [
    Object.freeze({
      id: 'page.open',
      aliases: pageCommandAliases,
      authority: 'ui.route',
      safety: 'read',
      availability: 'available',
      slotGrammar: 'remainder',
      parseSlots: (match: CatalogMatch) => {
        const phrase = `${match.alias} ${match.remainder}`
          .trim()
          .toLocaleLowerCase()
          .replace(/\s+/gu, ' ');
        const route = routeByAlias.get(phrase);
        return route
          ? Object.freeze({ status: 'parsed' as const, slots: Object.freeze({ route }) })
          : Object.freeze({ status: 'rejected' as const, reason: 'Unknown page target.' });
      },
    }),
    Object.freeze({
      id: 'settings.section.open',
      aliases: Object.freeze([...sectionByAlias.keys()]),
      authority: 'ui.route',
      safety: 'read',
      availability: 'available',
      slotGrammar: 'none',
      parseSlots: (match: CatalogMatch) => {
        const section = sectionByAlias.get(match.alias);
        return section
          ? Object.freeze({ status: 'parsed' as const, slots: Object.freeze({ section }) })
          : Object.freeze({ status: 'rejected' as const, reason: 'Unknown Settings section.' });
      },
    }),
    Object.freeze({
      id: 'fullscreen.set',
      aliases: Object.freeze([...fullscreenByAlias.keys()]),
      authority: 'settings.allowlist',
      safety: 'reversible',
      availability: 'available',
      slotGrammar: 'none',
      parseSlots: (match: CatalogMatch) => {
        const enabled = fullscreenByAlias.get(match.alias);
        return enabled === undefined
          ? Object.freeze({ status: 'rejected' as const, reason: 'Say fullscreen on or off.' })
          : Object.freeze({ status: 'parsed' as const, slots: Object.freeze({ enabled }) });
      },
    }),
    Object.freeze({
      id: 'connections.open',
      aliases: Object.freeze([
        '/connect',
        'connect provider',
        ...CONNECT_PROVIDER_FOCUS_IDS.map((providerId) => `/connect ${providerId}`),
      ]),
      authority: 'ui.route',
      safety: 'read',
      availability: 'available',
      slotGrammar: 'remainder',
      parseSlots: (match: CatalogMatch) => {
        const aliasProvider = match.alias.startsWith('/connect ')
          ? match.alias.slice('/connect '.length)
          : undefined;
        if (aliasProvider && match.remainder) {
          return Object.freeze({
            status: 'rejected' as const,
            reason: 'Choose one supported provider in Settings.',
          });
        }
        const target = parseProviderConnectionTarget(aliasProvider ?? match.remainder);
        return target.ok
          ? Object.freeze({
              status: 'parsed' as const,
              slots: Object.freeze({
                section: 'providers',
                ...(target.providerId ? { providerId: target.providerId } : {}),
              }),
            })
          : Object.freeze({ status: 'rejected' as const, reason: target.reason });
      },
    }),
    ...(
      [
        ['page.back', ['go back', 'go back a page', '/back'], 'ui.route', 'read'],
        ['page.forward', ['go forward', 'go forward a page', '/forward'], 'ui.route', 'read'],
        ['page.home', ['go home', 'go to home page', '/home'], 'ui.route', 'read'],
        [
          'settings.open',
          ['open Jarvis settings', 'open settings', '/settings'],
          'ui.route',
          'read',
        ],
        ['settings.close', ['close settings'], 'ui.route', 'read'],
        ['palette.open', ['open command palette', '/palette'], 'ui.route', 'read'],
        [
          'launcher.open',
          ['open quick launcher', 'open launcher', '/launcher'],
          'ui.route',
          'read',
        ],
      ] as const
    ).map(([id, aliases, authority, safety]) =>
      Object.freeze({
        id,
        aliases: Object.freeze([...aliases]),
        authority,
        safety,
        availability: 'available' as const,
        slotGrammar: 'none' as const,
      }),
    ),
  ].sort(
    (left, right) =>
      (navigationOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (navigationOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER),
  ),
);
