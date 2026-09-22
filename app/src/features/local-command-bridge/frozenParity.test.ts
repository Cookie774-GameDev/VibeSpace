import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { routeLocalCommand, signature } from './router';
import { routeLocalCommand as frozenRoute } from './__fixtures__/frozen/router.mjs';
import { generateCorpus, type Fixture } from './__fixtures__/frozen/corpus.mjs';
import { generateNegativeCorpus } from './__fixtures__/frozen/safety-corpus.mjs';
import { generateTieredCorpus } from './__fixtures__/frozen/tiered-corpus.mjs';

const folder = resolve(process.cwd(), 'src/features/local-command-bridge/__fixtures__/frozen');
const expectedSignature = (c: { id: string; slots: Record<string, unknown> }) =>
  c.id + ':' + JSON.stringify(c.slots);
function verify(fixture: Fixture) {
  const result = routeLocalCommand(fixture.text);
  const baseline = frozenRoute(fixture.text);
  expect(result.commands, fixture.name + ' frozen commands').toEqual(baseline.commands);
  expect(result.residual, fixture.name + ' frozen residual').toBe(baseline.residual);
  expect(result.classification, fixture.name + ' frozen classification').toBe(
    baseline.classification,
  );
  for (const c of result.commands) {
    expect(fixture.text.slice(c.sourceStart, c.sourceEnd), fixture.name + ' source span').toBe(
      c.source,
    );
  }
  const got = result.commands.map(signature).sort();
  const want = fixture.expected.map(expectedSignature).sort();
  return JSON.stringify(got) === JSON.stringify(want) && result.classification === fixture.route;
}

describe('frozen tested localhost router preservation', () => {
  it.each([
    ['COMPACT_NIGHTMARE.txt', 'COMPACT_NIGHTMARE_KEY.json'],
    ['HARD_PROMPT_2.txt', 'HARD_PROMPT_2_ANSWER_KEY.json'],
  ])('preserves and independently grades %s', (promptFile, keyFile) => {
    const text = readFileSync(resolve(folder, promptFile), 'utf8');
    const key = JSON.parse(readFileSync(resolve(folder, keyFile), 'utf8')) as Pick<
      Fixture,
      'expected'
    >;
    expect(
      verify({
        name: promptFile,
        text,
        words: text.split(/\s+/u).length,
        expected: key.expected,
        route: 'both',
      }),
    ).toBe(true);
  });

  it('passes 100 fixed-seed 4,000-word mixed cases without changing frozen behavior', () => {
    const fixtures = generateCorpus(2718281828, 100, 4000);
    const failures = fixtures.filter((f) => !verify(f)).map((f) => f.name);
    expect(fixtures.every((f) => f.words >= 4000)).toBe(true);
    expect(failures).toEqual([]);
  }, 120_000);

  it('emits zero commands on 100 fixed-seed pure-negative prompts', () => {
    const fixtures = generateNegativeCorpus(3141592653, 100, 2500);
    const failures = fixtures.filter((f) => !verify(f)).map((f) => f.name);
    expect(fixtures.every((f) => f.words >= 2500)).toBe(true);
    expect(failures).toEqual([]);
  }, 120_000);

  it('meets independently graded High / X-High / Max acceptance thresholds', () => {
    const tiers = generateTieredCorpus(987654321);
    const scores = Object.fromEntries(
      Object.entries(tiers).map(([tier, fixtures]) => {
        const passed = fixtures.filter(verify).length;
        return [tier, { passed, total: fixtures.length, fraction: passed / fixtures.length }];
      }),
    );
    expect(scores.high.total).toBe(10);
    expect(scores.xhigh.total).toBe(10);
    expect(scores.max.total).toBe(3);
    expect(scores.high.fraction).toBeGreaterThanOrEqual(0.95);
    expect(scores.xhigh.fraction).toBeGreaterThanOrEqual(0.9);
    expect(scores.max.fraction).toBeGreaterThan(0.7);
    console.info('FROZEN_ROUTER_TIERS', JSON.stringify(scores));
  }, 120_000);
});
