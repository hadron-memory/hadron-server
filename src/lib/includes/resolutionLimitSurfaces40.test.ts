/**
 * hadron-internal#40 (rulings 0196/0197, Vera's reconciliation) — each surface's mapping of the one resolution-limit
 * refusal: MCP single reads a typed refusal (never the generic fault), the MCP batch a per-node loud reason, the skill
 * export leaves the node out and names it, and external artefacts and run renders refuse before any side effect. Limits
 * are lowered so a refusal is reached with tiny fixtures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from '../../mcp/server.js';
import { CONTENT_RESOLUTION_LIMIT_EXCEEDED, setResolutionLimits } from './resolutionBudget.js';
import { drainNodeUsage } from '../usageRecorder.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../pdfClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pdfClient.js')>()),
  renderMarkdownToPdf: vi.fn(async () => ({ base64: 'UERG', bytes: 3 })),
}));
vi.mock('../emailClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../emailClient.js')>()),
  runEmailOperation: vi.fn(async () => ({ file: { id: 'doc', name: 'd', kind: 'document', mimeType: 'x', parents: [] } })),
}));

const { renderMarkdownToPdf } = await import('../pdfClient.js');
const { runEmailOperation } = await import('../emailClient.js');

let orgId: string;
let memoryId: string;
let memoryUrn: string;
let reader: { id: string };
const ctx = (): Context => ({ db, userId: reader.id, roles: [] });
const urn = (loc: string) => `hrn:node:${memoryUrn}:${loc}`;
const mk = (loc: string, content: string | null, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content, ...extra } });
const mcp = () => createTestableMcpServer({ userId: reader.id, roles: [], clientId: `user:${reader.id}` });
const Q = resolvers.Query as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const readEvents = () => db.usageEvent.count({ where: { memoryId } });

// #3839: resolver return does not imply completion of the deferred usage insert.
async function settleExportUsage() {
  await drainNodeUsage(db);
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('#3839 controlled writer did not reach its boundary')), 5_000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Hold the real insert, not the recorder: release and drain before restoring the spy on every path. */
async function heldExportWriter(run: (entered: Promise<void>, release: () => void) => Promise<void>) {
  await drainNodeUsage(db);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const seen = new Promise<void>((resolve) => { entered = resolve; });
  const insert = db.usageEvent.createMany.bind(db.usageEvent);
  const spy = vi.spyOn(db.usageEvent, 'createMany').mockImplementation((args) => {
    entered();
    return gate.then(() => insert(args)) as ReturnType<typeof insert>;
  });
  try {
    await run(seen, release);
  } finally {
    vi.useRealTimers();
    release();
    try { await drainNodeUsage(db); } finally { spy.mockRestore(); }
  }
}

/** `p` is over a 10-byte limit; `ok` is under it. */
async function fixtures() {
  await mk('t', 'x'.repeat(20));
  await mk('p', 'a {{> t}} b');
  await mk('ok', 'short {{> small}}');
  await mk('small', 'y');
  setResolutionLimits({ limits: { maxBytes: 12 } });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Rs Org', urn: 'rs.example' } });
  orgId = org.id;
  reader = await db.user.create({ data: { githubId: 404201, githubUsername: 'rs-reader', handle: 'rs-reader', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader.id, role: 'ADMIN' } });
  const m = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'rs' }, ctx());
  memoryId = m.id; memoryUrn = m.urn;
});
afterEach(() => setResolutionLimits(null));

describe('#40 MCP single reads: a typed refusal, never the generic fault', () => {
  it('hadron_get_node refuses with the code and the limit, no partial text, and records no read', async () => {
    await fixtures();
    const res = await mcp().callTool('hadron_get_node', { urn: urn('p') }) as any;
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error).toMatchObject({ code: CONTENT_RESOLUTION_LIMIT_EXCEEDED, limit: 'bytes' });
    const text = res.content.map((c: { text: string }) => c.text).join('\n');
    expect(text).toMatch(/raw: true/);
    expect(text).not.toMatch(/xxxx|internal/i);
    await new Promise((r) => setTimeout(r, 50));
    expect(await readEvents()).toBe(0);
  });

  it('control: hadron_get_node under the limit, and with raw, still serves', async () => {
    await fixtures();
    expect(await mcp().callToolText('hadron_get_node', { urn: urn('ok') })).toContain('short y');
    expect(await mcp().callToolText('hadron_get_node', { urn: urn('p'), raw: true })).toContain('a {{> t}} b');
  });

  it('hadron_get_next_node refuses the same way', async () => {
    await mk('par', 'parent');
    await mk('t', 'x'.repeat(20));
    await mk('par:child', 'a {{> t}} b', { seq: 1 });
    setResolutionLimits({ limits: { maxBytes: 12 } });
    const res = await mcp().callTool('hadron_get_next_node', { parent: urn('par') }) as any;
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error).toMatchObject({ code: CONTENT_RESOLUTION_LIMIT_EXCEEDED, limit: 'bytes' });
  });
});

