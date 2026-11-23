/**
 * #4689 — a run's includes follow a full node URN into another memory, under the right reader.
 *
 * cor:dmo:150:02 lets a full node URN name a node in any memory; cor:dmo:150:04 checks the READER's access to each
 * target when it resolves; cor:dmo:150:05 shows one notice, the same bytes, for a missing or an unreadable target.
 * cor:api:060:05 makes a render and an execution one assembly (`assembleRunNodePrompt`), so the four surfaces below
 * change together. Who the reader is (ruling A, Holger 2026-11-23, decision record
 * hrn:node:hadronmemory.com:hadron-dev-team-shared:decisions:2026-11-23-holger-rulings-to-victor §1):
 *
 *  - a RENDER (the MCP run tools, `renderRunNode`, `runTask` without `appRef`): the caller, as on any read;
 *  - an EXECUTED run (the kernel calls `runTask` under the run principal, `runContext`): the run principal, judged
 *    exactly as adoption judges a partial (`captureAutomationPin`): same organization, not encrypted, readable by the
 *    principal. Anything else is the notice, so what runs is what was adopted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import { canReadMemory } from './access-control.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';
import { runAuthContext } from '../lib/auth/runPrincipal.js';
import { captureAutomationPin } from '../lib/automation/pins.js';
import { setResolutionLimits } from '../lib/includes/resolutionBudget.js';
import { sessionKeyCache } from '../lib/sessionKeyCache.js';
import { parseDataKey } from '../lib/crypto.js';
import { encryptNodeFieldsWithKey } from '../lib/nodeCrypto.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const NOTICE = '[Include unavailable]';
const T = {
  sameOrg: 'SAME-ORG-KNOWLEDGE-READABLE-BY-CALLER-AND-PRINCIPAL',
  otherOrg: 'OTHER-ORG-KNOWLEDGE-READABLE-BY-CALLER-AND-PRINCIPAL',
  callerPrivate: 'CALLER-PRIVATE-READABLE-BY-THE-CALLER-ONLY',
  hidden: 'STRANGER-PRIVATE-READABLE-BY-NOBODY-HERE',
  encrypted: 'ENCRYPTED-SAME-ORG-KNOWLEDGE-KEY-CACHED',
  appMemory: 'APP-MEMORY-READABLE-BY-THE-APP-PRINCIPAL',
} as const;
type Slot = keyof typeof T | 'missing';
const SLOTS: Slot[] = ['sameOrg', 'otherOrg', 'callerPrivate', 'hidden', 'encrypted', 'appMemory', 'missing'];

let ownerId: string;
let orgId: string;
let appId: string;
let runMemId: string;
let runMemUrn: string;
const memIds: Partial<Record<Slot, string>> = {};
const urnOf: Partial<Record<Slot, string>> = {};

const callerCtx = (): Context => ({ db, roles: ['READER'], userId: ownerId, clientId: `user:${ownerId}` } as Context);
const callerAuth = (): AuthContext => ({ userId: ownerId, roles: ['READER'], clientId: `user:${ownerId}` });
/** The context the run kernel executes under (`runContext`, src/jobs/appRunDeps.ts). */
const principal = (onBehalf: boolean): AuthContext =>
  runAuthContext({ id: generateId(), appId, userId: onBehalf ? ownerId : null, organizationId: orgId });
const principalCtx = (onBehalf: boolean): Context => ({ db, ...principal(onBehalf) } as Context);

const mcpUrn = (loc: string): string => {
  const i = runMemUrn.indexOf(':');
  return `${runMemUrn.slice(0, i)}::${runMemUrn.slice(i + 1)}::${loc}`;
};
const runTask = async (loc: string, ctx: Context): Promise<string> =>
  (await resolvers.Mutation.runTask({}, { nodeRef: `hrn:node:${runMemUrn}:${loc}`, args: { subject: 'x' } }, ctx)) as string;
