/**
 * #5469 (the rest of #430) — a node WRITE in a Git-synced, unencrypted, org-owned memory is captured as a PENDING WRITE
 * obligation by a trigger on `nodes`, in the writer's own transaction; the sweep applies it, a successful ordinary mirror
 * settles it, and a delete drops it (a WRITE is never applied after a REMOVE).
 *
 * Same harness as nodeDeleteMirror425.test.ts: real git against a temp BARE remote, no network. Writes are driven straight
 * at `nodes`, below every writer (resolver, MCP delegate, merge, import) the same trigger serves; rows are read straight
 * from `git_mirror_obligations`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile as execFileCb, execFileSync } from 'child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { db } from '../db/client.js';
import { cleanDb, createDbNode, createDbOrgAndGraph, writeFrontmatterNode } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';

const env = vi.hoisted(() => ({
  failure: null as unknown, root: '', bare: '', failOn: null as null | ((args: string[]) => boolean),
  /** A one-shot hold: the FIRST matching `execGit` call signals `entered`, then waits for `released`. */
  hold: null as null | { on: (args: string[]) => boolean; entered: () => void; released: Promise<void> },
  /** Checkout-lock arrivals and acquisitions, in order (the wrapper mock below). */
  lockEvents: [] as string[],
}));
const TOKEN = 'tok-5469-secret';
const SOURCE = 'https://github.com/acme/repo-5469.git';
vi.mock('./githubApp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./githubApp.js')>()),
  getInstallationToken: vi.fn(async () => TOKEN),
}));
vi.mock('../../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../config.js')>();
  return { ...real, get GRAPHS_PATH() { return env.root; } };
});
// Only execFile is canned (syncGraphFromGithub's git leg); execFileSync stays real for this file.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  return {
    ...real,
    execFile: vi.fn((...args: unknown[]) => {
      const argv = args[1] as string[];
      const cb = args[args.length - 1] as Function;
      if (typeof cb !== 'function') return;
      cb(null, {
        stdout: argv.includes('ls-remote') ? 'ref: refs/heads/main\tHEAD\n' : argv.includes('rev-list') ? '0\n' : '',
        stderr: '',
      });
    }),
  };
});
vi.mock('./execGit.js', () => ({
  execGit: vi.fn(async (args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
    if (env.failOn?.(args)) throw env.failure ?? new Error('Git command failed. Check the repository and branch, then retry.');
    const hold = env.hold;
    if (hold?.on(args)) { env.hold = null; hold.entered(); await hold.released; }
    const stdout = execFileSync('git', [
      '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
      '-c', `url.${env.bare}.insteadOf=${SOURCE}`,
      '-c', `url.${env.bare}.insteadOf=${SOURCE.replace('https://github.com/', `https://x-access-token:${TOKEN}@github.com/`)}`,
      ...args,
    ], { ...options, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { stdout, stderr: '' };
  }),
}));

// Observe the checkout lock's queue WITHOUT replacing the real lock (the #430 sweep harness's pattern): every
// arrival and every acquisition is recorded, so a pin can tell "queued behind" from "ran alongside".
vi.mock('./mirrorCheckoutLock.js', async importOriginal => {
  const real = await importOriginal<typeof import('./mirrorCheckoutLock.js')>();
  return {
    ...real,
    withMirrorCheckoutLock: <T>(id: string, work: () => Promise<T>, opts?: { fenceEncryption?: boolean }) => {
      env.lockEvents.push('requested');
      return real.withMirrorCheckoutLock(id, async () => { env.lockEvents.push('acquired'); return work(); }, opts);
    },
  };
});

import { gitMirrorSweepTick } from '../../jobs/sweepGitMirrorObligations.js';
import { syncGraphFromGithub, type MemoryWithOrg } from './syncGraphFromGithub.js';
import { nodeFilePath } from './nodeFrontmatter.js';
import { memoryLocalPath } from './gitMirrorCheckout.js';
import { writeNodeToGit } from './writeNodeToGit.js';
import { settleMirrorObligations, takeAttemptSeq } from './mirrorObligations.js';
import { validateMemoryNodes } from '../../lib/memoryValidation.js';

const IDENT = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf-8', env: { ...process.env, ...IDENT } }).trim();

let memoryId: string;
let local: string;

interface SetupOpts {
  repo?: boolean;
  writeBranch?: string | null;
  readBranch?: string | null;
  encrypted?: boolean;
  noSource?: boolean;
  softDeletedMemory?: boolean;
}

async function setup(opts: SetupOpts = {}) {
  const withRepo = opts.repo !== false;
  if (withRepo) {
    env.bare = mkdtempSync(join(tmpdir(), 'hadron-5469-bare-'));
    git(env.bare, 'init', '--bare', '-b', 'main');
    const seed = mkdtempSync(join(tmpdir(), 'hadron-5469-seed-'));
    git(seed, 'init', '-b', 'main');
    git(seed, 'commit', '--allow-empty', '-m', 'seed');
    git(seed, 'push', env.bare, '--all');
    rmSync(seed, { recursive: true, force: true });
  }
  const { org, graph } = await createDbOrgAndGraph(db, { orgName: 'org5469', graphName: 'repo5469' });
  await db.organization.update({ where: { id: org.id }, data: { githubInstallationId: 4242 } });
  await db.memory.update({
    where: { id: graph.id },
    data: {
      source: opts.noSource ? null : SOURCE,
      ...(opts.readBranch !== undefined ? { readBranch: opts.readBranch } : {}),
      ...(opts.writeBranch !== undefined ? { writeBranch: opts.writeBranch } : {}),
      ...(opts.encrypted ? { isEncrypted: true } : {}),
      ...(opts.softDeletedMemory ? { deletedAt: new Date() } : {}),
    },
  });
  memoryId = graph.id;
  local = memoryLocalPath(org.urn, graph.urn);
  if (withRepo) cloneRemote();
  return { org, graph };
}

/** Clone the bare remote into the memory's local path, as a first mirror write or sync would. */
const cloneRemote = () => {
  mkdirSync(dirname(local), { recursive: true });
  execFileSync('git', ['-c', 'protocol.file.allow=always', '-c', `url.${env.bare}.insteadOf=${SOURCE}`, 'clone', SOURCE, local], { stdio: 'ignore' });
};
const sequenceValue = () => db.$queryRaw<Array<{ value: string; is_called: boolean }>>`SELECT last_value::text AS value, is_called FROM git_mirror_attempt_seq`;
/** Poll until `done` holds; fails the test after five seconds instead of hanging a held sweep forever. */
const eventually = async (done: () => boolean) => {
  for (let i = 0; i < 500 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  if (!done()) throw new Error('not reached within five seconds');
};

const makeNode = (loc: string, id = generateId()) => createDbNode(db, { id, loc, memoryId, name: loc || 'root' });
const softDelete = (id: string) => db.node.update({ where: { id }, data: { deletedAt: new Date() } });
const restore = (id: string) => db.node.update({ where: { id }, data: { deletedAt: null } });

const rows = () => db.gitMirrorObligation.findMany({ where: { memoryId }, orderBy: [{ nodeId: 'asc' }] });


/**
 * Put the fixture files on the write branch only, the way a real mirror write did: main keeps its seed
 * commit, hadron-updates carries the nodes. The working tree stays on hadron-updates.
 */
const commitFixtures = (files: string[]) => {
  git(local, 'checkout', '-b', 'hadron-updates');
  git(local, 'add', ...files);
  git(local, 'commit', '-m', 'fixtures');
  git(local, 'push', env.bare, 'hadron-updates');
};

beforeEach(async () => {
  env.root = mkdtempSync(join(tmpdir(), 'hadron-5469-'));
  env.failOn = null;
  env.failure = null;
  env.hold = null;
  env.lockEvents = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await cleanDb(db);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(env.root, { recursive: true, force: true });
  if (env.bare) rmSync(env.bare, { recursive: true, force: true });
});

const wrote = (nodeId: string, branch = 'hadron-updates') =>
  expect.objectContaining({ nodeId, kind: 'WRITE' as const, removeLoc: '', branch, state: 'PENDING' as const, errorClass: 'PENDING' as const, attempts: 1 });
const update = (id: string, data: Record<string, unknown>) => db.node.update({ where: { id }, data });
const seqOf = async (nodeId: string) => (await rows()).find(r => r.nodeId === nodeId)!.attemptSeq;
const NOW = () => new Date(Date.now() + 60_000);

describe('#5469 a node write leaves a PENDING WRITE obligation', () => {
  it('a created node owes one PENDING WRITE row on the default write branch', async () => {
    await setup({ repo: false });
    const node = await makeNode('docs:a');
    expect(await rows()).toEqual([wrote(node.id)]);
  });

  it('the row carries the memory write branch when one is configured', async () => {
    await setup({ repo: false, writeBranch: 'feature/x' });
    const node = await makeNode('docs:a');
    expect(await rows()).toEqual([wrote(node.id, 'feature/x')]);
  });

  it.each([
    ['content', { content: 'changed' }],
    ['name', { name: 'renamed' }],
    ['loc', { loc: 'docs:moved' }],
    ['tags', { tags: ['x'] }],
    ['description', { description: 'd' }],
    ['abstract', { abstract: 'a' }],
    ['data', { data: { k: 1 } }],
    ['properties', { properties: { k: 1 } }],
    ['seq', { seq: 7 }],
    ['alias', { alias: 'al' }],
    ['nodeType', { nodeType: 'task' }],
    ['role', { role: 'process' }],
    ['isRunnable', { isRunnable: true }],
  ])('an update of %s that changes the file owes a WRITE', async (_name, data) => {
    await setup({ repo: false });
    const node = await makeNode('docs:a');
    await db.gitMirrorObligation.deleteMany({});
    await update(node.id, data);
    expect(await rows()).toEqual([wrote(node.id)]);
  });

  it('an update that only re-sets a mirrored column to its current value owes nothing', async () => {
    await setup({ repo: false });
    const node = await makeNode('docs:a');
    await db.gitMirrorObligation.deleteMany({});
    await update(node.id, { content: node.content, name: node.name, tags: node.tags });
    expect(await rows()).toEqual([]);
  });

  it('an update of columns the file does not carry owes nothing (embedding, token, revision, updated_*)', async () => {
    await setup({ repo: false });
    const node = await makeNode('docs:a');
    await db.gitMirrorObligation.deleteMany({});
    await update(node.id, {
      embeddingAttempts: 3, embeddingError: 'x', embeddingPendingAt: new Date(), revSeq: { increment: 1 },
      updatedAt: new Date(), updatedBy: 'someone', contentChangedAt: new Date(),
    });
    expect(await rows()).toEqual([]);
  });

  it('a root node (loc empty) owes nothing: its file is the memory README', async () => {
    await setup({ repo: false });
    const root = await makeNode('');
    await update(root.id, { content: 'changed' });
    expect(await rows()).toEqual([]);
  });

  it('a {client} template write branch owes nothing', async () => {
    await setup({ repo: false, writeBranch: 'client/{client}' });
    const node = await makeNode('docs:a');
    await update(node.id, { content: 'changed' });
    expect(await rows()).toEqual([]);
  });

  it('a DB-only memory (no source) owes nothing', async () => {
    await setup({ repo: false, noSource: true });
    await makeNode('docs:a');
    expect(await rows()).toEqual([]);
  });

  it('an encrypted memory owes nothing', async () => {
    await setup({ repo: false, encrypted: true });
    await makeNode('docs:a');
    expect(await rows()).toEqual([]);
  });

  it('a user-owned memory (no organization) owes nothing', async () => {
    await setup({ repo: false });
    const owner = await db.user.create({ data: { githubId: 5469999, githubUsername: 'owner-5469' } });
    await db.memory.update({ where: { id: memoryId }, data: { organizationId: null, ownerUserId: owner.id } });
    await makeNode('docs:a');
    expect(await rows()).toEqual([]);
  });

  it('a write in an already-soft-deleted memory owes nothing and does not fail', async () => {
    await setup({ repo: false, softDeletedMemory: true });
    const node = await makeNode('docs:a');
    await update(node.id, { content: 'changed' });
    expect(await rows()).toEqual([]);
  });

  it('a node write after the memory delete in one transaction does not abort the delete (the foreign-key case)', async () => {
    await setup({ repo: false });
    const node = await makeNode('docs:a');
    await db.$transaction(async tx => {
      await tx.memory.delete({ where: { id: memoryId } });
      await tx.node.updateMany({ where: { id: node.id }, data: { content: 'late' } });
    });
    expect(await db.memory.findUnique({ where: { id: memoryId } })).toBeNull();
    expect(await db.gitMirrorObligation.findMany({ where: { memoryId } })).toEqual([]);
  });

  it('a memory delete still succeeds and leaves no debt', async () => {
    await setup({ repo: false });
    await makeNode('docs:a');
    await db.memory.delete({ where: { id: memoryId } });
    expect(await db.gitMirrorObligation.findMany({ where: { memoryId } })).toEqual([]);
  });

  it('a soft-deleted node is not captured as a write, even if the same update changes its content', async () => {
    await setup({ repo: false });
    const node = await makeNode('docs:a');
    await db.gitMirrorObligation.deleteMany({});
    await update(node.id, { deletedAt: new Date(), content: 'last words' });
    expect((await rows()).map(r => r.kind)).toEqual(['REMOVE']);
  });
});

describe('#5469 repeated writes and the row states', () => {
  it('repeated writes of one node leave exactly one row, re-fenced with a higher attempt number each time', async () => {
    await setup({ repo: false });
    const node = await makeNode('docs:a');
    const first = await seqOf(node.id);
    await update(node.id, { content: 'two' });
    const second = await seqOf(node.id);
    await update(node.id, { content: 'three' });
    expect(await rows()).toEqual([wrote(node.id)]);
    expect(second > first).toBe(true);
    expect(await seqOf(node.id) > second).toBe(true);
  });

  it('a FAILED row keeps its state, class, attempts and backoff clock; only its fence moves', async () => {
    await setup({ repo: false });
    const node = await makeNode('docs:a');
    const stamp = new Date('2026-01-01T00:00:00Z');
    await db.gitMirrorObligation.updateMany({ where: { nodeId: node.id }, data: { state: 'FAILED', errorClass: 'PUSH_FAILED', attempts: 4, lastAttemptAt: stamp } });
    const before = await seqOf(node.id);
    await update(node.id, { content: 'again' });
    const [row] = await rows();
    expect(row).toEqual(expect.objectContaining({ state: 'FAILED', errorClass: 'PUSH_FAILED', attempts: 4, lastAttemptAt: stamp }));
    expect(row!.attemptSeq > before).toBe(true);
  });

  it('an EXHAUSTED row is re-armed to PENDING with one attempt: the sweep no longer selects EXHAUSTED, so the new write would be lost', async () => {
    await setup({ repo: false });
    const node = await makeNode('docs:a');
    await db.gitMirrorObligation.updateMany({ where: { nodeId: node.id }, data: { state: 'EXHAUSTED', errorClass: 'PUSH_FAILED', attempts: 10 } });
    await update(node.id, { content: 'again' });
    expect(await rows()).toEqual([wrote(node.id)]);
  });

  it('a write never touches a REMOVE row of the same node (a move\'s vacated loc is a separate debt)', async () => {
    await setup({ repo: false });
    const node = await makeNode('docs:a');
    await db.gitMirrorObligation.create({ data: {
      memoryId, nodeId: node.id, kind: 'REMOVE', removeLoc: 'docs:old', branch: 'hadron-updates', state: 'FAILED',
      errorClass: 'PUSH_FAILED', attempts: 2, attemptSeq: 1n,
    } as never });
    await update(node.id, { content: 'again' });
    const found = await rows();
    expect(found.map(r => `${r.kind}:${r.removeLoc}:${r.state}`).sort()).toEqual(['REMOVE:docs:old:FAILED', 'WRITE::PENDING']);
  });

  it('the captured row satisfies the closed-word shape: nothing free-form is storable', async () => {
    await setup({ repo: false });
    await makeNode('docs:a');
    const [row] = await rows();
    expect(row).toEqual(expect.objectContaining({ errorClass: 'PENDING', state: 'PENDING' }));
    await expect(db.gitMirrorObligation.updateMany({ data: { errorClass: 'boom: https://x-access-token:secret@github.com' } })).rejects.toThrow();
  });
});

describe('#5469 a delete drops the WRITE debt (a WRITE is never applied after a REMOVE)', () => {
  it('a soft delete after a write leaves only the REMOVE', async () => {
    await setup({ repo: false });
    const node = await makeNode('docs:a');
    await update(node.id, { content: 'two' });
    await softDelete(node.id);
    expect((await rows()).map(r => `${r.kind}:${r.removeLoc}`)).toEqual(['REMOVE:docs:a']);
  });

  it('a hard delete after a write leaves only the REMOVE', async () => {
    await setup({ repo: false });
    const node = await makeNode('docs:a');
    await db.node.delete({ where: { id: node.id } });
    expect((await rows()).map(r => `${r.kind}:${r.removeLoc}`)).toEqual(['REMOVE:docs:a']);
  });

  it('a FAILED or EXHAUSTED WRITE row is dropped by the delete too, on every branch', async () => {
    await setup({ repo: false });
    const node = await makeNode('docs:a');
    await db.gitMirrorObligation.create({ data: {
      memoryId, nodeId: node.id, kind: 'WRITE', removeLoc: '', branch: 'old-branch', state: 'EXHAUSTED',
      errorClass: 'PUSH_FAILED', attempts: 10, attemptSeq: 1n,
    } as never });
    await softDelete(node.id);
    expect((await rows()).map(r => r.kind)).toEqual(['REMOVE']);
  });

  it('a delete of one node leaves another node\'s WRITE row alone', async () => {
    await setup({ repo: false });
    const a = await makeNode('docs:a');
    const b = await makeNode('docs:b');
    await softDelete(a.id);
    expect((await rows()).map(r => `${r.nodeId === b.id ? 'b' : 'a'}:${r.kind}`).sort()).toEqual(['a:REMOVE', 'b:WRITE']);
  });

  it('a restore leaves the node with no REMOVE debt, and a write after it is captured again', async () => {
    await setup({ repo: false });
    const node = await makeNode('docs:a');
    await softDelete(node.id);
    await restore(node.id);
    expect(await rows()).toEqual([]);
    await update(node.id, { content: 'back' });
    expect(await rows()).toEqual([wrote(node.id)]);
  });
});

describe('#5469 the sweep applies the debt and the ordinary mirror settles it', () => {
  it('a write whose mirror never ran: the sweep applies it, the file lands on the remote branch and the row clears', async () => {
    await setup();
    const root = await makeNode('');
    writeFrontmatterNode(join(local, 'README.md'), { id: root.id, name: 'root' }, 'root');
    commitFixtures(['README.md']);
    const node = await makeNode('docs:a'); // the process "died" here: no mirror attempt follows the commit
    await update(node.id, { content: 'hello from the db' });
    expect(await rows()).toEqual([wrote(node.id)]);
    await gitMirrorSweepTick(db, NOW());
    expect(git(env.bare, 'ls-tree', '-r', '--name-only', 'hadron-updates')).toContain('docs/a.md');
    expect(git(env.bare, 'show', 'hadron-updates:docs/a.md')).toContain('hello from the db');
    expect(await rows()).toEqual([]);
  });

  it('an ordinary mirror write that lands leaves no unsettled row (no permanent PENDING)', async () => {
    await setup();
    const root = await makeNode('');
    writeFrontmatterNode(join(local, 'README.md'), { id: root.id, name: 'root' }, 'root');
    commitFixtures(['README.md']);
    const node = await makeNode('docs:a');
    const fresh = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(await rows()).toEqual([wrote(node.id)]); // the stored branch is the one the ordinary writer settles on
    await writeNodeToGit({ ...fresh, outgoingEdges: [] }, '', null, memoryId);
    expect(git(env.bare, 'ls-tree', '-r', '--name-only', 'hadron-updates')).toContain('docs/a.md');
    expect(await rows()).toEqual([]);
  });

  it('a write that commits AFTER an attempt took its number keeps its row (the attempt may have read the old node)', async () => {
    await setup({ repo: false });
    const node = await makeNode('docs:a');
    const attempt = await takeAttemptSeq(db);
    await update(node.id, { content: 'newer than the attempt' });
    await settleMirrorObligations(db, memoryId, [{ nodeId: node.id, kind: 'WRITE', branch: 'hadron-updates' }], { result: 'cleared' }, attempt);
    expect(await rows()).toEqual([wrote(node.id)]);
  });

  it('a write that committed BEFORE an attempt took its number is covered by that attempt, which clears it', async () => {
    await setup({ repo: false });
    const node = await makeNode('docs:a');
    await update(node.id, { content: 'older than the attempt' });
    const attempt = await takeAttemptSeq(db);
    await settleMirrorObligations(db, memoryId, [{ nodeId: node.id, kind: 'WRITE', branch: 'hadron-updates' }], { result: 'cleared' }, attempt);
    expect(await rows()).toEqual([]);
  });

  it('a second write while an attempt holds the row re-fences it: the attempt\'s success cannot clear what it may not have read', async () => {
    await setup({ repo: false });
    const node = await makeNode('docs:a');
    await update(node.id, { content: 'two' });
    const attempt = await takeAttemptSeq(db);
    await update(node.id, { content: 'three' }); // collides with the existing row
    await settleMirrorObligations(db, memoryId, [{ nodeId: node.id, kind: 'WRITE', branch: 'hadron-updates' }], { result: 'cleared' }, attempt);
    expect(await rows()).toEqual([wrote(node.id)]);
  });
});

describe('#5469 the change is additive (functions and triggers only)', () => {
  const dir = new URL('../../../prisma/migrations/20261128120000_git_mirror_write_capture/', import.meta.url);
  it('the migration holds only the idempotent constraint re-add, the sequence, functions and triggers: no column, enum or table change', () => {
    const sql = readFileSync(new URL('migration.sql', dir), 'utf8').replace(/--.*$/gm, '');
    const statements = sql.split(/\$(\w+)\$[\s\S]*?\$\1\$/).join(' ').split(';').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
    for (const s of statements) {
      expect(s, s.slice(0, 80)).toMatch(/^(CREATE SEQUENCE IF NOT EXISTS git_mirror_attempt_seq|ALTER TABLE git_mirror_obligations (DROP|ADD) CONSTRAINT (IF EXISTS )?chk_git_mirror_obligation_shape|CREATE OR REPLACE FUNCTION hadron_git_mirror_|DROP TRIGGER IF EXISTS git_mirror_node_|CREATE TRIGGER git_mirror_node_)/);
    }
    expect(sql).not.toMatch(/ADD COLUMN|DROP COLUMN|ALTER TYPE|CREATE TABLE|DROP TABLE|ALTER COLUMN/i);
  });

  it('applying the migration again is a no-op on the table: same columns, same constraint, same trigger set', async () => {
    await setup({ repo: false });
    const shape = async () => ({
      cols: await db.$queryRawUnsafe<unknown[]>("SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'git_mirror_obligations' ORDER BY column_name"),
      con: await db.$queryRawUnsafe<unknown[]>("SELECT conname, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'git_mirror_obligations'::regclass ORDER BY conname"),
      trg: await db.$queryRawUnsafe<unknown[]>("SELECT tgname FROM pg_trigger WHERE tgrelid = 'nodes'::regclass AND tgname LIKE 'git_mirror_node_%' ORDER BY tgname"),
    });
    const before = await shape();
    const pg = new URL(process.env.DATABASE_URL!);
    await promisify(execFileCb)('psql', ['-q', '-v', 'ON_ERROR_STOP=1', '-f', fileURLToPath(new URL('migration.sql', dir))], {
      env: { ...process.env, PGHOST: pg.hostname, PGPORT: pg.port, PGUSER: decodeURIComponent(pg.username), PGPASSWORD: decodeURIComponent(pg.password), PGDATABASE: decodeURIComponent(pg.pathname.slice(1)) },
    });
    expect(await shape()).toEqual(before);
    expect((before.trg as Array<{ tgname: string }>).map(t => t.tgname)).toEqual(expect.arrayContaining(['git_mirror_node_write_insert', 'git_mirror_node_write_update']));
  });
});
