import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_RESOURCES = [
  '../../docs/oss/dependency-lock.json',
  '../../docs/oss/grammar-license-inventory.md',
  '../../docs/oss/THIRD_PARTY_NOTICES.md',
  '../../docs/oss/sbom-pr31.cdx.json',
  '../../docs/oss/browser-agent-feature-pack.json',
  '../../docs/oss/licenses/*',
];
const LICENSE_FILES = new Map([
  ['gpt-tokenizer', 'MIT-gpt-tokenizer.txt'],
  ['@huggingface/tokenizers', 'Apache-2.0.txt'],
  ['web-tree-sitter', 'MIT-tree-sitter.txt'],
  ['@repomix/tree-sitter-wasms', 'UNLICENSE.txt'],
  ['tree-sitter-json', 'MIT-tree-sitter-json.txt'],
  ['@opentelemetry/api', 'Apache-2.0.txt'],
  ['@opentelemetry/sdk-trace-base', 'Apache-2.0.txt'],
  ['@modelcontextprotocol/sdk', 'MIT-mcp-sdk.txt'],
  ['playwright-core', 'Apache-2.0-playwright.txt'],
  ['@playwright/test', 'Apache-2.0-playwright.txt'],
  ['promptfoo', 'MIT-promptfoo.txt'],
]);
const GRAMMARS = [
  ['typescript', '0.23.2', 'f975a621f4e7f532fe322e13c4f79495e0a7b2e7', 'tree-sitter-typescript.wasm', 'MIT-tree-sitter-typescript.txt'],
  ['tsx', '0.23.2', 'f975a621f4e7f532fe322e13c4f79495e0a7b2e7', 'tree-sitter-tsx.wasm', 'MIT-tree-sitter-typescript.txt'],
  ['javascript', '0.25.0', '44c892e0be055ac465d5eeddae6d3e194424e7de', 'tree-sitter-javascript.wasm', 'MIT-tree-sitter-javascript.txt'],
  ['rust', '0.24.0', '18b0515fca567f5a10aee9978c6d2640e878671a', 'tree-sitter-rust.wasm', 'MIT-tree-sitter-rust.txt'],
  ['python', '0.25.0', '293fdc02038ee2bf0e2e206711b69c90ac0d413f', 'tree-sitter-python.wasm', 'MIT-tree-sitter-python.txt'],
  ['json', '0.24.8', 'ee35a6ebefcef0c5c416c0d1ccec7370cfca5a24', 'tree-sitter-json.wasm', 'MIT-tree-sitter-json.txt'],
];

function loadText(root, relative, errors) {
  try {
    return readFileSync(resolve(root, relative), 'utf8');
  } catch {
    errors.push(`missing or unreadable: ${relative}`);
    return '';
  }
}

function loadJson(root, relative, errors) {
  const text = loadText(root, relative, errors);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    errors.push(`invalid JSON: ${relative}`);
    return {};
  }
}

function property(component, name) {
  return component?.properties?.find((candidate) => candidate?.name === name)?.value;
}

function licenseId(component) {
  return component?.licenses?.[0]?.license?.id;
}

function check(condition, message, errors) {
  if (!condition) errors.push(message);
}

