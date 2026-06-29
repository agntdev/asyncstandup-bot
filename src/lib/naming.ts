/**
 * User display helpers. We can't resolve Telegram usernames at scale, so we
 * format user IDs consistently. Telegram bots CANNOT DM a user by their ID
 * who hasn't started the bot — the invite-flow constraint is enforced at the
 * Member-add layer.
 */

/** A readable label for a user in digests/lists. */
export function userLabel(userId: number): string {
  return `Member #${userId}`;
}

/** A short label for inline display. */
export function userShort(userId: number): string {
  return `#${userId}`;
}