const renders = [
  ['hadron_run_action', (loc: string) => createTestableMcpServer(callerAuth()).callToolText('hadron_run_action', { urn: mcpUrn(loc), args: { subject: 'x' } })],
  ['hadron_run_task (render path)', (loc: string) => createTestableMcpServer(callerAuth()).callToolText('hadron_run_task', { urn: mcpUrn(loc), args: { subject: 'x' } })],
  ['renderRunNode', async (loc: string) => (await resolvers.Query.renderRunNode({}, { nodeRef: `hrn:node:${runMemUrn}:${loc}`, args: { subject: 'x' } }, callerCtx())) as string],
  ['runTask without appRef (render)', (loc: string) => runTask(loc, callerCtx())],
] as const;

const mkMemory = async (org: string, name: string): Promise<{ id: string; urn: string }> => {
  const created = (await resolvers.Mutation.createMemory({}, { orgRef: org, name: `${name}-${generateId()}` }, callerCtx())) as { id: string };
  return db.memory.findUniqueOrThrow({ where: { id: created.id }, select: { id: true, urn: true } });
};
const mkNode = (memoryId: string, loc: string, content: string, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, nodeType: 'info', content, tags: [], ...extra } as never });
const tag = (slot: Slot) => `{{> ${urnOf[slot]}}}`;
/** One runnable node per slot, so each include is judged on its own: `<slot>[` + include + `]`. */
const taskOf = (slot: Slot) => `tasks:${slot}`;
const segment = (text: string, slot: Slot): string => {
  const m = text.match(new RegExp(`${slot}\\[(.*?)\\] end`, 's'));
  if (!m) throw new Error(`no ${slot} segment in: ${text}`);
  return m[1];
};

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  const n = generateId().slice(-8).toLowerCase();
  const org = await db.organization.create({ data: { id: generateId(), name: 'fi-org', urn: `fi-${n}.test` } });
  const org2 = await db.organization.create({ data: { id: generateId(), name: 'fi-org2', urn: `fi2-${n}.test` } });
  orgId = org.id;
  const owner = await db.user.create({ data: { githubId: 46_890_000 + Math.floor(Math.random() * 100_000), githubUsername: `fi-owner-${n}`, roles: ['READER'] } });
  ownerId = owner.id;
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: owner.id, role: 'ADMIN' },
    { organizationId: org2.id, userId: owner.id, role: 'ADMIN' },
  ] });
  appId = (await db.app.create({ data: { organizationId: org.id, name: 'Runner', urn: `${org.urn}:runner` } })).id;

  // The run nodes live in an App memory, which the caller, and the App's principal with or without a user, all read.
  const run = await db.memory.create({ data: { id: generateId(), name: 'Run', urn: `${org.urn}:run-${n}`, class: 'app', appId, organizationId: org.id } });
  runMemId = run.id;
  runMemUrn = run.urn;
  const sameOrg = await mkMemory(org.id, 'SameOrg');
  const otherOrg = await mkMemory(org2.id, 'OtherOrg');
  const encrypted = await mkMemory(org.id, 'Encrypted');
  const callerPrivate = await db.memory.create({ data: { id: generateId(), name: 'Mine', urn: `${org.urn}:mine-${n}`, class: 'private', userId: owner.id, ownerUserId: owner.id } });
  const stranger = await db.user.create({ data: { githubId: 46_990_000 + Math.floor(Math.random() * 100_000), githubUsername: `fi-stranger-${n}`, roles: [] } });
  const hidden = await db.memory.create({ data: { id: generateId(), name: 'Theirs', urn: `${org.urn}:theirs-${n}`, class: 'private', userId: stranger.id, ownerUserId: stranger.id } });
  const appMemory = await db.memory.create({ data: { id: generateId(), name: 'AppMem', urn: `${org.urn}:appmem-${n}`, class: 'app', appId, organizationId: org.id } });

  for (const [slot, mem] of [['sameOrg', sameOrg], ['otherOrg', otherOrg], ['callerPrivate', callerPrivate], ['hidden', hidden], ['encrypted', encrypted], ['appMemory', appMemory]] as const) {
    memIds[slot] = mem.id;
    urnOf[slot] = `hrn:node:${mem.urn}:snippet`;
    await mkNode(mem.id, 'snippet', T[slot]);
  }
  memIds.missing = sameOrg.id;
  urnOf.missing = `hrn:node:${sameOrg.urn}:no-such-node`;
  // Sealed directly (encryptMemory is the memory owner's door): an org knowledge memory the principal reads, whose
  // content opens only with its key, and the key is cached, so the only thing keeping a run out is the encryption rule.
  const key = parseDataKey(Buffer.alloc(32, 11).toString('base64'));
  await db.memory.update({ where: { id: encrypted.id }, data: { isEncrypted: true, vectorIndexEnabled: false } });
  await db.node.update({ where: { loc_memoryId: { loc: 'snippet', memoryId: encrypted.id } }, data: encryptNodeFieldsWithKey({ content: T.encrypted }, key) as never });
  sessionKeyCache.set('fi-4689', encrypted.id, key);

  for (const slot of SLOTS) await mkNode(runMemId, taskOf(slot), `${slot}[${tag(slot)}] end {{subject}}`, { isRunnable: true });
});
afterEach(() => {
  setResolutionLimits(null);
  sessionKeyCache.clear();
});

