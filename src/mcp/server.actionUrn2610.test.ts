/**
 * MCP-side pins for hadron-server#2610 — the `hrn:action:<root>:<agent-slug>:<code>`
 * URN on the READ surface (cor:urn:010:01, Proposed). The GraphQL arm and
 * Node.actionUrn are pinned in resolvers.resolveUrnAction2610.test.ts; this file
 * pins their MCP twins so the two surfaces cannot drift apart:
 *
 *   - `hadron_get_node` accepts the action URN as a register entry's SECOND
 *     address and serves the ENTRY's projection — byte-identical to the same
 *     node read by its node URN (one projection for both addresses).
 *   - The projection carries an `Action URN:` line on every read of an entry
 *     (the discovery direction: an agent reading the register node by its node
 *     URN learns the action address to cite), and NOT on anything else.
 *   - `hadron_get_nodes` (batch) renders the same line per node — cor:api:040:01
 *     per-node parity with the single read.
 *   - The arm's uniform refusal (other tenant, unreadable memory, unknown
 *     agent, missing or malformed code → one not-found message) and its two
 *     review-carry gates: the agent gate verbatim (the PR #2711 mutant-B caller
 *     shape) and the content gate on the memory a healed entry actually lives
 *     in (§10 P3-2 / mutant F).
 *
 * `hadron_run_action` (invoking an action by URN) is the run slice, not the
 * read slice — deliberately absent here.
 *
 * Mutation pass (the PR #2711 discipline): dropping the action branch, the
 * agent gate, the register:-only line predicate, or the batch's actionUrns
 * wiring are each killed by a pin below. Two gates are MASKED by construction,
 * as the GraphQL file documents for its mutant A: resolveActionEntryRef's
 * system-memory gate is re-applied by the entry-memory gate it flows into
 * (the entry lives in that memory unless a heal moved it), and the
 * entry-memory gate is re-applied by serveNodeReadProjection's
 * loadCurrentReadProjection on current.memoryId — the refusal message is
 * identical either way. Both stay in the branch for parity with the arm's
 * line-to-line structure and because the helper's null-for-every-refusal
 * contract must not depend on its one caller.
 *
 * Test harness: createTestableMcpServer drives the registered tool callbacks
 * without an HTTP transport, so this exercises the production closure.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppMember, createDbAppWithKey } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { emitNodeUrnV2 } from '../lib/urnEmit.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import { AmbiguousLegacyUrnError } from '../lib/entityRef/errors.js';
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const PORTAL = 'https://hadronmemory.com';
const M = resolvers.Mutation as any;

/** The canonical valid code example from the amendment (dots are legal slug chars). */
const CODE = 'task.finish.open-children';
const MISSING_CODE = 'task.assign.no-such-code';

let org: { id: string; urn: string };
let admin: { id: string };
let outsider: { id: string };
let teamAgent: { id: string; urn: string };
let teamMemoryId: string;
let teamMemoryUrn: string;
let childAgent: { id: string; urn: string };

const gqlCtx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const auth = (userId: string): AuthContext => ({ userId, roles: ['READER'], clientId: `user:${userId}` });
const actionUrn = (agentUrn: string, code: string) => `hrn:action:${agentUrn}:${code}`;
const getNode = (ref: string, params: Record<string, unknown> = {}) =>
  createTestableMcpServer(auth(admin.id)).callToolText('hadron_get_node', { urn: ref, ...params });

async function node(memoryId: string, loc: string, extra: Record<string, unknown> = {}) {
  return db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: '# x', ...extra } });
}
const registerEntry = (memoryId: string, code: string) =>
  node(memoryId, `register:${code}`, { data: { registerEntry: { code, taskLoc: 'tasks:finish' } } });

