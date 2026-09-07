import { describe, expect, it } from 'vitest';
import { parseJarvisPlanBlocks } from './planParser';

describe('parseJarvisPlanBlocks', () => {
  it('converts fenced jarvis_plan JSON into a plan_review part', () => {
    const parsed = parseJarvisPlanBlocks(`Here is the plan.\n\n\`\`\`jarvis_plan\n{
  "id": "plan_1",
  "title": "Build interaction cards",
  "summary": "Add cards without replacing chat.",
  "steps": ["Add types", "Render cards"],
  "risks": ["Shared Composer surface"]
}\n\`\`\``);

    expect(parsed.hasPlanBlocks).toBe(true);
    expect(parsed.parts).toEqual([
      { kind: 'text', text: 'Here is the plan.' },
      {
        kind: 'plan_review',
        plan: {
          id: 'plan_1',
          title: 'Build interaction cards',
          summary: 'Add cards without replacing chat.',
          steps: ['Add types', 'Render cards'],
          risks: ['Shared Composer surface'],
          status: 'pending',
        },
      },
    ]);
  });

  it('marks fenced informational plans as non-executable when no app work is present', () => {
    const parsed = parseJarvisPlanBlocks(`\`\`\`jarvis_plan\n{
  "id": "plan_coffee",
  "title": "Make coffee",
  "summary": "A simple kitchen checklist.",
  "steps": ["Boil water", "Add coffee", "Pour slowly"]
}\n\`\`\``);

    expect(parsed.parts[0]).toMatchObject({
      kind: 'plan_review',
      plan: {
        id: 'plan_coffee',
        executable: false,
      },
    });
  });

  it('accepts validated plan-shaped JSON from providers that omit the jarvis_plan fence name', () => {
    const parsed = parseJarvisPlanBlocks(`Here is the requested plan.\n\n\`\`\`json\n{
  "title": "Harmless welcome banner",
  "summary": "Add a static welcome message without changing runtime behavior.",
  "steps": ["Define copy", "Reuse theme tokens", "Verify in the native app"],
  "risks": ["Minor layout drift"]
}\n\`\`\``);

    expect(parsed.hasPlanBlocks).toBe(true);
    expect(parsed.parts).toEqual([
      { kind: 'text', text: 'Here is the requested plan.' },
      expect.objectContaining({
        kind: 'plan_review',
        plan: expect.objectContaining({
          title: 'Harmless welcome banner',
          steps: ['Define copy', 'Reuse theme tokens', 'Verify in the native app'],
          status: 'pending',
        }),
      }),
    ]);
  });

  it('can force a plan card from prose when Plan Mode response has no JSON block', () => {
    const parsed = parseJarvisPlanBlocks('1. Inspect files\n2. Add tests', { force: true });

    expect(parsed.hasPlanBlocks).toBe(true);
    expect(parsed.parts.at(-1)).toMatchObject({
      kind: 'plan_review',
      plan: {
        title: 'Review plan',
        summary: '1. Inspect files\n2. Add tests',
        steps: [],
        status: 'pending',
      },
    });
  });

  it('does not duplicate forced plan prose outside the review card', () => {
    const parsed = parseJarvisPlanBlocks('1. Boil water\n2. Add coffee\n3. Pour slowly', { force: true });

    expect(parsed.hasPlanBlocks).toBe(true);
    expect(parsed.parts).toHaveLength(1);
    expect(parsed.parts[0]).toMatchObject({
      kind: 'plan_review',
      plan: {
        summary: '1. Boil water\n2. Add coffee\n3. Pour slowly',
        executable: false,
      },
    });
  });
});
