/**
 * Skills feature barrel.
 *
 * Slice 5 (data) + Slice 6 (UI) live in this folder. The PageRouter
 * lazy-imports `SkillsPage` from here.
 */

export { SkillsPage } from './SkillsPage';
export { SkillCard } from './SkillCard';
export { SkillDetail } from './SkillDetail';
export { SkillEditor } from './SkillEditor';
export { skillRegistry } from './registry';
export { loadAllSkills, loadAllAgents } from './loader';
export {
  getAllCatalogSkills,
  getSkillPickerOptions,
  getUnifiedSkillManifests,
  resolveCatalogSkill,
  resolveCatalogSkills,
} from './skillCatalog';
export { useSkillsStore } from './skillsStore';
export type { SkillManifest } from './loader';
