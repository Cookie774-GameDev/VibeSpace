/** Native Codex 0.151+ goal API; never emulate a goal with a slash-prefixed prompt. */
export function parseCodexGoalObjective(prompt: string): string | undefined {
  const match = /^\/goal(?:\s+([\s\S]*))?$/iu.exec(prompt.trim());
  if (!match) return undefined;
  const objective = match[1]?.trim();
  if (
    !objective ||
    objective.length > 100_000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(objective)
  ) {
    throw new Error('Use /goal <objective> to set a native Codex goal.');
  }
  return objective;
}

export function buildCodexGoalSetRequest(requestId: string, threadId: string, objective: string) {
  return {
    id: requestId,
    method: 'thread/goal/set' as const,
    params: { threadId, objective, status: 'active' as const },
  };
}

export function validateCodexGoalSetResult(
  result: unknown,
  threadId: string,
  objective: string,
): void {
  const goal = result && typeof result === 'object' && 'goal' in result ? result.goal : undefined;
  if (
    !goal ||
    typeof goal !== 'object' ||
    !('threadId' in goal) ||
    goal.threadId !== threadId ||
    !('objective' in goal) ||
    goal.objective !== objective ||
    !('status' in goal) ||
    goal.status !== 'active'
  ) {
    throw new Error('Codex did not confirm the requested native goal.');
  }
}
