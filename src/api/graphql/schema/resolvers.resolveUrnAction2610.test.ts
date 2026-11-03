/**
 * Pins for hadron-server#2610 — the `hrn:action:<root>:<agent-slug>:<code>`
 * URN kind on Query.resolveUrn (the CHECKED contract: Vera's Proposed cor:urn:010:01
 * amendment, issue comment 6447611964; Patrick's live-code attach; Xenophon's gate
 * receipt 2026-10-27). Written red-first against the contract while the lib built;
 * the arm landed at d4ae3490b (urn-lib-js pinned to the v0.0.18 git tag).
 *
 * The shape: root + agent-slug name the Agent whose system memory holds the entry at
 * `register:<code>`; the leaf is the code (slug charset, ≤64 chars); 1:1 with that
 * register node — a computed SECOND address, the node URN keeps resolving. The URN
 * names the entry in ONE Agent: no nearest-first chain fallthrough on resolve.
 *
 * The negations pin the uniform-refusal rule: every failure — other tenant,
 * unreadable memory, missing code, malformed leaf — collapses to the same null.
 *
 * Review-driven pins (PR #2711 seats): the agent-gate pin and the chain
 * negative kill the two mutants that survived Dan's LOCAL mutation pass (B and
 * the fallthrough); the cross-memory move pin kills Rico's §10 allow-list
 * mutant; the field pins kill the deleted-Agent / no-agent / bad-code mutants
 * (G, H, J). Mutant A (dropping canReadMemory) is masked by construction —
 * resolveNodeRefForCaller re-applies the same memory gate below it — so it has
 * no individual pin; the PUBLIC-agent pair-pin covers the A+F interaction.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppMember, createDbAppWithKey } from '../../../test/helpers.js';
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

describe('#2610 action URN — resolution', () => {
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

describe('#2610 action URN — uniform refusal', () => {
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

describe('#2610 action URN — review-driven pins (PR #2711 LOCAL/§10 mutation kills)', () => {
  /**
   * Dan's LOCAL mutant B: dropping the agent gate (`visibility !== 'PUBLIC' &&
   * !isOwnerOrOrgMember`) left every test green because every outsider in the
   * fixtures also failed the memory gates. This pin is the one caller shape
   * that passes the memory gates but fails the agent gate: an App participant
   * (#2206 case 3 — the participant fold reads every installed, licensed
   * Agent's system memory) who is neither owner nor org member of a
   * non-PUBLIC Agent. The `agent` arm refuses exactly this caller, and the
   * action arm applies that gate verbatim — so the address an App participant
   * may still see on a readable node (Node.actionUrn computes for any reader
   * of the node) does not RESOLVE for them. That field/arm asymmetry is
   * intended at this head and pinned here; the SDL documents it.
   */
  it('refuses an App participant who READS the system memory but is not owner/org member (agent-gate mutant B)', async () => {
    await registerEntry(teamMemoryId, CODE);
    const { app } = await createDbAppWithKey(db, 'au-app', org.id);
    await createDbAppAgent(db, app.id, teamAgent.id);
    await createDbAppMember(db, app.id, outsider.id, 'member');
    const out = ctx(outsider.id);
    // the memory gates genuinely pass for this caller (otherwise the pin
    // would test the wrong gate): the node arm resolves the entry, and the
    // computed field is non-null on it.
    const entryRow = await db.node.findFirstOrThrow({ where: { memoryId: teamMemoryId, loc: `register:${CODE}` } });
    const byNode = await resolve(out, emitNodeUrnV2(teamMemoryUrn, `register:${CODE}`));
    expect(byNode?.kind).toBe('node');
    expect(byNode?.id).toBe(entryRow.id);
    const field = (resolvers as any).Node?.actionUrn;
    await expect(field(entryRow, {}, out)).resolves.toBe(actionUrn(teamAgent.urn, CODE));
    // …but the action arm refuses them (the agent gate, verbatim from the
    // `agent` arm — non-PUBLIC Agent, not owner, not org member).
    expect(await resolve(out, actionUrn(teamAgent.urn, CODE))).toBeNull();
  });

  /**
   * Dan's LOCAL P2-2: the no-chain-fallthrough rule was stated (the arm's own
   * comment) but only pinned as a positive — the shadow test resolves each
   * Agent's OWN entry. The negative: the child's URN with NO entry in the
   * child's memory, while the Team Agent holds one, names nothing.
   */
  it('refuses a child-Agent URN whose code exists only in the Team Agent\'s memory (no chain fallthrough)', async () => {
    await registerEntry(teamMemoryId, CODE); // only the Team Agent holds the entry
    expect(await resolve(ctx(admin.id), actionUrn(childAgent.urn, CODE))).toBeNull();
  });

  /**
   * Rico's §10 mutant M-series / Dan's LOCAL G, H, J on the computed field:
   * the three contract claims that had no pins. G: a soft-deleted Agent keys
   * no address. H: a memory with NO live Agent returns null BEFORE any
   * emittable-code work — the observable is no `not emittable` warning (the
   * mutant's swallowed TypeError logs exactly that misleading line). J: an
   * unemittable STORED code atom serves null, never a throw.
   */
  it('serves null for a register entry whose holding Agent is soft-deleted (mutant G)', async () => {
    const field = (resolvers as any).Node?.actionUrn;
    const entry = await registerEntry(teamMemoryId, CODE);
    await db.agent.update({ where: { id: teamAgent.id }, data: { deletedAt: new Date() } });
    await expect(field(entry, {}, ctx(admin.id))).resolves.toBeNull();
  });

  it('serves null with NO warning for a register loc in a memory no live Agent holds (mutant H)', async () => {
    const field = (resolvers as any).Node?.actionUrn;
    const otherMem = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:no-agent-mem`,
        name: 'no-agent-mem', class: 'knowledge', visibility: 'ORGANIZATION',
      },
    });
    const stray = await registerEntry(otherMem.id, CODE);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(field(stray, {}, ctx(admin.id))).resolves.toBeNull();
      expect(warn).not.toHaveBeenCalled(); // the no-agent exit precedes any emit work
    } finally {
      warn.mockRestore();
    }
  });

  it('serves null, never a throw, for an unemittable STORED code atom (mutant J)', async () => {
    const field = (resolvers as any).Node?.actionUrn;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // raw row: the create surface would refuse the loc; the point is what
      // READ does with a bad stored value (serve-and-log, #298 posture).
      const bad = await node(teamMemoryId, 'register:bad code!');
      await expect(field(bad, {}, ctx(admin.id))).resolves.toBeNull();
      expect(warn).toHaveBeenCalledTimes(1); // repair prompt, not silence
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * Rico's §10 allow-list mutant (line ~675): an UNMINTEd entry moved out of
   * the system memory still heals there through its NODE alias (the rename
   * widening), so without the `node` arm's content gate the arm would hand
   * back the entry to a caller who cannot read where it now lives. The
   * caller shape that isolates the allow-list: a PUBLIC Agent (agent gate
   * passes) + App participant (memory gate passes) whose accessible set does
   * NOT include the org knowledge memory the admin moved the entry into.
   * The admin companion also pins the healed-memory report: entry.memoryId,
   * the memory the entry lives in now — `node`-arm parity (§10 P3-2).
   */
  it('refuses a healed entry that moved OUT of the system memory when the caller cannot read where it lives (allow-list mutant F)', async () => {
    const entry = await registerEntry(teamMemoryId, CODE);
    await db.agent.update({ where: { id: teamAgent.id }, data: { visibility: 'PUBLIC' } });
    const { app } = await createDbAppWithKey(db, 'au-app2', org.id);
    await createDbAppAgent(db, app.id, teamAgent.id);
    await createDbAppMember(db, app.id, outsider.id, 'member');
    const movedMem = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:moved-mem`,
        name: 'moved-mem', class: 'knowledge', visibility: 'ORGANIZATION',
      },
    });
    await M.moveNode(
      {},
      { sourceRef: entry.id, targetUrn: emitNodeUrnV2(`${org.urn}:moved-mem`, `register:${CODE}`) },
      ctx(admin.id),
    );
    const out = ctx(outsider.id);
    // the participant passes the agent gate (PUBLIC) and the system-memory
    // read gate (the #2206 fold) — the allow-list on the entry's CURRENT
    // memory is what refuses them.
    expect(await resolve(out, actionUrn(teamAgent.urn, CODE))).toBeNull();
    // …while the org admin, whose accessible set includes the target memory,
    // still resolves — and is told the memory the entry lives in NOW.
    const byAdmin = await resolve(ctx(admin.id), actionUrn(teamAgent.urn, CODE));
    expect(byAdmin).toEqual({ kind: 'action', id: entry.id, memoryId: movedMem.id });
  });
});