describe('#40 MCP batch: a per-node, loud reason; the other nodes return', () => {
  it('hadron_get_nodes lists the refused node with its limit and returns the rest', async () => {
    await fixtures();
    const res = await mcp().callTool('hadron_get_nodes', { refs: [urn('p'), urn('ok')] }) as any;
    expect(res.isError).toBeFalsy();
    const text = res.content.map((c: { text: string }) => c.text).join('\n');
    expect(text).toMatch(/returned 1 node\(s\); 1 refused/);
    expect(text).toContain('short y');
    expect(text).toContain(`${urn('p')} (over the size limit; limit: bytes)`);
    expect(text).toContain(CONTENT_RESOLUTION_LIMIT_EXCEEDED);
    expect(text).not.toContain('xxxx');
  });
});

describe('#40 skill export: the refused node is left out and named; the others export', () => {
  const declaration = (name: string) => ({
    exports: { claudeSkill: { name, description: 'Does a thing. Use when you need it.', enable: true } },
  });
  it('the over-limit node carries an error finding and no body; its neighbour exports in full', async () => {
    await mk('t', 'x'.repeat(20), { isRunnable: false });
    await mk('small', 'y', { isRunnable: false });
    await mk('tasks:big', '# B\n{{> t}}', { isRunnable: true, properties: declaration('big-skill') });
    await mk('tasks:fine', '# F\n{{> small}}', { isRunnable: true, properties: declaration('fine-skill') });
    setResolutionLimits({ limits: { maxBytes: 12 }, requestMaxBytes: 1 });
    const got = await Q.skillPlan({}, { input: { intent: 'EXPORT', files: [] } }, ctx());
    const big = got.entries.find((e: any) => e.urn.endsWith('tasks:big'));
    const fine = got.entries.find((e: any) => e.urn.endsWith('tasks:fine'));
    const finding = big.findings.find((f: any) => f.rule === 'skill-content-resolution-limit');
    expect(finding).toMatchObject({ severity: 'error' });
    expect(finding.message).toMatch(/size limit/);
    // An export has no raw read, so its remedy is the export one.
    expect(finding.message).toContain('Export it after shortening the content, or read the stored text instead.');
    expect(finding.message).not.toContain('raw: true');
    expect(big.renderedBody).toBeNull();
    expect(big.exportPlan.action).not.toBe('WRITE');
    // Per node only: the request aggregate (set to 1 byte here) never applies to the export.
    expect(fine.findings.filter((f: any) => f.severity === 'error')).toEqual([]);
    expect(fine.renderedBody).toContain('# F\ny');
  });
});

