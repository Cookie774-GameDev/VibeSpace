export function normalizeSiyuanFilesystemPath(value: string): string {
  const slashNormalized = value.replace(/\\/gu, '/');
  const verbatimDrive = /^(?:\/\/\?\/|\/\?\/)([A-Za-z]:\/.*)$/u.exec(slashNormalized);
  const legacyDrive = /^\/([A-Za-z]:\/.*)$/u.exec(slashNormalized);
  return verbatimDrive?.[1] ?? legacyDrive?.[1] ?? slashNormalized;
}

export function canonicalSiyuanAuthorityRoot(value: string): string {
  const slashNormalized = normalizeSiyuanFilesystemPath(value);
  const windowsRoot = /^[A-Za-z]:\//u.test(slashNormalized) || slashNormalized.startsWith('//');
  const normalized = slashNormalized.replace(/\/{2,}/gu, '/').replace(/\/$/u, '');
  return windowsRoot ? normalized.toLocaleLowerCase('en-US') : normalized;
}
