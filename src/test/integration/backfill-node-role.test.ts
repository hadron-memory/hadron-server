/**
 * #1216 — the `role` backfill migration.
 *
 * Executes the REAL migration file rather than a copy of its SQL. A copy is the
 * thing that drifts: the assertions would keep passing against a statement the
 * migration no longer contains, which is a test proving something about a file
 * nobody ships.
 *
 * The local dev and test databases are managed by `prisma db push` and carry no
 * migration history (CLAUDE.md), so nothing else in this repo ever runs this
 * file. Production does, on every restart, via `migrate deploy` — which makes
 * this the only place it is exercised before it reaches 421 rows of the
 * platform's oldest corpus.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';

const MIGRATION = join(
  import.meta.dirname,
  '../../../prisma/migrations/20260919170000_backfill_node_role/migration.sql',
);

/**
 * Split the file into executable statements. Prisma's raw helpers use the
 * extended protocol and reject multi-statement strings, and a naive split on
 * `;` would cut the `DO $$ … $$` block in half — so dollar-quoted bodies are
 * tracked and kept whole.
 */
function statements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inDollar = false;
  for (const line of sql.split('\n')) {
    const dollars = (line.match(/\$\$/g) ?? []).length;
    buf += line + '\n';
    if (dollars % 2 === 1) inDollar = !inDollar;
    if (!inDollar && line.trimEnd().endsWith(';')) {
      const stmt = buf
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('--'))
        .join('\n')
        .trim();
      if (stmt) out.push(stmt);
      buf = '';
    }
  }
  return out;
}

async function runMigration(): Promise<void> {
  for (const stmt of statements(readFileSync(MIGRATION, 'utf-8'))) {
    await db.$executeRawUnsafe(stmt);
  }
}

let org: { id: string };
const memIds: Record<string, string> = {};

/** A memory at an exact URN — the migration keys on URN, not id. */
async function mem(urn: string): Promise<string> {
  const m = await db.memory.create({
    data: { id: generateId(), urn, name: urn, class: 'knowledge', organizationId: org.id },
  });
  memIds[urn] = m.id;
  return m.id;
}

const node = (memoryId: string, loc: string, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, ...extra } });

const roleOf = async (memUrn: string, loc: string) =>
  (
    await db.node.findFirstOrThrow({
      where: { memoryId: memIds[memUrn], loc },
      select: { role: true },
    })
  ).role;

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 'bnr', urn: `bnr-${generateId()}` },
  });
  await mem('hadronmemory.com:specs');
  await mem('hadronmemory.com:hadron-server');
  await mem('hadronmemory.com:dev');
  // A DIFFERENT org's corpus, shaped identically — the scope boundary.
  await mem('micromentor.org:specs');
});

describe('#1216 — what the migration stamps', () => {
  it('stamps citation-shaped spec locs, at both feature and rule level', async () => {
    await node(memIds['hadronmemory.com:specs'], 'cor:acl:010');
    await node(memIds['hadronmemory.com:specs'], 'cor:acl:010:01');
    await runMigration();
    expect(await roleOf('hadronmemory.com:specs', 'cor:acl:010')).toBe('spec');
    expect(await roleOf('hadronmemory.com:specs', 'cor:acl:010:01')).toBe('spec');
  });

  it('stamps review locs across the repo memories', async () => {
    await node(memIds['hadronmemory.com:hadron-server'], 'review:narrow-catch-blocks');
    await runMigration();
    expect(await roleOf('hadronmemory.com:hadron-server', 'review:narrow-catch-blocks')).toBe('review');
  });
});

