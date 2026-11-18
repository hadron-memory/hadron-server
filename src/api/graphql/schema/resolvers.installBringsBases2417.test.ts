/**
 * #2417 (cor:dmo:050:14, Holger 2026-10-27; scenario S13) — installing an Agent
 * that extends a base brings its bases along: the installing organisation needs
 * only the child, with no licence per base.
 *
 * Fixture: `engineer` belongs to one vendor, `backend-engineer` (extends
 * `engineer`) and `go-engineer` (extends `backend-engineer`) to another, which
 * holds the grant extending needs. Acme holds a licence to the child it installs
 * and to nothing else. Every Agent is non-public, so nothing here is readable or
 * subscribable by Acme on its own.
 *
 * Pinned:
 *   (1) both install doors (`createApp`, `installAgentIntoApp`) succeed with no
 *       licence to a base, and write nothing for one (no grant, no App, no install);
 *   (2) Acme's members then read the base's nodes through the child, over GraphQL
 *       and MCP alike, and never a base's overridden node, boot prompt or own URN;
 *   (3) the same for a chain of three;
 *   (4) side by side with an import: an unlicensed required import refuses the
 *       install, an unlicensed base does not; a licensed import gets its own App,
 *       a base gets none;
 *   (5) the App's compile of the child's boot prompt includes an inherited part
 *       under the child's licence alone, and still refuses a part of an Agent that
 *       is not in the child's chain.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAgentImport, createDbAgentOrgGrant } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { compileBootPrompt } from './compileBootPrompt.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;

type Org = { id: string; urn: string };
type Ag = { id: string; urn: string; mem: string; memUrn: string };

let acme: Org;
let vendor: Org;
let baseVendor: Org;
let admin: string;
let member: string;
let engineer: Ag;
let backend: Ag;
let go: Ag;
const ids: Record<string, string> = {};

const ctxOf = (userId: string): Context => ({ db, userId, roles: ['READER'], clientId: `user:${userId}` }) as Context;
const mcp = (userId: string, tool: string, params: Record<string, unknown>) =>
  createTestableMcpServer({ userId, roles: ['READER'], clientId: `user:${userId}` }).callToolText(tool, params);
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return 'NO_ERROR'; } catch (e) {
    const err = e as { code?: string; extensions?: { code?: string }; message: string };
    return String(err.extensions?.code ?? err.code ?? err.message);
  }
};

async function agent(org: Org, slug: string, baseId?: string): Promise<Ag> {
  const memUrn = `${org.urn}:${slug}-system`;
  const mem = await db.memory.create({ data: { id: generateId(), class: 'system', organizationId: org.id, name: slug, urn: memUrn } });
  const a = await db.agent.create({
    data: {
      id: generateId(), organizationId: org.id, name: slug, urn: `${org.urn}:${slug}`, visibility: 'ORGANIZATION',
      systemMemoryId: mem.id, extendsAgentId: baseId ?? null,
    },
  });
  return { id: a.id, urn: a.urn, mem: mem.id, memUrn };
}
const node = async (memoryId: string, loc: string, content: string, extra: Record<string, unknown> = {}) =>
  (await db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content, ...extra } })).id;

/** What Acme holds: its grants, and the Agents its Apps install. */
const acmeHolds = async () => ({
  grants: (await db.agentOrgGrant.findMany({ where: { orgId: acme.id }, select: { agentId: true } })).map((g) => g.agentId).sort(),
  installed: (await db.appAgent.findMany({ where: { app: { organizationId: acme.id } }, select: { agentId: true } })).map((r) => r.agentId).sort(),
  apps: await db.app.count({ where: { organizationId: acme.id } }),
});

/** An Acme member (org READER, App member) of the App that installs `child`. */
async function joinApp(appId: string) {
  await db.appMember.upsert({
    where: { appId_userId: { appId, userId: member } },
    create: { appId, userId: member, role: 'member' },
    update: {},
  });
}

beforeEach(async () => {
  await cleanDb(db);
  const sfx = generateId().slice(-8);
  const org = async (name: string): Promise<Org> =>
    db.organization.create({ data: { id: generateId(), name, urn: `${name}-${sfx}.example` }, select: { id: true, urn: true } });
  acme = await org('acme2417');
  vendor = await org('vendor2417');
  baseVendor = await org('basevendor2417');
  admin = (await db.user.create({ data: { id: generateId(), handle: `adm-${sfx}`, roles: ['READER'] } })).id;
  member = (await db.user.create({ data: { id: generateId(), handle: `mem-${sfx}`, roles: ['READER'] } })).id;
  await db.orgMember.create({ data: { organizationId: acme.id, userId: admin, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: acme.id, userId: member, role: 'READER' } });

  engineer = await agent(baseVendor, 'engineer');
  // The grant extending needs is the child's owner's, never the installer's.
  await createDbAgentOrgGrant(db, vendor.id, engineer.id);
  backend = await agent(vendor, 'backend-engineer', engineer.id);
  go = await agent(vendor, 'go-engineer', backend.id);

  ids.engRelease = await node(engineer.mem, 'processes:release', 'engineer release');
  ids.engOpenPr = await node(engineer.mem, 'tasks:open-pr', 'engineer open-pr');
  ids.engBoot = await node(engineer.mem, 'boot:source', 'engineer boot', { role: 'boot-prompt' });
  ids.backOpenPr = await node(backend.mem, 'tasks:open-pr', 'backend open-pr');
  ids.backReview = await node(backend.mem, 'tasks:review', 'backend review');
  ids.goShip = await node(go.mem, 'tasks:ship', 'go ship');
});

