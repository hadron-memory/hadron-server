// The canonical mention token — the address side of the team-chat mention
// contract (cor:agt:020:04). Extracted to its own module during the PR #978
// review cycle; the mention-token UNIQUENESS that briefly accompanied it
// (workers_app_mention_token_uniq + a castWorker refusal) was removed by
// decision (Holger, 2026-08-14 / PR #979): cor:agt:020:02 keeps the
// case-insensitive NAME as the only uniqueness layer, so two names may
// legally share one token — a mention then addresses both workers, which is
// the accepted behavior of the one-format mention contract.

/** Broadcast mentions route once to every registered destination. */
export const BROADCAST_MENTION_TOKENS = ['all', 'team'] as const;
/** Name reservation is unconditional, including when new bare-team routing retires. */
export const RESERVED_WORKER_MENTION_TOKENS = ['all', 'team'] as const;

/**
 * Canonical mention token of a display name — the slug both sides of the
 * mention contract use (Codex P2 on PR #941): worker names may legally
 * contain spaces ("Mary Jane"), which the extraction atom cannot, so the
 * writer mentions `@mary-jane` and the reader slugs the resolved name the
 * same way. Lowercase; runs of out-of-atom characters collapse to `-`;
 * trimmed to alphanumeric ends. Returns null when nothing usable remains —
 * such a name is UNADDRESSABLE (never mentionable). The map is deliberately
 * LOSSY and carries no uniqueness guarantee: distinct worker names may share
 * a token, and the mention filter simply matches them all.
 */
export function mentionTokenOf(name: string): string | null {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '');
  return slug.length > 0 ? slug : null;
}
