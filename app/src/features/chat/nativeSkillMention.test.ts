import { describe, expect, it } from 'vitest';
import { parseNativeSkillMention, replaceNativeSkillMention } from './nativeSkillMention';
import type { CodexDiscoveredSkill } from '@/lib/ai/adapters/codexAppServerProtocol';

describe('native skill mention parser', () => {
  it('opens only at a word boundary and records the exact token range around the caret', () => {
    expect(parseNativeSkillMention('$', 1)).toMatchObject({ start: 0, end: 1, query: '' });
    expect(parseNativeSkillMention('run $plan-now extra', 13)).toMatchObject({
      start: 4,
      end: 13,
      query: 'plan-now',
    });
    expect(parseNativeSkillMention('run $plan-now extra', 9)).toMatchObject({
      start: 4,
      end: 13,
      query: 'plan',
    });
    expect(parseNativeSkillMention('word$skill', 10)).toBeNull();
    expect(parseNativeSkillMention('prefix_$skill', 13)).toBeNull();
  });

  it('preserves currency, escaped dollars, and inline or fenced code', () => {
    expect(parseNativeSkillMention('costs $25 today', 9)).toBeNull();
    expect(parseNativeSkillMention(String.raw`literal \$skill`, 15)).toBeNull();
    expect(parseNativeSkillMention('`$skill`', 6)).toBeNull();
    expect(parseNativeSkillMention('```md\n$skill\n```', 10)).toBeNull();
  });

  it('replaces only the active mention with the exact discovered skill name', () => {
    const skill: CodexDiscoveredSkill = {
      cwd: 'C:/project',
      name: 'release-check',
      description: 'Review release readiness',
      path: 'C:/project/.codex/skills/release-check/SKILL.md',
      scope: 'repo',
      enabled: true,
      pluginId: null,
    };
    const text = 'please $release now';
    const mention = parseNativeSkillMention(text, 11);
    expect(mention).not.toBeNull();
    expect(replaceNativeSkillMention(text, mention!, skill)).toEqual({
      text: 'please $release-check now',
      caret: 21,
    });
  });
});
