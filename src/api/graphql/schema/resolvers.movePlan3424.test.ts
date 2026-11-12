/** cor:api:190:03 — a plan uses the move's checks without performing its writes. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { typeDefs } from './typeDefs.js';
import { impersonationReadOnlyPlugin } from '../impersonationReadOnlyPlugin.js';
import { generateId } from '../../../lib/id.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph, createDbNode, createDbAppWithKey, createDbAppAgent, createDbAppMember } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';

const M = resolvers.Mutation as any;
let memory: { id: string; urn: string };
let userId: string;
const context = (): Context => ({ db, userId, roles: ['ADMIN'] });
beforeEach(async () => {
  await cleanDb(db);
  userId = (await db.user.create({ data: { githubId: 3424, githubUsername: 'plan3424', roles: ['ADMIN'] } })).id;
  memory = (await createDbOrgAndGraph(db, { orgName: 'plan3424', graphName: 'plan', visibility: 'PUBLIC' })).graph;
});
afterEach(() => vi.restoreAllMocks());
const targetUrn = (loc: string) => `hrn:node:${memory.urn.replace(/^hrn:mem:/, '')}:${loc}`;
describe('planNodeMove #3424', () => {
  it('lists stable IDs and rebased URNs in loc order without changing rows or revisions', async () => {
    const root = await createDbNode(db, { memoryId: memory.id, loc: 'a' });
    const child = await createDbNode(db, { memoryId: memory.id, loc: 'a:b' });
    const before = await db.node.findMany({ where: { memoryId: memory.id }, orderBy: { id: 'asc' } });
    const revisions = await db.nodeRevision.count();
    const plan = await M.planNodeMove(null, { sourceRef: root.id, targetUrn: `hrn:node:${memory.urn.replace(/^hrn:mem:/, '')}:z` }, context());
    expect(plan.nodes).toEqual([
      { id: root.id, currentUrn: `hrn:node:${memory.urn.replace(/^hrn:mem:/, '')}:a`, newUrn: `hrn:node:${memory.urn.replace(/^hrn:mem:/, '')}:z` },
      { id: child.id, currentUrn: `hrn:node:${memory.urn.replace(/^hrn:mem:/, '')}:a:b`, newUrn: `hrn:node:${memory.urn.replace(/^hrn:mem:/, '')}:z:b` },
    ]);
    expect(plan.totalCount).toBe(2);
    expect(plan.truncated).toBe(false);
    expect(plan.pointInTime).toBe(true);
    expect(await db.node.findMany({ where: { memoryId: memory.id }, orderBy: { id: 'asc' } })).toEqual(before);
    expect(await db.nodeRevision.count()).toBe(revisions);
    await M.moveNode(null, { sourceRef: root.id, targetUrn: plan.nodes[0].newUrn }, context());
    expect((await db.node.findUniqueOrThrow({ where: { id: child.id } })).loc).toBe('z:b');
  });
  it('discloses a bounded result with the full count', async () => {
    const root = await createDbNode(db, { memoryId: memory.id, loc: 'a' });
    await createDbNode(db, { memoryId: memory.id, loc: 'a:b' });
    const plan = await M.planNodeMove(null, { sourceRef: root.id, targetUrn: `hrn:node:${memory.urn.replace(/^hrn:mem:/, '')}:z`, limit: 1 }, context());
    expect(plan.nodes).toHaveLength(1);
    expect(plan.totalCount).toBe(2);
    expect(plan.truncated).toBe(true);
  });
  it.each(['a:b', 'taken'])('raises the real move refusal for %s without revisions', async target => {
    const root = await createDbNode(db, { memoryId: memory.id, loc: 'a' });
    await createDbNode(db, { memoryId: memory.id, loc: 'taken' });
    const args = { sourceRef: root.id, targetUrn: `hrn:node:${memory.urn.replace(/^hrn:mem:/, '')}:${target}` };
    const revisions = await db.nodeRevision.count();
    const moveError = await M.moveNode(null, args, context()).catch((e: unknown) => e);
    expect(moveError.extensions.code).toBe(target === 'a:b' ? 'BAD_USER_INPUT' : 'NODE_ALREADY_EXISTS');
    await expect(M.planNodeMove(null, args, context())).rejects.toMatchObject({ message: moveError.message, extensions: moveError.extensions });
    expect(await db.nodeRevision.count()).toBe(revisions);
  });
  it('does not lock or reconcile even a governed source with raw content drift', async () => {
    const root = await createDbNode(db, { memoryId: memory.id, loc: 'a' });
    await db.node.update({ where: { id: root.id }, data: { content: 'raw drift', role: 'info' } });
    const before = await db.node.findUniqueOrThrow({ where: { id: root.id } });
    const revisions = await db.nodeRevision.count();
    const transaction = db.$transaction.bind(db);
    const sql: string[] = [];
    vi.spyOn(db, '$transaction').mockImplementation((async (work: any, options: any) => transaction(async tx => {
      for (const method of ['$queryRaw', '$executeRaw'] as const) {
        const original = tx[method].bind(tx);
        vi.spyOn(tx, method).mockImplementation(((...args: any[]) => {
          sql.push(String(args[0]));
          return (original as any)(...args);
        }) as any);
      }
      return work(tx);
    }, options)) as any);
    await M.planNodeMove(null, { sourceRef: root.id, targetUrn: targetUrn('z') }, context());
    expect(sql.filter(q => /FOR (UPDATE|SHARE|NO KEY UPDATE)|pg_advisory/i.test(q))).toEqual([]);
    expect(await db.node.findUniqueOrThrow({ where: { id: root.id } })).toEqual(before);
    expect(await db.nodeRevision.count()).toBe(revisions);
  });

  it.each([
        ['info', 'decision', 'DECISION_CONTAINED'],
    ['compiled-boot-prompt', 'boot-prompt', 'BOOT_PROMPT_COMPILED_WRITE'],
  ])('uses the real refusal for governed %s/%s', async (nodeType, role, code) => {
    const root = await createDbNode(db, { memoryId: memory.id, loc: 'a' });
    await db.node.update({ where: { id: root.id }, data: { nodeType: nodeType!, role } });
    const args = { sourceRef: root.id, targetUrn: targetUrn('z') };
    const before = await db.node.findMany({ where: { memoryId: memory.id } });
    const real = await M.moveNode(null, args, context()).catch((e: unknown) => e);
    expect(real.extensions?.code).toBe(code);
    await expect(M.planNodeMove(null, args, context())).rejects.toMatchObject({ message: real.message, extensions: real.extensions });
    expect(await db.node.findMany({ where: { memoryId: memory.id } })).toEqual(before);
  });

  it('withholds link warnings for an unreadable user-owned system destination', async () => {
    const other = await db.user.create({ data: { githubId: 3425, githubUsername: 'other3424' } });
    const dest = await db.memory.create({ data: { id: generateId(), urn: 'plan3424:hidden', name: 'hidden',
      class: 'system', ownerUserId: other.id, visibility: null } });
    await db.agent.create({ data: { id: generateId(), name: 'Hidden agent', urn: 'plan3424:hidden-agent', ownerUserId: other.id, systemMemoryId: dest.id } });
    const root = await createDbNode(db, { memoryId: memory.id, loc: 'a', content: '[[target]]' });
    await createDbNode(db, { memoryId: memory.id, loc: 'target' });
    await createDbNode(db, { memoryId: dest.id, loc: 'target' });
    const plan = await M.planNodeMove(null, { sourceRef: root.id, targetMemoryRef: dest.id }, context());
    expect(plan.linkWarningsWithheld).toBe(true);
    expect(plan.linkWarnings).toBeNull();
    expect((await db.node.findUniqueOrThrow({ where: { id: root.id } })).memoryId).toBe(memory.id);
  });

  it('reports cross-memory content links against the virtual moved subtree', async () => {
    const dest = (await createDbOrgAndGraph(db, { orgName: 'dest3424', graphName: 'dest', visibility: 'PUBLIC' })).graph;
    const root = await createDbNode(db, { memoryId: memory.id, loc: 'a', content: '[[a:b]] [[outside]]' });
    await createDbNode(db, { memoryId: memory.id, loc: 'a:b' });
    await createDbNode(db, { memoryId: memory.id, loc: 'outside' });
    const args = { sourceRef: root.id, targetMemoryRef: dest.id };
    const plan = await M.planNodeMove(null, args, context());
    expect(plan.linkWarningsWithheld).toBe(false);
    expect(plan.linkWarnings).toMatchObject([{ target: 'outside', status: 'MISSING' }]);
    const moved = await M.moveNode(null, args, context());
    expect(plan.linkWarnings).toEqual(moved.moveLinkWarnings);
  });

  it('conceals an unreadable source exactly as the real move does', async () => {
    const root = await createDbNode(db, { memoryId: memory.id, loc: 'a' });
    await db.memory.update({ where: { id: memory.id }, data: { visibility: 'ORGANIZATION' } });
    const outsider = await db.user.create({ data: { githubId: 3426, githubUsername: 'outsider3424' } });
    const ctx: Context = { db, userId: outsider.id, roles: ['READER'] };
    const args = { sourceRef: root.id, targetUrn: targetUrn('z') };
    const real = await M.moveNode(null, args, ctx).catch((e: unknown) => e);
    expect(real.extensions.code).toBe('NODE_NOT_FOUND');
    await expect(M.planNodeMove(null, args, ctx)).rejects.toMatchObject({ message: real.message, extensions: real.extensions });
  });

  it('is refused by the mutation impersonation chokepoint', async () => {
    const server = new ApolloServer<Context>({ typeDefs, resolvers, plugins: [impersonationReadOnlyPlugin] });
    try {
      const result = await server.executeOperation({ query: 'mutation { planNodeMove(sourceRef: "missing", targetMemoryRef: "missing") { totalCount } }' },
        { contextValue: { ...context(), impersonation: { sessionId: 'test', readOnly: true } as any } });
      expect(result.body.kind).toBe('single');
      if (result.body.kind === 'single') expect(result.body.singleResult.errors?.[0].extensions?.code).toBe('IMPERSONATION_READ_ONLY');
    } finally { await server.stop(); }
  });

  it('refuses a comment node and carrying threads into a private memory', async () => {
    const root = await createDbNode(db, { memoryId: memory.id, loc: 'a' });
    const comment = await M.createComment(null, { targetRef: root.id, body: 'discussion' }, context());
    const dest = await db.memory.create({ data: { id: generateId(), urn: 'plan3424:private', name: 'private',
      class: 'private', userId, ownerUserId: userId } });
    for (const [args, code] of [
      [{ sourceRef: comment.id, targetUrn: targetUrn('z') }, 'ROLE_GOVERNED'],
      [{ sourceRef: root.id, targetMemoryRef: dest.id }, 'COMMENT_MOVE_UNCOMMENTABLE'],
    ] as const) {
      const real = await M.moveNode(null, args, context()).catch((e: unknown) => e);
      expect(real.extensions.code).toBe(code);
      await expect(M.planNodeMove(null, args, context())).rejects.toMatchObject({ message: real.message, extensions: real.extensions });
    }
  });

  it.each(['encrypted', 'chat', 'schema'])('shares cross-memory %s refusal', async kind => {
    const dest = (await createDbOrgAndGraph(db, { orgName: 'dest3424', graphName: 'dest', visibility: 'PUBLIC' })).graph;
    const root = await createDbNode(db, { memoryId: memory.id, loc: 'a' });
    if (kind === 'encrypted') await db.memory.update({ where: { id: dest.id }, data: { isEncrypted: true } });
    if (kind === 'chat') await db.node.update({ where: { id: root.id }, data: { nodeType: 'chat' } });
    if (kind === 'schema') {
      await db.memory.update({ where: { id: dest.id }, data: { schema: { objectTypes: { widget: { fields: { size: { type: 'text', required: true } } } } } } });
      await db.node.update({ where: { id: root.id }, data: { objectType: 'widget', properties: {} } });
    }
    const args = { sourceRef: root.id, targetMemoryRef: dest.id };
    const revisions = await db.nodeRevision.count();
    const real = await M.moveNode(null, args, context()).catch((e: unknown) => e);
    expect(real.extensions.code).toBe('BAD_USER_INPUT');
    await expect(M.planNodeMove(null, args, context())).rejects.toMatchObject({ message: real.message, extensions: real.extensions });
    expect(await db.nodeRevision.count()).toBe(revisions);
  });

  it('shares Channel source and destination refusals', async () => {
    const root = await createDbNode(db, { memoryId: memory.id, loc: 'a' });
    await M.createChannel(null, { input: { memoryRef: memory.id, loc: 'chats:room', name: 'room' } }, context());
    for (const args of [
      { sourceRef: root.id, targetUrn: targetUrn('chats:room:child') },
      { sourceRef: targetUrn('chats:room'), targetUrn: targetUrn('z') },
    ]) {
      const real = await M.moveNode(null, args, context()).catch((e: unknown) => e);
      expect(real.extensions.code).toBeTruthy();
      await expect(M.planNodeMove(null, args, context())).rejects.toMatchObject({ message: real.message, extensions: real.extensions });
    }
  });

  it('refuses a readable source when the caller cannot write it', async () => {
    const root = await createDbNode(db, { memoryId: memory.id, loc: 'a' });
    const ctx = { ...context(), roles: [] };
    const args = { sourceRef: root.id, targetUrn: targetUrn('z') };
    const real = await M.moveNode(null, args, ctx).catch((e: unknown) => e);
    expect(real.extensions.code).toBe('FORBIDDEN');
    await expect(M.planNodeMove(null, args, ctx)).rejects.toMatchObject({ message: real.message, extensions: real.extensions });
  });

  it('plans install-memory writes for the live manager without authority locks, and refuses a participant', async () => {
    const org = await db.organization.create({ data: { name: 'Install plan', urn: 'install3424' } });
    const agent = await db.agent.create({ data: { name: 'Agent', urn: 'install3424:agent', organizationId: org.id } });
    const { app } = await createDbAppWithKey(db, 'install-plan', org.id);
    await createDbAppAgent(db, app.id, agent.id);
    await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
    await createDbAppMember(db, app.id, userId, 'member');
    const root = await M.createNode(null, { input: { install: { appRef: app.id, agentRef: agent.id }, loc: 'a', name: 'A' } }, context());
    const mem = await db.memory.findUniqueOrThrow({ where: { id: root.memoryId } });
    const args = { sourceRef: root.id, targetUrn: `hrn:node:${mem.urn}:z` };
    const transaction = db.$transaction.bind(db);
    const sql: string[] = [];
    vi.spyOn(db, '$transaction').mockImplementation((async (work: any, options: any) => transaction(async tx => {
      for (const method of ['$queryRaw', '$executeRaw'] as const) {
        const original = tx[method].bind(tx);
        vi.spyOn(tx, method).mockImplementation(((...args: any[]) => {
          sql.push(String(args[0]));
          return (original as any)(...args);
        }) as any);
      }
      return work(tx);
    }, options)) as any);
    expect((await M.planNodeMove(null, args, context())).totalCount).toBe(1);
    expect(sql.filter(q => /FOR (UPDATE|SHARE|NO KEY UPDATE)|pg_advisory/i.test(q))).toEqual([]);
    vi.restoreAllMocks();
    const participant = await db.user.create({ data: { name: 'Participant' } });
    await createDbAppMember(db, app.id, participant.id, 'member');
    const ctx: Context = { db, userId: participant.id, roles: [] };
    const real = await M.moveNode(null, args, ctx).catch((e: unknown) => e);
    expect(real.extensions.code).toBe('FORBIDDEN');
    await expect(M.planNodeMove(null, args, ctx)).rejects.toMatchObject({ message: real.message, extensions: real.extensions });
  });

  it('reports warnings for a readable shared personal destination', async () => {
    const owner = await db.user.create({ data: { name: 'Share owner' } });
    const dest = await db.memory.create({ data: { id: generateId(), urn: 'plan3424:shared', name: 'shared',
      class: 'personal', userId: owner.id, ownerUserId: owner.id } });
    await db.memoryShare.create({ data: { memoryId: dest.id, granteeId: userId, grantorId: owner.id, role: 'writer' } });
    const root = await createDbNode(db, { memoryId: memory.id, loc: 'a', content: '[[outside]]' });
    await createDbNode(db, { memoryId: memory.id, loc: 'outside' });
    const sourceMemory = await db.memory.findUniqueOrThrow({ where: { id: memory.id } });
    await db.orgMember.create({ data: { organizationId: sourceMemory.organizationId!, userId, role: 'CONTRIBUTOR' } });
    const plan = await M.planNodeMove(null, { sourceRef: root.id, targetMemoryRef: dest.id }, { ...context(), roles: [] });
    expect(plan.linkWarningsWithheld).toBe(false);
    expect(plan.linkWarnings).toMatchObject([{ target: 'outside', status: 'MISSING' }]);
  });

  it('keeps historical MEMORY prefix aliases in plan/real warning agreement', async () => {
    const dest = (await createDbOrgAndGraph(db, { orgName: 'dest3424', graphName: 'dest-new', visibility: 'PUBLIC' })).graph;
    await createDbNode(db, { memoryId: memory.id, loc: 'old-link' });
    const other = await createDbNode(db, { memoryId: dest.id, loc: 'new-target' });
    await db.urnAlias.create({ data: { entityType: 'MEMORY', entityId: dest.id, urn: 'plan3424:dest-old', reason: 'RENAME' } });
    await db.urnAlias.create({ data: { entityType: 'NODE', entityId: other.id, urn: 'plan3424:dest-old:old-link', reason: 'RENAME' } });
    const root = await createDbNode(db, { memoryId: memory.id, loc: 'a', content: '[[old-link]]' });
    const args = { sourceRef: root.id, targetMemoryRef: dest.id };
    const plan = await M.planNodeMove(null, args, context());
    const moved = await M.moveNode(null, args, context());
    expect(moved.moveLinkWarnings).toMatchObject([{ target: 'old-link', status: 'RETARGETED' }]);
    expect(plan.linkWarnings).toEqual(moved.moveLinkWarnings);
  });

  it('projects a newly created alias reachable through a historical destination prefix', async () => {
    const dest = (await createDbOrgAndGraph(db, { orgName: 'dest3424', graphName: 'dest', visibility: 'PUBLIC' })).graph;
    await db.urnAlias.create({ data: { entityType: 'MEMORY', entityId: dest.id, urn: memory.urn, reason: 'RENAME' } });
    const root = await createDbNode(db, { memoryId: memory.id, loc: 'a', content: '[[a]]' });
    await db.node.update({ where: { id: root.id }, data: { mintedAt: new Date(), mintedByInfo: 'test' } });
    const args = { sourceRef: root.id, targetUrn: `hrn:node:${dest.urn}:z` };
    const plan = await M.planNodeMove(null, args, context());
    expect(await db.urnAlias.count({ where: { entityType: 'NODE', entityId: root.id } })).toBe(0);
    const moved = await M.moveNode(null, args, context());
    expect(moved.moveLinkWarnings).toEqual([]);
    expect(plan.linkWarnings).toEqual(moved.moveLinkWarnings);
    expect(await db.urnAlias.count({ where: { entityType: 'NODE', entityId: root.id } })).toBe(1);
  });

  it.each(['key', 'sign-in'] as const)('plans install moves with a live %s credential and refuses its revocation', async credential => {
    const org = await db.organization.create({ data: { name: 'Credential plan', urn: 'credential3424' } });
    const agent = await db.agent.create({ data: { name: 'Agent', urn: 'credential3424:agent', organizationId: org.id } });
    const { app } = await createDbAppWithKey(db, 'credential-plan', org.id);
    await createDbAppAgent(db, app.id, agent.id);
    await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
    await createDbAppMember(db, app.id, userId, 'member');
    const root = await M.createNode(null, { input: { install: { appRef: app.id, agentRef: agent.id }, loc: 'a', name: 'A' } }, context());
    const mem = await db.memory.findUniqueOrThrow({ where: { id: root.memoryId } });
    const key = await db.userApiKey.create({ data: { userId, keyHash: generateId(), keyPreview: '3424', oauthScopes: [] } });
    const signIn = await db.signIn.create({ data: { userId, method: 'email', expiresAt: new Date(Date.now() + 60_000) } });
    const ctx: Context = { ...context(), ...(credential === 'key' ? { apiKeyId: key.id } : { signInId: signIn.id }) };
    const args = { sourceRef: root.id, targetUrn: `hrn:node:${mem.urn}:z` };
    const before = await db.node.findUniqueOrThrow({ where: { id: root.id } });
    const plan = await M.planNodeMove(null, args, ctx);
    expect(plan.nodes).toMatchObject([{ id: root.id, newUrn: args.targetUrn }]);
    expect(await db.node.findUniqueOrThrow({ where: { id: root.id } })).toEqual(before);
    if (credential === 'key') await db.userApiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    else await db.signIn.update({ where: { id: signIn.id }, data: { endedAt: new Date(), endReason: 'revoked' } });
    const real = await M.moveNode(null, args, ctx).catch((e: unknown) => e);
    expect(real.extensions.code).toBe('FORBIDDEN');
    await expect(M.planNodeMove(null, args, ctx)).rejects.toMatchObject({ message: real.message, extensions: real.extensions });
  });

});
