/**
 * Build credential-shaped values only at test runtime. Keeping the prefix and
 * body in separate source literals preserves detector coverage without placing
 * alert-triggering credentials in Git blobs.
 */
export function syntheticCredentialFixture(prefix: string, body: string): string {
  return `${prefix}${body}`;
}
