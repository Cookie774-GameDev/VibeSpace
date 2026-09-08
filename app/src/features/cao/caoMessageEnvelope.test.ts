import { expect, it } from 'vitest';
import { caoMessageEnvelope } from './caoMessageEnvelope';
it('carries the complete original objective even when the model refers to missing context', () => {
  const objective =
    'Build C:\\games\\tower\\index.html with three towers, bosses and touch. Preserve other agents.';
  expect(caoMessageEnvelope('Implement every listed requirement.', objective)).toBe(
    `CAO direction:\nImplement every listed requirement.\n\nUser objective (complete):\n${objective}`,
  );
});
it('preserves a maximum-size objective without truncation', () => {
  const objective = 'x'.repeat(8000);
  expect(caoMessageEnvelope('y'.repeat(8000), objective)).toContain(objective);
});
it('rejects empty or oversized model text before creating a proposal', () => {
  expect(() => caoMessageEnvelope('', 'build')).toThrow();
  expect(() => caoMessageEnvelope('x'.repeat(8001), 'build')).toThrow();
});
