import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const icons = join(root, 'src-tauri', 'icons');
const pub = join(root, 'public');

const pairs = [
  ['32x32.png', 'favicon-32.png'],
  ['128x128.png', 'vibespace-icon.png'],
  ['icon.ico', 'favicon.ico'],
];

for (const [from, to] of pairs) {
  const src = join(icons, from);
  if (!existsSync(src)) {
    console.warn(`skip missing ${from}`);
    continue;
  }
  copyFileSync(src, join(pub, to));
  console.log(`synced ${to}`);
}