beforeEach(async () => {
  await cleanDb(db);
  process.env.FRONTEND_URL = PORTAL;
  const suffix = generateId().toLowerCase();
  org = await db.organization.create({ data: { id: generateId(), name: 'mcp-au-org', urn: `mcpau2610-${suffix}.example` } });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 2610101, githubUsername: 'mcp-au-admin', handle: 'mcp-au-admin', roles: ['READER'] },
  });
  outsider = await db.user.create({
    data: { id: generateId(), githubId: 2610102, githubUsername: 'mcp-au-out', handle: 'mcp-au-out', roles: ['READER'] },
  });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });

  const created = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, gqlCtx(admin.id));
  const teamRow = await db.agent.findUniqueOrThrow({ where: { id: created.id } });
  teamAgent = { id: teamRow.id, urn: teamRow.urn };
  teamMemoryId = teamRow.systemMemoryId as string;
  teamMemoryUrn = (await db.memory.findUniqueOrThrow({ where: { id: teamMemoryId } })).urn;
  await node(teamMemoryId, 'roles'); // the Team Agent marker (locateTeamAgent)

  const createdChild = await M.createAgent({}, { orgId: org.id, name: 'Child Agent' }, gqlCtx(admin.id));
  await db.agent.update({ where: { id: createdChild.id }, data: { extendsAgentId: teamAgent.id } });
  const childRow = await db.agent.findUniqueOrThrow({ where: { id: createdChild.id } });
  childAgent = { id: childRow.id, urn: childRow.urn };
});

afterEach(() => {
  // vitest.config pins FRONTEND_URL off for every other file; restore that.
  process.env.FRONTEND_URL = '';
});

