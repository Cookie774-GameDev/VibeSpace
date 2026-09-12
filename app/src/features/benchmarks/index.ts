/** Public surface for the backend-authoritative benchmarks feature. */
export { BenchmarkIntelligencePage as BenchmarksPage } from './BenchmarkIntelligencePage';
export { BenchmarkIntelligencePage as BenchmarkLeaderboardPage } from './BenchmarkIntelligencePage';
export { BenchmarkIntelligencePage } from './BenchmarkIntelligencePage';
export {
  blendedTokenPrice,
  clearLegacyBenchmarkCaches,
  configuredBenchmarkApiUrl,
  fetchBenchmarkLeaderboard,
  intelligencePerDollar,
  parseBenchmarkResponse,
  type BenchmarkApiResponse,
  type BenchmarkDatasetMetadata,
  type BenchmarkFetchResult,
  type BenchmarkFreshness,
  type BenchmarkFreshnessState,
  type BenchmarkModelRow,
} from './benchmarkApi';

// Legacy utilities remain exported for narrow compatibility, but they no
// longer own the default route or any ingestion schedule.
export { BarChart } from './BarChart';
export {
  fetchBenchmarks,
  clearBenchmarkCache,
  isSupportedProvider,
  normalizeWulong,
  vendorToProvider,
  type BenchmarkRow,
  type FetchResult,
} from './benchmarkData';
export {
  clearNewsBenchmarkCache,
  discoverNewsBenchmarkPair,
  pickLatestModelRelease,
  resolveNewsApiUrl,
  selectNewsBenchmarkPair,
  type NewsApiItem,
  type NewsBenchmarkDiscovery,
  type NewsBenchmarkPair,
  type NewsBenchmarkPosition,
  type NewsModelRelease,
  type NewsVerification,
} from './newsModelDiscovery';
