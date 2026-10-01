export function createProgressTracker(total) {
  if (!Number.isInteger(total) || total < 1) {
    throw new RangeError('Progress total must be a positive integer.');
  }

  const completed = new Set();

  return {
    complete(id) {
      const before = completed.size;
      completed.add(String(id));
      return completed.size !== before;
    },
    percent() {
      return Math.min(100, Math.round((completed.size / total) * 100));
    },
    get completed() {
      return completed.size;
    },
    get total() {
      return total;
    },
  };
}

async function decodeImage(src) {
  const image = new Image();
  image.decoding = 'async';
  image.src = src;
  await image.decode();
  return image;
}

export async function preloadCritical({
  images,
  fonts,
  rendererReady,
  onProgress = () => {},
}) {
  const readiness = [
    ...images.map((src, index) => ({
      id: `image-${index}`,
      load: () => decodeImage(src),
    })),
    {
      id: 'fonts',
      load: () => fonts ?? Promise.resolve(),
    },
    {
      id: 'renderer',
      load: () => rendererReady ?? Promise.resolve(),
    },
  ];
  const tracker = createProgressTracker(readiness.length);
  const decodedImages = new Array(images.length);

  onProgress(0);
  await Promise.all(
    readiness.map(async ({ id, load }, readinessIndex) => {
      const result = await load();
      if (id.startsWith('image-')) {
        decodedImages[readinessIndex] = result;
      }
      tracker.complete(id);
      onProgress(tracker.percent());
    }),
  );

  return decodedImages;
}
