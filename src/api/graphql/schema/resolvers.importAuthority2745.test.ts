/** #2745: composed imports preserve authority fences before entering the write core. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { resolvers, type Context } from './resolvers.js';
import * as nodeWrite from './resolvers.mutation.node.js';
import * as manualRun from './resolvers.appRun.js';
import * as pdfClient from '../../../lib/pdfClient.js';
import { isMemoryReadableCached } from './resolvers.helpers.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

beforeEach(async () => { await cleanDb(db); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function fixture(kind: 'install' | 'agent') {
  const org = await db.organization.create({ data: { name: 'Import authority', urn: 'import2745.test' } });
  const user = await db.user.create({ data: { id: generateId(), roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { name: 'Importer', urn: 'import2745.test:app', organizationId: org.id } });
  const agent = await db.agent.create({ data: { name: 'Importer', urn: 'import2745.test:agent', organizationId: org.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await serveAgentBootPrompt(db, agent.id, 'Import safely.');
  const system = await db.agent.findUniqueOrThrow({ where: { id: agent.id }, select: { systemMemoryId: true } });
  const memoryId = kind === 'agent' ? system.systemMemoryId! : (await db.memory.create({ data: {
    name: 'Install', urn: 'import2745.test:install', class: 'system', organizationId: org.id,
    appId: app.id, isInstallMemory: true, installOfAgentId: agent.id,
  } })).id;
  const task = await db.node.create({ data: {
    memoryId: system.systemMemoryId!, loc: 'tasks:import', name: 'Import', nodeType: 'task', isRunnable: true,
    content: 'Process {{importedNodeUrn}}',
  } });
  const ctx = { db, userId: user.id, roles: ['READER'], clientId: `user:${user.id}` } as Context;
  const input = { memoryId, loc: 'clips:authority', content: '# Imported', contentType: 'text/markdown', taskRef: task.id, appRef: app.id };
  return { org, user, app, agent, memoryId, ctx, input };
}

describe('#2745 composed import authority controls', () => {
  // #3101 is fixed on main: both paths enter naturally, with no internal preflight flag.
  it.each(['agent', 'install'] as const)('%s manager can import and mint (positive control)', async kind => {
    const f = await fixture(kind);
    const result = await resolvers.Mutation.importNode({}, { input: f.input }, f.ctx);
    expect(result.status).toBe('FETCH_PENDING');
    expect(await db.appRun.count()).toBe(1);
    expect((await db.node.findUniqueOrThrow({ where: { loc_memoryId: { memoryId: f.memoryId, loc: f.input.loc } } })).content).toBe('# Imported');
  });

  it('HTML conversion runs on the composed transaction before mint (budget audit control, converter mocked)', async () => {
    const f = await fixture('agent');
    let transaction: NonNullable<Parameters<typeof nodeWrite.writeNodeCore>[3]>['transaction'];
    const write = nodeWrite.writeNodeCore;
    vi.spyOn(nodeWrite, 'writeNodeCore').mockImplementation((...args) => {
      transaction = args[3]?.transaction;
      return write(...args);
    });
    const phases: string[] = [];
    const convert = vi.spyOn(pdfClient, 'convertHtmlToMarkdown').mockImplementation(async () => {
      expect(transaction).toBeDefined();
      // The real transaction client is usable during conversion; this is not
      // evidence of a live converter's latency or worst-case timeout headroom.
      await transaction!.tx.$queryRaw`SELECT 1`;
      phases.push('convert');
      return { markdown: '# Converted' };
    });
    const mint = manualRun.mintManualRun;
    vi.spyOn(manualRun, 'mintManualRun').mockImplementation(async (...args) => {
      phases.push('mint');
      return mint(...args);
    });
    const at = performance.now();
    const result = await resolvers.Mutation.importNode({}, { input: { ...f.input, content: '<h1>Converted</h1>', contentType: 'text/html' } }, f.ctx);
    expect(result.status).toBe('FETCH_PENDING');
    expect(result.node.content).toBe('# Converted');
    expect(convert).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(['convert', 'mint']);
    if (process.env.HADRON_IMPORT_2745_TIMINGS === '1') process.stdout.write(`#2745 mocked-HTML totalMs=${Math.round(performance.now() - at)}\n`);
  });

  describe.each(['agent', 'install'] as const)('%s authority', kind => {
  it.each([true, false])('revoke=%s waits before store, refreshes cached reads, and commits no partial import', async revoke => {
    const f = await fixture(kind);
    const anchor = kind === 'agent' ? { kind: 'agent' as const, id: f.agent.id } : { kind: 'app' as const, id: f.app.id };
    const owner = await db.user.create({ data: { id: generateId() } });
    const probe = await db.memory.create({ data: {
      name: 'Shared read probe', urn: 'import2745.test:probe', class: 'personal', userId: owner.id, ownerUserId: owner.id,
    } });
    await db.memoryShare.create({ data: { memoryId: probe.id, granteeId: f.user.id, grantorId: owner.id, role: 'reader' } });
    expect(await isMemoryReadableCached(f.ctx, probe.id)).toBe(true);
    let entered = 0;
    let storeMs: number | null = null;
    let mintMs: number | null = null;
    const mint = manualRun.mintManualRun;
    vi.spyOn(manualRun, 'mintManualRun').mockImplementation(async (...args) => {
      const at = performance.now();
      try { return await mint(...args); }
      finally { mintMs = Math.round(performance.now() - at); }
    });
    const write = nodeWrite.writeNodeCore;
    vi.spyOn(nodeWrite, 'writeNodeCore').mockImplementation(async (...args) => {
      entered++;
      // This is a real authorization read, not a sentinel Cache field. The holder
      // revoked its share after preflight; the composed transaction must re-ask.
      expect(await isMemoryReadableCached(args[1], probe.id)).toBe(!revoke);
      const at = performance.now();
      try { return await write(...args); }
      finally { storeMs = Math.round(performance.now() - at); }
    });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held!: () => void;
    let fail!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { held = resolve; fail = reject; });
    const holder = db.$transaction(async tx => {
      await lockAuthorityAnchors(tx, [anchor], 'exclusive');
      held();
      await gate;
      if (revoke) {
        await tx.orgMember.update({ where: { organizationId_userId: { organizationId: f.org.id, userId: f.user.id } }, data: { role: 'READER' } });
        await tx.memoryShare.delete({ where: { memoryId_granteeId: { memoryId: probe.id, granteeId: f.user.id } } });
      }
    }, { timeout: 20_000 });
    const holderOutcome = holder.then(() => null, error => { fail(error); return error; });
    await ready;
    const started = performance.now();
    const importing = resolvers.Mutation.importNode({}, { input: f.input }, f.ctx)
      .then((result: unknown) => ({ ok: true as const, result }), (error: unknown) => ({ ok: false as const, error }));
    let completed = false;
    void importing.then(() => { completed = true; });
    let outcome: Awaited<typeof importing>;
    try {
      let waiting = 0;
      const deadline = Date.now() + 5000;
      while (!completed && waiting === 0 && Date.now() < deadline) {
        const [wait] = await db.$queryRaw<Array<{ waiting: number }>>`
          SELECT count(*)::int AS waiting FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted
            AND classid = hashtext(${`authorization:${anchor.kind}`})::oid
            AND objid = hashtext(${anchor.id})::oid
            AND pid IN (SELECT pid FROM pg_stat_activity WHERE datname = current_database())`;
        waiting = wait.waiting;
        if (!completed && waiting === 0) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(completed, 'import must not complete while its authority anchor is held exclusively').toBe(false);
      expect(waiting, 'import must reach its exact authority lock wait').toBe(1);
      // M_lock_first: a later write recheck cannot replace acquiring authority
      // before entering the core and taking memory/node/loc locks.
      expect(entered, 'authority must be acquired before entering writeNodeCore').toBe(0);
    } finally {
      release();
      const holderError = await holderOutcome;
      outcome = await importing;
      if (holderError) throw holderError;
    }
    if (process.env.HADRON_IMPORT_2745_TIMINGS === '1') {
      process.stdout.write(`#2745 timings ${JSON.stringify({ kind, revoke, totalMs: Math.round(performance.now() - started), storeMs, mintMs })}\n`);
    }
    expect(entered).toBe(1);
    if (revoke) {
      expect(outcome).toMatchObject({ ok: false, error: { extensions: { code: 'FORBIDDEN' } } });
      expect(await db.node.findUnique({ where: { loc_memoryId: { memoryId: f.memoryId, loc: f.input.loc } } })).toBeNull();
      expect(await db.appRun.count()).toBe(0);
      expect(await db.quotaCounter.count()).toBe(0);
    } else {
      expect(outcome).toMatchObject({ ok: true, result: { status: 'FETCH_PENDING' } });
      expect(await db.appRun.count()).toBe(1);
    }
  });
  });
});
