import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const [sourcePath, outputDirectory, prefix] = process.argv.slice(2);
if (!sourcePath || !outputDirectory || !prefix) {
  throw new Error(
    'Usage: node split-four-candidate-atlas.mjs <source> <output-directory> <prefix>',
  );
}

const absoluteOutputDirectory = path.resolve(outputDirectory);
await mkdir(absoluteOutputDirectory, { recursive: true });
await copyFile(sourcePath, path.join(absoluteOutputDirectory, `${prefix}-atlas.png`));

const metadata = await sharp(sourcePath).metadata();
if (!metadata.width || !metadata.height) {
  throw new Error('Candidate atlas has no readable dimensions.');
}
const candidateWidth = Math.floor(metadata.width / 2);
const candidateHeight = Math.floor(metadata.height / 2);
const labels = ['a', 'b', 'c', 'd'];

for (const [index, label] of labels.entries()) {
  await sharp(sourcePath)
    .extract({
      left: (index % 2) * candidateWidth,
      top: Math.floor(index / 2) * candidateHeight,
      width: candidateWidth,
      height: candidateHeight,
    })
    .resize(1672, 941, { fit: 'cover' })
    .webp({ quality: 88, effort: 5 })
    .toFile(path.join(absoluteOutputDirectory, `${prefix}-candidate-${label}.webp`));
}
