/**
 * #4335 (part of #434 Slice C): migration 20260519180903_baseline_init builds `memories_user_id_idx` and
 * `users_external_app_id_external_id_key` PARTIAL (`WHERE (... IS NOT NULL)`), and `prisma db push`, which cannot model
 * an index predicate, builds both full. The uniqueness rule is the same either way (no `NULLS NOT DISTINCT` anywhere, so
 * a full unique never collides on a NULL `external_id`), but the dev and test path (push + post-push.sql) must carry the
 * migration's exact definitions so the catalogs compare equal.
 */
import { describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';

const INDEXES: Array<[name: string, tail: string]> = [
  ['memories_user_id_idx', 'memories USING btree (user_id) WHERE (user_id IS NOT NULL)'],
  ['users_external_app_id_external_id_key', 'users USING btree (external_app_id, external_id) WHERE (external_id IS NOT NULL)'],
];

describe('#4335 the two partial indexes carry the migration definition on push + post-push', () => {
  it.each(INDEXES)('%s is partial, as the migration builds it', async (name, tail) => {
    const [row] = await db.$queryRaw<Array<{ def: string | null; schema: string }>>`
      SELECT pg_get_indexdef(to_regclass(quote_ident(current_schema()) || '.' || quote_ident(${name}))) AS def,
             current_schema() AS schema`;
    expect(row.def).not.toBeNull();
    expect(row.def!.slice(row.def!.indexOf(' ON '))).toBe(` ON ${row.schema}.${tail}`);
  });
});
