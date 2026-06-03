import {
  Archive,
  Atom,
  BadgeCheck,
  Bot,
  BrainCircuit,
  BriefcaseBusiness,
  Bug,
  Calculator,
  CalendarClock,
  ChartSpline,
  ClipboardCheck,
  Code2,
  Compass,
  Database,
  FileSearch,
  Hammer,
  HeartHandshake,
  Lightbulb,
  ListChecks,
  Map,
  MessageCircle,
  Microscope,
  Palette,
  PenLine,
  Puzzle,
  Radar,
  Scale,
  Search,
  Shield,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  type LucideIcon,
} from 'lucide-react';
import type { Agent } from '@/types';

export const AGENT_ICON_BY_SLUG: Record<string, LucideIcon> = {
  action_extractor: ListChecks,
  analyst: ChartSpline,
  architect: Map,
  builder: Hammer,
  coder: Code2,
  critic: ShieldCheck,
  debugger: Bug,
  designer: Palette,
  devops: TerminalSquare,
  finance: Calculator,
  jarvis: Sparkles,
  legal: Scale,
  manager: BriefcaseBusiness,
  math: Calculator,
  memory_keeper: Database,
  planner: CalendarClock,
  product: Lightbulb,
  qa: ClipboardCheck,
  researcher: Search,
  reviewer: ClipboardCheck,
  scout: Compass,
  security: Shield,
  strategist: Radar,
  support: HeartHandshake,
  tester: Bug,
  writer: PenLine,
};

export const AGENT_ICON_BY_CAPABILITY: Partial<Record<Agent['capabilities'][number], LucideIcon>> = {
  action_extraction: ListChecks,
  code: Code2,
  critique: ShieldCheck,
  design: Palette,
  math: Calculator,
  memory_keeping: Database,
  planning: Map,
  reasoning: BrainCircuit,
  research: FileSearch,
  voice_supervision: MessageCircle,
  writing: PenLine,
};

const FALLBACK_ICONS: LucideIcon[] = [
  Bot,
  BrainCircuit,
  Microscope,
  Archive,
  Atom,
  BadgeCheck,
  Puzzle,
  Radar,
];

function hashSlug(slug: string): number {
  return slug.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

export function getAgentIcon(agent: Agent): LucideIcon {
  const direct = AGENT_ICON_BY_SLUG[agent.slug.toLowerCase()];
  if (direct) return direct;
  for (const capability of agent.capabilities) {
    const icon = AGENT_ICON_BY_CAPABILITY[capability];
    if (icon) return icon;
  }
  return FALLBACK_ICONS[hashSlug(agent.slug) % FALLBACK_ICONS.length] ?? Bot;
}