/** The reads an Acme member makes through `child` once an App of theirs installs it. */
async function expectReadsThroughChild(appId: string, child: Ag, own: string[]) {
  await joinApp(appId);
  const c = ctxOf(member);

  // GraphQL, the App listing: the effective system memory, inherited rows under their own address and marked.
  const rows: Array<{ id: string; inheritedFrom?: { agentUrn: string } }> = await Q.appNodes({}, { appRef: appId }, c);
  const got = rows.map((r) => r.id);
  expect(got).toEqual(expect.arrayContaining([ids.engRelease!, ids.backOpenPr!, ...own]));
  expect(got).not.toContain(ids.engOpenPr);
  expect(got).not.toContain(ids.engBoot);
  expect(rows.find((r) => r.id === ids.engRelease)?.inheritedFrom?.agentUrn).toBe(engineer.urn);

  // GraphQL, a single read through the child: the inherited node, and the nearest node at a shared loc.
  expect((await Q.node({}, { ref: 'processes:release', memoryRef: child.mem }, c))?.id).toBe(ids.engRelease);
  expect((await Q.node({}, { ref: 'tasks:open-pr', memoryRef: child.mem }, c))?.id).toBe(ids.backOpenPr);
  // Never a base's other content: its boot prompt through the child, or anything by the base's own address.
  expect(await Q.node({}, { ref: 'boot:source', memoryRef: child.mem }, c).then((r: { id: string } | null) => r?.id ?? null, () => null))
    .not.toBe(ids.engBoot);
  expect(await Q.node({}, { ref: `hrn:node:${engineer.memUrn}:processes:release` }, c).then((r: unknown) => r, () => null)).toBeNull();
  expect(await Q.node({}, { ref: `hrn:node:${engineer.memUrn}:tasks:open-pr` }, c).then((r: unknown) => r, () => null)).toBeNull();

  // MCP agrees: the same listing and the same single reads.
  const listed = await mcp(member, 'hadron_list_nodes', { memoryUrn: `hrn:mem:${child.memUrn}`, depth: 3 });
  expect(listed).toContain('processes:release');
  expect(listed).not.toContain('boot:source');
  expect(await mcp(member, 'hadron_get_node', { urn: `hrn:node:${child.memUrn}:processes:release` })).toContain('engineer release');
  expect(await mcp(member, 'hadron_get_node', { urn: `hrn:node:${child.memUrn}:tasks:open-pr` })).toContain('backend open-pr');
  expect(await mcp(member, 'hadron_get_node', { urn: `hrn:node:${engineer.memUrn}:tasks:open-pr` })).not.toContain('engineer open-pr');
}

