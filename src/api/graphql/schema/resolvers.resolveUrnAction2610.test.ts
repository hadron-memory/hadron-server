/**
 * RED-FIRST pins for hadron-server#2610 — the `hrn:action:<root>:<agent-slug>:<code>`
 * URN kind on Query.resolveUrn (the CHECKED contract: Vera's Proposed cor:urn:010:01
 * amendment, issue comment 6447611964; Patrick's live-code attach; Xenophon's gate
 * receipt 2026-10-27).
 *
 * The shape: root + agent-slug name the Agent whose system memory holds the entry at
 * `register:<code>`; the leaf is the code (slug charset, ≤64 chars); 1:1 with that
 * register node — a computed SECOND address, the node URN keeps resolving. The URN
 * names the entry in ONE Agent: no nearest-first chain fallthrough on resolve.
 *
 * Dependency: urn-lib-js#24 (0.0.18) is not released, so the implementation is
 * dependency-held; these pins are written against the CHECKED contract while the lib
 * builds (task note). Positive round-trips are RED until the arm lands; the negations
 * pass trivially today (no arm ⇒ null) and pin the uniform-refusal rule so it cannot
 * regress once the arm exists: every failure — other tenant, unreadable memory,
 * missing code, malformed leaf — collapses to the same null.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { emitNodeUrnV2 } from '../../../lib/urnEmit.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;

/** The canonical valid code example from the amendment (dots are legal slug chars). */
const CODE = 'task.finish.open-children';
const CHILD_CODE = 'task.finish.open-children'; // same code, own entry, own Agent
const MISSING_CODE = 'task.assign.no-such-code';
const MEMO_LOC = 'tasks:finish';

let org: { id: string; urn: string };
let admin: { id: string };
let outsider: { id: string };
let teamAgent: { id: string; urn: string };
let teamMemoryId: string;
let teamMemoryUrn: string;
let childAgent: { id: string; urn: string };
let childMemoryId: string;

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const actionUrn = (agentUrn: string, code: string) => `hrn:action:${agentUrn}:${code}`;
const resolve = (c: Context, urn: string) => resolvers.Query.resolveUrn({}, { urn }, c);

async function node(memoryId: string, loc: string, extra: Record<string, unknown> = {}) {
  return db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: '# x', ...extra } });
}
const registerEntry = (memoryId: string, code: string) =>
  node(memoryId, `register:${code}`, { data: { registerEntry: { code, taskLoc: MEMO_LOC } } });

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId().toLowerCase();
  org = await db.organization.create({ data: { id: generateId(), name: 'au-org', urn: `au2610-${suffix}.example` } });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 2610001, githubUsername: 'au-admin', handle: 'au-admin', roles: ['READER'] },
  });
  outsider = await db.user.create({
    data: { id: generateId(), githubId: 2610002, githubUsername: 'au-out', handle: 'au-out', roles: ['READER'] },
  });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });

  // The Team Agent and a child Agent that EXTENDS it (the R138 override carrier).
  const created = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  const teamRow = await db.agent.findUniqueOrThrow({ where: { id: created.id } });
  teamAgent = { id: teamRow.id, urn: teamRow.urn };
  teamMemoryId = teamRow.systemMemoryId as string;
  const teamMem = await db.memory.findUniqueOrThrow({ where: { id: teamMemoryId } });
  teamMemoryUrn = teamMem.urn;
  // No visibility touch: a system memory's visibility is NULL by constraint
  // (chk_memory_visibility_class), so the read gate is org membership — an org
  // member reads it, an outsider does not (that refusal is pinned on purpose).
  await node(teamMemoryId, 'roles'); // the Team Agent marker (locateTeamAgent)

  const createdChild = await M.createAgent({}, { orgId: org.id, name: 'Child Agent' }, ctx(admin.id));
  await db.agent.update({ where: { id: createdChild.id }, data: { extendsAgentId: teamAgent.id } });
  const childRow = await db.agent.findUniqueOrThrow({ where: { id: createdChild.id } });
  childAgent = { id: childRow.id, urn: childRow.urn };
  childMemoryId = childRow.systemMemoryId as string;
});

