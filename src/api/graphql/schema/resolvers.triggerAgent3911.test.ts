/**
 * #3911 / V70 (cor:agt:040:10): createAgentSchedule and createAgentWebhook choose their Agent at creation exactly as a
 * manual run does: a named Agent must be installed, else the App's single installed Agent, else RUN_AGENT_REQUIRED with
 * several, and BOOT_PROMPT_NOT_SET with none. Every refusal lands before any write.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
let orgId: string;
let appId: string;
let adminId: string;
let agentA: string;
let agentB: string;
let foreign: string;

const ctx = (): Context => ({ db, roles: ['READER'], userId: adminId });
const code = async (p: Promise<unknown>) => { try { await p; return 'RESOLVED'; } catch (e: any) { return e?.extensions?.code ?? e?.message; } };
const schedule = (extra: Record<string, unknown> = {}) => M.createAgentSchedule({}, {
  input: { appRef: appId, name: `s-${generateId().slice(-6)}`, cron: '0 6 * * *', entryNodeUrn: 't3911::mem::tasks:go', ...extra },
}, ctx());
const webhook = (extra: Record<string, unknown> = {}) => M.createAgentWebhook({}, {
  input: { appRef: appId, name: `w-${generateId().slice(-6).toLowerCase()}`, entryNodeUrn: 't3911::mem::tasks:go', ...extra },
}, ctx());
const doors = [['schedule', schedule], ['webhook', webhook]] as const;
const rows = async () => (await db.agentSchedule.count()) + (await db.agentWebhook.count());
async function agent(name: string, org = orgId) {
  const mem = await db.memory.create({ data: { id: generateId(), class: 'system', name: `${name}-sys`, urn: `${name}:sys`, organizationId: org } });
  const id = (await db.agent.create({ data: { id: generateId(), name, urn: `${name}:agent`, organizationId: org, systemMemoryId: mem.id } })).id;
  await serveAgentBootPrompt(db, id, `You are ${name}.`);
  return id;
}
const install = (agentId: string) => db.appAgent.create({ data: { appId, agentId } as never });

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 't3911', urn: 't3911' } })).id;
  appId = (await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 't3911-app', urn: 't3911::t3911-app' } })).id;
  adminId = (await db.user.create({ data: { githubId: 3911, githubUsername: 't3911-admin', roles: ['READER'] } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: adminId, role: 'ADMIN' } });
  agentA = await agent('alpha');
  agentB = await agent('bravo');
  const other = await db.organization.create({ data: { id: generateId(), name: 't3911-other', urn: 't3911-other' } });
  foreign = await agent('foreign', other.id);
});

describe.each(doors)('#3911 V70: %s creation resolves its Agent like a manual run', (_kind, create) => {
  it('one installed Agent and none named: the trigger records that Agent', async () => {
    await install(agentA);
    const row: any = await create();
    expect((row.webhook ?? row).agentId).toBe(agentA);
  });

  it('several installed and none named: RUN_AGENT_REQUIRED, nothing written', async () => {
    await install(agentA); await install(agentB);
    expect(await code(create())).toBe('RUN_AGENT_REQUIRED');
    expect(await rows()).toBe(0);
  });

  it('several installed and one named: the named Agent is recorded', async () => {
    await install(agentA); await install(agentB);
    const row: any = await create({ agentRef: agentB });
    expect((row.webhook ?? row).agentId).toBe(agentB);
  });

  it('none installed: BOOT_PROMPT_NOT_SET, nothing written', async () => {
    expect(await code(create())).toBe('BOOT_PROMPT_NOT_SET');
    expect(await rows()).toBe(0);
  });

  it('a named Agent the App has not installed (or that does not exist): one BAD_USER_INPUT, nothing written', async () => {
    await install(agentA);
    expect(await code(create({ agentRef: agentB }))).toBe('BAD_USER_INPUT');
    expect(await code(create({ agentRef: foreign }))).toBe('BAD_USER_INPUT');
    expect(await rows()).toBe(0);
  });
});
