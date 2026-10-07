/** A selected-file limit carried alongside the directory root used by native readers. */
export interface ContextLocalFileScopeV1 {
  readonly version: 1;
  readonly rootDir: string;
  readonly filePath: string;
}

export interface ContextLocalFileScopeSource {
  readonly sourceType?: string;
  readonly rootDir: string;
  readonly localFileScope?: unknown;
}

function invalidScope(): never {
  throw new Error('context_local_file_scope_invalid');
}

function normalizedPath(value: unknown, directory: boolean): string {
  if (typeof value !== 'string' || !value || value.length > 4_096 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    return invalidScope();
  }
  let path = value.replace(/\\/gu, '/');
  // Retain the existing normalizable drive picker forms, not arbitrary device/UNC roots.
  const drivePicker = /^(?:\/\/\?\/|\/\?\/|\/)([A-Za-z]:\/.*)$/u.exec(path);
  if (drivePicker) path = drivePicker[1]!;
  const windows = /^[A-Za-z]:\//u.test(path);
  // A backslash is a literal POSIX component character. Existing downstream
  // readers normalize separators, so such a source is unsupported, not an alias.
  if (!windows && value.includes('\\')) return invalidScope();
  if ((!windows && !path.startsWith('/')) || path.startsWith('//') || (!directory && path.endsWith('/'))) {
    return invalidScope();
  }
  const segments = path.split('/').filter(Boolean);
  if (segments.some((part) => part === '.' || part === '..')) return invalidScope();
  if (windows && segments.slice(1).some((part) => /[<>:"|?*]/u.test(part) || /[. ]$/u.test(part))) {
    return invalidScope();
  }
  path = path.replace(/\/{2,}/gu, '/');
  if (directory && path !== '/' && !/^[A-Za-z]:\/$/u.test(path)) path = path.replace(/\/$/u, '');
  if (!directory && (path === '/' || /^[A-Za-z]:\/$/u.test(path))) return invalidScope();
  return path;
}

function pathKey(path: string): string {
  // ASCII drive/name aliases are safe to compare here. Do not equate distinct
  // Unicode spellings via expanding case folds or Unicode normalization.
  return /^[A-Za-z]:\//u.test(path) ? path.replace(/[A-Z]/gu, (letter) => letter.toLowerCase()) : path;
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf('/');
  if (separator === 0) return '/';
  if (separator === 2 && /^[A-Za-z]:\//u.test(path)) return path.slice(0, 3);
  return path.slice(0, separator);
}

export function parseContextLocalFileScope(value: unknown): ContextLocalFileScopeV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidScope();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalidScope();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join('\u0000') !== ['filePath', 'rootDir', 'version'].join('\u0000') || record.version !== 1) {
    return invalidScope();
  }
  const rootDir = normalizedPath(record.rootDir, true);
  const filePath = normalizedPath(record.filePath, false);
  if (pathKey(parentPath(filePath)) !== pathKey(rootDir)) return invalidScope();
  return Object.freeze({ version: 1 as const, rootDir, filePath });
}

export function readContextLocalFileScope(
  source: ContextLocalFileScopeSource,
): ContextLocalFileScopeV1 | null {
  if (source.sourceType !== 'local_file') {
    if (source.localFileScope !== undefined) return invalidScope();
    return null;
  }
  if (source.localFileScope === undefined) throw new Error('context_local_file_scope_required');
  const scope = parseContextLocalFileScope(source.localFileScope);
  if (pathKey(normalizedPath(source.rootDir, true)) !== pathKey(scope.rootDir)) return invalidScope();
  return scope;
}

export function assertContextLocalFilePath(
  source: ContextLocalFileScopeSource,
  candidate: string,
): void {
  const scope = readContextLocalFileScope(source);
  if (!scope) return;
  let path: string;
  try {
    path = normalizedPath(candidate, false);
  } catch {
    throw new Error('context_local_file_path_denied');
  }
  if (pathKey(path) !== pathKey(scope.filePath)) throw new Error('context_local_file_path_denied');
}

export function contextLocalFileRelativePath(source: ContextLocalFileScopeSource): string | null {
  const scope = readContextLocalFileScope(source);
  return scope ? scope.filePath.slice(scope.filePath.lastIndexOf('/') + 1) : null;
}

export function contextLocalFileScopeFingerprint(source: ContextLocalFileScopeSource): string | null {
  const scope = readContextLocalFileScope(source);
  return scope ? JSON.stringify([scope.version, pathKey(scope.rootDir), pathKey(scope.filePath)]) : null;
}
