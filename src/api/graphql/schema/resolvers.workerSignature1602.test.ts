/** #1602: cast defaults, manager-only atomic edits and S4 delivery. H26 session denial is provisional. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { resolvers, type Context } from './resolvers.js';
import { composeWorkerPrompt } from './resolvers.worker.js';
import { applyPlatformVariables } from '../../../lib/personaDescription.js';
import { agentPlatformValues } from '../../../lib/bootPrompt/variables.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any, Q = resolvers.Query as any, W = resolvers.Worker as any;
const SIG = '— [{{worker.name}}, {{worker.role}}]({{worker.url}}) · {{session.llmModel}}';
const TRL = 'Worker: {{worker.name}} ({{worker.role}}) <{{worker.url}}>';
let org: any, app: any, agent: any, admin: any, staff: any, member: any, outsider: any, worker: any;
const ctx = (u = admin, extra: Partial<Context> = {}): Context => ({ db, userId: u.id, roles: ['READER'], ...extra });
const update = (args: object, c = ctx()) => M.updateWorker({}, { workerRef: worker.id, ...args }, c);
const row = () => db.worker.findUniqueOrThrow({ where: { id: worker.id } }) as Promise<any>;
beforeEach(async () => {
  await cleanDb(db);
  const n = generateId().toLowerCase();
  org = await db.organization.create({ data: { name: 'Signature', urn: `sig-${n}.example` } });
  const user = (i: number) => db.user.create({ data: { githubId: 91602000 + i, githubUsername: `sig-${i}`, roles: ['READER'] } });
  [admin, staff, member, outsider] = await Promise.all([0, 1, 2, 3].map(user));
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: staff.id, role: 'CONTRIBUTOR' } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  agent = await M.createAgent({}, { orgId: org.id, name: 'Engineer', personaRole: 'engineer' }, ctx());
  await serveAgentBootPrompt(db, agent.id, '{{worker.signature}}\n{{worker.trailer}}');
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  const made = await M.castWorker({}, { appRef: app.id, agentRef: agent.id, name: 'Anne' }, ctx());
  worker = await db.worker.findUniqueOrThrow({ where: { id: made.id } });
});

describe('#1602 signature/trailer', () => {
  it('casts exact variable defaults and pre-renders preview without inventing a worker/model', async () => {
    expect(await row()).toMatchObject({ signature: SIG, trailer: TRL });
    const preview = await Q.castWorkerPreview({}, { appRef: app.id, agentRef: agent.id, name: 'Bea' }, ctx());
    expect(preview.prompt).toBe('— [Bea, engineer]() · \nWorker: Bea (engineer) <>');
  });
  it('manager edits reach next compose and leave the prior briefing immutable', async () => {
    const old = (await composeWorkerPrompt(ctx(), worker, { llmModel: 'model-one' })).text;
    expect(old).toContain('— [Anne, engineer](');
    expect(old).toContain('model-one');
    await update({ signature: 'Hello {{worker.name}} / {{session.llmModel}}', trailer: 'By {{worker.role}}' });
    const next = (await composeWorkerPrompt(ctx(), await row(), { llmModel: 'model-two' })).text;
    expect(next).toBe('Hello Anne / model-two\nBy engineer');
    expect(old).not.toContain('Hello');
  });
  it('does not recursively expand signature/trailer tokens, unknown tokens or values containing tokens', async () => {
    await update({ signature: '{{worker.signature}}|{{worker.trailer}}|{{unknown}}|{{worker.name}}', trailer: '{{worker.signature}}' });
    const got = await composeWorkerPrompt(ctx(), { ...await row(), name: '{{agent.name}}' });
    expect(got.text).toBe('{{worker.signature}}|{{worker.trailer}}|{{unknown}}|{{agent.name}}\n{{worker.signature}}');
  });
  it.each(['signature', 'trailer'])('%s omission preserves; whitespace empties; nonblank stays raw', async field => {
    const before = await row();
    await update({ [field === 'signature' ? 'trailer' : 'signature']: 'the other field' });
    expect((await row())[field]).toBe(before[field]);
    await update({ [field]: ' \t\n' }); expect((await row())[field]).toBe('');
    await update({ [field]: '  raw {{worker.name}}  ' }); expect((await row())[field]).toBe('  raw {{worker.name}}  ');
  });
  it.each(['signature', 'trailer'])('%s invalid values roll back a mixed prompt edit', async field => {
    for (const value of [null, 'x'.repeat(2001), 'no\0value']) {
      const before = await row();
      await expect(update({ [field]: value })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
      expect(await row()).toEqual(before);
    }
    await expect(update({ [field]: 'x'.repeat(2000) })).resolves.toBeTruthy();
  });
  it.each(['staff', 'member', 'outsider', 'key', 'impersonation', 'run', 'session'])('refuses %s with no mixed-field writes', async kind => {
    const before = await row();
    const c = kind === 'staff' ? ctx(staff) : kind === 'member' ? ctx(member) : kind === 'outsider' ? ctx(outsider)
      : kind === 'key' ? { db, appId: app.id, roles: [] } as Context
      : kind === 'impersonation' ? ctx(admin, { roles: [], impersonation: { sessionId: generateId(), actorUserId: outsider.id, orgId: org.id, expiresAt: new Date(Date.now() + 60000) } })
      : ctx();
    const call = () => update({ signature: 'denied', trailer: 'denied' }, c);
    const result = kind === 'session' ? runAsActor({ workerId: worker.id, agentId: agent.id }, call) : kind === 'run' ? runAsActor({ workerId: null, agentId: agent.id }, call) : call();
    await expect(result).rejects.toBeTruthy();
    expect(await row()).toEqual(before);
  });
  it('owner-role App member and unbound org/platform managers may edit', async () => {
    await db.appMember.update({ where: { appId_userId: { appId: app.id, userId: member.id } }, data: { role: 'owner' } });
    await expect(update({ signature: 'owner' }, ctx(member))).resolves.toMatchObject({ signature: 'owner' });
    await db.user.update({ where: { id: outsider.id }, data: { roles: ['ADMIN'] } });
    await expect(update({ trailer: 'platform' }, ctx(outsider, { roles: ['ADMIN'] }))).resolves.toMatchObject({ trailer: 'platform' });
    await expect(update({ signature: 'org' })).resolves.toMatchObject({ signature: 'org' });
  });
  it('masks both working-state fields for a historical nonreader', async () => {
    expect(typeof W.signature).toBe('function'); expect(typeof W.trailer).toBe('function');
    expect(await W.signature(worker, {}, ctx(outsider))).toBeNull();
    expect(await W.trailer(worker, {}, ctx(outsider))).toBeNull();
    expect(await W.signature(worker, {}, ctx())).toBe(SIG);
  });
  it('retired workers refuse', async () => {
    await db.worker.update({ where: { id: worker.id }, data: { retiredAt: new Date() } });
    await expect(update({ signature: 'retired' })).rejects.toMatchObject({ extensions: { code: 'WORKER_RETIRED' } });
  });
  it('a fieldless call on a retired worker refuses too (#2725 blind P3, main parity)', async () => {
    await db.worker.update({ where: { id: worker.id }, data: { retiredAt: new Date() } });
    await expect(update({})).rejects.toMatchObject({ extensions: { code: 'WORKER_RETIRED', workerId: worker.id } });
  });
  it('no-worker chat/headless keeps signature and trailer empty', () => {
    // The served chat path's binding (serveChatPrompt): the Agent's own values, no worker.
    const values = agentPlatformValues({ name: 'Agent', urn: 'sig.example:agent', personaRole: 'engineer' });
    expect(applyPlatformVariables('[{{worker.signature}}][{{worker.trailer}}]', values)).toBe('[][]');
  });
  it('migration backfills each NULL independently, preserving configured and retired rows on rerun', async () => {
    const sql = readFileSync('prisma/migrations/20261019090000_worker_signature/migration.sql', 'utf8');
    const constant = await import('../../../lib/workerSignature.js');
    expect(constant.DEFAULT_WORKER_SIGNATURE).toBe(SIG); expect(constant.DEFAULT_WORKER_TRAILER).toBe(TRL);
    expect(sql).toContain(SIG); expect(sql).toContain(TRL);
    // Replay the actual migration in an isolated schema with only its target table.
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe('CREATE SCHEMA signature1602');
      await tx.$executeRawUnsafe('SET LOCAL search_path TO signature1602');
      await tx.$executeRawUnsafe('CREATE TABLE workers (id text PRIMARY KEY, retired_at timestamp, signature text, trailer text)');
      await tx.$executeRawUnsafe("INSERT INTO workers VALUES ('a',NULL,NULL,'configured trailer'),('b',now(),'configured signature',NULL),('c',NULL,'','')");
      // Migration statements have no dollar-quoted procedural bodies.
      for (const statement of sql.split(';').filter(s => s.trim())) await tx.$executeRawUnsafe(statement);
      const first = await tx.$queryRawUnsafe<any[]>('SELECT * FROM workers ORDER BY id');
      expect(first.map(r => [r.signature, r.trailer])).toEqual([[SIG, 'configured trailer'], ['configured signature', TRL], ['', '']]);
      for (const statement of sql.split(';').filter(s => s.trim())) await tx.$executeRawUnsafe(statement);
      expect(await tx.$queryRawUnsafe('SELECT * FROM workers ORDER BY id')).toEqual(first);
      await tx.$executeRawUnsafe('DROP SCHEMA signature1602 CASCADE');
    });
  });
});

it('user-owned App owner may edit without an org staffing role', async () => {
  await db.app.update({ where: { id: app.id }, data: { organizationId: null, ownerUserId: outsider.id } });
  await expect(update({ signature: 'owned' }, ctx(outsider))).resolves.toMatchObject({ signature: 'owned' });
});

it('rechecks retirement at the transactional write and rolls back the mixed edit', async () => {
  let parked = false;
  const wrapped = new Proxy(db, { get(target, prop) {
    if (prop !== '$transaction') return Reflect.get(target, prop);
    return (fn: any, opts: any) => target.$transaction(async tx => fn(new Proxy(tx, { get(client, key) {
      if (key !== 'worker') return Reflect.get(client, key);
      return new Proxy(client.worker, { get(delegate, method) {
        if (method !== 'updateMany') return Reflect.get(delegate, method);
        return async (args: any) => {
          if (!parked) { parked = true; await db.worker.update({ where: { id: worker.id }, data: { retiredAt: new Date() } }); }
          return delegate.updateMany(args);
        };
      } });
    } })), opts);
  } });
  await expect(update({ signature: 'late', trailer: 'late' }, ctx(admin, { db: wrapped }))).rejects.toMatchObject({ extensions: { code: 'WORKER_RETIRED' } });
  expect(await row()).toMatchObject({ signature: SIG, trailer: TRL });
});

it('GraphQL exposes both fields, preserves omissions, and atomically refuses null', async () => {
  const { ApolloServer } = await import('@apollo/server');
  const { typeDefs } = await import('./typeDefs.js');
  const server = new ApolloServer<Context>({ typeDefs, resolvers });
  const source = 'mutation($id:ID!,$signature:String){updateWorker(workerRef:$id,signature:$signature){signature trailer}}';
  const goodResult = await server.executeOperation({ query: source, variables: { id: worker.id, signature: 'graphql' } }, { contextValue: ctx() });
  const good = (goodResult.body as any).singleResult;
  expect(good.errors).toBeUndefined();
  expect((good.data as any).updateWorker).toEqual({ signature: 'graphql', trailer: TRL });
  const badResult = await server.executeOperation({ query: source, variables: { id: worker.id, signature: null } }, { contextValue: ctx() });
  const bad = (badResult.body as any).singleResult;
  expect(bad.errors?.[0].extensions.code).toBe('BAD_USER_INPUT');
  expect((await row()).signature).toBe('graphql');
  await server.stop();
});


// #3082: retired MCP wrapper-only cases; authoritative GraphQL/lib cases remain.
it.each(['worker-only', 'context-bound', 'binding-refused'] as const)('H26 independently refuses %s without relying on agent actor', async kind => {
  const session = kind === 'context-bound' ? await db.session.create({ data: { id: generateId(), userId: admin.id, appId: app.id, workerId: worker.id, agentId: agent.id } }) : null;
  const before = await row();
  const call = () => update({ signature: 'no', trailer: 'no' }, ctx(admin, {
    ...(session ? { sessionId: session.id } : {}), ...(kind === 'binding-refused' ? { sessionBindingRefused: true } : {}),
  }));
  await expect(kind === 'worker-only' ? runAsActor({ workerId: worker.id, agentId: null }, call) : call()).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  expect(await row()).toEqual(before);
});

// #3082: retired MCP wrapper-only cases; authoritative GraphQL/lib cases remain.
