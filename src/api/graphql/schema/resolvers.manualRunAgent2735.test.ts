/**
 * #2735 / cor:agt:040:10 (Holger R1): which Agent a MANUAL run is served as.
 * Every manual-run surface (runTask(appRef:), importNode(taskRef:),
 * triggerAppRun, MCP hadron_run_task) takes an optional agentRef: a named Agent
 * must be installed in the App; omitted means the App's single installed Agent;
 * several installed and none named is RUN_AGENT_REQUIRED, identical on GraphQL
 * and MCP and raised before any write; none installed is unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { composeNodeUrn } from '../../../lib/urn.js';
import { emitNodeUrnV2 } from '../../../lib/urnEmit.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
let orgId: string;
let appId: string;
let adminId: string;
let taskUrn: string;
let entryUrn: string;
let targetMemoryId: string;
let agentA: string;
let agentB: string;
let foreignAgent: string;
const before = process.env.BOOT_PROMPT_SERVE_ENABLED;

const ctx = (): Context => ({ db, roles: ['ADMIN'], userId: adminId, clientId: `user:${adminId}` });
const code = async (p: Promise<unknown>) => { try { await p; return 'RESOLVED'; } catch (e: any) { return e?.extensions?.code ?? e?.message; } };
const mcp = () => createTestableMcpServer({ userId: adminId, roles: ['ADMIN'], clientId: `user:${adminId}` });
const importInput = (extra: Record<string, unknown> = {}) => ({
  memoryId: targetMemoryId, loc: 'imports:one', content: 'hello', contentType: 'text/markdown',
  taskRef: taskUrn, appRef: appId, ...extra,
});
async function agent(name: string, org = orgId) {
  const mem = await db.memory.create({ data: { id: generateId(), class: 'system', name: `${name}-sys`, urn: `${name}:sys`, organizationId: org } });
  return (await db.agent.create({ data: { id: generateId(), name, urn: `${name}:agent`, organizationId: org, systemMemoryId: mem.id } })).id;
}
const install = (agentId: string) => db.appAgent.create({ data: { appId, agentId } as never });

beforeEach(async () => {
  delete process.env.BOOT_PROMPT_SERVE_ENABLED;
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'mra-org', urn: 'mra-org' } });
  orgId = org.id;
  appId = (await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'mra-app', urn: 'mra-org::mra-app' } })).id;
  adminId = (await db.user.create({ data: { githubId: 9735, githubUsername: 'mra-admin', roles: ['ADMIN'] } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: adminId, role: 'ADMIN' } });
  const taskMem = await db.memory.create({ data: { id: generateId(), organizationId: orgId, name: 'mra-tasks', urn: 'mra-org::mra-tasks', class: 'knowledge' } });
  await db.node.create({ data: { id: generateId(), memoryId: taskMem.id, loc: 'tasks:go', isLink: false, name: 'go', nodeType: 'task', isRunnable: true, content: 'Go {{importedNodeUrn}}', tags: [] } });
  taskUrn = composeNodeUrn(taskMem.urn, 'tasks:go');
  entryUrn = emitNodeUrnV2(taskMem.urn, 'tasks:go');
  targetMemoryId = (await M.createMemory({}, { orgId, name: 'mra-import' }, ctx())).id;
  agentA = await agent('alpha');
  agentB = await agent('bravo');
  const other = await db.organization.create({ data: { id: generateId(), name: 'mra-other', urn: 'mra-other' } });
  foreignAgent = await agent('foreign', other.id);
});
afterEach(() => {
  if (before === undefined) delete process.env.BOOT_PROMPT_SERVE_ENABLED;
  else process.env.BOOT_PROMPT_SERVE_ENABLED = before;
});

const runs = () => db.appRun.findMany();
const importedNodes = () => db.node.count({ where: { memoryId: targetMemoryId, loc: 'imports:one' } });

describe('#2735 single installed Agent is the default', () => {
  beforeEach(async () => { await install(agentA); });

  it('runTask, triggerAppRun and importNode serve the run as the installed Agent', async () => {
    const viaTask = await M.runTask({}, { nodeRef: taskUrn, appRef: appId }, ctx());
    const viaTrigger = await M.triggerAppRun({}, { input: { appRef: appId, entryNodeUrn: entryUrn } }, ctx());
    const viaImport = await M.importNode({}, { input: importInput() }, ctx());
    for (const id of [viaTask, viaTrigger.id, viaImport.jobId]) {
      expect((await db.appRun.findUniqueOrThrow({ where: { id } })).agentId).toBe(agentA);
    }
  });

  it('hadron_run_task serves the run as the installed Agent', async () => {
    const text = await mcp().callToolText('hadron_run_task', { urn: taskUrn, appRef: appId });
    expect(text).toContain('Run started');
    expect((await runs()).map((r) => r.agentId)).toEqual([agentA]);
  });

  it('a named installed Agent is accepted, a foreign or unknown one is one BAD_USER_INPUT, with nothing written', async () => {
    expect(await code(M.runTask({}, { nodeRef: taskUrn, appRef: appId, agentRef: agentA }, ctx()))).toBe('RESOLVED');
    for (const agentRef of [foreignAgent, generateId()]) {
      expect(await code(M.runTask({}, { nodeRef: taskUrn, appRef: appId, agentRef }, ctx()))).toBe('BAD_USER_INPUT');
      expect(await code(M.triggerAppRun({}, { input: { appRef: appId, entryNodeUrn: entryUrn, agentRef } }, ctx()))).toBe('BAD_USER_INPUT');
      expect(await code(M.importNode({}, { input: importInput({ agentRef }) }, ctx()))).toBe('BAD_USER_INPUT');
    }
    expect(await runs()).toHaveLength(1);
    expect(await importedNodes()).toBe(0);
  });
});

describe('#2735 several installed Agents', () => {
  beforeEach(async () => { await install(agentA); await install(agentB); });

  it('none named is RUN_AGENT_REQUIRED on every surface, and nothing is written', async () => {
    expect(await code(M.runTask({}, { nodeRef: taskUrn, appRef: appId }, ctx()))).toBe('RUN_AGENT_REQUIRED');
    expect(await code(M.triggerAppRun({}, { input: { appRef: appId, entryNodeUrn: entryUrn } }, ctx()))).toBe('RUN_AGENT_REQUIRED');
    expect(await code(M.importNode({}, { input: importInput() }, ctx()))).toBe('RUN_AGENT_REQUIRED');
    expect(await mcp().callToolText('hadron_run_task', { urn: taskUrn, appRef: appId })).toContain('RUN_AGENT_REQUIRED');
    expect(await runs()).toHaveLength(0);
    expect(await importedNodes()).toBe(0);
  });

  it('a blank agentRef counts as none named', async () => {
    expect(await code(M.runTask({}, { nodeRef: taskUrn, appRef: appId, agentRef: '  ' }, ctx()))).toBe('RUN_AGENT_REQUIRED');
  });

  it('naming one serves the run as that Agent on every surface', async () => {
    const viaTask = await M.runTask({}, { nodeRef: taskUrn, appRef: appId, agentRef: agentB }, ctx());
    const viaTrigger = await M.triggerAppRun({}, { input: { appRef: appId, entryNodeUrn: entryUrn, agentRef: agentB } }, ctx());
    const viaImport = await M.importNode({}, { input: importInput({ agentRef: agentB }) }, ctx());
    await mcp().callToolText('hadron_run_task', { urn: taskUrn, appRef: appId, agentRef: agentB });
    const all = await runs();
    expect(all).toHaveLength(4);
    expect(all.every((r) => r.agentId === agentB)).toBe(true);
    expect([viaTask, viaTrigger.id, viaImport.jobId].every((id) => all.some((r) => r.id === id))).toBe(true);
  });

  it('the access gate still answers first: a caller with no manual-run access never learns the App has several Agents', async () => {
    const stranger = (await db.user.create({ data: { githubId: 9736, githubUsername: 'mra-stranger', roles: ['READER'] } })).id;
    const sctx: Context = { db, roles: ['READER'], userId: stranger, clientId: `user:${stranger}` };
    const got = await code(M.runTask({}, { nodeRef: taskUrn, appRef: appId }, sctx));
    expect(got).not.toBe('RUN_AGENT_REQUIRED');
    expect(got).not.toBe('RESOLVED');
  });
});

describe('#2735 no installed Agent', () => {
  it('is unchanged: the run is minted agent-less while serving is off, BOOT_PROMPT_NOT_SET once on, and an import then leaves no node', async () => {
    expect(await code(M.runTask({}, { nodeRef: taskUrn, appRef: appId }, ctx()))).toBe('RESOLVED');
    expect((await runs())[0]!.agentId).toBeNull();
    process.env.BOOT_PROMPT_SERVE_ENABLED = 'true';
    expect(await code(M.runTask({}, { nodeRef: taskUrn, appRef: appId }, ctx()))).toBe('BOOT_PROMPT_NOT_SET');
    expect(await code(M.importNode({}, { input: importInput() }, ctx()))).toBe('BOOT_PROMPT_NOT_SET');
    expect(await importedNodes()).toBe(0);
    expect(await runs()).toHaveLength(1);
  });
});