describe('#4689 fixtures: who can read what', () => {
  it('the caller reads every target memory but the stranger\'s; the principal on the caller\'s behalf reads the same-org and other-org ones; the App principal alone reads its App memory', async () => {
    const readable = async (auth: AuthContext) =>
      Object.fromEntries(await Promise.all((Object.keys(T) as Array<keyof typeof T>).map(async (s) => [s, await canReadMemory(db, auth, memIds[s]!)])));
    expect(await readable(callerAuth())).toEqual({ sameOrg: true, otherOrg: true, callerPrivate: true, hidden: false, encrypted: true, appMemory: true });
    expect(await readable(principal(true))).toMatchObject({ sameOrg: true, otherOrg: true, callerPrivate: false, hidden: false, appMemory: true });
    expect(await readable(principal(false))).toMatchObject({ sameOrg: false, otherOrg: false, callerPrivate: false, hidden: false, appMemory: true });
  });
});

describe('#4689 a RENDER resolves a foreign full-URN include as the caller reads it (cor:dmo:150:04)', () => {
  const expected: Record<Slot, string> = {
    sameOrg: T.sameOrg, otherOrg: T.otherOrg, callerPrivate: T.callerPrivate, hidden: NOTICE, encrypted: T.encrypted, appMemory: T.appMemory, missing: NOTICE,
  };

  it.each(renders)('%s: a readable target splices in, whichever memory it is in; an unreadable one is the notice, the same as a missing one', async (_name, call) => {
    for (const slot of SLOTS) {
      expect(segment(await call(taskOf(slot)), slot), slot).toBe(expected[slot]);
    }
  });

  it.each(renders)('%s: byte-identical to runTask\'s render (one assembly, cor:api:060:05)', async (_name, call) => {
    for (const slot of SLOTS) expect(await call(taskOf(slot)), slot).toBe(await runTask(taskOf(slot), callerCtx()));
  });

  it.each(renders)('%s: a readable foreign target\'s own includes resolve as the caller reads them too (nested)', async (_name, call) => {
    await mkNode(memIds.sameOrg!, 'outer', `outer(${tag('otherOrg')}|${tag('hidden')})`);
    await mkNode(runMemId, 'tasks:nested', `nested[{{> ${urnOf.sameOrg!.replace(':snippet', ':outer')}}}] end {{subject}}`, { isRunnable: true });
    expect(segment(await call('tasks:nested'), 'nested' as Slot)).toBe(`outer(${T.otherOrg}|${NOTICE})`);
  });
});

