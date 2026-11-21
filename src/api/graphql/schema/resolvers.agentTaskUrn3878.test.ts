/**
 * #3878 (cor:urn:010:01, the Agent task row; ruling 0278): an agent task's URN `hrn:agenttask:<root>:<app-slug>:<handle>`
 * is COMPUTED at read time (no column) and EMITTED ENTIRELY IN LOWER CASE, the handle leaf included (`…:at3.405`), while
 * input stays case-insensitive. `resolveUrn` resolves it through the App's reference (rename alias map) and then
 * `Query.agentTask`'s own read gate (`withReadableTask`: an App participant or the App's own key), and every refusal is
 * the one null (cor:api:180:01): a caller outside the App, another App's task, a malformed body, a task-id leaf and a
 * nonexistent handle are indistinguishable. The MCP task read prints the same address.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { qualifiedTaskHandle } from '../../../lib/agentTasks/handle.js';
import { renderTask } from '../../../mcp/agentTaskTools.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
// The run arm's team-read decision (cor:agt:050:23), made switchable so the pin compares the arm with Query.agentTask.
const runGrant = vi.hoisted(() => ({ value: false }));
vi.mock('../../../lib/auth/runTeamRead.js', () => ({ runMayReadTeam: vi.fn(async () => runGrant.value) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const T = (resolvers as any).AgentTask as Record<string, (t: any, a: unknown, c: Context) => unknown>;

let org: { id: string; urn: string };
let alice: { id: string }; // member of X and Y
let bob: { id: string };   // member of X only
let eve: { id: string };   // a member of the org, but of no App
let zed: { id: string };   // another org entirely
let appX: { id: string; urn: string };
let appY: { id: string; urn: string };
let keyX: { id: string };
let keyY: { id: string };

const as = (u: { id: string }): Context => ({ db, userId: u.id, roles: ['READER'] });
const keyCtx = (app: { id: string }, key: { id: string }): Context => ({ db, appId: app.id, appKeyId: key.id, roles: [] });
const user = (githubId: number) => db.user.create({ data: { id: generateId(), githubId, githubUsername: `u${githubId}-${generateId().slice(0, 6)}`, roles: ['READER'] }, select: { id: true } });
const urnOf = (t: any, c: Context = as(alice)) => T.urn!(t, {}, c) as Promise<string | null>;
const resolve = (urn: string, c: Context) => Q.resolveUrn({}, { urn }, c);
/** The task's URN as the gate composes it, upper-case handle (the spelling ruling 0065 emitted). */
const upper = (app: { urn: string }, handle: string) => `hrn:agenttask:${app.urn}:${handle}`;

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'u-org', urn: `u-org-${suffix}.com` } });
  const otherOrg = await db.organization.create({ data: { id: generateId(), name: 'z-org', urn: `z-org-${suffix}.com` } });
  alice = await user(38_781);
  bob = await user(38_782);
  eve = await user(38_783);
  zed = await user(38_784);
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: alice.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: eve.id, role: 'READER' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: otherOrg.id, userId: zed.id, role: 'ADMIN' } });
  appX = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'X', urn: `${org.urn}:x` } });
  appY = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Y', urn: `${org.urn}:y` } });
  await db.appMember.create({ data: { appId: appX.id, userId: alice.id, role: 'member' } });
  await db.appMember.create({ data: { appId: appY.id, userId: alice.id, role: 'member' } });
  await db.appMember.create({ data: { appId: appX.id, userId: bob.id, role: 'member' } });
  keyX = await db.appKey.create({ data: { id: generateId(), appId: appX.id, keyHash: `h-${generateId()}`, keyPreview: 'abcd' }, select: { id: true } });
  keyY = await db.appKey.create({ data: { id: generateId(), appId: appY.id, keyHash: `h-${generateId()}`, keyPreview: 'efgh' }, select: { id: true } });
});

/** AT0 (the reserved bookkeeping row), a project AT1, and a nested AT1.1 in App X; AT0.1 in App Y. */
async function seed() {
  const loose: any = await M.createAgentTask({}, { input: { appRef: appX.id, title: 'loose' } }, as(alice)); // AT0.1, makes AT0
  const at0 = await db.agentTask.findUniqueOrThrow({ where: { appId_handle: { appId: appX.id, handle: 'AT0' } } });
  const project: any = await M.createAgentTask({}, { input: { appRef: appX.id, title: 'project', project: true, assignee: { user: bob.id } } }, as(alice));
  const nested: any = await M.createAgentTask({}, { input: { parentTaskId: project.id, title: 'nested' } }, as(bob));
  const onY: any = await M.createAgentTask({}, { input: { appRef: appY.id, title: 'on Y' } }, as(alice));
  expect([at0.handle, loose.handle, project.handle, nested.handle, onY.handle]).toEqual(['AT0', 'AT0.1', 'AT1', 'AT1.1', 'AT0.1']);
  return { at0, loose, project, nested, onY };
}

