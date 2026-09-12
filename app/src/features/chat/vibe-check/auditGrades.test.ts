import { describe, expect, it } from 'vitest';
import { auditReportText, parseAuditGrades } from './auditGrades';
import { auditInstruction, collectAuditEvidence } from './auditEvidence';
const grade = {
  metric: 'quality',
  score: 82,
  reason: 'Relevant checks passed',
  evidence: 'message-3',
  confidence: 'high',
};
const line = (value: unknown) => `VIBECHECK_GRADE ${JSON.stringify(value)}`;
describe('incremental audit grades', () => {
  it('reveals only complete grades and accepts evidence-backed revisions', () => {
    const text = line(grade);
    for (let end = 0; end < text.length; end++)
      expect(parseAuditGrades(text.slice(0, end))).toEqual({});
    expect(parseAuditGrades(text).quality?.score).toBe(82);
    expect(parseAuditGrades(`${text}\n${line({ ...grade, score: 65 })}`).quality?.score).toBe(65);
  });
  it('rejects malformed or unsupported scores and permits explicit unknowns', () => {
    for (const score of [0, 101, 3.5, '82', undefined])
      expect(parseAuditGrades(line({ ...grade, score }))).toEqual({});
    expect(
      parseAuditGrades(line({ ...grade, metric: 'speed', score: null })).speed?.score,
    ).toBeNull();
    expect(parseAuditGrades(line({ ...grade, metric: '__proto__' }))).toEqual({});
    expect(auditReportText(`Verdict\n${line(grade)}\nVIBECHECK_GRADE {`)).toBe('Verdict');
  });
  it('bundles the grading skill within the dispatch budget even with many long file names', () => {
    const evidence = collectAuditEvidence([], []);
    evidence.files = Array.from({ length: 100 }, () => 'long/'.repeat(100));
    const prompt = auditInstruction('Source', evidence);
    expect(prompt).toContain('VIBECHECK_GRADE');
    expect(prompt).toContain('prompt_adherence');
    expect(prompt.length).toBeLessThan(7800);
  });
});