describe('#40 external artefacts refuse before the external call', () => {
  it('#3839: the export usage boundary waits for a controlled delayed insert, not 50ms', async () => {
    await fixtures();
    const p = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'p' } });
    await heldExportWriter(async (entered, release) => {
      expect((await Q.nodeExport({}, { id: p.id }, ctx())).data).toContain('{{> t}}');
      await bounded(entered); // The resolver returned although the real usage insert is still held.
      expect(await readEvents()).toBe(0);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let settled = false;
      const draining = settleExportUsage().then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(50); // Deterministically exhaust the old wait without a wall-clock sleep.
      try {
        expect(settled).toBe(false);
      } finally {
        vi.useRealTimers();
        release();
        await bounded(draining);
      }
      expect(await readEvents()).toBe(1);
    });
  }, 15_000);

  it('#3839: a writer that stays pending fails the bounded drain, and cleanup releases it', async () => {
    await fixtures();
    const p = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'p' } });
    await heldExportWriter(async (entered) => {
      await Q.nodeExport({}, { id: p.id }, ctx());
      await bounded(entered);
      await expect(drainNodeUsage(db, { timeoutMs: 25 })).rejects.toThrow('Timed out draining asynchronous usage-event writes');
      expect(await readEvents()).toBe(0);
    });
    expect(await readEvents()).toBe(1);
  }, 15_000);

  it('nodeExport PDF calls no PDF service', async () => {
    await fixtures();
    const p = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'p' } });
    await expect(Q.nodeExport({}, { id: p.id, format: 'PDF' }, ctx()))
      .rejects.toMatchObject({ extensions: { code: CONTENT_RESOLUTION_LIMIT_EXCEEDED, limit: 'bytes' }, message: expect.stringContaining('Export it after shortening the content, or read the stored text instead.') });
    expect(vi.mocked(renderMarkdownToPdf)).not.toHaveBeenCalled();
    await expect(Q.nodeExport({}, { id: p.id, full: false }, ctx()))
      .rejects.toMatchObject({ extensions: { code: CONTENT_RESOLUTION_LIMIT_EXCEEDED } });
    await settleExportUsage();
    expect(await readEvents()).toBe(0);
    // The restore export reads with resolution off and is unaffected.
    expect((await Q.nodeExport({}, { id: p.id }, ctx())).data).toContain('{{> t}}');
    await settleExportUsage();
    expect(await readEvents()).toBe(1);
  });

  it('exportNodeToGoogleDoc calls no Drive tool', async () => {
    await fixtures();
    const connection = await db.exchangeConnection.create({
      data: {
        organizationId: orgId, userId: reader.id, mailboxEmail: 'r@gdrive.example', provider: 'google-drive',
        toolConnectionId: 'tool-drive-1', createdBy: reader.id,
      },
    });
    const p = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'p' } });
    await expect(M.exportNodeToGoogleDoc({}, { nodeRef: p.id, connectionRef: connection.id }, ctx()))
      .rejects.toMatchObject({ extensions: { code: CONTENT_RESOLUTION_LIMIT_EXCEEDED, limit: 'bytes' }, message: expect.stringContaining('Export it after shortening the content, or read the stored text instead.') });
    expect(vi.mocked(runEmailOperation)).not.toHaveBeenCalled();
  });
});

describe('#40 run renders refuse before any record', () => {
  it('renderRunNode and the render-only runTask refuse and record no read or run', async () => {
    await mk('t', 'x'.repeat(20));
    await mk('task', 'do {{> t}} now', { isRunnable: true });
    setResolutionLimits({ limits: { maxBytes: 12 } });
    await expect(Q.renderRunNode(null, { nodeRef: urn('task') }, ctx()))
      .rejects.toMatchObject({ extensions: { code: CONTENT_RESOLUTION_LIMIT_EXCEEDED, limit: 'bytes' } });
    await expect(M.runTask(null, { nodeRef: urn('task') }, ctx()))
      .rejects.toMatchObject({ extensions: { code: CONTENT_RESOLUTION_LIMIT_EXCEEDED, limit: 'bytes' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(await readEvents()).toBe(0);
    expect(await db.appRun.count()).toBe(0);
  });
});

describe('#40 run renders count toward the request aggregate', () => {
  it('renderRunNode and the render-only runTask past the aggregate refuse as requestBytes', async () => {
    await mk('t', 'x'.repeat(20));
    await mk('task', 'do {{> t}} now', { isRunnable: true });
    setResolutionLimits({ requestMaxBytes: 8 });
    await expect(Q.renderRunNode(null, { nodeRef: urn('task') }, ctx()))
      .rejects.toMatchObject({ extensions: { code: CONTENT_RESOLUTION_LIMIT_EXCEEDED, limit: 'requestBytes' } });
    await expect(M.runTask(null, { nodeRef: urn('task') }, ctx()))
      .rejects.toMatchObject({ extensions: { code: CONTENT_RESOLUTION_LIMIT_EXCEEDED, limit: 'requestBytes' } });
  });

  it('control: under the aggregate both render in full', async () => {
    await mk('t', 'x'.repeat(20));
    await mk('task', 'do {{> t}} now', { isRunnable: true });
    setResolutionLimits({ requestMaxBytes: 1024 });
    expect(JSON.stringify(await Q.renderRunNode(null, { nodeRef: urn('task') }, ctx()))).toContain('x'.repeat(20));
  });

  it('a run node with no template syntax is never charged', async () => {
    await mk('task', 'plain instructions, no template', { isRunnable: true });
    setResolutionLimits({ requestMaxBytes: 1 });
    expect(JSON.stringify(await Q.renderRunNode(null, { nodeRef: urn('task') }, ctx()))).toContain('plain instructions');
  });
});