describe('#2417 installing a child brings its bases along (cor:dmo:050:14 S13)', () => {
  it('createApp: Acme, licensed to the child only, installs it; nothing is written for the base; members read through the child', async () => {
    await createDbAgentOrgGrant(db, acme.id, backend.id);
    const app = await M.createApp(null, { orgRef: acme.id, agentRef: backend.id, name: 'Backend' }, ctxOf(admin));
    expect(await acmeHolds()).toEqual({ grants: [backend.id], installed: [backend.id], apps: 1 });
    await expectReadsThroughChild(app.id, backend, [ids.backReview!]);
  });

  it('installAgentIntoApp: the second install door agrees', async () => {
    await createDbAgentOrgGrant(db, acme.id, backend.id);
    const app = await db.app.create({ data: { id: generateId(), name: 'Existing', urn: `${acme.urn}:existing`, organizationId: acme.id } });
    await M.installAgentIntoApp(null, { appRef: app.id, agentRef: backend.id }, ctxOf(admin));
    expect(await acmeHolds()).toEqual({ grants: [backend.id], installed: [backend.id], apps: 1 });
    await expectReadsThroughChild(app.id, backend, [ids.backReview!]);
  });

  it('a chain of three: licensed to the child only, both bases come along through both doors', async () => {
    await createDbAgentOrgGrant(db, acme.id, go.id);
    const app = await M.createApp(null, { orgRef: acme.id, agentRef: go.id, name: 'Go' }, ctxOf(admin));
    expect(await acmeHolds()).toEqual({ grants: [go.id], installed: [go.id], apps: 1 });
    await expectReadsThroughChild(app.id, go, [ids.backReview!, ids.goShip!]);

    const second = await db.app.create({ data: { id: generateId(), name: 'Go Two', urn: `${acme.urn}:go-two`, organizationId: acme.id } });
    await M.installAgentIntoApp(null, { appRef: second.id, agentRef: go.id }, ctxOf(admin));
    expect((await acmeHolds()).grants).toEqual([go.id]);
    await expectReadsThroughChild(second.id, go, [ids.backReview!, ids.goShip!]);
  });

  it('an install with no licence to the child is still refused, whatever its bases', async () => {
    // Acme holds the BASE's licence and not the child's: a base never licenses the Agent that extends it.
    await createDbAgentOrgGrant(db, acme.id, engineer.id);
    expect(await codeOf(M.createApp(null, { orgRef: acme.id, agentRef: backend.id, name: 'No' }, ctxOf(admin)))).toBe('AGENT_NOT_FOUND');
    expect((await acmeHolds()).apps).toBe(0);
  });

  it('side by side with an import: an unlicensed required import refuses the install, an unlicensed base does not', async () => {
    const reviewer = await agent(baseVendor, 'reviewer');
    await createDbAgentOrgGrant(db, vendor.id, reviewer.id);
    await createDbAgentImport(db, backend.id, reviewer.id, { required: true });
    await createDbAgentOrgGrant(db, acme.id, backend.id);

    // The import needs Acme's own licence (cor:dmo:050:06): none, so nothing is installed.
    expect(await codeOf(M.createApp(null, { orgRef: acme.id, agentRef: backend.id, name: 'Bundle' }, ctxOf(admin))))
      .toBe('AGENT_DEPENDENCY_UNAVAILABLE');
    expect(await acmeHolds()).toEqual({ grants: [backend.id], installed: [], apps: 0 });

    // With the import licensed the install goes through: the import gets its own App, the base gets nothing.
    await createDbAgentOrgGrant(db, acme.id, reviewer.id);
    const app = await M.createApp(null, { orgRef: acme.id, agentRef: backend.id, name: 'Bundle' }, ctxOf(admin));
    expect(await acmeHolds()).toEqual({
      grants: [backend.id, reviewer.id].sort(), installed: [backend.id, reviewer.id].sort(), apps: 2,
    });
    await expectReadsThroughChild(app.id, backend, [ids.backReview!]);
  });

  it('the App compiles the child boot prompt with an inherited part under the child licence alone', async () => {
    await createDbAgentOrgGrant(db, acme.id, backend.id);
    await node(backend.mem, 'boot:source', 'Release: {{> processes:release}}', { role: 'boot-prompt' });
    const app = await M.createApp(null, { orgRef: acme.id, agentRef: backend.id, name: 'Compile' }, ctxOf(admin));
    const r = await compileBootPrompt(ctxOf(admin), { kind: 'APP_AGENT', appId: app.id, agentId: backend.id });
    expect((await db.node.findUniqueOrThrow({ where: { id: r.nodeId } })).content).toBe('Release: engineer release');
    // The compile licensed nothing either: Acme still holds the child alone.
    expect((await acmeHolds()).grants).toEqual([backend.id]);
  });

  it('the App compile still refuses a part of an Agent outside the child chain that Acme holds no licence to', async () => {
    const stranger = await agent(baseVendor, 'stranger');
    await node(stranger.mem, 'parts:rules', 'stranger rules');
    await createDbAgentOrgGrant(db, acme.id, backend.id);
    await node(backend.mem, 'boot:source', `{{> hrn:node:${stranger.memUrn}:parts:rules}}`, { role: 'boot-prompt' });
    const app = await M.createApp(null, { orgRef: acme.id, agentRef: backend.id, name: 'Compile' }, ctxOf(admin));
    expect(await codeOf(compileBootPrompt(ctxOf(admin), { kind: 'APP_AGENT', appId: app.id, agentId: backend.id })))
      .toBe('BOOT_PROMPT_INCLUDE_UNAVAILABLE');
    // And a base named by its full URN, outside what the child inherits, is no more available: an overridden base node.
    await db.node.updateMany({ where: { memoryId: backend.mem, loc: 'boot:source' }, data: { content: `{{> hrn:node:${engineer.memUrn}:tasks:open-pr}}` } });
    expect(await codeOf(compileBootPrompt(ctxOf(admin), { kind: 'APP_AGENT', appId: app.id, agentId: backend.id })))
      .toBe('BOOT_PROMPT_INCLUDE_UNAVAILABLE');
  });
});