describe('#2610 action URN — resolution (RED until the arm lands)', () => {
  it('round-trips a Team Agent register entry: resolve returns kind action, the register node id and the Agent system memory', async () => {
    const entry = await registerEntry(teamMemoryId, CODE);
    const r = await resolve(ctx(admin.id), actionUrn(teamAgent.urn, CODE));
    expect(r).toEqual({ kind: 'action', id: entry.id, memoryId: teamMemoryId });
  });

  it('resolves a child-Agent override under its OWN URN and does not shadow the Team Agent URN (the URN names one Agent)', async () => {
    const teamEntry = await registerEntry(teamMemoryId, CODE);
    const childEntry = await registerEntry(childMemoryId, CHILD_CODE);
    const c = ctx(admin.id);
    const byChild = await resolve(c, actionUrn(childAgent.urn, CHILD_CODE));
    const byTeam = await resolve(c, actionUrn(teamAgent.urn, CODE));
    expect(byChild).toEqual({ kind: 'action', id: childEntry.id, memoryId: childMemoryId });
    expect(byTeam).toEqual({ kind: 'action', id: teamEntry.id, memoryId: teamMemoryId });
  });

  it('heals through the NODE alias after the entry renames (register:old → register:new); the old code keeps resolving', async () => {
    const entry = await registerEntry(teamMemoryId, CODE);
    const renamedCode = 'task.finish.done-children';
    await M.moveNode(
      {},
      { sourceRef: entry.id, targetUrn: emitNodeUrnV2(teamMemoryUrn, `register:${renamedCode}`) },
      ctx(admin.id),
    );
    const c = ctx(admin.id);
    const byNew = await resolve(c, actionUrn(teamAgent.urn, renamedCode));
    const byOld = await resolve(c, actionUrn(teamAgent.urn, CODE));
    expect(byNew?.id).toBe(entry.id);
    expect(byOld?.id).toBe(entry.id); // old atom never stops resolving (alias heal)
  });

  it('exposes Node.actionUrn only for a register:<code> node in an Agent system memory', async () => {
    const field = (resolvers as any).Node?.actionUrn;
    expect(typeof field).toBe('function');
    const c = ctx(admin.id);
    const entry = await registerEntry(teamMemoryId, CODE);
    const regRow = await db.node.findUniqueOrThrow({
      where: { id: entry.id },
      include: { memory: { select: { id: true, urn: true } } },
    });
    await expect(field(regRow, {}, c)).resolves.toBe(actionUrn(teamAgent.urn, CODE));
    // a non-register node in the same system memory: null
    const plain = await node(teamMemoryId, 'plain-loc');
    const plainRow = await db.node.findUniqueOrThrow({
      where: { id: plain.id },
      include: { memory: { select: { id: true, urn: true } } },
    });
    await expect(field(plainRow, {}, c)).resolves.toBeNull();
    // a register:<code> node in a NON-Agent memory is not a register entry: null
    const otherMem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:plain-mem`,
        name: 'plain-mem',
        class: 'knowledge',
        visibility: 'ORGANIZATION',
      },
    });
    const stray = await registerEntry(otherMem.id, CODE);
    const strayRow = await db.node.findUniqueOrThrow({
      where: { id: stray.id },
      include: { memory: { select: { id: true, urn: true } } },
    });
    await expect(field(strayRow, {}, c)).resolves.toBeNull();
  });
});

describe('#2610 action URN — uniform refusal (null before AND after the arm lands)', () => {
  it('refuses another tenant\'s Team Agent URN exactly like a code that names nothing', async () => {
    await registerEntry(teamMemoryId, CODE);
    const out = ctx(outsider.id);
    expect(await resolve(out, actionUrn(teamAgent.urn, CODE))).toBeNull();
    expect(await resolve(out, actionUrn(teamAgent.urn, MISSING_CODE))).toBeNull();
  });

  it('refuses a missing code for an authorized caller', async () => {
    await registerEntry(teamMemoryId, CODE);
    expect(await resolve(ctx(admin.id), actionUrn(teamAgent.urn, MISSING_CODE))).toBeNull();
  });

  it('refuses a malformed leaf (bad charset, over length, empty)', async () => {
    await registerEntry(teamMemoryId, CODE);
    const c = ctx(admin.id);
    expect(await resolve(c, actionUrn(teamAgent.urn, 'bad code!'))).toBeNull();
    expect(await resolve(c, actionUrn(teamAgent.urn, 'áccent'))).toBeNull();
    expect(await resolve(c, actionUrn(teamAgent.urn, 'x'.repeat(65)))).toBeNull();
    expect(await resolve(c, actionUrn(teamAgent.urn, ''))).toBeNull();
  });

  it('refuses a PUBLIC Agent whose system memory the caller cannot read (agent gate passes, memory gate does not)', async () => {
    await registerEntry(teamMemoryId, CODE);
    await db.agent.update({ where: { id: teamAgent.id }, data: { visibility: 'PUBLIC' } });
    // the system memory is org-readable only (visibility NULL); the outsider
    // passes the PUBLIC agent gate but must still fail the memory read gate
    expect(await resolve(ctx(outsider.id), actionUrn(teamAgent.urn, CODE))).toBeNull();
  });

  it('leaves the pre-existing register:<code> NODE urn resolving unchanged (kind node, same id)', async () => {
    const entry = await registerEntry(teamMemoryId, CODE);
    const r = await resolve(ctx(admin.id), emitNodeUrnV2(teamMemoryUrn, `register:${CODE}`));
    expect(r?.kind).toBe('node');
    expect(r?.id).toBe(entry.id);
  });
});
