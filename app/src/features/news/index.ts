/**
 * Public surface of the AI News mini-panel feature.
 */
export { NewsHost } from './NewsHost';
export { NewsPanel } from './NewsPanel';
export type { NewsPanelProps } from './NewsPanel';
export {
  configuredNewsApiUrl,
  fetchLiveNews,
  parseNewsResponse,
  type LiveNewsItem,
  type LiveNewsResponse,
} from './newsApi';
export {
  NEWS_CATALOG,
  NEWS_KIND_META,
  NEWS_SECTION_META,
  type NewsItem,
  type NewsKind,
  type NewsSectionId,
} from './newsCatalog';
export {
  countNewsBySection,
  daysBetween,
  formatNewsDate,
  getNewsFeed,
  parseNewsDay,
  resolveTodayIso,
  sectionForItem,
  toIsoDay,
} from './newsSections';
