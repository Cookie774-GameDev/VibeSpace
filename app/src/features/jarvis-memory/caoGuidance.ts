export const CAO_GUIDANCE_AREAS = [
  'communication',
  'delegation',
  'fileHandling',
  'agentManagement',
  'corrections',
  'verification',
  'boundaries',
] as const;
export type CaoGuidanceArea = (typeof CAO_GUIDANCE_AREAS)[number];
export interface CaoGuidance {
  schemaVersion: 1;
  sections: Partial<Record<CaoGuidanceArea, { guidance: string; sourceIds: string[] }>>;
  sourceIds: string[];
}

export function parseCaoGuidance(text: string, sourceIds: readonly string[]): CaoGuidance {
  if (text.length > 16000) throw new Error('cao_guidance_too_large');
  const raw = JSON.parse(text);
  if (!raw || !raw.sections || typeof raw.sections !== 'object' || Array.isArray(raw.sections))
    throw new Error('cao_guidance_invalid');
  const sections: CaoGuidance['sections'] = {};
  const allowed = new Set(sourceIds);
  for (const area of CAO_GUIDANCE_AREAS) {
    const section = raw.sections[area];
    if (section === undefined) continue;
    if (
      !section ||
      typeof section.guidance !== 'string' ||
      section.guidance.trim().length < 40 ||
      section.guidance.length > 1800 ||
      /\b(?:password|api[_ -]?key|access[_ -]?token|secret)\s*(?:[:=]|\bis\b)\s*\S+|\b(?:gh[pousr]_|sk-)[A-Za-z0-9_-]{20,}|(?:ignore|override|disregard)\s+(?:all\s+|the\s+)?(?:system|developer|previous|prior)\s+instructions/i.test(
        section.guidance,
      ) ||
      !Array.isArray(section.sourceIds) ||
      !section.sourceIds.length ||
      section.sourceIds.length > 20 ||
      section.sourceIds.some((id: unknown) => typeof id !== 'string' || !allowed.has(id))
    )
      throw new Error('cao_guidance_ungrounded');
    sections[area] = {
      guidance: section.guidance.trim(),
      sourceIds: [...new Set<string>(section.sourceIds)],
    };
  }
  return {
    schemaVersion: 1,
    sections,
    sourceIds: [...new Set(Object.values(sections).flatMap((section) => section.sourceIds))],
  };
}

export function caoGuidanceReady(guidance?: CaoGuidance): boolean {
  return Boolean(
    guidance && CAO_GUIDANCE_AREAS.every((area) => guidance.sections[area]?.sourceIds.length),
  );
}

export function renderCaoGuidance(guidance?: CaoGuidance): string[] {
  return [
    '## CAO — How to handle my chats and agents',
    '',
    `Guidance: ${caoGuidanceReady(guidance) ? 'ready for user activation' : 'learning — more evidence needed'}`,
    '',
    ...CAO_GUIDANCE_AREAS.flatMap((area) => {
      const section = guidance?.sections[area];
      return [
        `### ${area}`,
        '',
        section?.guidance ?? 'Not yet established from observed evidence.',
        '',
        ...(section ? [`Sources: ${section.sourceIds.join(', ')}`, ''] : []),
      ];
    }),
  ];
}
