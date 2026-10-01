/**
 * Repository guard: user-facing assistant copy must never say "Sage".
 * Color tokens (accent-sage, --sage) and non-assistant identifiers are allowed.
 * Legacy LiveKit identity prefix `sage_` is an internal wire format, not UI copy.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx']);
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', '.git']);

/** Explicit user-facing / product-copy patterns that must not reappear. */
const FORBIDDEN = [
  /Ask Sage\b/,
  /Ringing Sage\b/,
  /Call Sage\b/,
  /straight to Sage\b/,
  /when Sage\b/,
  /Sage will not\b/,
  /Sage calls\b/,
  /Sage greets\b/,
  /persona:\s*['"]sage['"]/,
  /['"`]Sage['"`]\s*,/,
  /go straight to Sage\b/,
  /talk to Sage\b/,
];

function stripColorTokens(line: string): string {
  return line
    .replace(/accent-sage/g, '')
    .replace(/text-sage/g, '')
    .replace(/border-sage/g, '')
    .replace(/bg-sage/g, '')
    .replace(/ring-accent-sage/g, '')
    .replace(/via-accent-sage/g, '')
    .replace(/from-accent-sage/g, '')
    .replace(/to-accent-sage/g, '')
    .replace(/--sage/g, '')
    .replace(/pillTone:\s*'sage'/g, '')
    .replace(/scout-sage-\d+/g, '')
    .replace(/hsl\(var\(--sage\)\)/g, '')
    .replace(/startsWith\('sage_'\)/g, '')
    .replace(/identity\.startsWith\('sage_'\)/g, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR_NAMES.has(name)) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (SOURCE_EXT.has(path.extname(name))) out.push(full);
  }
  return out;
}

describe('assistant persona — no user-facing Sage', () => {
  it('does not introduce new user-facing Sage assistant strings under app/src', () => {
    const offenders: string[] = [];
    for (const file of walk(APP_SRC)) {
      if (file.endsWith('assistantPersona.noSage.test.ts')) continue;
      if (file.endsWith('assistantPersona.ts')) continue;
      if (file.endsWith('assistantPersona.test.ts')) continue;
      // Skip huge generated/fixture dumps if any.
      if (file.includes(`${path.sep}__fixtures__${path.sep}`)) continue;
      const text = readFileSync(file, 'utf8');
      if (!text.includes('Sage') && !text.includes('sage')) continue;
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (
          !line.includes('Sage') &&
          !line.includes("persona: 'sage'") &&
          !line.includes('persona: "sage"')
        ) {
          continue;
        }
        const stripped = stripColorTokens(line);
        for (const pattern of FORBIDDEN) {
          if (pattern.test(stripped) || pattern.test(line)) {
            offenders.push(`${path.relative(APP_SRC, file)}:${index + 1}: ${line.trim()}`);
            break;
          }
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  }, 30_000);
});
