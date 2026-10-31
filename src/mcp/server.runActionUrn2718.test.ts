/**
 * #2718 — `hadron_run_action` accepts `hrn:action:<root>:<agent-slug>:<code>`
 * (cor:agt:110:04, cor:urn:010:01 Proposed). Vera's ruling (a): the action URN
 * is a register entry's SECOND address, so running by it resolves the entry and
 * applies EXACTLY the node-URN spelling's gate (`loadNodeForRun` ->
 * `canReadMemory`), NOT the `agent` arm's gate (PUBLIC #551, else owner or org
 * member). Both spellings give the same outcome for every caller class:
 *
 *   caller                                   node URN    action URN
 *   admin (owner / org member, reads memory) runs        runs
 *   App participant: memory gate yes,
 *     Agent gate no                          runs        runs   (the body's asymmetry)
 *   PUBLIC Agent, memory gate no             refused     refused (the reverse one)
 *   other tenant / unknown / malformed       refused     refused
 *
 * Every unreadable action case answers with ONE message that names nothing
 * (cor:api:140:03): other tenant, unreadable memory, unknown Agent, missing or
 * malformed code are indistinguishable.
 *
 * Test harness: createTestableMcpServer drives the registered tool callbacks
 * without a transport, so this exercises the production closure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppMember, createDbAppWithKey } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { emitNodeUrnV2 } from '../lib/urnEmit.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;
const CODE = 'task.finish.open-children';
const MISSING_CODE = 'task.assign.no-such-code';
const BODY = 'RUN-BODY-2718 {{who}}';

let org: { id: string; urn: string };
let admin: { id: string };
let outsider: { id: string };
let agent: { id: string; urn: string };
let memoryId: string;
let memoryUrn: string;

const gqlCtx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const auth = (userId: string): AuthContext => ({ userId, roles: ['READER'], clientId: `user:${userId}` });
const actionUrn = (agentUrn: string, code: string) => `hrn:action:${agentUrn}:${code}`;
const nodeUrn = (code = CODE) => emitNodeUrnV2(memoryUrn, `register:${code}`);
const run = (as: string, urn: string, args?: Record<string, string>) =>
  createTestableMcpServer(auth(as)).callToolText('hadron_run_action', { urn, ...(args ? { args } : {}) });
const notFound = (urn: string) => `Node "${urn}" not found.`;

async function registerEntry(mem: string, code: string) {
  return db.node.create({
    data: {
      id: generateId(), memoryId: mem, loc: `register:${code}`, name: code, content: BODY,
      data: { registerEntry: { code, taskLoc: 'tasks:finish' } },
    },
  });
}

/** An App where `outsider` is a plain member and the Agent is installed: the caller passes the MEMORY gate but is neither owner nor org member of the Agent. */
async function installForOutsider() {
  const { app } = await createDbAppWithKey(db, 'run-au-app', org.id);
  await createDbAppAgent(db, app.id, agent.id);
  await createDbAppMember(db, app.id, outsider.id, 'member');
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId().toLowerCase();
  org = await db.organization.create({ data: { id: generateId(), name: 'run-au-org', urn: `runau2718-${suffix}.example` } });
  admin = await db.user.create({ data: { id: generateId(), githubId: 2718101, githubUsername: 'run-au-admin', handle: 'run-au-admin', roles: ['READER'] } });
  outsider = await db.user.create({ data: { id: generateId(), githubId: 2718102, githubUsername: 'run-au-out', handle: 'run-au-out', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const created = await M.createAgent({}, { orgId: org.id, name: 'Run Agent' }, gqlCtx(admin.id));
  const row = await db.agent.findUniqueOrThrow({ where: { id: created.id } });
  agent = { id: row.id, urn: row.urn };
  memoryId = row.systemMemoryId as string;
  memoryUrn = (await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).urn;
});

afterEach(() => { process.env.FRONTEND_URL = ''; });

describe('#2718 — hadron_run_action by action URN', () => {
  it('runs the entry by its action address, byte-identical to its node address', async () => {
    await registerEntry(memoryId, CODE);
    const byNode = await run(admin.id, nodeUrn(), { who: 'W' });
    expect(byNode).toContain('RUN-BODY-2718 W');
    const byAction = await run(admin.id, actionUrn(agent.urn, CODE), { who: 'W' });
    expect(byAction).toBe(byNode);
  });

  it('admits an App participant who passes the MEMORY gate but not the Agent gate, on BOTH spellings', async () => {
    await registerEntry(memoryId, CODE);
    await installForOutsider();
    const byNode = await run(outsider.id, nodeUrn(), { who: 'P' });
    // The memory gate genuinely passes (otherwise this pins the wrong gate).
    expect(byNode).toContain('RUN-BODY-2718 P');
    const byAction = await run(outsider.id, actionUrn(agent.urn, CODE), { who: 'P' });
    expect(byAction).toBe(byNode);
  });

  it('refuses a caller who passes the Agent gate (PUBLIC) but not the memory gate, on BOTH spellings', async () => {
    await registerEntry(memoryId, CODE);
    await db.agent.update({ where: { id: agent.id }, data: { visibility: 'PUBLIC' } });
    const byNode = await run(outsider.id, nodeUrn());
    expect(byNode).not.toContain('RUN-BODY-2718');
    const byAction = await run(outsider.id, actionUrn(agent.urn, CODE));
    expect(byAction).not.toContain('RUN-BODY-2718');
    expect(byAction).toBe(notFound(actionUrn(agent.urn, CODE)));
  });

  it('answers every unreadable case identically and never says what exists', async () => {
    await registerEntry(memoryId, CODE);
    const out = (urn: string) => run(outsider.id, urn);
    const otherTenant = await out(actionUrn(agent.urn, CODE));
    const missingCode = await out(actionUrn(agent.urn, MISSING_CODE));
    const unknownAgent = await out(actionUrn(agent.urn.replace(/[^:]+$/, 'no-such-agent'), CODE));
    const malformed = await out(actionUrn(agent.urn, 'bad code!'));
    expect(otherTenant).toBe(notFound(actionUrn(agent.urn, CODE)));
    expect(missingCode).toBe(otherTenant.replace(CODE, MISSING_CODE));
    expect(unknownAgent).toBe(otherTenant.replace(agent.urn, agent.urn.replace(/[^:]+$/, 'no-such-agent')));
    expect(malformed).toBe(otherTenant.replace(CODE, 'bad code!'));
    // A caller who CAN read gets the same message for a missing code (no oracle either way).
    expect(await run(admin.id, actionUrn(agent.urn, MISSING_CODE))).toBe(notFound(actionUrn(agent.urn, MISSING_CODE)));
  });

  it('refuses a code that exists only under a base Agent (no chain fallthrough)', async () => {
    await registerEntry(memoryId, CODE);
    const createdChild = await M.createAgent({}, { orgId: org.id, name: 'Child Run Agent' }, gqlCtx(admin.id));
    await db.agent.update({ where: { id: createdChild.id }, data: { extendsAgentId: agent.id } });
    const child = await db.agent.findUniqueOrThrow({ where: { id: createdChild.id } });
    expect(await run(admin.id, actionUrn(child.urn, CODE))).toBe(notFound(actionUrn(child.urn, CODE)));
  });

  it('keeps an OLD code running after the entry renames (alias heal)', async () => {
    const entry = await registerEntry(memoryId, CODE);
    const renamed = 'task.finish.done-children';
    await M.moveNode({}, { sourceRef: entry.id, targetUrn: emitNodeUrnV2(memoryUrn, `register:${renamed}`) }, gqlCtx(admin.id));
    const byOld = await run(admin.id, actionUrn(agent.urn, CODE), { who: 'H' });
    expect(byOld).toContain('RUN-BODY-2718 H');
  });

  it('refuses a healed entry that moved out of the system memory when the caller cannot read where it lives', async () => {
    const entry = await registerEntry(memoryId, CODE);
    await installForOutsider();
    const moved = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:run-moved`, name: 'run-moved', class: 'knowledge', visibility: 'ORGANIZATION' },
    });
    await M.moveNode({}, { sourceRef: entry.id, targetUrn: emitNodeUrnV2(moved.urn, `register:${CODE}`) }, gqlCtx(admin.id));
    expect(await run(outsider.id, actionUrn(agent.urn, CODE))).toBe(notFound(actionUrn(agent.urn, CODE)));
    expect(await run(admin.id, actionUrn(agent.urn, CODE), { who: 'M' })).toContain('RUN-BODY-2718 M');
  });

  it('refuses a healed entry that moved to a memory the caller CAN read when the caller cannot read the Agent\'s system memory', async () => {
    // The address is the Agent's: cor:agt:110:04 reads it by whoever may read
    // THAT system memory. The system-memory gate is not masked by the final node
    // gate here, because the entry now lives somewhere the caller does read.
    const entry = await registerEntry(memoryId, CODE);
    const open = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:run-open`, name: 'run-open', class: 'knowledge', visibility: 'PUBLIC' },
    });
    await M.moveNode({}, { sourceRef: entry.id, targetUrn: emitNodeUrnV2(open.urn, `register:${CODE}`) }, gqlCtx(admin.id));
    // Outsider reads the moved entry's memory by node address...
    expect(await run(outsider.id, emitNodeUrnV2(open.urn, `register:${CODE}`), { who: 'O' })).toContain('RUN-BODY-2718 O');
    // ...but is not admitted through the Agent's action address (system memory unreadable).
    expect(await run(outsider.id, actionUrn(agent.urn, CODE))).toBe(notFound(actionUrn(agent.urn, CODE)));
  });

  it('still refuses a non-action, non-node URN with the qualification message', async () => {
    const text = await run(admin.id, 'not-a-urn');
    expect(text).not.toContain('RUN-BODY-2718');
    expect(text).not.toContain('not found.');
  });
});
