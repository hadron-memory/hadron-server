/**
 * #1329 — Xan's ruling 6661007376: on MCP, READABLE only where MCP loads the task.
 * Every principal shape against every memory shape, after Rico's residual matrix
 * (17 of 126 cells told READABLE while `hadron_get_node` refused). GraphQL keeps
 * its gate, so those 17 are the declared surface difference (hadron-server#3519).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { attestedAuthoring, judgeAuthoring } from '../lib/authoringAttestation.js';
import type { Context } from '../api/graphql/schema/resolvers.js';
import type { AuthContext } from '../middleware/auth.js';
import { canReadMemory, EXPLICIT_REF } from './access-control.js';
import { mcpReadsTask } from './taskReadGate.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

let n = 900;
const mem = (urn: string, d: Record<string, unknown>) => db.memory.create({ data: { id: generateId(), urn, name: urn, ...d } as never });
const user = (h: string) => db.user.create({ data: { githubId: n++, githubUsername: h, handle: h } });
const write = { priorRole: 'guide', priorRunnable: false, role: 'guide', runnable: false, authoredChange: true };

describe('#1329 the MCP refusal and the MCP read', () => {
  let dest: string;
  let configId: string;
  let memories: Record<string, string>;
  let principals: Record<string, AuthContext>;
  let subscribe: () => Promise<unknown>;

  beforeEach(async () => {
    await cleanDb(db);
    const org = (await db.organization.create({ data: { id: generateId(), name: 'o', urn: 'o' } })).id;
    const u = (await user('u')).id;
    const v = (await user('v')).id;
    await db.user.update({ where: { id: v }, data: { roles: ['ADMIN'] as never } });
    await db.orgMember.create({ data: { organizationId: org, userId: u, role: 'CONTRIBUTOR' } });
    await db.orgMember.create({ data: { organizationId: org, userId: v, role: 'CONTRIBUTOR' } });
    const appA = (await db.app.create({ data: { organizationId: org, name: 'A', urn: 'o:a' } })).id;
    const appB = (await db.app.create({ data: { organizationId: org, name: 'B', urn: 'o:b' } })).id;
    const appC = (await db.app.create({ data: { organizationId: org, name: 'C', urn: 'o:c' } })).id; // u is not a member
    await db.appMember.create({ data: { appId: appA, userId: u, role: 'owner' } });
    await db.appMember.create({ data: { appId: appB, userId: u, role: 'owner' } });
    const agent = (await db.agent.create({ data: { id: generateId(), organizationId: org, name: 'ag', urn: 'o:ag' } as never })).id;
    subscribe = () => db.agentSubscription.create({ data: { userId: u, agentId: agent, activatedAt: new Date() } });
    dest = (await mem('o:dest', { organizationId: org, class: 'knowledge' })).id;
    configId = (await db.memoryConfig.create({ data: { id: generateId(), memoryId: dest } })).id;
    memories = {
      know: (await mem('o:k', { organizationId: org, class: 'knowledge' })).id,
      pubOwnOrg: (await mem('o:pub', { organizationId: org, class: 'knowledge', visibility: 'PUBLIC' })).id,
      appA: (await mem('o:ama', { organizationId: org, class: 'app', appId: appA })).id,
      appB: (await mem('o:amb', { organizationId: org, class: 'app', appId: appB })).id,
      appC: (await mem('o:amc', { organizationId: org, class: 'app', appId: appC })).id,
      knowAppB: (await mem('o:kb', { organizationId: org, class: 'knowledge', appId: appB })).id,
      personalFree: (await mem('o:pf', { organizationId: org, class: 'personal', userId: u })).id,
      privateFree: (await mem('o:prf', { organizationId: org, class: 'private', userId: u })).id,
      personalA: (await mem('o:pa', { organizationId: org, class: 'personal', appId: appA, userId: u, userMemoryOfAgentId: agent })).id,
      personalB: (await mem('o:pb', { organizationId: org, class: 'personal', appId: appB, userId: u, userMemoryOfAgentId: agent })).id,
      privateB: (await mem('o:prb', { organizationId: org, class: 'private', appId: appB, userId: u, userMemoryOfAgentId: agent })).id,
      personalC: (await mem('o:pc', { organizationId: org, class: 'personal', appId: appC, userId: u, userMemoryOfAgentId: agent })).id,
      holdingB: (await mem('o:hb', { organizationId: org, class: 'knowledge', appId: appB, userMemoryOfAgentId: agent, createdBy: u })).id,
      holdingC: (await mem('o:hc', { organizationId: org, class: 'knowledge', appId: appC, userMemoryOfAgentId: agent, createdBy: u })).id,
      sharedV: (await mem('o:sv', { organizationId: org, class: 'personal', userId: v })).id,
      vPersonal: (await mem('o:vp', { organizationId: org, class: 'personal', userId: v })).id,
      ownedKnow: (await mem('o:own', { class: 'knowledge', ownerUserId: u })).id,
    };
    await db.memoryShare.create({ data: { memoryId: memories.sharedV!, granteeId: u, grantorId: v, role: 'reader' as never } });
    memories.sessMem = (await mem('o:sm', { organizationId: org, class: 'app', appId: appA })).id;
    const sU = generateId();
    const sK = generateId();
    await db.session.create({ data: { id: sU, appId: appA, userId: u, memoryId: memories.sessMem } as never });
    await db.session.create({ data: { id: sK, appId: appA, memoryId: memories.sessMem } as never });
    for (const id of Object.values(memories)) {
      await db.node.create({ data: { id: generateId(), memoryId: id, loc: 'task', name: 'T', content: 'body', isRunnable: true, revSeq: 2 } });
    }
    const base = { roles: [], organizationId: org, clientId: 'cli' };
    principals = {
      user: { ...base, userId: u },
      hybridA: { ...base, userId: u, appId: appA },
      hybridASess: { ...base, userId: u, appId: appA, sessionId: sU },
      keyA: { ...base, appId: appA, clientId: 'app:k', appKeyId: 'k' },
      keyASess: { ...base, appId: appA, sessionId: sK, clientId: 'app:k', appKeyId: 'k' },
      admin: { ...base, roles: ['ADMIN'], userId: v },
      imperson: { ...base, userId: u, appId: appA, impersonation: { orgId: org, adminUserId: v } },
    } as unknown as Record<string, AuthContext>;
  });

  const verdictOn = async (ctx: Context, taskMemoryId: string) => {
    const task = await db.node.findFirstOrThrow({ where: { memoryId: taskMemoryId, loc: 'task' } });
    await db.nodeRoleRule.deleteMany({ where: { configId } });
    await db.nodeRoleRule.create({ data: { id: generateId(), configId, role: 'guide', authorTaskId: task.id, authorTaskRequired: true } });
    return db.$transaction((tx) => judgeAuthoring(tx, dest, write as never, attestedAuthoring(ctx, null, 'mcp')));
  };

  it('READABLE on MCP exactly where the MCP read gate admits, on every principal and memory', async () => {
    const differ: string[] = [];
    let surfaceDifference = 0;
    for (const [principal, auth] of Object.entries(principals)) {
      for (const [shape, id] of Object.entries(memories)) {
        const loads = await canReadMemory(db, auth, id, EXPLICIT_REF);
        const onMcp = await verdictOn({ ...auth, db, readsAuthorTask: mcpReadsTask(auth) } as unknown as Context, id);
        const readable = onMcp.refused ? onMcp.recovery?.taskAccess === 'READABLE' : false;
        if (readable !== loads) differ.push(`${principal}/${shape}`);
        const onGraphql = await verdictOn({ ...auth, db } as unknown as Context, id);
        if (onGraphql.refused && onGraphql.recovery?.taskAccess === 'READABLE' && !loads) surfaceDifference += 1;
      }
    }
    expect(differ).toEqual([]);
    expect(surfaceDifference).toBe(17);
  }, 120_000);

  it('asks as an explicit reference, as hadron_get_node does: an own memory in another App they belong to', async () => {
    await subscribe();
    const auth = principals.hybridA!;
    expect(await canReadMemory(db, auth, memories.personalB!)).toBe(false);
    expect(await canReadMemory(db, auth, memories.personalB!, EXPLICIT_REF)).toBe(true);
    const verdict = await verdictOn({ ...auth, db, readsAuthorTask: mcpReadsTask(auth) } as unknown as Context, memories.personalB!);
    expect(verdict.refused && verdict.recovery?.taskAccess).toBe('READABLE');
  });
});
