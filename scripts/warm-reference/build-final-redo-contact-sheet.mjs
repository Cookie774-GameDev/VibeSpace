import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const referenceRoot =
  process.env.VIBESPACE_WARM_FINAL_REFERENCE_ROOT ??
  'C:/Users/viper/Downloads/VibeSpace_Warm_Final_Redo_Pack_With_References/VibeSpace_Warm_Final_Redo_Pack/references';
const outputPath = process.env.VIBESPACE_WARM_FINAL_CONTACT_SHEET
  ? path.resolve(repositoryRoot, process.env.VIBESPACE_WARM_FINAL_CONTACT_SHEET)
  : path.join(repositoryRoot, 'artifacts/warm-final/reference-contact-sheet.png');

async function listPngFiles(root, relativeRoot = '') {
  const entries = await readdir(path.join(root, relativeRoot), { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map((entry) => {
      const relativePath = path.join(relativeRoot, entry.name);
      return entry.isDirectory()
        ? listPngFiles(root, relativePath)
        : entry.name.endsWith('.png')
          ? [relativePath]
          : [];
    }),
  );
  return nestedFiles.flat();
}

const files = (await listPngFiles(referenceRoot)).sort((left, right) => left.localeCompare(right));

const tileWidth = 620;
const tileHeight = 390;
const imageHeight = 349;
const columns = 2;
const rows = Math.ceil(files.length / columns);
const background = '#25170f';
const composites = [];

for (const [index, file] of files.entries()) {
  const left = (index % columns) * tileWidth;
  const top = Math.floor(index / columns) * tileHeight;
  const image = await sharp(path.join(referenceRoot, file))
    .resize(tileWidth - 20, imageHeight, { fit: 'contain', background })
    .png()
    .toBuffer();
  const label = Buffer.from(
    `<svg width="${tileWidth - 20}" height="31" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="${background}"/>
      <text x="8" y="21" fill="#f7e7ce" font-size="15" font-family="Segoe UI, sans-serif">${file}</text>
    </svg>`,
  );
  composites.push({ input: image, left: left + 10, top: top + 8 });
  composites.push({ input: label, left: left + 10, top: top + imageHeight + 8 });
}

await mkdir(path.dirname(outputPath), { recursive: true });
await sharp({
  create: {
    width: columns * tileWidth,
    height: rows * tileHeight,
    channels: 3,
    background,
  },
})
  .composite(composites)
  .png()
  .toFile(outputPath);

console.log(outputPath);
