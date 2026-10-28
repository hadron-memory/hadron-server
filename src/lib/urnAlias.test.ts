import { WORKER_SIGNATURE_DEFAULTS } from './workerSignature.js';
/**
 * #1079 — the URN alias map: a rename no longer 404s every published URN.
 *
 * The defect: a URN is the platform's publishable identifier — it goes into
 * commit trailers, PR descriptions, issue signatures and chat archives, none of
 * which can be rewritten. Four entities store their URN in a column and all four
 * can be renamed, and no rename path recorded the old value. Worse, most URNs
 * are COMPOSED on read from one of those four, so a single memory rename
 * orphaned every published *node* URN beneath it.
 *
 * What this file pins, per rename path:
 *   - the old URN still resolves after the rename, and resolves to the SAME row;
 *   - **derived** URNs heal too, without their own resolvers knowing about
 *     renames — a worker URN through its App, a node URN through its memory;
 *   - a LIVE URN always beats an alias, so a re-used URN addresses its current
 *     owner and never the historical one;
 *   - liveness is re-checked, so an alias can never resurrect a soft-deleted or
 *     uninstalled row;
 *   - an ambiguous alias fails LOUDLY rather than picking one;
 *   - renaming back and forth does not accumulate duplicate rows (which would
 *     read as ambiguity and refuse a URN that resolves to exactly one entity);
 *   - the org cascade and the owner-handle cascade record aliases for the rows
 *     they rewrite, and only those.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { resolveAppRef } from './entityRef/appRef.js';
import { resolveMemoryRef } from './entityRef/memoryRef.js';
import { resolveAgentRef } from './entityRef/agentRef.js';
import { resolveOrgRef } from './entityRef/orgRef.js';
import { resolveWorkerRef, composeWorkerUrn } from './entityRef/workerRef.js';
import { recordUrnRename, findUrnAliasTargetIds, dedupeById } from './urnAlias.js';
import { propagateOrgUrnRename } from './org/propagateOrgUrnRename.js';
import { renameOwnerNamespacedUrns } from './ownerUrnRename.js';
import {
  AmbiguousLegacyUrnError,
  AppNotFoundError,
  MemoryNotFoundError,
  OrganizationNotFoundError,
} from './entityRef/errors.js';

let org: { id: string; urn: string };
let user: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'ua-org', urn: `ua-${suffix}.com` },
  });
  user = await db.user.create({
    data: { id: generateId(), githubId: 97810, githubUsername: `ua-${suffix}`, handle: `ua${suffix.replace(/\D/g, '')}`, roles: ['READER'] },
  });
});

const mkApp = (urn: string) =>
  db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'A', urn } });
const mkMemory = (urn: string) =>
  db.memory.create({
    data: { id: generateId(), organizationId: org.id, name: 'M', urn, class: 'knowledge' },
  });
const mkAgent = (urn: string) =>
  db.agent.create({
    data: { id: generateId(), organizationId: org.id, name: 'G', urn, visibility: 'ORGANIZATION' },
  });

describe('#1079 — an alias keeps a renamed entity reachable by its old URN', () => {
  it('App: the old URN resolves to the same App', async () => {
    const app = await mkApp(`${org.urn}:team`);
    await recordUrnRename(db, {
      entityType: 'APP', entityId: app.id, oldUrn: `${org.urn}:team`, newUrn: `${org.urn}:renamed`,
    });
    await db.app.update({ where: { id: app.id }, data: { urn: `${org.urn}:renamed` } });
    expect(await resolveAppRef(db, `hrn:app:${org.urn}:team`)).toEqual({ id: app.id });
    expect(await resolveAppRef(db, `hrn:app:${org.urn}:renamed`)).toEqual({ id: app.id });
  });

  it('Memory, Agent and Organization likewise', async () => {
    const mem = await mkMemory(`${org.urn}:docs`);
    const agent = await mkAgent(`${org.urn}:helper`);
    await recordUrnRename(db, { entityType: 'MEMORY', entityId: mem.id, oldUrn: mem.urn, newUrn: `${org.urn}:handbook` });
    await recordUrnRename(db, { entityType: 'AGENT', entityId: agent.id, oldUrn: agent.urn, newUrn: `${org.urn}:assistant` });
    await recordUrnRename(db, { entityType: 'ORGANIZATION', entityId: org.id, oldUrn: org.urn, newUrn: 'ua-renamed.com' });
    await db.memory.update({ where: { id: mem.id }, data: { urn: `${org.urn}:handbook` } });
    await db.agent.update({ where: { id: agent.id }, data: { urn: `${org.urn}:assistant` } });
    await db.organization.update({ where: { id: org.id }, data: { urn: 'ua-renamed.com' } });

    expect(await resolveMemoryRef(db, `hrn:mem:${org.urn}:docs`)).toEqual({ id: mem.id });
    expect(await resolveAgentRef(db, `hrn:agent:${org.urn}:helper`)).toEqual({ id: agent.id });
    expect(await resolveOrgRef(db, `hrn:org:${org.urn}`)).toEqual({ id: org.id });
  });
});

describe('#1079 — DERIVED URNs heal through their parent, with no change of their own', () => {
  it('a published worker URN survives an App rename', async () => {
    const agent = await mkAgent(`${org.urn}:se`);
    const app = await mkApp(`${org.urn}:team`);
    const worker = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Dara', slug: 'dara' },
    });
    // The URN as it would appear in a commit trailer or an issue signature.
    const published = composeWorkerUrn(app.urn, 'dara');
    expect(await resolveWorkerRef(db, published)).toEqual({ id: worker.id });

    await recordUrnRename(db, {
      entityType: 'APP', entityId: app.id, oldUrn: app.urn, newUrn: `${org.urn}:renamed`,
    });
    await db.app.update({ where: { id: app.id }, data: { urn: `${org.urn}:renamed` } });

    // workerRef knows nothing about renames: it resolves the App URN first, and
    // the App's alias is what carries the worker URN across.
    expect(await resolveWorkerRef(db, published)).toEqual({ id: worker.id });
  });

  it('a published node URN survives a memory rename', async () => {
    const mem = await mkMemory(`${org.urn}:specs`);
    const node = await db.node.create({
      data: { id: generateId(), memoryId: mem.id, loc: 'cor:api:230', name: 'n' },
    });
    const { resolveNodeRef } = await import('./entityRef/nodeRef.js');
    const published = `hrn:node:${org.urn}:specs:cor:api:230`;
    expect(await resolveNodeRef(db, published)).toEqual({ id: node.id });

    await recordUrnRename(db, {
      entityType: 'MEMORY', entityId: mem.id, oldUrn: mem.urn, newUrn: `${org.urn}:law`,
    });
    await db.memory.update({ where: { id: mem.id }, data: { urn: `${org.urn}:law` } });

    // The widest arm of the fix: node URNs are the platform's most-cited
    // identifier, and every one of them carries its memory's slug.
    expect(await resolveNodeRef(db, published)).toEqual({ id: node.id });
  });
});

describe('#1079 — a LIVE urn always beats an alias', () => {
  it('a re-used URN addresses its NEW owner, not the historical one', async () => {
    const first = await mkApp(`${org.urn}:team`);
    await recordUrnRename(db, {
      entityType: 'APP', entityId: first.id, oldUrn: `${org.urn}:team`, newUrn: `${org.urn}:old-team`,
    });
    await db.app.update({ where: { id: first.id }, data: { urn: `${org.urn}:old-team` } });
    // The freed URN is taken by a NEW App — legal, and the case an alias map
    // must not hijack.
    const second = await mkApp(`${org.urn}:team`);
    expect(await resolveAppRef(db, `hrn:app:${org.urn}:team`)).toEqual({ id: second.id });
  });
});

describe('#1079 — an alias never resurrects a dead row', () => {
  it('a soft-deleted App is not reachable through its alias', async () => {
    const app = await mkApp(`${org.urn}:team`);
    await recordUrnRename(db, {
      entityType: 'APP', entityId: app.id, oldUrn: app.urn, newUrn: `${org.urn}:renamed`,
    });
    await db.app.update({
      where: { id: app.id },
      data: { urn: `${org.urn}:renamed`, deletedAt: new Date() },
    });
    await expect(resolveAppRef(db, `hrn:app:${org.urn}:team`)).rejects.toBeInstanceOf(
      AppNotFoundError,
    );
    // …and opting in reaches it, proving the refusal came from the liveness
    // filter rather than a missing alias row.
    expect(await resolveAppRef(db, `hrn:app:${org.urn}:team`, { includeDeleted: true })).toEqual({
      id: app.id,
    });
  });

  it('an UNINSTALLED App is not reachable through its alias', async () => {
    const app = await mkApp(`${org.urn}:team`);
    await recordUrnRename(db, {
      entityType: 'APP', entityId: app.id, oldUrn: app.urn, newUrn: `${org.urn}:renamed`,
    });
    await db.app.update({
      where: { id: app.id },
      data: { urn: `${org.urn}:renamed`, uninstalledAt: new Date() },
    });
    await expect(resolveAppRef(db, `hrn:app:${org.urn}:team`)).rejects.toBeInstanceOf(
      AppNotFoundError,
    );
  });

  it('a soft-deleted memory is not reachable through its alias', async () => {
    const mem = await mkMemory(`${org.urn}:docs`);
    await recordUrnRename(db, {
      entityType: 'MEMORY', entityId: mem.id, oldUrn: mem.urn, newUrn: `${org.urn}:handbook`,
    });
    await db.memory.update({
      where: { id: mem.id },
      data: { urn: `${org.urn}:handbook`, deletedAt: new Date() },
    });
    await expect(resolveMemoryRef(db, `hrn:mem:${org.urn}:docs`)).rejects.toBeInstanceOf(
      MemoryNotFoundError,
    );
  });

  it('a soft-deleted org is not reachable through its alias', async () => {
    await recordUrnRename(db, {
      entityType: 'ORGANIZATION', entityId: org.id, oldUrn: org.urn, newUrn: 'ua-gone.com',
    });
    await db.organization.update({
      where: { id: org.id },
      data: { urn: 'ua-gone.com', deletedAt: new Date() },
    });
    await expect(resolveOrgRef(db, `hrn:org:${org.urn}`)).rejects.toBeInstanceOf(
      OrganizationNotFoundError,
    );
  });
});

describe('#1079 — ambiguity fails loudly rather than guessing', () => {
  it('two live Apps aliased from one URN refuse', async () => {
    const a = await mkApp(`${org.urn}:one`);
    const b = await mkApp(`${org.urn}:two`);
    // Both once answered to `:shared` — legal, at different times.
    await recordUrnRename(db, { entityType: 'APP', entityId: a.id, oldUrn: `${org.urn}:shared`, newUrn: `${org.urn}:one` });
    await recordUrnRename(db, { entityType: 'APP', entityId: b.id, oldUrn: `${org.urn}:shared`, newUrn: `${org.urn}:two` });
    await expect(resolveAppRef(db, `hrn:app:${org.urn}:shared`)).rejects.toBeInstanceOf(
      AmbiguousLegacyUrnError,
    );
  });

  it('an alias to a DEAD row does not make a live sibling ambiguous', async () => {
    const live = await mkApp(`${org.urn}:one`);
    const dead = await mkApp(`${org.urn}:two`);
    await recordUrnRename(db, { entityType: 'APP', entityId: live.id, oldUrn: `${org.urn}:shared`, newUrn: `${org.urn}:one` });
    await recordUrnRename(db, { entityType: 'APP', entityId: dead.id, oldUrn: `${org.urn}:shared`, newUrn: `${org.urn}:two` });
    await db.app.update({ where: { id: dead.id }, data: { deletedAt: new Date() } });
    // Liveness is applied BEFORE the ambiguity check, so the dead claimant does
    // not turn a resolvable URN into a refusal.
    expect(await resolveAppRef(db, `hrn:app:${org.urn}:shared`)).toEqual({ id: live.id });
  });
});

describe('#1079 — recordUrnRename is idempotent and refuses to record nonsense', () => {
  it('renaming back and forth does not accumulate duplicate rows', async () => {
    const app = await mkApp(`${org.urn}:team`);
    for (let i = 0; i < 3; i++) {
      await recordUrnRename(db, {
        entityType: 'APP', entityId: app.id, oldUrn: `${org.urn}:team`, newUrn: `${org.urn}:renamed`,
      });
    }
    expect(await db.urnAlias.count({ where: { urn: `${org.urn}:team` } })).toBe(1);
    // Which is what keeps the URN resolvable: three rows would read as ambiguous
    // and refuse a URN naming exactly one App.
    await db.app.update({ where: { id: app.id }, data: { urn: `${org.urn}:renamed` } });
    expect(await resolveAppRef(db, `hrn:app:${org.urn}:team`)).toEqual({ id: app.id });
  });

  it('a repeat rename through the same old URN refreshes the successor', async () => {
    const app = await mkApp(`${org.urn}:team`);
    await recordUrnRename(db, { entityType: 'APP', entityId: app.id, oldUrn: `${org.urn}:team`, newUrn: `${org.urn}:v2` });
    await recordUrnRename(db, { entityType: 'APP', entityId: app.id, oldUrn: `${org.urn}:team`, newUrn: `${org.urn}:v3` });
    const row = await db.urnAlias.findFirstOrThrow({ where: { urn: `${org.urn}:team` } });
    expect(row.replacedByUrn).toBe(`${org.urn}:v3`);
  });

  it('records nothing when the URN did not change, or either side is blank', async () => {
    const app = await mkApp(`${org.urn}:team`);
    await recordUrnRename(db, { entityType: 'APP', entityId: app.id, oldUrn: app.urn, newUrn: app.urn });
    await recordUrnRename(db, { entityType: 'APP', entityId: app.id, oldUrn: '', newUrn: app.urn });
    await recordUrnRename(db, { entityType: 'APP', entityId: app.id, oldUrn: app.urn, newUrn: '  ' });
    expect(await db.urnAlias.count()).toBe(0);
  });

  it('scopes lookups by entity type — an App alias never resolves a memory ref', async () => {
    const app = await mkApp(`${org.urn}:team`);
    await recordUrnRename(db, { entityType: 'APP', entityId: app.id, oldUrn: `${org.urn}:team`, newUrn: `${org.urn}:renamed` });
    await db.app.update({ where: { id: app.id }, data: { urn: `${org.urn}:renamed` } });
    expect(await findUrnAliasTargetIds(db, 'APP', `${org.urn}:team`)).toEqual([app.id]);
    expect(await findUrnAliasTargetIds(db, 'MEMORY', `${org.urn}:team`)).toEqual([]);
    await expect(resolveMemoryRef(db, `hrn:mem:${org.urn}:team`)).rejects.toBeInstanceOf(
      MemoryNotFoundError,
    );
  });
});

describe('dedupeById', () => {
  it('keeps the first of each id — the overlap the two alias sources have by construction', () => {
    expect(dedupeById([{ id: 'a' }, { id: 'b' }], [{ id: 'a' }])).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(dedupeById([], [])).toEqual([]);
  });
});

describe('#1079 — the org rename cascade records aliases for exactly the rows it rewrites', () => {
  it('a child renamed by the cascade is still reachable by its old URN', async () => {
    const mem = await mkMemory(`${org.urn}:docs`);
    const app = await mkApp(`${org.urn}:team`);
    const agent = await mkAgent(`${org.urn}:helper`);
    const oldOrgUrn = org.urn;
    const newOrgUrn = 'ua-renamed.com';

    await db.$transaction(async (tx) => {
      await recordUrnRename(tx, {
        entityType: 'ORGANIZATION', entityId: org.id, oldUrn: oldOrgUrn, newUrn: newOrgUrn,
      });
      await propagateOrgUrnRename(tx, org.id, oldOrgUrn, newOrgUrn);
      await tx.organization.update({ where: { id: org.id }, data: { urn: newOrgUrn } });
    });

    // Every child URN moved…
    expect((await db.memory.findUniqueOrThrow({ where: { id: mem.id } })).urn).toBe(`${newOrgUrn}:docs`);
    // …and every OLD child URN still resolves, which is the point.
    expect(await resolveMemoryRef(db, `hrn:mem:${oldOrgUrn}:docs`)).toEqual({ id: mem.id });
    expect(await resolveAppRef(db, `hrn:app:${oldOrgUrn}:team`)).toEqual({ id: app.id });
    expect(await resolveAgentRef(db, `hrn:agent:${oldOrgUrn}:helper`)).toEqual({ id: agent.id });
    expect(await resolveOrgRef(db, `hrn:org:${oldOrgUrn}`)).toEqual({ id: org.id });
  });

  it('records NO alias for a row the cascade skips', async () => {
    // A row already sitting at the target prefix is skipped by the UPDATE's
    // `NOT starts_with` guard; an alias for it would claim a rename that never
    // happened. The two predicates must agree exactly.
    const newOrgUrn = 'ua-target.com';
    const already = await mkMemory(`${newOrgUrn}:docs`);
    await db.$transaction((tx) => propagateOrgUrnRename(tx, org.id, org.urn, newOrgUrn));
    expect(await db.urnAlias.count({ where: { entityId: already.id } })).toBe(0);
  });

  it('is a no-op when the org URN did not change', async () => {
    await mkMemory(`${org.urn}:docs`);
    await db.$transaction((tx) => propagateOrgUrnRename(tx, org.id, org.urn, org.urn));
    expect(await db.urnAlias.count()).toBe(0);
  });
});

describe('#1079 — the owner-handle cascade records aliases too', () => {
  it('a user-owned entity is still reachable by its pre-rename URN', async () => {
    const oldHandle = 'oldhandle';
    const mem = await db.memory.create({
      data: { id: generateId(), ownerUserId: user.id, name: 'M', urn: `${oldHandle}:notes`, class: 'personal', userId: user.id },
    });
    const app = await db.app.create({
      data: { id: generateId(), ownerUserId: user.id, name: 'A', urn: `${oldHandle}:tool` },
    });
    await db.$transaction((tx) => renameOwnerNamespacedUrns(tx, user.id, oldHandle, 'newhandle'));

    expect((await db.memory.findUniqueOrThrow({ where: { id: mem.id } })).urn).toBe('newhandle:notes');
    expect(await resolveMemoryRef(db, `hrn:mem:${oldHandle}:notes`)).toEqual({ id: mem.id });
    expect(await resolveAppRef(db, `hrn:app:${oldHandle}:tool`)).toEqual({ id: app.id });
  });
});

describe('#1080 review — defects the first draft shipped', () => {
  it('normalizes the alias key on write, so a `::` stored urn is still findable', async () => {
    // A row may hold the canonical `::` spelling from the spec-021 migration
    // window, while every resolver queries the single-colon form. Storing the
    // key verbatim put it somewhere nothing ever looks.
    const app = await mkApp(`${org.urn}:team`);
    await recordUrnRename(db, {
      entityType: 'APP', entityId: app.id, oldUrn: `${org.urn}::team`, newUrn: `${org.urn}:renamed`,
    });
    await db.app.update({ where: { id: app.id }, data: { urn: `${org.urn}:renamed` } });
    const row = await db.urnAlias.findFirstOrThrow({ where: { entityId: app.id } });
    expect(row.urn).toBe(`${org.urn}:team`);
    expect(await resolveAppRef(db, `hrn:app:${org.urn}:team`)).toEqual({ id: app.id });
  });

  it('treats a `::` → `:` spelling change as no rename at all', async () => {
    const app = await mkApp(`${org.urn}:team`);
    await recordUrnRename(db, {
      entityType: 'APP', entityId: app.id, oldUrn: `${org.urn}::team`, newUrn: `${org.urn}:team`,
    });
    expect(await db.urnAlias.count()).toBe(0);
  });

  it('finds a live holder even when more than three dead ones came first', async () => {
    // The old `take: 3` was UNORDERED, so three dead claimants could hide the
    // live one and report a resolvable URN as missing.
    const shared = `${org.urn}:shared`;
    for (let i = 0; i < 4; i++) {
      const dead = await mkApp(`${org.urn}:dead-${i}`);
      await recordUrnRename(db, { entityType: 'APP', entityId: dead.id, oldUrn: shared, newUrn: dead.urn });
      await db.app.update({ where: { id: dead.id }, data: { deletedAt: new Date() } });
    }
    const live = await mkApp(`${org.urn}:live`);
    await recordUrnRename(db, { entityType: 'APP', entityId: live.id, oldUrn: shared, newUrn: live.urn });
    expect(await resolveAppRef(db, `hrn:app:${shared}`)).toEqual({ id: live.id });
  });

  it('a dead claimant does not make a NODE urn ambiguous', async () => {
    // resolveMemoryRef filtered liveness before the ambiguity check; the
    // node/edge arm did not, so the two surfaces disagreed about the same URN.
    const shared = `${org.urn}:shared`;
    const dead = await mkMemory(`${org.urn}:dead`);
    const live = await mkMemory(`${org.urn}:live`);
    await recordUrnRename(db, { entityType: 'MEMORY', entityId: dead.id, oldUrn: shared, newUrn: dead.urn });
    await recordUrnRename(db, { entityType: 'MEMORY', entityId: live.id, oldUrn: shared, newUrn: live.urn });
    await db.memory.update({ where: { id: dead.id }, data: { deletedAt: new Date() } });
    const node = await db.node.create({
      data: { id: generateId(), memoryId: live.id, loc: 'a:b', name: 'n' },
    });
    const { resolveNodeRef } = await import('./entityRef/nodeRef.js');
    expect(await resolveNodeRef(db, `hrn:node:${shared}:a:b`)).toEqual({ id: node.id });
  });

  it('a soft-deleted holder of a re-used urn does not suppress the alias arm', async () => {
    // `??` only fires on null, so an unfiltered primary lookup let a dead row
    // win the coalesce and the old URN 404'd despite a live historical claimant.
    const shared = `${org.urn}:shared`;
    const live = await mkMemory(`${org.urn}:live`);
    await recordUrnRename(db, { entityType: 'MEMORY', entityId: live.id, oldUrn: shared, newUrn: live.urn });
    const squatter = await mkMemory(shared);
    await db.memory.update({ where: { id: squatter.id }, data: { deletedAt: new Date() } });
    const node = await db.node.create({
      data: { id: generateId(), memoryId: live.id, loc: 'a:b', name: 'n' },
    });
    const { resolveNodeRef } = await import('./entityRef/nodeRef.js');
    expect(await resolveNodeRef(db, `hrn:node:${shared}:a:b`)).toEqual({ id: node.id });
  });

  it('an agent rename aliases the system memory it drags along', async () => {
    // The agent rename also renames its derived `<urn>-system` memory. Without a
    // MEMORY alias, every node URN under a Team Agent's roles: branch 404s.
    const sysMem = await mkMemory(`${org.urn}:helper-system`);
    const agent = await db.agent.create({
      data: {
        id: generateId(), organizationId: org.id, name: 'G', urn: `${org.urn}:helper`,
        visibility: 'ORGANIZATION', systemMemoryId: sysMem.id,
      },
    });
    const node = await db.node.create({
      data: { id: generateId(), memoryId: sysMem.id, loc: 'roles:backend', name: 'r' },
    });
    const published = `hrn:node:${org.urn}:helper-system:roles:backend`;

    const { resolvers } = await import('../api/graphql/schema/resolvers.js');
    await resolvers.Mutation.updateAgent(
      {},
      { ref: agent.id, urn: 'assistant' } as never,
      { db, userId: user.id, roles: ['ADMIN'], organizationId: org.id } as never,
    );

    expect((await db.memory.findUniqueOrThrow({ where: { id: sysMem.id } })).urn).toBe(
      `${org.urn}:assistant-system`,
    );
    const { resolveNodeRef } = await import('./entityRef/nodeRef.js');
    expect(await resolveNodeRef(db, published)).toEqual({ id: node.id });
  });
});

describe('#1080 re-review — a bound must never precede liveness', () => {
  it('finds the only live holder past the first alias page', async () => {
    // The cap moved 3 → 100 in the first fix round, which is the same defect at
    // a larger threshold. The walk now pages until it has enough LIVE rows, so
    // holder count cannot hide a resolvable URN.
    const shared = `${org.urn}:shared`;
    const dead: string[] = [];
    for (let i = 0; i < 120; i++) dead.push(`${org.urn}:dead-${i}`);
    // Created in bulk: 120 dead claimants is past one 100-row page.
    await db.app.createMany({
      data: dead.map((urn) => ({ id: generateId(), organizationId: org.id, name: 'A', urn })),
    });
    const deadRows = await db.app.findMany({ where: { urn: { in: dead } }, select: { id: true } });
    await db.urnAlias.createMany({
      data: deadRows.map((r) => ({
        id: generateId(), urn: shared, entityType: 'APP' as const,
        entityId: r.id, reason: 'RENAME' as const,
      })),
    });
    await db.app.updateMany({ where: { urn: { in: dead } }, data: { deletedAt: new Date() } });

    const live = await mkApp(`${org.urn}:live`);
    await recordUrnRename(db, { entityType: 'APP', entityId: live.id, oldUrn: shared, newUrn: live.urn });

    expect(await resolveAppRef(db, `hrn:app:${shared}`)).toEqual({ id: live.id });
  });

  it('still detects ambiguity when both live holders sit past the first page', async () => {
    const shared = `${org.urn}:shared`;
    const dead: string[] = [];
    for (let i = 0; i < 120; i++) dead.push(`${org.urn}:dead-${i}`);
    await db.app.createMany({
      data: dead.map((urn) => ({ id: generateId(), organizationId: org.id, name: 'A', urn })),
    });
    const deadRows = await db.app.findMany({ where: { urn: { in: dead } }, select: { id: true } });
    await db.urnAlias.createMany({
      data: deadRows.map((r) => ({
        id: generateId(), urn: shared, entityType: 'APP' as const,
        entityId: r.id, reason: 'RENAME' as const,
      })),
    });
    await db.app.updateMany({ where: { urn: { in: dead } }, data: { deletedAt: new Date() } });

    const a = await mkApp(`${org.urn}:one`);
    const b = await mkApp(`${org.urn}:two`);
    await recordUrnRename(db, { entityType: 'APP', entityId: a.id, oldUrn: shared, newUrn: a.urn });
    await recordUrnRename(db, { entityType: 'APP', entityId: b.id, oldUrn: shared, newUrn: b.urn });

    // Truncating the walk early would silently pick one of these.
    await expect(resolveAppRef(db, `hrn:app:${shared}`)).rejects.toBeInstanceOf(
      AmbiguousLegacyUrnError,
    );
  });

  // NOTE ON WHAT THIS DOES *NOT* COVER. This pins the PRE-TRANSACTION
  // derived-pattern guard, not the locked re-check inside the transaction.
  // Mutating that inner guard away leaves this test green, because the outer
  // check has already excluded this input — a green mutation indicting the
  // test, exactly as `review:a-green-mutation-indicts-the-test` describes. The
  // inner guard is reachable only when the pattern matches at the outer read and
  // has changed by the time the lock is acquired, which is a real interleaving
  // this suite cannot stage. It is documented as unproven at the call site
  // rather than deleted, and rather than claimed here to be tested.
  it('leaves a system memory that no longer matches the derived pattern alone', async () => {
    const sysMem = await mkMemory(`${org.urn}:helper-system`);
    const agent = await db.agent.create({
      data: {
        id: generateId(), organizationId: org.id, name: 'G', urn: `${org.urn}:helper`,
        visibility: 'ORGANIZATION', systemMemoryId: sysMem.id,
      },
    });
    // Simulate the concurrent winner: the memory no longer matches the pattern
    // derived from the agent urn this call read.
    await db.memory.update({ where: { id: sysMem.id }, data: { urn: `${org.urn}:moved-system` } });

    const { resolvers } = await import('../api/graphql/schema/resolvers.js');
    await resolvers.Mutation.updateAgent(
      {},
      { ref: agent.id, urn: 'assistant' } as never,
      { db, userId: user.id, roles: ['ADMIN'], organizationId: org.id } as never,
    );

    // Left alone, and no alias invented for a rename that did not happen.
    expect((await db.memory.findUniqueOrThrow({ where: { id: sysMem.id } })).urn).toBe(
      `${org.urn}:moved-system`,
    );
    expect(await db.urnAlias.count({ where: { entityId: sysMem.id } })).toBe(0);
  });
});
