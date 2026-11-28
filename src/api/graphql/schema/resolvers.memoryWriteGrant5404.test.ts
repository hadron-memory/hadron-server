/**
 * #5404 (S2 of #5321; hrn:node:hadronmemory.com:specs:cor:acl:140:02 `memory.read` / `memory.write`,
 * hrn:node:hadronmemory.com:specs:cor:agt:010:01; Holger, 2026-11-27, decision record
 * 2026-11-27-holger-rulings-to-victor-read-grant-shape-r1 sections 5-6; Q1 Victor #155838, Q2 Peter #155843, Q3 Peter #155843 /
 * Victor #155845): an App's userless runs reach a memory outside their own only through a SIGNED grant their App holds.
 *
 * Pinned (the issue's acceptance, as amended by the gate, comment 7218964670):
 *  1. the migration empties both unsigned grant tables and their event tables;
 *  2. a run is refused a read through an old per-automation read grant row and a write through an old App write grant row, on the
 *     GraphQL door, the run's own node tools and the MCP server, exactly as with no row;
 *  3. the same read and write work once signed (`memory.read`, `memory.write`, whole memory and the one-loc prefix form);
 *  4. `memory.write` is refused unsigned (PENDING), by a signer who does not manage the memory, for the organization value, for a
 *     target the write rule refuses, and for a prefix with a list; a giver who stops managing the memory ends the write;
 *  5. the six retired GraphQL doors and the three MCP tools answer DOOR_RETIRED, for every caller and argument.
 *
 * Red on main: main has no `memory.write` action, no DOOR_RETIRED and no migration, and still honours the old rows.
 */
import { readFileSync, readdirSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAuthContext } from '../../../lib/auth/runPrincipal.js';
import { attestedAuthoring } from '../../../lib/authoringAttestation.js';
import { writeNodeCore } from './resolvers.mutation.node.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { canReadMemory, canWriteToMemory } from '../../../mcp/access-control.js';
import { upsertPlatformActions } from '../../../lib/grants/actions.js';
import { createPendingGrant, GrantCreateRefusal } from '../../../lib/grants/create.js';
import { requireActionIssuer } from '../../../lib/grants/issuers.js';
import { userlessRunHoldsMemoryWriteGrant } from '../../../lib/grants/writeGrant.js';
import { activeMemoryReadGrant, activeMemoryWriteGrant, revokeGrantRow } from '../../../test/appGrants5404.js';
import { testRunAgentId } from '../../../test/runAgent.js';
import { hadronCreateNode, hadronReadNode } from '../../../lib/runner/tools/nodeTools.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const PREFIX = 'reports:team';
const LOC = 'reports:team:one';

async function fixture() {
  const tag = generateId().slice(-8).toLowerCase();
  const org = await db.organization.create({ data: { name: 'W', urn: `w5404-${tag}.test` } });
  const mgr = await db.user.create({ data: { handle: `mgr-${tag}` } });
  const member = await db.user.create({ data: { handle: `mem-${tag}` } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: mgr.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: member.id, role: 'CONTRIBUTOR' } });
  const app = await db.app.create({ data: { name: 'A', urn: `${org.urn}:app`, organizationId: org.id } });
  await db.appMember.create({ data: { appId: app.id, userId: mgr.id, role: 'owner' } });
  const mem = (slug: string, extra: Record<string, unknown> = {}) => db.memory.create({
    data: { name: slug, urn: `${org.urn}:${slug}`, class: 'knowledge', visibility: 'ORGANIZATION', organizationId: org.id, ...extra } as never,
  });
  const dest = await mem('dest');
  const other = await mem('other');
  const encrypted = await mem('vault', { isEncrypted: true });
  await db.node.create({ data: { memoryId: dest.id, loc: 'kept', name: 'kept', content: 'secret kept', nodeType: 'record' } });
  const schedule = await db.agentSchedule.create({
    data: { id: generateId(), organizationId: org.id, appId: app.id, name: 'S', cron: '* * * * *', entryNodeUrn: `hrn:node:${dest.urn}:kept` },
  });
  const run = await db.appRun.create({
    data: {
      id: generateId(), organizationId: org.id, appId: app.id, agentId: await testRunAgentId(db, org.id, app.id), userId: null,
      triggerKind: 'SCHEDULE', triggerId: schedule.id, entryNodeUrn: schedule.entryNodeUrn,
    },
  });
  const principal = { db, ...runAuthContext(run) } as unknown as Context;
  return { org, mgr, member, app, dest, other, encrypted, schedule, run, principal };
}
type F = Awaited<ReturnType<typeof fixture>>;
let f: F;
beforeEach(async () => { await cleanDb(db); await upsertPlatformActions(db); f = await fixture(); });

