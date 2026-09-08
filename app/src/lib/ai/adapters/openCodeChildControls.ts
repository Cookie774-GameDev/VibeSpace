export async function resolveOpenCodeChildControl(
  event: { type: string; properties?: Readonly<Record<string, unknown>> },
  rootSessionId: string,
  lookup: (id: string) => Promise<unknown>,
): Promise<string | undefined> {
  if (!['permission.asked', 'permission.updated', 'question.asked'].includes(event.type)) return;
  const identifier = (value: unknown): value is string =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(value);
  const child = event.properties?.sessionID ?? event.properties?.sessionId;
  if (!identifier(child) || !identifier(rootSessionId) || child === rootSessionId) return;
  const seen = new Set<string>();
  let current = child;
  for (let depth = 0; depth < 8; depth += 1) {
    if (seen.has(current)) return;
    seen.add(current);
    const value = await lookup(current).catch(() => undefined);
    if (!value || typeof value !== 'object') return;
    const session = value as Record<string, unknown>;
    if (session.id !== current || !identifier(session.parentID)) return;
    if (session.parentID === rootSessionId) return child;
    current = session.parentID;
  }
  return undefined;
}
