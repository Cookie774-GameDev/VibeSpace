import { expect, it } from 'vitest';
import { CAO_GUIDANCE_AREAS, parseCaoGuidance, caoGuidanceReady } from './caoGuidance';

it('requires grounded guidance for every area, including file handling and user corrections', () => {
  const sections = Object.fromEntries(
    CAO_GUIDANCE_AREAS.map((area) => [
      area,
      {
        guidance:
          'Use focused changes, report observed results, and ask when requirements conflict.',
        sourceIds: ['m1'],
      },
    ]),
  );
  const profile = parseCaoGuidance(JSON.stringify({ sections }), ['m1']);
  expect(caoGuidanceReady(profile)).toBe(true);
  delete sections.fileHandling;
  expect(caoGuidanceReady(parseCaoGuidance(JSON.stringify({ sections }), ['m1']))).toBe(false);
});

it('rejects invented source references and does not accept model-selected activation or access', () => {
  expect(() =>
    parseCaoGuidance(
      JSON.stringify({
        sections: {
          communication: {
            guidance: 'Detailed unsupported instructions that should not be accepted.',
            sourceIds: ['invented'],
          },
        },
      }),
      ['real'],
    ),
  ).toThrow();
  const result = parseCaoGuidance(
    JSON.stringify({ enabled: true, permissionMode: 'full-access', sections: {} }),
    [],
  );
  expect(result).not.toHaveProperty('enabled');
  expect(result).not.toHaveProperty('permissionMode');
  expect(caoGuidanceReady(result)).toBe(false);
});
