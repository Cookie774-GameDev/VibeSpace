/**
 * Tiny YAML frontmatter parser.
 *
 * Supports the subset Slice 5's contracts file calls out:
 *   key: value
 *   key: 'string' | "string"
 *   key: [a, b, c] | ['a', 'b']
 *   key: true | false
 *   key: 123 | 1.5
 *
 * Tolerates Windows line endings (\r\n). Returns `{ meta: {}, body: raw }`
 * if no frontmatter is present so callers don't have to null-check.
 */

export interface ParsedFrontmatter {
  meta: Record<string, unknown>;
  body: string;
}

const FENCE_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const normalized = raw.replace(/\r\n/g, '\n');
  const match = normalized.match(FENCE_RE);
  if (!match) {
    return { meta: {}, body: normalized.replace(/\n+$/, '') };
  }

  const yamlBody = match[1] ?? '';
  const body = (match[2] ?? '').replace(/\n+$/, '');
  const meta: Record<string, unknown> = {};

  for (const line of yamlBody.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx <= 0) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();
    meta[key] = parseYamlValue(rawValue);
  }

  return { meta, body };
}

function parseYamlValue(raw: string): unknown {
  if (!raw) return null;

  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null' || raw === '~') return null;

  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);

  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return splitCsvOutsideQuotes(inner).map((item) => parseYamlValue(item.trim()));
  }

  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }

  return raw;
}

/** Split on commas that are not inside single/double quotes. */
function splitCsvOutsideQuotes(s: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inS = false;
  let inD = false;
  for (const c of s) {
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    if (c === ',' && !inS && !inD) {
      out.push(buf);
      buf = '';
    } else {
      buf += c;
    }
  }
  if (buf) out.push(buf);
  return out;
}
