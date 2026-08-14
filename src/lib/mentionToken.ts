// The canonical mention token — the address side of the team-chat mention
// contract (cor:agt:020:04).
//
// It lives in its own module (moved out of resolvers.teamChat.ts by the PR #978
// review) because BOTH sides of the contract need it and they must not import
// each other: the chat resolver slugs a resolved name to match stored envelope
// tokens, and worker casting refuses a name whose token is already spoken for.
//
// There is a SQL mirror of this function — the `workers_app_mention_token_uniq`
// functional unique, written out in prisma/post-push.sql, the
// 20260814140000_worker_mention_token_uniq migration, and
// src/test/globalSetup.ts. Changing the rule here means changing all three, or
// the database will admit a pair of names this function maps to one address.

/**
 * Canonical mention token of a display name — the slug both sides of the
 * mention contract use (Codex P2 on PR #941): worker names may legally
 * contain spaces ("Mary Jane"), which the extraction atom cannot, so the
 * writer mentions `@mary-jane` and the reader slugs the resolved name the
 * same way. Lowercase; runs of out-of-atom characters collapse to `-`;
 * trimmed to alphanumeric ends. Returns null when nothing usable remains —
 * such a name is UNADDRESSABLE (never mentionable), not a collision, which is
 * why the SQL mirror excludes empty tokens from its unique index rather than
 * letting every unaddressable name share one slot.
 */
export function mentionTokenOf(name: string): string | null {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '');
  return slug.length > 0 ? slug : null;
}
