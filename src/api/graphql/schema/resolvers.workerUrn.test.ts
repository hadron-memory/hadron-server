import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #991 — the Worker URN: `hrn:worker:<root>:<app-slug>:<slug>`.
 *
 * The contract lines under test:
 *   - the slug is DERIVED at cast time and never refuses a cast (it iterates),
 *     so the name collision stays the only allocation failure a caller sees
 *     (cor:agt:020:02);
 *   - two names that slugify to one token — the pair PR #979 deliberately keeps
 *     castable — get DISTINCT URNs;
 *   - the URN is accepted anywhere a workerRef is, and resolves through
 *     Query.resolveUrn behind the SHARED worker read gate;
 *   - a retired worker still resolves (retirement frees nothing);
 *   - the migration's SQL backfill derives the same slug the runtime mints.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { workerSlugBase } from '../../../lib/workerSlug.js';
import { resolveWorkerRef } from '../../../lib/entityRef/workerRef.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const W = resolvers.Worker as any;

function ctx(userId?: string, appId?: string): Context {
  return { db, userId, appId, roles: ['READER'] };
}

let org: { id: string; urn: string };
let admin: { id: string };
let outsider: { id: string };
let roleAgent: { id: string };
let app: { id: string; urn: string };
let appSlug: string;

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'wurn-org', urn: `wurn-org-${suffix}.com` },
  });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 99400, githubUsername: `wurn-admin-${suffix}`, roles: ['READER'] },
  });
  outsider = await db.user.create({
    data: { id: generateId(), githubId: 99401, githubUsername: `wurn-out-${suffix}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });

  const role = await M.createAgent(
    {},
    {
      orgId: org.id,
      name: 'WURN Backend Engineer',
      personaRole: 'backend-engineer',
      systemPrompt: 'You are {{name}}, a {{role}}.',
    },
    ctx(admin.id),
  );
  roleAgent = { id: role.id };

  appSlug = 'wurn-team';
  app = await db.app.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      name: 'WURN Team App',
      urn: `${org.urn}:${appSlug}`,
    },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: roleAgent.id } });
});

const cast = (name: string, c: Context = ctx(admin.id)) =>
  M.castWorker({}, { appRef: app.id, agentRef: roleAgent.id, name }, c);

describe('#991 — slug minting', () => {
  it('derives the slug from the name at cast time', async () => {
    const worker = await cast('Iris');
    expect(worker.slug).toBe('iris');
  });

  it('gives distinct URNs to two names that slugify to one token', async () => {
    // The reason a name could not be the URN atom: cor:agt:020:02 keeps both
    // castable and PR #979 lets them share a mention token.
    const mj1 = await cast('Mary Jane');
    const mj2 = await cast('Mary-Jane');
    expect(workerSlugBase('Mary Jane')).toBe(workerSlugBase('Mary-Jane'));
    expect(mj1.slug).toBe('mary-jane');
    expect(mj2.slug).toBe('mary-jane-2');

    const urn1 = await W.urn(mj1, {}, ctx(admin.id));
    const urn2 = await W.urn(mj2, {}, ctx(admin.id));
    expect(urn1).not.toBe(urn2);
    expect(urn1).toBe(`hrn:worker:${org.urn}:${appSlug}:mary-jane`);
    expect(urn2).toBe(`hrn:worker:${org.urn}:${appSlug}:mary-jane-2`);
  });

  it('never refuses a cast over a slug collision — only over the NAME', async () => {
    await cast('Mary Jane');
    // Same derived slug, different name: succeeds (iterates).
    await expect(cast('Mary-Jane')).resolves.toBeTruthy();
    // Same name (case-insensitively): the one allocation refusal.
    try {
      await cast('mary jane');
      expect.fail('expected WORKER_NAME_TAKEN');
    } catch (e) {
      expect((e as GraphQLError).extensions?.code).toBe('WORKER_NAME_TAKEN');
    }
  });

  it('keeps a name that slugifies to nothing castable, under the fallback base', async () => {
    const w = await cast('!!!');
    expect(w.slug).toBe('worker');
    expect(await W.urn(w, {}, ctx(admin.id))).toBe(
      `hrn:worker:${org.urn}:${appSlug}:worker`,
    );
  });

  it('reserves the slug through retirement — the URN keeps resolving', async () => {
    const w = await cast('Iris');
    const urn = await W.urn(w, {}, ctx(admin.id));
    await M.retireWorker({}, { workerRef: w.id }, ctx(admin.id));

    // The row survives and the slug is not recycled.
    const again = await cast('Iris2');
    expect(again.slug).toBe('iris2');
    const { id } = await resolveWorkerRef(db, urn);
    expect(id).toBe(w.id);
  });
});

describe('#991 — the URN as a ref', () => {
  it('resolves through resolveWorkerRef, equivalently to the PK', async () => {
    const w = await cast('Iris');
    const urn = await W.urn(w, {}, ctx(admin.id));
    expect((await resolveWorkerRef(db, urn)).id).toBe(w.id);
    expect((await resolveWorkerRef(db, w.id)).id).toBe(w.id);
  });

  it('is accepted by Query.worker', async () => {
    const w = await cast('Iris');
    const urn = await W.urn(w, {}, ctx(admin.id));
    const read = await Q.worker({}, { ref: urn }, ctx(admin.id));
    expect(read.id).toBe(w.id);
  });

  it('is accepted by startSession workerRef', async () => {
    const w = await cast('Iris');
    const urn = await W.urn(w, {}, ctx(admin.id));
    const session = await M.startSession(
      {},
      { input: { id: generateId(), appRef: app.id, workerRef: urn, tool: 'vitest' } },
      ctx(admin.id),
    );
    expect(session.workerId).toBe(w.id);
  });

  it('refuses a URN naming a worker in another App, and a malformed one, identically', async () => {
    const w = await cast('Iris');
    await expect(
      resolveWorkerRef(db, `hrn:worker:${org.urn}:no-such-app:iris`),
    ).rejects.toThrow();
    await expect(resolveWorkerRef(db, `hrn:worker:${org.urn}:${appSlug}:nope`)).rejects.toThrow();
    // Wrong arity — the fixed 2-segment shape.
    await expect(resolveWorkerRef(db, `hrn:worker:${org.urn}:${appSlug}`)).rejects.toThrow();
    // Wrong type word.
    await expect(resolveWorkerRef(db, `hrn:apprun:${org.urn}:${appSlug}:iris`)).rejects.toThrow();
    expect(w.id).toBeTruthy();
  });
});

describe('#991 — resolveUrn dispatch', () => {
  it('resolves a worker URN for a caller who may read the App staff', async () => {
    const w = await cast('Iris');
    const urn = await W.urn(w, {}, ctx(admin.id));
    const res = await Q.resolveUrn({}, { urn }, ctx(admin.id));
    expect(res).toMatchObject({ kind: 'worker', id: w.id, organizationId: org.id });
  });

  it('collapses to null for a caller outside the App — no existence oracle', async () => {
    const w = await cast('Iris');
    const urn = await W.urn(w, {}, ctx(admin.id));
    expect(await Q.resolveUrn({}, { urn }, ctx(outsider.id))).toBeNull();
    // Indistinguishable from a worker that does not exist at all.
    expect(
      await Q.resolveUrn({}, { urn: `hrn:worker:${org.urn}:${appSlug}:ghost` }, ctx(outsider.id)),
    ).toBeNull();
    expect(w.id).toBeTruthy();
  });

  it('resolves a RETIRED worker (history must keep resolving)', async () => {
    const w = await cast('Iris');
    const urn = await W.urn(w, {}, ctx(admin.id));
    await M.retireWorker({}, { workerRef: w.id }, ctx(admin.id));
    const res = await Q.resolveUrn({}, { urn }, ctx(admin.id));
    expect(res).toMatchObject({ kind: 'worker', id: w.id });
  });
});

describe('#991 — sessions(workerRef:) is a filter, never a widener', () => {
  it('returns nothing for a supplied-but-BLANK ref, rather than every session', async () => {
    // PR #993 review: trimming a whitespace ref to '' and treating that as
    // "absent" drops the predicate entirely and returns the caller's whole
    // scope — the opposite of the filter contract, and a widening.
    const w = await cast('Iris');
    await M.startSession(
      {},
      { input: { id: generateId(), appRef: app.id, workerRef: w.id, tool: 'vitest' } },
      ctx(admin.id),
    );
    const all = await Q.sessions({}, {}, ctx(admin.id));
    expect(all.length).toBeGreaterThan(0);

    expect(await Q.sessions({}, { workerRef: '   ' }, ctx(admin.id))).toEqual([]);
    expect(await Q.sessions({}, { workerRef: '' }, ctx(admin.id))).toEqual([]);
  });

  it('still returns the unfiltered scope when the ref is OMITTED', async () => {
    const w = await cast('Iris');
    await M.startSession(
      {},
      { input: { id: generateId(), appRef: app.id, workerRef: w.id, tool: 'vitest' } },
      ctx(admin.id),
    );
    expect((await Q.sessions({}, {}, ctx(admin.id))).length).toBeGreaterThan(0);
  });

  it('returns nothing for a well-formed ref that names no worker', async () => {
    expect(
      await Q.sessions({}, { workerRef: `hrn:worker:${org.urn}:${appSlug}:ghost` }, ctx(admin.id)),
    ).toEqual([]);
  });
});

describe('#991 — migration backfill: cross-base collisions', () => {
  // Runs the REAL DO block out of the migration file — not a copy — against
  // rows whose derived bases overlap. PR #993 review found that ranking each
  // (app, base) partition independently hands one slug to two rows: `Iris`,
  // `Iris!`, and `Iris-2` derive bases `iris`, `iris`, `iris-2`, so the second
  // row is numbered `iris-2` and the third claims `iris-2` as its bare base.
  // The unique index then aborts the migration.
  const migrationSql = readFileSync(
    new URL(
      '../../../../prisma/migrations/20260815120000_worker_slug/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const backfillBlock = migrationSql.match(/DO \$\$[\s\S]*?END \$\$;/)?.[0];

  it('the migration file still contains a DO-block backfill', () => {
    expect(backfillBlock).toBeTruthy();
  });

  it.each([
    [['Iris', 'Iris!', 'Iris-2'], 'suffix equals a later row\'s bare base'],
    [['Mary Jane', 'Mary-Jane', 'Mary Jane 2'], 'the review\'s worked example'],
    [['Iris-2', 'Iris', 'Iris!'], 'the colliding base is inserted FIRST'],
    [['!!!', '???', '@@@'], 'every name falls back to the same base'],
  ])('assigns distinct slugs for %j (%s)', async (names) => {
    for (const [i, name] of names.entries()) {
      await db.worker.create({
        data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: roleAgent.id, name, slug: `seed-${i}` },
      });
    }
    // Re-run the backfill over these rows exactly as a migration would.
    await db.$executeRawUnsafe('ALTER TABLE workers ALTER COLUMN slug DROP NOT NULL');
    try {
      await db.$executeRawUnsafe('UPDATE workers SET slug = NULL');
      await db.$executeRawUnsafe(backfillBlock!);
      const rows = await db.worker.findMany({
        where: { appId: app.id },
        select: { name: true, slug: true },
      });
      const slugs = rows.map((r) => r.slug);
      expect(slugs).toHaveLength(names.length);
      expect(new Set(slugs).size).toBe(names.length); // no duplicates
      expect(slugs.every((s) => s && s.length <= 64)).toBe(true);
      // And the index the migration creates would actually build.
      await expect(
        db.$executeRawUnsafe(
          'CREATE UNIQUE INDEX wrk_slug_probe ON workers (app_id, slug)',
        ),
      ).resolves.toBeDefined();
      await db.$executeRawUnsafe('DROP INDEX wrk_slug_probe');
    } finally {
      await db.$executeRawUnsafe('ALTER TABLE workers ALTER COLUMN slug SET NOT NULL');
    }
  });

  it('gives the oldest casting the bare base', async () => {
    await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: roleAgent.id, name: 'Iris', slug: 'seed-a' },
    });
    await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: roleAgent.id, name: 'Iris!', slug: 'seed-b' },
    });
    await db.$executeRawUnsafe('ALTER TABLE workers ALTER COLUMN slug DROP NOT NULL');
    try {
      await db.$executeRawUnsafe('UPDATE workers SET slug = NULL');
      await db.$executeRawUnsafe(backfillBlock!);
      const rows = await db.worker.findMany({
        where: { appId: app.id },
        orderBy: { createdAt: 'asc' },
        select: { name: true, slug: true },
      });
      expect(rows[0]).toMatchObject({ name: 'Iris', slug: 'iris' });
      expect(rows[1].slug).toBe('iris-2');
    } finally {
      await db.$executeRawUnsafe('ALTER TABLE workers ALTER COLUMN slug SET NOT NULL');
    }
  });
});

describe('#991 — migration backfill parity', () => {
  // The migration derives slugs in SQL; the runtime derives them in JS. They
  // must agree, or a migrated row gets a different URN than the one the same
  // name would mint today. Runs the migration's EXACT base expression against
  // the DB and compares to workerSlugBase — the same cross-language pinning
  // takenWorkersByName does for lower().
  const BASE_SQL = `
    SELECT COALESCE(
      NULLIF(
        regexp_replace(
          left(
            regexp_replace(
              regexp_replace(
                regexp_replace(lower(btrim($1::text)), '[^a-z0-9._-]+', '-', 'g'),
                '^[._-]+', ''),
              '[._-]+$', ''),
            64),
          '[._-]+$', ''),
        ''),
      'worker') AS base`;

  it.each([
    'Iris',
    'Mary Jane',
    'Mary-Jane',
    '  Hello, World  ',
    'acme.com',
    'UPPER_case',
    '!!!',
    '...dots...',
    'a'.repeat(80),
    'café',
  ])('SQL and JS derive the same base for %j', async (name) => {
    const rows = await db.$queryRawUnsafe<{ base: string }[]>(BASE_SQL, name);
    expect(rows[0].base).toBe(workerSlugBase(name));
  });
});
