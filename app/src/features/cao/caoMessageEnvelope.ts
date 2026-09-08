/** Keep the user's exact scope visible in approval and in the receiving agent's context. */
export function caoMessageEnvelope(direction: string, objective: string): string {
  if (!direction.trim() || direction.length > 8000 || !objective.trim() || objective.length > 8000)
    throw Error('cao_message_invalid');
  return `CAO direction:\n${direction.trim()}\n\nUser objective (complete):\n${objective}`;
}