describe('#2610 — hadron_get_node action branch', () => {
  it('serves the register entry under its action address, with both addresses in one projection', async () => {
    const entry = await registerEntry(teamMemoryId, CODE);
    const text = await getNode(actionUrn(teamAgent.urn, CODE));
    expect(text).toContain(`hrn:node:${teamMemoryUrn}:register:${CODE}`);
    expect(text).toContain(`Action URN: ${actionUrn(teamAgent.urn, CODE)}`);
    expect(text).toContain(`ID: ${entry.id}`);
    expect(text).toContain('# x');
  });

  it('serves the SAME projection for both of the node\'s addresses (byte-identical)', async () => {
    await registerEntry(teamMemoryId, CODE);
    const byAction = await getNode(actionUrn(teamAgent.urn, CODE));
    const byNode = await getNode(emitNodeUrnV2(teamMemoryUrn, `register:${CODE}`));
    expect(byAction).toBe(byNode);
  });

  it('serves exactly the node resolveUrn\'s action arm resolves (cross-surface parity)', async () => {
    const entry = await registerEntry(teamMemoryId, CODE);
    const urn = actionUrn(teamAgent.urn, CODE);
    const resolved = await resolvers.Query.resolveUrn({}, { urn }, gqlCtx(admin.id));
    expect(resolved).toEqual({ kind: 'action', id: entry.id, memoryId: teamMemoryId });
    const text = await getNode(urn);
    expect(text).toContain(`ID: ${resolved!.id}`);
  });

  it('refuses another tenant\'s agent exactly like a code that names nothing (uniform refusal)', async () => {
    await registerEntry(teamMemoryId, CODE);
    const out = createTestableMcpServer(auth(outsider.id));
    const otherTenant = await out.callToolText('hadron_get_node', { urn: actionUrn(teamAgent.urn, CODE) });
    const missing = await out.callToolText('hadron_get_node', { urn: actionUrn(teamAgent.urn, MISSING_CODE) });
    expect(otherTenant).toBe(`Node "${actionUrn(teamAgent.urn, CODE)}" not found.`);
    expect(missing).toBe(otherTenant.replace(CODE, MISSING_CODE));
  });

  it('refuses a missing code for an authorized caller', async () => {
    await registerEntry(teamMemoryId, CODE);
    const text = await getNode(actionUrn(teamAgent.urn, MISSING_CODE));
    expect(text).toBe(`Node "${actionUrn(teamAgent.urn, MISSING_CODE)}" not found.`);
  });

  it('refuses a malformed leaf (bad charset, over length)', async () => {
    await registerEntry(teamMemoryId, CODE);
    for (const bad of ['bad code!', 'x'.repeat(65)]) {
      const text = await getNode(actionUrn(teamAgent.urn, bad));
      expect(text).toBe(`Node "${actionUrn(teamAgent.urn, bad)}" not found.`);
    }
  });

  it('refuses a PUBLIC Agent whose system memory the caller cannot read (agent gate passes, memory gate does not)', async () => {
    await registerEntry(teamMemoryId, CODE);
    await db.agent.update({ where: { id: teamAgent.id }, data: { visibility: 'PUBLIC' } });
    const text = await createTestableMcpServer(auth(outsider.id))
      .callToolText('hadron_get_node', { urn: actionUrn(teamAgent.urn, CODE) });
    expect(text).toBe(`Node "${actionUrn(teamAgent.urn, CODE)}" not found.`);
  });

  it('refuses an App participant who READS the entry by node address but is not owner/org member (agent gate, verbatim)', async () => {
    await registerEntry(teamMemoryId, CODE);
    const { app } = await createDbAppWithKey(db, 'mcp-au-app', org.id);
    await createDbAppAgent(db, app.id, teamAgent.id);
    await createDbAppMember(db, app.id, outsider.id, 'member');
    const out = createTestableMcpServer(auth(outsider.id));
    // The memory gates genuinely pass for this caller (otherwise the pin would
    // test the wrong gate): the NODE address serves the entry's projection.
    const byNode = await out.callToolText('hadron_get_node', {
      urn: emitNodeUrnV2(teamMemoryUrn, `register:${CODE}`),
    });
    expect(byNode).toContain(`Action URN: ${actionUrn(teamAgent.urn, CODE)}`);
    // …but the ACTION address refuses them — the `agent` arm's gate, verbatim.
    const byAction = await out.callToolText('hadron_get_node', { urn: actionUrn(teamAgent.urn, CODE) });
    expect(byAction).toBe(`Node "${actionUrn(teamAgent.urn, CODE)}" not found.`);
  });

  it('refuses a child-Agent URN whose code exists only in the Team Agent\'s memory (no chain fallthrough)', async () => {
    await registerEntry(teamMemoryId, CODE); // only the Team Agent holds the entry
    const text = await getNode(actionUrn(childAgent.urn, CODE));
    expect(text).toBe(`Node "${actionUrn(childAgent.urn, CODE)}" not found.`);
  });

  it('keeps an OLD code resolving after the entry renames (alias heal) and reports the CURRENT address', async () => {
    const entry = await registerEntry(teamMemoryId, CODE);
    const renamed = 'task.finish.done-children';
    await M.moveNode(
      {},
      { sourceRef: entry.id, targetUrn: emitNodeUrnV2(teamMemoryUrn, `register:${renamed}`) },
      gqlCtx(admin.id),
    );
    const text = await getNode(actionUrn(teamAgent.urn, CODE)); // the OLD code
    expect(text).toContain(`ID: ${entry.id}`);
    // The projection reports where the entry lives NOW — cor:urn:030:01. (The
    // node NAME and Data envelope still carry the old code as content; only
    // the ADDRESS lines speak the current address.)
    expect(text).toContain(`hrn:node:${teamMemoryUrn}:register:${renamed}`);
    expect(text).toContain(`Action URN: ${actionUrn(teamAgent.urn, renamed)}`);
    expect(text).not.toMatch(new RegExp(`^hrn:(node|action):.*register:${CODE.replace('.', '\\.')}$`, 'm'));
  });

  it('refuses a healed entry that moved OUT of the system memory when the caller cannot read where it lives', async () => {
    const entry = await registerEntry(teamMemoryId, CODE);
    await db.agent.update({ where: { id: teamAgent.id }, data: { visibility: 'PUBLIC' } });
    const { app } = await createDbAppWithKey(db, 'mcp-au-app2', org.id);
    await createDbAppAgent(db, app.id, teamAgent.id);
    await createDbAppMember(db, app.id, outsider.id, 'member');
    const movedMem = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:mcp-moved-mem`,
        name: 'mcp-moved-mem', class: 'knowledge', visibility: 'ORGANIZATION',
      },
    });
    await M.moveNode(
      {},
      { sourceRef: entry.id, targetUrn: emitNodeUrnV2(movedMem.urn, `register:${CODE}`) },
      gqlCtx(admin.id),
    );
    const out = createTestableMcpServer(auth(outsider.id));
    const text = await out.callToolText('hadron_get_node', { urn: actionUrn(teamAgent.urn, CODE) });
    expect(text).toBe(`Node "${actionUrn(teamAgent.urn, CODE)}" not found.`);
    // The admin still resolves it — to where the entry lives NOW (the healed
    // memory's address, not the system memory the ref started from).
    const adminText = await getNode(actionUrn(teamAgent.urn, CODE));
    expect(adminText).toContain(`hrn:node:${movedMem.urn}:register:${CODE}`);
  });

  it('still validates contentScope on the action path', async () => {
    await registerEntry(teamMemoryId, CODE);
    const text = await getNode(actionUrn(teamAgent.urn, CODE), { contentScope: 'bogus' });
    expect(text).toMatch(/contentScope/i);
    expect(text).not.toContain('not found');
  });
});

describe('#2610 — Action URN projection line', () => {
  it('appears when the entry is read by its NODE address (the discovery direction)', async () => {
    await registerEntry(teamMemoryId, CODE);
    const text = await getNode(emitNodeUrnV2(teamMemoryUrn, `register:${CODE}`));
    expect(text).toContain(`Action URN: ${actionUrn(teamAgent.urn, CODE)}`);
  });

  it('sits directly under the URL line (identifiers stay together) and survives no-portal', async () => {
    await registerEntry(teamMemoryId, CODE);
    const withPortal = await getNode(emitNodeUrnV2(teamMemoryUrn, `register:${CODE}`));
    const lines = withPortal.split('\n');
    const urlIdx = lines.findIndex((l) => l.startsWith('URL: '));
    expect(lines[urlIdx + 1]).toBe(`Action URN: ${actionUrn(teamAgent.urn, CODE)}`);
    // No portal configured ⇒ no URL line, but the action address stays: the
    // line describes the node, not the portal.
    process.env.FRONTEND_URL = '';
    const noPortal = await getNode(emitNodeUrnV2(teamMemoryUrn, `register:${CODE}`));
    expect(noPortal).not.toMatch(/^URL: /m);
    expect(noPortal).toContain(`Action URN: ${actionUrn(teamAgent.urn, CODE)}`);
  });

  it('is absent for a non-register node, and for a register:<code> node no live Agent holds', async () => {
    // Dan's carry P2: the non-register loc must carry a slug-valid tail past
    // 'register:'.length — a short or hyphen-leading tail (e.g. plain-loc -> '', plain-loc-node -> '-node', both invalid atoms) makes the emitter throw, and a mutant
    // that drops the startsWith predicate survives this pin vacuously.
    await node(teamMemoryId, 'abcdefghijklmn');
    const plain = await getNode(emitNodeUrnV2(teamMemoryUrn, 'abcdefghijklmn'));
    expect(plain).not.toMatch(/^Action URN: /m);

    const strayMem = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:mcp-stray-mem`,
        name: 'mcp-stray-mem', class: 'knowledge', visibility: 'ORGANIZATION',
      },
    });
    await registerEntry(strayMem.id, CODE);
    const stray = await getNode(emitNodeUrnV2(strayMem.urn, `register:${CODE}`));
    expect(stray).not.toMatch(/^Action URN: /m);
  });

  // (A soft-deleted Agent's system memory refuses the READ itself — "Memory
  // not found" — so the mutant-G line-omission observable is masked by
  // construction on this surface (GraphQL's node read still serves the entry;
  // the two surfaces' memory gates differ here, pre-existing); the helpers
  // keep the deletedAt filter for parity with Node.actionUrn, and the ACTION
  // address's own deleted-agent refusal IS pinned, in the delta-review
  // describe below.)

  it('is omitted, never a throw, for an unemittable STORED code atom', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // raw row: the create surface would refuse the loc; the point is what
      // READ does with a bad stored value (serve-and-log, #298 posture). The
      // ref is composed MANUALLY (not emitNodeUrnV2, which validates atoms)
      // because a row that predates loc validation is exactly one whose
      // address no strict emitter will compose.
      await node(teamMemoryId, 'register:bad code!');
      const text = await getNode(`hrn:node:${teamMemoryUrn}:register:bad code!`);
      expect(text).not.toMatch(/^Action URN: /m);
      // One repair prompt for the ACTION line specifically (the read's corrupt
      // loc also trips the pre-existing [safeUrnEmit] fallback warn — not ours).
      expect(warn.mock.calls.filter((c) => String(c[0]).startsWith('[Action URN:]'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('#2610 — hadron_get_nodes batch parity (cor:api:040:01)', () => {
  it('renders the same Action URN line per node as the single read', async () => {
    const entry = await registerEntry(teamMemoryId, CODE);
    // Slug-valid tail past 'register:'.length (Dan's carry P2 — see the
    // projection describe's non-register pin for why).
    const plain = await node(teamMemoryId, 'abcdefghijklmn');
    const single = await getNode(emitNodeUrnV2(teamMemoryUrn, `register:${CODE}`));
    const batch = await createTestableMcpServer(auth(admin.id)).callToolText('hadron_get_nodes', {
      refs: [entry.id, plain.id],
    });
    // Strip the batch's own header; what remains is the per-node blocks.
    const body = batch.replace(/^Batch read — returned \d+ node\(s\)\.\n\n/, '');
    const blocks = body.split('\n\n────────────────────────────────────────\n\n');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe(single); // the entry block == the single read, byte-for-byte
    expect(blocks[0]).toContain(`Action URN: ${actionUrn(teamAgent.urn, CODE)}`);
    expect(blocks[1]).not.toMatch(/^Action URN: /m);
    expect(batch).not.toContain('Unavailable');
  });
});

describe('#2711 delta review — D-1 impersonation, D-2 pins', () => {
  it('D-1: an impersonation session whose shared org is not the Agent\'s org is refused by the agent gate', async () => {
    await registerEntry(teamMemoryId, CODE);
    const otherOrg = await db.organization.create({
      data: { id: generateId(), name: 'mcp-au-other-org', urn: `${org.urn}-imp-scope` },
    });
    // The admin behind the curtain, scoped to a DIFFERENT single org than the
    // Agent's — isOrgMemberOrAdmin's impersonation narrowing must refuse. The
    // fix carries auth.impersonation into the gate; scopeCtx() alone dropped it.
    const impersonated: AuthContext = {
      ...auth(admin.id),
      impersonation: { sessionId: 'sess-imp', actorUserId: admin.id, orgId: otherOrg.id, expiresAt: new Date('2099-01-01') },
    };
    const byAction = await createTestableMcpServer(impersonated)
      .callToolText('hadron_get_node', { urn: actionUrn(teamAgent.urn, CODE) });
    expect(byAction).toBe(`Node "${actionUrn(teamAgent.urn, CODE)}" not found.`);
    // The same impersonated caller still reads the entry by NODE address —
    // the memory gate's org fold is the pre-existing, separately-routed
    // surface (Rico D-1: "exposes nothing new"). This boundary is what makes
    // D-1 a gate-parity fix rather than a leak fix; pin it so a future
    // tightening of the memory fold turns this assertion red deliberately.
    const byNode = await createTestableMcpServer(impersonated)
      .callToolText('hadron_get_node', { urn: emitNodeUrnV2(teamMemoryUrn, `register:${CODE}`) });
    expect(byNode).toContain(`hrn:node:${teamMemoryUrn}:register:${CODE}`);
  });

  it('D-2: a soft-deleted Agent\'s action address refuses (mutant-kill masked — see comments)', async () => {
    await registerEntry(teamMemoryId, CODE);
    await db.agent.update({ where: { id: teamAgent.id }, data: { deletedAt: new Date() } });
    // The action address: the uniform refusal, indistinguishable from an
    // unknown agent. NOTE (mutant pass): an includeDeleted mutant on
    // resolveAgentRef SURVIVES this pin — the memory gate refuses a
    // soft-deleted Agent's system memory downstream, so the refusal fires
    // either way and this surface cannot tell which gate spoke. The
    // liveness filter's own kill lives in the GraphQL file (mutant G there
    // is unmasked: GraphQL's node read still serves the entry). The pin
    // keeps value here as a behavior pin: uniform not-found, never an error
    // or a partial leak.
    const byAction = await getNode(actionUrn(teamAgent.urn, CODE));
    expect(byAction).toBe(`Node "${actionUrn(teamAgent.urn, CODE)}" not found.`);
    // The node address's read refuses too ("Memory not found") — so the
    // line-omission observable ("the entry served WITHOUT its Action URN
    // line") is unreachable on MCP by construction (documented in the
    // projection describe's header note). Pin the refusal so a memory-gate
    // change that starts serving these memories fails here loudly and the
    // masked pins get written.
    const byNode = await getNode(emitNodeUrnV2(teamMemoryUrn, `register:${CODE}`));
    expect(byNode).toBe(`Memory not found: "${teamMemoryUrn}".`);
  });

  it('D-2: an unminted PLAIN node\'s rename leaves no alias — only register: entries widen (#1591 + #2610)', async () => {
    // The register entry's rename keeps the old code resolving (pinned above,
    // the alias heal). The widening mutant — every unminted loc leaves an
    // alias on move — is killed by this NEGATIVE: the plain node's old
    // address must die with the move.
    const plain = await node(teamMemoryId, 'plain-old-loc');
    await M.moveNode(
      {},
      { sourceRef: plain.id, targetUrn: emitNodeUrnV2(teamMemoryUrn, 'plain-new-loc') },
      gqlCtx(admin.id),
    );
    const old = await getNode(emitNodeUrnV2(teamMemoryUrn, 'plain-old-loc'));
    expect(old).toBe(`Node "${emitNodeUrnV2(teamMemoryUrn, 'plain-old-loc')}" not found.`);
    const moved = await getNode(emitNodeUrnV2(teamMemoryUrn, 'plain-new-loc'));
    expect(moved).toContain('ID: ');
  });

  it('D-2: a globally-ambiguous historical code stays a LOUD refusal (the rethrow)', async () => {
    // Two minted entries renamed away from the same code leave two aliases
    // from one address (#697 ambiguity). The arm's contract: the ambiguity
    // escapes rather than folding into the uniform not-found.
    const amb = 'task.amb.duplicated';
    for (const renamed of ['task.amb.first', 'task.amb.second']) {
      const entry = await registerEntry(teamMemoryId, amb);
      await db.node.update({ where: { id: entry.id }, data: { mintedAt: new Date(), mintedByInfo: 'test' } });
      await M.moveNode(
        {},
        { sourceRef: entry.id, targetUrn: emitNodeUrnV2(teamMemoryUrn, `register:${renamed}`) },
        gqlCtx(admin.id),
      );
    }
    await expect(getNode(actionUrn(teamAgent.urn, amb))).rejects.toBeInstanceOf(AmbiguousLegacyUrnError);
  });

  it('D-2: an action URN with too many segments (arity) is the uniform refusal', async () => {
    await registerEntry(teamMemoryId, CODE);
    const tooLong = `${actionUrn(teamAgent.urn, CODE)}:extra`;
    const text = await getNode(tooLong);
    expect(text).toBe(`Node "${tooLong}" not found.`);
  });
});