describe('#3878 AgentTask.urn: computed, all lower case', () => {
  it('the SDL declares AgentTask.urn', () => {
    const block = typeDefs.match(/type AgentTask \{[\s\S]*?\n {2}\}/)![0];
    expect(block).toMatch(/\n {4}urn: String\n/);
  });

  it('emits hrn:agenttask:<root>:<app-slug>:<handle> with the handle in lower case, for AT0 and a nested handle', async () => {
    const { at0, nested, loose } = await seed();
    expect(await urnOf(at0)).toBe(`hrn:agenttask:${org.urn}:x:at0`);
    expect(await urnOf(nested)).toBe(`hrn:agenttask:${org.urn}:x:at1.1`);
    expect(await urnOf(loose)).toBe(`hrn:agenttask:${org.urn}:x:at0.1`);
  });

  it('the emitted urn carries no upper-case character, and the displayed handle stays upper case', async () => {
    const { at0, nested } = await seed();
    for (const t of [at0, nested]) {
      const urn = await urnOf(t);
      expect(urn).not.toBeNull();
      expect(urn).not.toMatch(/[A-Z]/);
      expect(T.handle!(t, {}, as(alice))).toMatch(/^AT/);
    }
  });

  it('a stored App urn that cannot compose a fixed-arity URN gives null, not a wrong address', async () => {
    const { nested } = await seed();
    await db.app.update({ where: { id: appX.id }, data: { urn: 'nocolon' } });
    expect(await T.urn!(nested, {}, { db, userId: alice.id, roles: ['READER'] })).toBeNull();
  });
});