export function verifyPr31OssBundle(root = SCRIPT_ROOT) {
  const errors = [];
  const dependencyLock = loadJson(root, 'docs/oss/dependency-lock.json', errors);
  const packageLock = loadJson(root, 'package-lock.json', errors);
  const rootPackage = loadJson(root, 'package.json', errors);
  const appPackage = loadJson(root, 'app/package.json', errors);
  const tauri = loadJson(root, 'app/src-tauri/tauri.conf.json', errors);
  const sbom = loadJson(root, 'docs/oss/sbom-pr31.cdx.json', errors);
  const featurePack = loadJson(root, 'docs/oss/browser-agent-feature-pack.json', errors);
  const licensesReadme = loadText(root, 'docs/oss/licenses/README.md', errors);
  const grammarInventory = loadText(root, 'docs/oss/grammar-license-inventory.md', errors);
  const notices = loadText(root, 'docs/oss/THIRD_PARTY_NOTICES.md', errors);

  check(dependencyLock.schemaVersion === 1, 'dependency lock schemaVersion must be 1', errors);
  check(Array.isArray(dependencyLock.entries), 'dependency lock entries must be an array', errors);
  const entries = Array.isArray(dependencyLock.entries) ? dependencyLock.entries : [];
  check(entries.length === LICENSE_FILES.size, 'dependency lock must exactly match the PR31 license map', errors);
  const names = new Set();
  for (const entry of entries) {
    check(typeof entry?.name === 'string' && !names.has(entry.name), `duplicate or invalid dependency entry: ${entry?.name ?? '<missing>'}`, errors);
    names.add(entry?.name);
    check(/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(entry?.version ?? ''), `invalid pinned version: ${entry?.name}`, errors);
    check(/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry?.integrity ?? ''), `invalid integrity: ${entry?.name}`, errors);
    check(/^[a-f0-9]{40}$/.test(entry?.gitCommit ?? ''), `invalid commit: ${entry?.name}`, errors);
    check(/^https:\/\/github\.com\//.test(entry?.repositoryUrl ?? ''), `invalid repository: ${entry?.name}`, errors);
    check(['MIT', 'Apache-2.0', 'Unlicense'].includes(entry?.license), `invalid license: ${entry?.name}`, errors);

    const locked = packageLock.packages?.[`node_modules/${entry?.name}`];
    if (entry?.name === 'promptfoo') {
      check(locked === undefined, 'promptfoo must be absent from package-lock dependency graph', errors);
      check(
        rootPackage.workspaces?.includes('app') &&
          appPackage.scripts?.['eval:ai']?.includes(`promptfoo@${entry.version}`),
        'promptfoo exact development command must match dependency-lock version',
        errors,
      );
    } else {
      check(locked?.version === entry?.version, `package-lock version mismatch: ${entry?.name}`, errors);
      check(locked?.integrity === entry?.integrity, `package-lock integrity mismatch: ${entry?.name}`, errors);
    }
    if (['playwright-core', '@playwright/test'].includes(entry?.name)) {
      check(
        rootPackage.devDependencies?.[entry.name] === entry.version,
        `root development pin mismatch: ${entry.name}`,
        errors,
      );
    } else if (entry?.name !== 'promptfoo') {
      check(
        appPackage.dependencies?.[entry.name] === entry.version,
        `app production pin mismatch: ${entry.name}`,
        errors,
      );
    }
    if (entry?.distribution === 'development-only') {
      check(locked?.dev === true || entry.name === 'promptfoo', `development-only package is not marked dev: ${entry?.name}`, errors);
    }

    const component = sbom.components?.find(
      (candidate) =>
        candidate?.name === entry?.name &&
        candidate?.version === entry?.version &&
        candidate?.type !== 'file',
    );
    check(Boolean(component), `SBOM component missing: ${entry?.name}@${entry?.version}`, errors);
    check(licenseId(component) === entry?.license, `SBOM license mismatch: ${entry?.name}`, errors);
    check(property(component, 'npm:integrity') === entry?.integrity, `SBOM integrity mismatch: ${entry?.name}`, errors);
    check(property(component, 'vcs:commit') === entry?.gitCommit, `SBOM commit mismatch: ${entry?.name}`, errors);
    check(property(component, 'vcs:repository') === entry?.repositoryUrl, `SBOM repository mismatch: ${entry?.name}`, errors);

    const licenseFile = LICENSE_FILES.get(entry?.name);
    check(Boolean(licenseFile), `license mapping missing: ${entry?.name}`, errors);
    check(
      Boolean(licenseFile && existsSync(resolve(root, 'docs/oss/licenses', licenseFile))),
      `license file missing: ${entry?.name}`,
      errors,
    );
    check(
      licensesReadme.includes(`\`${entry?.name}\` ${entry?.version}`),
      `license README mapping missing: ${entry?.name}@${entry?.version}`,
      errors,
    );
    check(notices.includes(`\`${entry?.name}\` ${entry?.version}`), `third-party notice missing: ${entry?.name}@${entry?.version}`, errors);
  }

  check(sbom.bomFormat === 'CycloneDX' && sbom.specVersion === '1.6', 'SBOM must be CycloneDX 1.6', errors);
  check(sbom.version === 1, 'SBOM version must be deterministic integer 1', errors);
  check(!('serialNumber' in sbom), 'SBOM must not contain a generated serial number', errors);
  check(!('timestamp' in (sbom.metadata ?? {})), 'SBOM must not contain a generated timestamp', errors);

  for (const [id, version, commit, artifact, licenseFile] of GRAMMARS) {
    check(grammarInventory.includes(artifact), `grammar inventory artifact missing: ${artifact}`, errors);
    check(grammarInventory.includes(version), `grammar inventory version missing: ${id}@${version}`, errors);
    check(grammarInventory.includes(commit), `grammar inventory commit missing: ${id}`, errors);
    check(grammarInventory.includes(`licenses/${licenseFile}`), `grammar license mapping missing: ${id}`, errors);
    check(existsSync(resolve(root, 'docs/oss/licenses', licenseFile)), `grammar license file missing: ${id}`, errors);
    const component = sbom.components?.find((candidate) => candidate?.['bom-ref'] === `grammar:${id}@${version}`);
    check(Boolean(component), `grammar SBOM component missing: ${id}@${version}`, errors);
    check(component?.scope === 'required', `grammar SBOM scope mismatch: ${id}`, errors);
    check(licenseId(component) === 'MIT', `grammar SBOM license mismatch: ${id}`, errors);
    check(property(component, 'vcs:commit') === commit, `grammar SBOM commit mismatch: ${id}`, errors);
    check(property(component, 'vibespace:grammar-artifact') === artifact, `grammar SBOM artifact mismatch: ${id}`, errors);
  }

  const resources = tauri.bundle?.resources;
  check(Array.isArray(resources), 'Tauri bundle resources must be an explicit array', errors);
  for (const resource of REQUIRED_RESOURCES) {
    check(resources?.includes(resource), `Tauri OSS resource missing: ${resource}`, errors);
  }
  const resourceText = JSON.stringify(resources ?? []).toLowerCase();
  for (const forbidden of ['node_modules', 'playwright-browser', 'ms-playwright', 'promptfoo', '.env', 'credential', 'secret']) {
    check(!resourceText.includes(forbidden), `forbidden default bundle resource: ${forbidden}`, errors);
  }
  for (const excludedRuntime of ['playwright-core', '@playwright/test', 'promptfoo']) {
    check(
      appPackage.dependencies?.[excludedRuntime] === undefined,
      `default app dependency graph contains excluded runtime: ${excludedRuntime}`,
      errors,
    );
  }

  check(featurePack.schemaVersion === 1, 'feature-pack schemaVersion must be 1', errors);
  check(featurePack.defaultInstallerIncluded === false, 'Browser Agent pack must be excluded by default', errors);
  check(featurePack.separatelyRemovable === true, 'Browser Agent pack must be separately removable', errors);
  check(featurePack.separatelyMeasurable === true, 'Browser Agent pack must be separately measurable', errors);
  check(featurePack.installerMeasurementClaimed === false, 'feature pack must not claim installer measurement', errors);
  check(featurePack.measurementStatus === 'pending-build-verification', 'feature pack measurement must remain pending', errors);
  const browserBinary = featurePack.components?.find((component) => component?.name === 'playwright-browser-binaries');
  const optionalCore = featurePack.components?.find((component) => component?.name === 'playwright-core');
  check(optionalCore?.version === '1.61.1', 'optional playwright-core version mismatch', errors);
  check(optionalCore?.defaultInstallerIncluded === false, 'optional playwright-core must be excluded by default', errors);
  check(browserBinary?.defaultInstallerIncluded === false, 'Playwright browsers must be excluded from default installer', errors);
  check(browserBinary?.measuredBytes === null, 'unmeasured browser binaries must use null measuredBytes', errors);
  check(featurePack.excluded?.some((entry) => entry?.name === 'promptfoo' && entry?.version === '0.121.20'), 'Promptfoo exclusion must be explicit and pinned', errors);

  check(rootPackage.scripts?.['verify:pr31-oss'] === 'node scripts/pr31-oss-bundle.mjs', 'root OSS verification script mismatch', errors);
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze([...new Set(errors)].sort()) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = verifyPr31OssBundle();
  if (!result.ok) {
    for (const error of result.errors) console.error(`PR31 OSS: ${error}`);
    process.exitCode = 1;
  } else {
    console.log('PR31 OSS bundle metadata is internally consistent.');
  }
}
