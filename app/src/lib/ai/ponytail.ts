import { ponytailArtifact } from './ponytail.generated';

export const ponytailSource = ponytailArtifact.source;
export const ponytailFullInstructions = ponytailArtifact.instructions.full;
export const ponytailRawSkill = ponytailArtifact.skills.ponytail.raw;
export const ponytailAuditRaw = ponytailArtifact.skills.audit.raw;

export const ponytailSkillCatalog = Object.freeze([
  Object.freeze({
    name: 'ponytail',
    path: ponytailArtifact.skills.ponytail.path,
    sha256: ponytailArtifact.skills.ponytail.sha256,
  }),
  Object.freeze({
    name: 'ponytail-audit',
    path: ponytailArtifact.skills.audit.path,
    sha256: ponytailArtifact.skills.audit.sha256,
  }),
]);

export { ponytailArtifact };
