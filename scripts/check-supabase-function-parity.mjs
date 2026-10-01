import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const configPath = path.join(root, 'supabase', 'config.toml');
const functionsRoot = path.join(root, 'supabase', 'functions');

const config = fs.readFileSync(configPath, 'utf8');
const directories = fs.readdirSync(functionsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
  .map((entry) => entry.name)
  .sort();

const publicFunctions = new Set([
  'model-manifest',
  'stripe-webhook',
  'call-status',
  'twilio-voice-webhook',
  'twilio-message-webhook',
  'telnyx-call-webhook',
]);

const errors = [];
for (const name of directories) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Do not use the multiline flag here: with `m`, `$` matches the end of the
  // section-header line and the non-greedy capture becomes empty.
  const section = new RegExp(`\\[functions\\.${escaped}\\]([\\s\\S]*?)(?=\\n\\[|$)`).exec(config)?.[1] ?? '';
  const match = /verify_jwt\s*=\s*(true|false)/.exec(section);
  if (!match) {
    errors.push(`${name}: missing explicit verify_jwt policy`);
    continue;
  }
  const expected = publicFunctions.has(name) ? 'false' : 'true';
  if (match[1] !== expected) {
    errors.push(`${name}: verify_jwt=${match[1]}, expected ${expected}`);
  }
}

for (const name of publicFunctions) {
  if (!directories.includes(name)) errors.push(`${name}: public policy listed but function directory is missing`);
}

if (errors.length) {
  console.error('Supabase function policy parity failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Supabase function policy parity passed for ${directories.length} functions.`);
