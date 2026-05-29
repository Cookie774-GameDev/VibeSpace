/**
 * Public surface for the benchmarks feature.
 */
export { BenchmarksPage } from './BenchmarksPage';
export { BarChart } from './BarChart';
export {
  fetchBenchmarks,
  clearBenchmarkCache,
  isSupportedProvider,
  SNAPSHOT_ROWS,
  type BenchmarkRow,
  type FetchResult,
} from './benchmarkData';