const write = (memoryId: string, loc: string) => writeNodeCore(
  { memoryId, loc, name: loc.split(':').pop()!, nodeType: 'record', content: 'body' } as never, f.principal as never, 'create',
  { ownerLimit: 'refuse', sizeCeiling: 'check', authoring: attestedAuthoring(null) },
);
const nodeAt = (memoryId: string, loc: string) => db.node.findFirst({ where: { memoryId, loc, deletedAt: null } });
const mcpCreate = (memory: { urn: string }, loc: string) => createTestableMcpServer(f.principal as never)
  .callToolText('hadron_create_node', { urn: `hrn:node:${memory.urn}:${loc}`, name: loc.split(':').pop()!, content: 'via mcp' });
const mcpGet = (memory: { urn: string }, loc: string) => createTestableMcpServer(f.principal as never)
  .callToolText('hadron_get_node', { urn: `hrn:node:${memory.urn}:${loc}` });
const auth = () => f.principal as never;
/** The run's own tool surface (what a run's model calls): the node write door with the destination named. The MCP server's
 * hadron_create_node names no destination (#2484: only the write door and the run pre-check do), so a write grant never answers
 * there, before or after #5404. */
const toolCreate = (memory: { urn: string }, loc: string) =>
  hadronCreateNode.execute({ db, run: f.run, principal: f.principal, log: () => undefined } as never, { urn: `hrn:node:${memory.urn}:${loc}`, name: 'n', content: 'via tool' });
const toolRead = (memory: { urn: string }, loc: string) =>
  hadronReadNode.execute({ db, run: f.run, principal: f.principal, log: () => undefined } as never, { urn: `hrn:node:${memory.urn}:${loc}` });

/** The old unsigned rows, as the retired doors wrote them. */
const oldWriteRow = () => db.appMemoryWriteGrant.create({ data: { appId: f.app.id, memoryId: f.dest.id, prefix: PREFIX, grantedBy: f.mgr.id } });
const oldReadRow = () => db.appAutomationReadGrant.create({
  data: { appId: f.app.id, triggerKind: 'SCHEDULE', triggerId: f.schedule.id, memoryId: f.dest.id, prefix: null, grantedBy: f.mgr.id },
} as never);

describe('1. the migration empties the unsigned grant tables (D-a, D-b)', () => {
  it('rows and event rows of both grants are gone after the migration runs; nothing else is touched', async () => {
    const w = await oldWriteRow();
    await db.appMemoryWriteGrantEvent.create({ data: { grantId: w.id, appId: f.app.id, memoryId: f.dest.id, prefix: PREFIX, action: 'GRANT', actorUserId: f.mgr.id } } as never);
    const r = await oldReadRow();
    await db.appAutomationReadGrantEvent.create({
      data: { grantId: (r as { id: string }).id, appId: f.app.id, triggerKind: 'SCHEDULE', triggerId: f.schedule.id, memoryId: f.dest.id, action: 'GRANT', actorUserId: f.mgr.id },
    } as never);
    const signed = await activeMemoryWriteGrant(f.app.id, f.dest.id, { issuerUserId: f.mgr.id });
    const dir = readdirSync(new URL('../../../../prisma/migrations', import.meta.url)).find((d) => d.endsWith('_drop_unsigned_app_grants'));
    expect(dir).toBeTruthy();
    await db.$executeRawUnsafe(readFileSync(new URL(`../../../../prisma/migrations/${dir}/migration.sql`, import.meta.url), 'utf8'));
    expect(await db.appMemoryWriteGrant.count()).toBe(0);
    expect(await db.appMemoryWriteGrantEvent.count()).toBe(0);
    expect(await db.appAutomationReadGrant.count()).toBe(0);
    expect(await db.appAutomationReadGrantEvent.count()).toBe(0);
    expect(await db.grant.findUnique({ where: { id: signed } })).not.toBeNull();
    expect(await db.memory.count({ where: { id: f.dest.id } })).toBe(1);
  });
});

