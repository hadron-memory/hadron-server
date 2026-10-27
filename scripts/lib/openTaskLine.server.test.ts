/**
 * #2613 — the wake scripts' open-task count (scripts/lib/openTaskLine.ts) against REAL server behavior: the exact
 * query text the scripts send, validated against the live SDL and run through the shared task-read gate, under the
 * credentials a delivery script can hold. The scripts' own suites use fakes; this is the authorized-list proof.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../src/integrations/db/client.js';
import { cleanDb } from '../../src/test/helpers.js';
import { generateId } from '../../src/lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../src/lib/workerSignature.js';
import { OPEN_TASKS_QUERY, countOpenTasks } from './openTaskLine.js';
import { typeDefs } from '../../src/api/graphql/schema/typeDefs.js';
import { resolvers, type Context } from '../../src/api/graphql/schema/resolvers.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });
const M = resolvers.Mutation as any;

let member: { id: string };
let appX: { id: string };
let appY: { id: string };
let keyX: { id: string };
let anne: { id: string };
let bert: { id: string };

const userCtx = (): Context => ({ db, userId: member.id, roles: ['READER'] });
const keyCtx = (extra: Partial<Context> = {}): Context => ({ db, appId: appX.id, appKeyId: keyX.id, roles: [], ...extra });

async function read(ctx: Context, app: string, worker: string, offset = 0) {
  const res = await server.executeOperation(
    { query: OPEN_TASKS_QUERY, variables: { a: app, w: worker, o: offset } },
    { contextValue: ctx },
  );
  if (res.body.kind !== 'single') throw new Error('unexpected');
  return res.body.singleResult;
}

async function task(appId: string, worker: string | null, status: 'PENDING' | 'STARTED' | 'FINISHED' | 'CANCELLED' | 'BACKLOG', title = 't') {
  const t = await M.createAgentTask({}, { input: { appRef: appId, title } }, userCtx());
  const now = new Date();
  await db.agentTask.update({
    where: { id: t.id },
    data: {
      assigneeWorkerId: worker, status: status.toLowerCase(),
      assignedAt: worker ? now : null,
      startedAt: status === 'STARTED' || status === 'FINISHED' ? now : null,
      finishedAt: status === 'FINISHED' ? now : null,
      cancelledAt: status === 'CANCELLED' ? now : null,
      resultOutcome: status === 'FINISHED' ? 'succeeded' : null,
    },
  });
  return t.id as string;
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const org = await db.organization.create({ data: { id: generateId(), name: 'ot-org', urn: `ot-org-${suffix}.com` } });
  member = await db.user.create({ data: { id: generateId(), githubId: 98_200, githubUsername: `ot-${suffix}`, roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: member.id, role: 'ADMIN' } });
  appX = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'X', urn: `${org.urn}:x` } });
  appY = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Y', urn: `${org.urn}:y` } });
  await db.appMember.create({ data: { appId: appX.id, userId: member.id, role: 'member' } });
  await db.appMember.create({ data: { appId: appY.id, userId: member.id, role: 'member' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, userCtx());
  anne = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: appX.id, agentId: agent.id, name: 'Anne', slug: 'anne' }, select: { id: true } });
  bert = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: appX.id, agentId: agent.id, name: 'Bert', slug: 'bert' }, select: { id: true } });
  keyX = await db.appKey.create({ data: { id: generateId(), appId: appX.id, keyHash: `h-${generateId()}`, keyPreview: 'abcd' }, select: { id: true } });
});

describe('the open-task read the wake scripts send (#2613)', () => {
  it('validates against the live SDL and returns only the worker\'s PENDING and STARTED tasks', async () => {
    const a = await task(appX.id, anne.id, 'PENDING');
    const b = await task(appX.id, anne.id, 'STARTED');
    await task(appX.id, anne.id, 'FINISHED');
    await task(appX.id, anne.id, 'CANCELLED');
    await task(appX.id, null, 'BACKLOG'); // unassigned backlog
    await task(appX.id, bert.id, 'STARTED'); // another worker's
    await task(appY.id, anne.id, 'STARTED'); // another App's
    const r = await read(userCtx(), appX.id, anne.id);
    expect(r.errors).toBeUndefined();
    expect((r.data?.agentTasks as Array<{ id: string }>).map((t) => t.id).sort()).toEqual([a, b].sort());
  });

  it('the script\'s own count agrees, for an App participant and for the App\'s live key', async () => {
    await task(appX.id, anne.id, 'PENDING');
    await task(appX.id, anne.id, 'STARTED');
    await task(appX.id, anne.id, 'FINISHED');
    for (const ctx of [userCtx(), keyCtx()]) {
      const run = (argv: string[]) => {
        const f = (k: string) => argv.find((x, i) => argv[i - 1] === '-F' && x.startsWith(`${k}=`))!.slice(k.length + 1);
        return server.executeOperation({ query: argv[2], variables: { a: f('a'), w: f('w'), o: Number(f('o')) } }, { contextValue: ctx })
          .then((res) => res);
      };
      // The script's runner is synchronous; drain the two reads through the real server first.
      const first = await run(['hadron', 'api', OPEN_TASKS_QUERY, '-F', `a=${appX.id}`, '-F', `w=${anne.id}`, '-F', 'o=0']);
      if (first.body.kind !== 'single') throw new Error('unexpected');
      const stdout = JSON.stringify(first.body.singleResult);
      expect(countOpenTasks(() => ({ code: 0, stdout }), 'hadron', appX.id, anne.id)).toBe(2);
    }
  });

  it('refuses a credential with no right to the App, so the script reads unknown, never zero', async () => {
    await task(appX.id, anne.id, 'STARTED');
    // another App's key
    const keyY = await db.appKey.create({ data: { id: generateId(), appId: appY.id, keyHash: `h-${generateId()}`, keyPreview: 'wxyz' }, select: { id: true } });
    const wrongKey = await read({ db, appId: appY.id, appKeyId: keyY.id, roles: [] }, appX.id, anne.id);
    expect(wrongKey.errors?.[0]?.extensions?.code).toBe('APP_NOT_FOUND');
    // a session-bound key
    const bound = await read(keyCtx({ sessionId: generateId() }), appX.id, anne.id);
    expect(bound.errors?.[0]?.extensions?.code).toBe('APP_KEY_SESSION_BOUND');
    // a non-participant user
    const outsider = await db.user.create({ data: { id: generateId(), githubId: 98_201, githubUsername: `out-${generateId()}`, roles: ['READER'] }, select: { id: true } });
    const denied = await read({ db, userId: outsider.id, roles: ['READER'] }, appX.id, anne.id);
    expect(denied.errors?.[0]?.extensions?.code).toBe('APP_NOT_FOUND');
    for (const r of [wrongKey, bound, denied]) {
      const stdout = JSON.stringify(r);
      expect(countOpenTasks(() => ({ code: 0, stdout }), 'hadron', appX.id, anne.id)).toBeNull();
    }
  });

  it('pages at the server cap of 200', async () => {
    const rows = Array.from({ length: 201 }, (_, i) => ({
      id: generateId(), appId: appX.id, title: `bulk ${i}`, handle: `AT0.${i + 100}`, taskNumber: i + 100, status: 'pending',
      assigneeWorkerId: anne.id, assignedAt: new Date(),
    }));
    const seed = await M.createAgentTask({}, { input: { appRef: appX.id, title: 'seed' } }, userCtx());
    const template = await db.agentTask.findUniqueOrThrow({ where: { id: seed.id } });
    await db.agentTask.createMany({ data: rows.map((r) => ({ ...template, ...r })) as any });
    const first = await read(userCtx(), appX.id, anne.id, 0);
    const second = await read(userCtx(), appX.id, anne.id, 200);
    expect((first.data?.agentTasks as unknown[]).length).toBe(200);
    expect((second.data?.agentTasks as unknown[]).length).toBe(1);
  });
});