describe('#3878 resolveUrn agenttask arm', () => {
  it('resolves the lower-case URN and the upper-case input alike to the task, with its organization', async () => {
    const { nested } = await seed();
    const want = { kind: 'agenttask', id: nested.id, organizationId: org.id };
    expect(await resolve(`hrn:agenttask:${org.urn}:x:at1.1`, as(alice))).toMatchObject(want);
    expect(await resolve(upper(appX, 'AT1.1'), as(alice))).toMatchObject(want);
    expect(await resolve(`hrn:agenttask:${org.urn}:x:At1.1`, as(bob))).toMatchObject(want);
  });

  it('round-trips: the emitted URN resolves to the same task, AT0 included', async () => {
    const { at0, project, nested, onY } = await seed();
    for (const t of [at0, project, nested, onY]) {
      const urn = (await urnOf(t))!;
      expect(await resolve(urn, as(alice))).toMatchObject({ kind: 'agenttask', id: t.id });
    }
  });

  it('the App key reads its own App\'s tasks by URN and nothing of another App', async () => {
    const { nested, onY } = await seed();
    expect(await resolve((await urnOf(nested))!, keyCtx(appX, keyX))).toMatchObject({ kind: 'agenttask', id: nested.id });
    expect(await resolve((await urnOf(onY))!, keyCtx(appX, keyX))).toBeNull();
    expect(await resolve((await urnOf(onY))!, keyCtx(appY, keyY))).toMatchObject({ kind: 'agenttask', id: onY.id });
  });

  it('a headless run in the App answers exactly as Query.agentTask does, granted or not', async () => {
    const { nested, onY } = await seed();
    const runCtx: Context = { db, appId: appX.id, organizationId: org.id, clientId: 'run:r1', roles: [] };
    for (const granted of [true, false]) {
      runGrant.value = granted;
      const direct = await Q.agentTask({}, { id: nested.id }, runCtx);
      const byUrn = await resolve(`hrn:agenttask:${org.urn}:x:at1.1`, runCtx);
      expect(direct?.id ?? null).toBe(granted ? nested.id : null);
      expect(byUrn?.id ?? null).toBe(granted ? nested.id : null);
      expect(await resolve(`hrn:agenttask:${org.urn}:y:at0.1`, runCtx), 'another App').toBeNull();
    }
    runGrant.value = false;
    expect(onY.appId).toBe(appY.id);
  });

  it('a URN through the App\'s rename alias resolves to the same task', async () => {
    const { nested } = await seed();
    const renamed = `renamed-${generateId().slice(0, 8)}.test:old`;
    await db.urnAlias.create({ data: { urn: renamed, entityType: 'APP', entityId: appX.id, reason: 'RENAME', replacedByUrn: appX.urn } });
    expect(await resolve(`hrn:agenttask:${renamed}:at1.1`, as(alice))).toMatchObject({ kind: 'agenttask', id: nested.id });
  });

  it('every refusal is the one null: outsider, other org, wrong App, nonexistent, malformed, task-id leaf, fragment', async () => {
    const { nested, onY } = await seed();
    const good = (await urnOf(nested))!;
    // Positive control: the same URN resolves for a participant, so each null below is the gate, not a broken arm.
    expect(await resolve(good, as(bob))).toMatchObject({ id: nested.id });
    const nulls: [string, Context][] = [
      [good, as(eve)],                                                  // org member, no App
      [good, as(zed)],                                                  // another org
      [(await urnOf(onY))!, as(bob)],                                   // bob is not in Y
      [`hrn:agenttask:${org.urn}:y:at1.1`, as(alice)],                  // Y has no AT1.1; X's handle under Y names nothing
      [`hrn:agenttask:${org.urn}:x:at9.9`, as(alice)],                  // nonexistent
      [`hrn:agenttask:${org.urn}:nosuchapp:at1.1`, as(alice)],          // no such App
      [`hrn:agenttask:${org.urn}:at1.1`, as(alice)],                    // wrong arity (no App slug)
      [`hrn:agenttask:${org.urn}:x:extra:at1.1`, as(alice)],            // wrong arity (extra segment)
      [`hrn:agenttask:${org.urn}:x:${nested.id}`, as(alice)],           // task-id leaf is not built
      [`hrn:agenttask:${org.urn}:x:at01`, as(alice)],                   // not a handle
      [`${good}#data`, as(alice)],                                      // no fragment on a task
    ];
    for (const [urn, c] of nulls) expect(await resolve(urn, c), urn).toBeNull();
  });

  it('a legacy App whose urn is not the <root>:<slug> pair emits no URN, and no wider-arity spelling resolves its tasks', async () => {
    const legacy = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'L', urn: `${org.urn}:x:extra` } });
    await db.appMember.create({ data: { appId: legacy.id, userId: alice.id, role: 'member' } });
    const t: any = await M.createAgentTask({}, { input: { appRef: legacy.id, title: 'legacy' } }, as(alice));
    // Positive control: the task is readable to alice by id, so the null below is the arity rule, not the gate.
    expect((await Q.agentTask({}, { id: t.id }, as(alice)))?.id).toBe(t.id);
    expect(await urnOf(t)).toBeNull();
    expect(await resolve(`hrn:agenttask:${org.urn}:x:extra:at0.1`, as(alice))).toBeNull();
  });

  it('an outsider gets the same null for a real task and a nonexistent one', async () => {
    const { nested } = await seed();
    const real = await resolve((await urnOf(nested))!, as(eve));
    const missing = await resolve(`hrn:agenttask:${org.urn}:x:at7.7`, as(eve));
    expect(real).toBeNull();
    expect(missing).toBeNull();
  });
});

describe('#3878 the second emission site and the hint texts say the same thing', () => {
  it('qualifiedTaskHandle emits the same lower-case URN as AgentTask.urn', async () => {
    const { nested } = await seed();
    expect(qualifiedTaskHandle(appX.urn, 'AT1.1')).toBe(await urnOf(nested));
  });

  it('the qualify refusal and the SDL show the lower-case form', async () => {
    let e: GraphQLError | undefined;
    try { await Q.agentTask({}, { id: 'AT0.1' }, as(alice)); } catch (err) { e = err as GraphQLError; }
    expect(e?.extensions?.code).toBe('TASK_HANDLE_QUALIFY');
    expect(e?.message).toContain('hrn:agenttask:<app-urn>:at<number>');
    expect(typeDefs).not.toMatch(/hrn:agenttask:<app-urn>:AT/);
  });
});

describe('#3878 MCP task read carries the URN', () => {
  it('renderTask prints a urn line with the emitted URN', async () => {
    const { nested } = await seed();
    const text = await renderTask(nested, as(alice));
    expect(text).toContain(`  urn: hrn:agenttask:${org.urn}:x:at1.1`);
  });
});
