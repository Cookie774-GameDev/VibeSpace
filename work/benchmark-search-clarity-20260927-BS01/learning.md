# Benchmark visual and search learning

- The apparent left side blur came from misty pixels baked into the composite artwork, amplified by a high opacity horizontal CSS wash. Inspect the source asset before changing filter or blur settings. Mirroring its clear right half across the left produced balanced scenery without a new asset.
- A custom clear button in an HTML `type="search"` field duplicates Chromium's native clear control. Use a text input with `role="searchbox"` when a custom clear control is required.
- Search must filter the full source rows before the chart slices to its top 25. Share the filtered rows with Table so model matches remain reachable.