describe('#4689 an EXECUTED run resolves a foreign include as its run principal, judged as adoption judges a partial (ruling A)', () => {
  it('on the caller\'s behalf: the same-org readable target splices in; another organization, the caller\'s own private memory, an encrypted memory, an unreadable and a missing target are all the notice', async () => {
    const ctx = principalCtx(true);
    const got = Object.fromEntries(await Promise.all(SLOTS.map(async (s) => [s, segment(await runTask(taskOf(s), ctx), s)])));
    expect(got).toEqual({
      sameOrg: T.sameOrg, otherOrg: NOTICE, callerPrivate: NOTICE, hidden: NOTICE, encrypted: NOTICE, appMemory: T.appMemory, missing: NOTICE,
    });
  });

  it('with no on-behalf user: only what the App principal reads splices in', async () => {
    const ctx = principalCtx(false);
    const got = Object.fromEntries(await Promise.all(SLOTS.map(async (s) => [s, segment(await runTask(taskOf(s), ctx), s)])));
    expect(got).toEqual({
      sameOrg: NOTICE, otherOrg: NOTICE, callerPrivate: NOTICE, hidden: NOTICE, encrypted: NOTICE, appMemory: T.appMemory, missing: NOTICE,
    });
  });

  it('the reader is the principal, not the person who launched it: the same node renders the caller\'s private target and executes the notice', async () => {
    expect(segment(await runTask(taskOf('callerPrivate'), callerCtx()), 'callerPrivate')).toBe(T.callerPrivate);
    expect(segment(await runTask(taskOf('callerPrivate'), principalCtx(true)), 'callerPrivate')).toBe(NOTICE);
  });

  it('what executes is what adoption pinned: a URN include splices in exactly when captureAutomationPin records it present', async () => {
    for (const onBehalf of [true, false]) {
      for (const slot of SLOTS) {
        const entry = `hrn:node:${runMemUrn}:${taskOf(slot)}`;
        const pin = await captureAutomationPin(db, appId, onBehalf ? ownerId : null, entry, orgId, principal(onBehalf));
        const absent = pin.absentPartials.some((p) => p.urn === urnOf[slot]);
        const shown = segment(await runTask(taskOf(slot), principalCtx(onBehalf)), slot);
        expect(shown === NOTICE, `${slot} onBehalf=${onBehalf}`).toBe(absent);
      }
    }
  });

  it('a readable foreign target\'s own includes are judged by the same rule: another organization stays out even one level down', async () => {
    await mkNode(memIds.sameOrg!, 'outer', `outer(${tag('appMemory')}|${tag('otherOrg')})`);
    await mkNode(runMemId, 'tasks:nested', `nested[{{> ${urnOf.sameOrg!.replace(':snippet', ':outer')}}}] end {{subject}}`, { isRunnable: true });
    expect(segment(await runTask('tasks:nested', principalCtx(true)), 'nested' as Slot)).toBe(`outer(${T.appMemory}|${NOTICE})`);
  });
});

describe('#4689 the guards a foreign follow keeps (cor:dmo:150:05, hadron-internal#40)', () => {
  // Readable, unreadable and missing cost the same lookups, so the lookup limit is no existence oracle: at every bound
  // the three either all resolve or all refuse, on a render and on an execution.
  const surfaces = [
    ['render (hadron_run_action)', (loc: string) => createTestableMcpServer(callerAuth()).callToolText('hadron_run_action', { urn: mcpUrn(loc), args: { subject: 'x' } })],
    ['execution (run principal)', (loc: string) => runTask(loc, principalCtx(true)).catch((e: { message: string; extensions?: { code?: string } }) => `refused: ${e.extensions?.code} ${e.message}`)],
  ] as const;
  it.each(surfaces)('%s: at every lookup bound a readable, an unreadable and a missing foreign target refuse alike', async (_name, call) => {
    for (let maxLookups = 1; maxLookups <= 8; maxLookups += 1) {
      setResolutionLimits({ limits: { maxLookups } });
      const refused = await Promise.all((['sameOrg', 'hidden', 'missing'] as const).map(async (s) => (await call(taskOf(s))).includes('CONTENT_RESOLUTION_LIMIT_EXCEEDED')));
      expect(new Set(refused).size, `maxLookups=${maxLookups}: ${refused}`).toBe(1);
    }
  });
});
