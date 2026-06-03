/**
 * Public surface of the whats-new feature.
 * Imports outside this folder go through this barrel.
 */
export { WhatsNewHost } from './WhatsNewHost';
export { WhatsNewModal } from './WhatsNewModal';
export type { WhatsNewModalProps } from './WhatsNewModal';
export { useWhatsNew } from './useWhatsNew';
export type { UseWhatsNewResult } from './useWhatsNew';
export {
  CURRENT_VERSION,
  RELEASES,
  SECTION_META,
  getLatestRelease,
  type Release,
  type ReleaseSection,
  type ReleaseSectionKind,
} from './releases';