describe('#1216 — what it must NOT stamp', () => {
  it('leaves the module roots and the corpus overview alone', async () => {
    // The deliberate under-reach: index nodes are arguably specs, and governing
    // a node wrongly needs somebody with a door to undo it.
    for (const loc of ['cor', 'cor:acl', 'platform-specs', 'register']) {
      await node(memIds['hadronmemory.com:specs'], loc);
    }
    await runMigration();
    for (const loc of ['cor', 'cor:acl', 'platform-specs', 'register']) {
      expect(await roleOf('hadronmemory.com:specs', loc)).toBeNull();
    }
  });

  it('leaves a RUNNABLE node alone — two governed kinds is editable by nothing', async () => {
    // `tasks:create-platform-spec` really lives in the specs memory. A runnable
    // node carrying `role: 'spec'` is refused by `createTaskNode` for the role
    // and by `createSpecNode` for the capability (hadron-cli#615), so stamping
    // it would take it away from every door at once.
    await node(memIds['hadronmemory.com:specs'], 'tasks:create-platform-spec', { isRunnable: true });
    // …and the shape that would be caught ONLY by the runnable guard, since its
    // loc passes the citation test.
    await node(memIds['hadronmemory.com:specs'], 'cor:acl:999:01', { isRunnable: true });
    await runMigration();
    expect(await roleOf('hadronmemory.com:specs', 'tasks:create-platform-spec')).toBeNull();
    expect(await roleOf('hadronmemory.com:specs', 'cor:acl:999:01')).toBeNull();
  });

  it('leaves ANOTHER ORG alone, even with identical locs', async () => {
    // micromentor.org is explicitly out of scope. Identical shape, different
    // org — so a scope keyed on loc alone would take it and this proves the
    // memory-URN clause is load-bearing.
    await node(memIds['micromentor.org:specs'], 'cor:acl:010:01');
    await runMigration();
    expect(await roleOf('micromentor.org:specs', 'cor:acl:010:01')).toBeNull();
  });

  it('leaves a topically review-TAGGED node alone when it is not under review:', async () => {
    // The measured `dev` case: three nodes tagged `review` that are a
    // conventions node and two findings ABOUT review. A tag-driven sweep would
    // have governed all three.
    await node(memIds['hadronmemory.com:dev'], 'findings:a-review-artifact-is-not-a-review-verdict', {
      tags: ['findings', 'review'],
    });
    await runMigration();
    expect(
      await roleOf('hadronmemory.com:dev', 'findings:a-review-artifact-is-not-a-review-verdict'),
    ).toBeNull();
  });

  it('stamps an UNTAGGED review node — the tag predicate would have missed it', async () => {
    // hadron-cli#1152 drops tags on a generic update, so a check edited that way
    // has lost its marker. 21 real checks are in this state, one with NO tags at
    // all. This is the node the sweep exists for.
    await node(memIds['hadronmemory.com:hadron-server'], 'review:narrow-to-every-discriminator', {
      tags: [],
    });
    await runMigration();
    expect(
      await roleOf('hadronmemory.com:hadron-server', 'review:narrow-to-every-discriminator'),
    ).toBe('review');
  });

  it('applies the SAME guards on the review half, not just the spec half', async () => {
    // Found by mutation, not by review: removing `is_runnable IS NOT TRUE` or
    // `deleted_at IS NULL` changed BOTH statements and reddened only ONE test,
    // so the review half's guards were riding on the spec half's coverage. Two
    // statements, two sets of assertions.
    await node(memIds['hadronmemory.com:hadron-server'], 'review:runnable-one', { isRunnable: true });
    await node(memIds['hadronmemory.com:hadron-server'], 'review:deleted-one', { deletedAt: new Date() });
    await runMigration();
    expect(await roleOf('hadronmemory.com:hadron-server', 'review:runnable-one')).toBeNull();
    expect(await roleOf('hadronmemory.com:hadron-server', 'review:deleted-one')).toBeNull();
  });

  it('leaves a soft-deleted node alone', async () => {
    await node(memIds['hadronmemory.com:specs'], 'cor:acl:020:01', { deletedAt: new Date() });
    await runMigration();
    expect(await roleOf('hadronmemory.com:specs', 'cor:acl:020:01')).toBeNull();
  });
});

describe('#1216 — idempotency and pre-existing roles', () => {
  it('re-running is a no-op, not a second stamp', async () => {
    await node(memIds['hadronmemory.com:specs'], 'cor:acl:030:01');
    await runMigration();
    const first = await db.node.findFirstOrThrow({
      where: { memoryId: memIds['hadronmemory.com:specs'], loc: 'cor:acl:030:01' },
      select: { role: true, updatedAt: true },
    });
    await runMigration();
    const second = await db.node.findFirstOrThrow({
      where: { memoryId: memIds['hadronmemory.com:specs'], loc: 'cor:acl:030:01' },
      select: { role: true, updatedAt: true },
    });
    expect(second.role).toBe('spec');
    // The row is not touched again — `updated_at` would move if it were, and a
    // sweep that rewrites every row on every deploy is not idempotent in the
    // sense that matters.
    expect(second.updatedAt.getTime()).toBe(first.updatedAt.getTime());
  });

  it('does not overwrite a role a node already carries', async () => {
    await node(memIds['hadronmemory.com:specs'], 'cor:acl:040:01', { role: 'something-else' });
    await runMigration();
    expect(await roleOf('hadronmemory.com:specs', 'cor:acl:040:01')).toBe('something-else');
  });

  it('DOES stamp a node whose role is the empty string (#1219)', async () => {
    // `role IS NULL` alone would skip it: the server stores `''` verbatim while
    // the adjacent objectType normalizes it to null, so `''` is a second
    // spelling of ungoverned that a reader cannot distinguish.
    await node(memIds['hadronmemory.com:specs'], 'cor:acl:050:01', { role: '' });
    await runMigration();
    expect(await roleOf('hadronmemory.com:specs', 'cor:acl:050:01')).toBe('spec');
  });
});

describe('#1216 — the post-condition fails loudly', () => {
  it('raises if a governed node is also runnable', async () => {
    // The guards cannot produce this state; something upstream could. The
    // migration asserts it rather than shipping a node no door can edit.
    await node(memIds['hadronmemory.com:specs'], 'cor:zzz:010:01', {
      role: 'review',
      isRunnable: true,
    });
    await expect(runMigration()).rejects.toThrow(/governed role AND isRunnable/);
  });
});
