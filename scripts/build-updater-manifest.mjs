#!/usr/bin/env node
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const version = required(args.version, '--version');
const assetsDir = path.resolve(required(args.assetsDir ?? args['assets-dir'], '--assets-dir'));
const baseUrl = required(args.baseUrl ?? args['base-url'], '--base-url').replace(/\/$/, '');
const outfile = path.resolve(args.outfile ?? path.join(assetsDir, 'latest.json'));
const notes = args.notes ?? `Jarvis ${version}`;

const files = await readdir(assetsDir, { withFileTypes: true });
const names = files.filter((f) => f.isFile()).map((f) => f.name);
const versionPattern = escapeRegex(version);

const platforms = {};
await addPlatform(
  'windows-x86_64',
  pick(names, [
    new RegExp(`^Jarvis-One-${versionPattern}-Windows-x64\\.exe$`),
    new RegExp(`^Jarvis( One)?_${versionPattern}_x64-setup\\.exe$`),
  ]),
  names,
);
await addPlatform('darwin-aarch64', pick(names, [/\.app\.tar\.gz$/, /macOS.*\.tar\.gz$/i]), names);
await addPlatform('linux-x86_64', pick(names, [/\.AppImage$/, /amd64.*\.AppImage$/i]), names);

if (Object.keys(platforms).length === 0) {
  throw new Error(`No signed updater artifacts found in ${assetsDir}`);
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
};

await writeFile(outfile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Wrote updater manifest: ${outfile}`);

async function addPlatform(platform, artifactName, allNames) {
  if (!artifactName) return;
  const sigName = `${artifactName}.sig`;
  if (!allNames.includes(sigName)) {
    throw new Error(`Missing signature for ${artifactName}: expected ${sigName}`);
  }
  const artifactStat = await stat(path.join(assetsDir, artifactName));
  const sigStat = await stat(path.join(assetsDir, sigName));
  if (sigStat.mtimeMs + 1000 < artifactStat.mtimeMs) {
    throw new Error(`Stale signature for ${artifactName}: ${sigName} is older than the artifact`);
  }
  const signature = (await readFile(path.join(assetsDir, sigName), 'utf8')).trim();
  platforms[platform] = {
    signature,
    url: `${baseUrl}/${encodeURIComponent(artifactName)}`,
  };
}

function pick(names, patterns) {
  for (const pattern of patterns) {
    const match = names.find((name) => pattern.test(name));
    if (match) return match;
  }
  return undefined;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      parsed[name] = 'true';
    } else {
      parsed[name] = next;
      i += 1;
    }
  }
  return parsed;
}

function required(value, label) {
  if (!value) throw new Error(`Missing required argument ${label}`);
  return value;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