describe('2. an old row reaches nothing', () => {
  it('write: refused on GraphQL, the run tool and MCP with an old App write grant row covering the loc, exactly as with none', async () => {
    await oldWriteRow();
    await expect(write(f.dest.id, LOC)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    await expect(toolCreate(f.dest, `${PREFIX}:tool`)).rejects.toBeTruthy();
    expect(await nodeAt(f.dest.id, `${PREFIX}:tool`)).toBeNull();
    expect(await canWriteToMemory(db, auth(), f.dest.id)).toBe(false);
    const withRow = await mcpCreate(f.dest, `${PREFIX}:mcp`);
    await db.$executeRawUnsafe('TRUNCATE TABLE app_memory_write_grant_events, app_memory_write_grants');
    expect(await mcpCreate(f.dest, `${PREFIX}:mcp`)).toBe(withRow);
    expect(await nodeAt(f.dest.id, LOC)).toBeNull();
    expect(await nodeAt(f.dest.id, `${PREFIX}:mcp`)).toBeNull();
  });

  it('read: refused on GraphQL and MCP with an old per-automation read grant row on the memory, exactly as with none', async () => {
    await oldReadRow();
    expect(await canReadMemory(db, auth(), f.dest.id)).toBe(false);
    await expect(toolRead(f.dest, 'kept')).rejects.toBeTruthy();
    await expect(Q.node({}, { ref: `hrn:node:${f.dest.urn}:kept` }, f.principal)).resolves.toBeNull();
    const withRow = await mcpGet(f.dest, 'kept');
    expect(withRow).not.toContain('secret kept');
    await db.$executeRawUnsafe('TRUNCATE TABLE app_automation_read_grant_events, app_automation_read_grants');
    expect(await mcpGet(f.dest, 'kept')).toBe(withRow);
  });
});

describe('3. the same read and write work once signed', () => {
  it('memory.write on the whole memory: the GraphQL write door and the run tool create; another memory stays refused', async () => {
    await activeMemoryWriteGrant(f.app.id, f.dest.id, { issuerUserId: f.mgr.id });
    await write(f.dest.id, LOC);
    expect(await nodeAt(f.dest.id, LOC)).not.toBeNull();
    expect(await toolCreate(f.dest, 'any:where')).toMatchObject({ created: true });
    expect(await nodeAt(f.dest.id, 'any:where')).not.toBeNull();
    await expect(write(f.other.id, LOC)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    await expect(toolCreate(f.other, 'any:where')).rejects.toBeTruthy();
    expect(await nodeAt(f.other.id, 'any:where')).toBeNull();
  });

  it('memory.write with a one-loc prefix covers the loc and its descendants, never a sibling or the parent', async () => {
    await activeMemoryWriteGrant(f.app.id, f.dest.id, { issuerUserId: f.mgr.id, prefix: PREFIX });
    await write(f.dest.id, PREFIX);
    await write(f.dest.id, LOC);
    for (const loc of ['reports', 'reports:teamX', 'other:loc']) {
      await expect(write(f.dest.id, loc)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
      expect(await nodeAt(f.dest.id, loc)).toBeNull();
    }
  });

  it('memory.write naming a list reaches each named memory', async () => {
    await activeMemoryWriteGrant(f.app.id, [f.dest.id, f.other.id], { issuerUserId: f.mgr.id });
    await write(f.dest.id, LOC);
    await write(f.other.id, LOC);
    expect(await nodeAt(f.other.id, LOC)).not.toBeNull();
  });

  it('memory.read: the run reads the memory on GraphQL and MCP; the read grant never admits a write', async () => {
    await activeMemoryReadGrant(f.app.id, f.dest.id, { issuerUserId: f.mgr.id });
    expect(await canReadMemory(db, auth(), f.dest.id)).toBe(true);
    expect(await mcpGet(f.dest, 'kept')).toContain('secret kept');
    expect(JSON.stringify(await toolRead(f.dest, 'kept'))).toContain('secret kept');
    await expect(write(f.dest.id, LOC)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });

  it('revoking the signed grant ends the write at the next call', async () => {
    const id = await activeMemoryWriteGrant(f.app.id, f.dest.id, { issuerUserId: f.mgr.id });
    await write(f.dest.id, LOC);
    await revokeGrantRow(id, f.mgr.id);
    await expect(write(f.dest.id, `${LOC}:2`)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });
});

describe('4. memory.write is signed, by the memory\'s manager, for a target the write rule admits', () => {
  const ctxOf = (userId: string): Context => ({ db, userId, roles: [] } as unknown as Context);
  const create = (values: unknown) => db.$transaction((tx) => createPendingGrant(tx, {
    appId: f.app.id, requester: { userId: f.mgr.id, workerId: null, sessionId: null }, holder: { kind: 'app', id: f.app.id },
    action: 'memory.write', values, reason: 'r', canReadMemory: async () => true,
  } as never));
  const code = (p: Promise<unknown>) => p.then(() => 'OK', (e) => e instanceof GrantCreateRefusal ? e.code : String(e));
  const signer = (userId: string, values: unknown) =>
    requireActionIssuer(ctxOf(userId), 'memory.write', f.app.id, values).then(() => 'OK', (e: any) => e?.extensions?.code ?? String(e));

  it('a PENDING (unsigned) memory.write grant reaches nothing', async () => {
    const id = await create({ memory: f.dest.id, prefix: '*' });
    expect((await db.grant.findUniqueOrThrow({ where: { id } })).activatedAt).toBeNull();
    await expect(write(f.dest.id, LOC)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });

  it('the memory\'s manager may sign; a member who does not manage it may not', async () => {
    expect(await signer(f.mgr.id, { memory: f.dest.id, prefix: '*' })).toBe('OK');
    expect(await signer(f.member.id, { memory: f.dest.id, prefix: '*' })).not.toBe('OK');
  });

  it('creation refuses the organization value, a wildcard memory, a refused target, a repeat and a prefix with a list', async () => {
    expect(await code(create({ memory: f.org.id, prefix: '*' }))).toBe('GRANT_VALUES_INVALID');
    expect(await code(create({ memory: '*', prefix: '*' }))).toBe('GRANT_VALUES_INVALID');
    expect(await code(create({ memory: f.encrypted.id, prefix: '*' }))).toBe('GRANT_VALUES_INVALID');
    expect(await code(create({ memory: [f.dest.id, f.dest.id], prefix: '*' }))).toBe('GRANT_VALUES_INVALID');
    expect(await code(create({ memory: [f.dest.id, f.other.id], prefix: PREFIX }))).toBe('GRANT_VALUES_INVALID');
    expect(await code(create({ memory: f.dest.id }))).toBe('GRANT_VALUES_INVALID');
    expect(await code(create({ memory: f.dest.id, prefix: PREFIX }))).toBe('OK');
    expect(await code(create({ memory: [f.dest.id], prefix: PREFIX }))).toBe('OK');
  });

  it('an active grant on a target the write rule refuses writes nothing (judged at every write)', async () => {
    await activeMemoryWriteGrant(f.app.id, f.encrypted.id, { issuerUserId: f.mgr.id });
    await expect(write(f.encrypted.id, LOC)).rejects.toBeTruthy();
    expect(await nodeAt(f.encrypted.id, LOC)).toBeNull();
  });

  it('a giver who no longer manages the memory ends the write; an erased giver does not', async () => {
    await activeMemoryWriteGrant(f.app.id, f.dest.id, { issuerUserId: f.member.id });
    await expect(write(f.dest.id, LOC)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    await activeMemoryWriteGrant(f.app.id, f.other.id, { issuerUserId: null });
    await write(f.other.id, LOC);
    expect(await nodeAt(f.other.id, LOC)).not.toBeNull();
  });
});

describe('5. the retired doors answer DOOR_RETIRED (Q2, until a CLI release carrying hadron-cli#3319 ships)', () => {
  const retired = (replacement: string) => ({ extensions: { code: 'DOOR_RETIRED', replacement } });
  it('every GraphQL door, for the App\'s manager and for an outsider, with real and junk arguments, writes nothing', async () => {
    const outsider = await db.user.create({ data: { handle: `out-${generateId().slice(-6).toLowerCase()}` } });
    for (const ctx of [{ db, userId: f.mgr.id, roles: [] }, { db, userId: outsider.id, roles: [] }]) {
      for (const appRef of [f.app.id, 'nope']) {
        await expect(M.setAppMemoryWriteGrant({}, { appRef, memoryRef: f.dest.id, prefix: PREFIX }, ctx)).rejects.toMatchObject(retired('memory.write'));
        await expect(M.revokeAppMemoryWriteGrant({}, { id: appRef }, ctx)).rejects.toMatchObject(retired('memory.write'));
        await expect(Q.appMemoryWriteGrants({}, { appRef }, ctx)).rejects.toMatchObject(retired('memory.write'));
        await expect(M.setAutomationReadGrant({}, { appRef, triggerKind: 'SCHEDULE', triggerId: f.schedule.id, memoryRef: f.dest.id }, ctx)).rejects.toMatchObject(retired('memory.read'));
        await expect(M.revokeAutomationReadGrant({}, { id: appRef }, ctx)).rejects.toMatchObject(retired('memory.read'));
        await expect(Q.automationReadGrants({}, { appRef }, ctx)).rejects.toMatchObject(retired('memory.read'));
      }
    }
    expect(await db.appMemoryWriteGrant.count()).toBe(0);
    expect(await db.appAutomationReadGrant.count()).toBe(0);
  });

  it('the three MCP tools answer the same refusal and write nothing', async () => {
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
    const mcp = createTestableMcpServer({ userId: f.mgr.id, roles: [], clientId: 'cli' } as never);
    const answers = [
      await mcp.callToolText('hadron_set_automation_read_grant', { app: f.app.id, triggerKind: 'SCHEDULE', triggerId: f.schedule.id, memory: f.dest.id }),
      await mcp.callToolText('hadron_revoke_automation_read_grant', { id: 'x' }),
      await mcp.callToolText('hadron_list_automation_read_grants', { app: f.app.id }),
    ];
    for (const a of answers) expect(a.startsWith('[door_retired] '), a).toBe(true);
    expect(await db.appAutomationReadGrant.count()).toBe(0);
    vi.unstubAllEnvs();
  });

  it('AutomationApproval.readGrants is always empty', async () => {
    await oldReadRow();
    const approval = await Q.automationApproval({}, { triggerKind: 'SCHEDULE', triggerRef: f.schedule.id }, { db, userId: f.mgr.id, roles: [] }).catch(() => null);
    if (approval) expect(approval.readGrants).toEqual([]);
  });
});

describe('6. Q3 (gate amendment 7228432741): memory.write takes the 0083 target rule, judged at every write, for userless runs only', () => {
  const teamSpace = () => db.memory.create({ data: { name: 'team', urn: `${f.org.urn}:team`, class: 'app', appId: f.app.id, organizationId: f.org.id } as never });
  const personalOf = (userId: string) => db.memory.create({
    data: { name: 'mine', urn: `${f.org.urn}:mine-${generateId().slice(-6).toLowerCase()}`, class: 'personal', userId, organizationId: f.org.id } as never,
  });

  it('admit: the App\'s own team space, which a userless run cannot write without the grant', async () => {
    const team = await teamSpace();
    await expect(write(team.id, LOC)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    await activeMemoryWriteGrant(f.app.id, team.id, { issuerUserId: f.mgr.id });
    await write(team.id, LOC);
    expect(await nodeAt(team.id, LOC)).not.toBeNull();
  });

  it('a person\'s run (a run carrying a user id) never uses the App\'s memory.write grant', async () => {
    const team = await teamSpace();
    await activeMemoryWriteGrant(f.app.id, [f.dest.id], { issuerUserId: f.mgr.id });
    await activeMemoryWriteGrant(f.app.id, team.id, { issuerUserId: f.mgr.id });
    // A person who cannot write either memory in their own right, so only the App's grant could admit the write.
    const outsider = await db.user.create({ data: { handle: `po-${generateId().slice(-6).toLowerCase()}` } });
    const userRun = { db, ...runAuthContext({ ...f.run, id: generateId(), userId: outsider.id } as never) } as never;
    for (const m of [f.dest, team]) {
      await expect(writeNodeCore(
        { memoryId: m.id, loc: 'person:run', name: 'p', nodeType: 'record', content: 'x' } as never, userRun, 'create',
        { ownerLimit: 'refuse', sizeCeiling: 'check', authoring: attestedAuthoring(null) },
      )).rejects.toBeTruthy();
      expect(await nodeAt(m.id, 'person:run')).toBeNull();
    }
  });

  it('admit: a personal memory only as its owner\'s grant; the same grant signed by anyone else writes nothing', async () => {
    const mine = await personalOf(f.mgr.id);
    const issuer = (userId: string) => requireActionIssuer({ db, userId, roles: [] } as never, 'memory.write', f.app.id, { memory: mine.id, prefix: '*' })
      .then(() => 'OK', (e: any) => e?.extensions?.code ?? String(e));
    expect(await issuer(f.mgr.id)).toBe('OK');
    expect(await issuer(f.member.id)).not.toBe('OK');
    const byOther = await activeMemoryWriteGrant(f.app.id, mine.id, { issuerUserId: f.member.id });
    await expect(write(mine.id, LOC)).rejects.toBeTruthy();
    expect(await nodeAt(mine.id, LOC)).toBeNull();
    await revokeGrantRow(byOther, f.member.id);
    await activeMemoryWriteGrant(f.app.id, mine.id, { issuerUserId: f.mgr.id });
    await write(mine.id, LOC);
    expect(await nodeAt(mine.id, LOC)).not.toBeNull();
  });

  it('refuse: another App\'s team space, at creation and at write (an active grant on one writes nothing)', async () => {
    const other = await db.app.create({ data: { name: 'B', urn: `${f.org.urn}:appb`, organizationId: f.org.id } });
    const theirs = await db.memory.create({ data: { name: 'tb', urn: `${f.org.urn}:teamb`, class: 'app', appId: other.id, organizationId: f.org.id } as never });
    const code = await db.$transaction((tx) => createPendingGrant(tx, {
      appId: f.app.id, requester: { userId: f.mgr.id, workerId: null, sessionId: null }, holder: { kind: 'app', id: f.app.id },
      action: 'memory.write', values: { memory: theirs.id, prefix: '*' }, reason: 'r', canReadMemory: async () => true,
    } as never)).then(() => 'OK', (e) => e instanceof GrantCreateRefusal ? e.code : String(e));
    expect(code).toBe('GRANT_VALUES_INVALID');
    await activeMemoryWriteGrant(f.app.id, theirs.id, { issuerUserId: f.mgr.id });
    await expect(write(theirs.id, LOC)).rejects.toBeTruthy();
    expect(await nodeAt(theirs.id, LOC)).toBeNull();
  });

  it('judged at every write: a memory that becomes encrypted after signing takes no further write', async () => {
    await activeMemoryWriteGrant(f.app.id, f.dest.id, { issuerUserId: f.mgr.id });
    await write(f.dest.id, LOC);
    await db.memory.update({ where: { id: f.dest.id }, data: { isEncrypted: true } });
    await expect(write(f.dest.id, `${LOC}:2`)).rejects.toBeTruthy();
    expect(await nodeAt(f.dest.id, `${LOC}:2`)).toBeNull();
  });

  it('judged at every write: the App must stay live (an uninstalled App or a soft-deleted organization writes nothing more)', async () => {
    // An erased giver (cor:acl:140:08) always counts, so only the App's own liveness can end this grant.
    await activeMemoryWriteGrant(f.app.id, f.dest.id, { issuerUserId: null });
    await write(f.dest.id, LOC);
    const holds = () => userlessRunHoldsMemoryWriteGrant(db as never, auth(), f.dest.id, { loc: `${LOC}:org` } as never);
    expect(await holds()).toBe(true);
    await db.organization.update({ where: { id: f.org.id }, data: { deletedAt: new Date() } });
    // The grant arm itself refuses (other layers refuse too; this pins the arm's own check).
    expect(await holds()).toBe(false);
    await expect(write(f.dest.id, `${LOC}:org`)).rejects.toBeTruthy();
    expect(await nodeAt(f.dest.id, `${LOC}:org`)).toBeNull();
    await db.organization.update({ where: { id: f.org.id }, data: { deletedAt: null } });
    await write(f.dest.id, `${LOC}:back`);
    await db.app.update({ where: { id: f.app.id }, data: { uninstalledAt: new Date() } });
    await expect(write(f.dest.id, `${LOC}:app`)).rejects.toBeTruthy();
    expect(await nodeAt(f.dest.id, `${LOC}:app`)).toBeNull();
  });
});
