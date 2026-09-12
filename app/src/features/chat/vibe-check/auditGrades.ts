export const AUDIT_METRICS = {
  efficiency: 'Agent efficiency',
  model_efficiency: 'Model efficiency',
  speed: 'Speed',
  quality: 'Quality',
  prompt_adherence: 'Prompt adherence',
  grounding: 'Grounding',
} as const;
export type AuditMetric = keyof typeof AUDIT_METRICS;
export type AuditGrade = {
  metric: AuditMetric;
  score: number | null;
  reason: string;
  evidence: string;
  confidence: 'low' | 'medium' | 'high';
};
const prefix = 'VIBECHECK_GRADE';
/** Parse only complete, validated records; incomplete stream tails never flash as grades. */
export function parseAuditGrades(report: string): Partial<Record<AuditMetric, AuditGrade>> {
  const grades: Partial<Record<AuditMetric, AuditGrade>> = {};
  for (const line of report.split('\n')) {
    if (!line.trimStart().startsWith(prefix + ' ')) continue;
    try {
      const grade = JSON.parse(line.trimStart().slice(prefix.length)) as AuditGrade;
      if (
        !grade ||
        !Object.prototype.hasOwnProperty.call(AUDIT_METRICS, grade.metric) ||
        !(
          grade.score === null ||
          (Number.isInteger(grade.score) && grade.score >= 1 && grade.score <= 100)
        ) ||
        !['low', 'medium', 'high'].includes(grade.confidence) ||
        typeof grade.reason !== 'string' ||
        !grade.reason.trim() ||
        typeof grade.evidence !== 'string' ||
        !grade.evidence.trim()
      )
        continue;
      grades[grade.metric] = {
        ...grade,
        reason: grade.reason.slice(0, 2000),
        evidence: grade.evidence.slice(0, 2000),
      };
    } catch {
      /* A partial stream record is expected. */
    }
  }
  return grades;
}
export function auditReportText(report: string): string {
  return report
    .split('\n')
    .filter((line) => {
      const text = line.trimStart();
      return !text.startsWith(prefix) && !(text.length > 3 && prefix.startsWith(text));
    })
    .join('\n')
    .trim();
}
