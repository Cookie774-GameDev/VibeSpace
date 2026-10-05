/** Unit tests must supply their own transport fixtures, never call a live provider. */
const offlineFetch: typeof globalThis.fetch = async () => {
  // Request URLs, headers and bodies may contain private data. Do not include them.
  throw new Error('Unmocked fetch is blocked in unit tests. Mock the transport explicitly.');
};

export function installOfflineFetchGuard(): void {
  // This is the baseline, not a vi.stubGlobal override: unstubAllGlobals and
  // restored spies must return to the blocked function, never the real fetch.
  globalThis.fetch = offlineFetch;
}
