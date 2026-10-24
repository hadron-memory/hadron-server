/** #1273 / R206 (#2377): an encrypted memory never syncs to Git, so no merge, key or cache can overwrite or extend its mirror. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateDataKey } from '../../../lib/crypto.js';
import { makeKeyVerifier } from '../../../lib/memoryUnlock.js';
import { encryptNodeFieldsWithKey } from '../../../lib/nodeCrypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { requestKeyStorage } from '../../../lib/requestKeys.js';
import * as mirror from '../../../integrations/github/writeNodeToGit.js';
import { withMirrorCheckout } from '../../../integrations/github/gitMirrorCheckout.js';
import { execGit } from '../../../integrations/github/execGit.js';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../../../config.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../config.js')>(),
  get GRAPHS_PATH() { return paths.root; },
}));
vi.mock('../../../integrations/github/gitBranch.js', () => ({ prepareWriteBranch: vi.fn(async () => {}) }));
// Exercise the real checkout, renderer and filesystem; no network/git push.
vi.mock('../../../integrations/github/execGit.js', () => ({ execGit: vi.fn() }));

const key = generateDataKey();
let memoryId: string;
let ownerId: string;
let sourceId: string;
let targetId: string;
let localPath: string;
let originalFile: Buffer;
let jobs: Promise<void>[] = [];
let warning: ReturnType<typeof vi.spyOn>;

const fields = { content: 'target private body', abstract: 'target private summary', data: { secret: 'target private data' } };
const ctx = (): Context => ({ db, userId: ownerId, roles: ['READER'] });
const payload = async (): Promise<mirror.NodeForGit> => {
  const node = await db.node.findUniqueOrThrow({ where: { id: targetId }, include: { outgoingEdges: { include: { target: true } } } });
  return { ...node, ...fields, outgoingEdges: node.outgoingEdges };
};

beforeEach(async () => {
  jobs = [];
  await cleanDb(db);
  sessionKeyCache.clear();
  vi.mocked(execGit).mockReset();
  vi.mocked(execGit).mockImplementation(async args => ({ stdout: args[0] === 'status' ? ' M target.md\n' : '', stderr: '' }));
  paths.root = mkdtempSync(join(tmpdir(), 'andi-keyless-mirror-'));
  const org = await db.organization.create({ data: { name: 'Mirror fixture', urn: 'andi1273.test' } });
  const owner = await db.user.create({ data: { handle: 'mirror-owner', roles: ['READER'] } });
  ownerId = owner.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: ownerId, role: 'READER' } });
  const memory = await db.memory.create({ data: {
    organizationId: org.id, userId: ownerId, class: 'private', name: 'mirror',
    urn: 'andi1273.test:mirror', source: 'https://github.com/andi1273/fixture',
    isEncrypted: true, keyVerifier: makeKeyVerifier(key),
  } });
  memoryId = memory.id;
  const source = await db.node.create({ data: { memoryId, loc: 'source', name: 'Source', tags: ['source-tag'], ...encryptNodeFieldsWithKey({ content: 'source private body' }, key) } });
  const target = await db.node.create({ data: { memoryId, loc: 'target', name: 'Target', tags: ['target-tag'], ...encryptNodeFieldsWithKey(fields, key) } });
  sourceId = source.id;
  targetId = target.id;
  localPath = join(paths.root, org.urn, 'mirror');
  mkdirSync(join(localPath, '.git'), { recursive: true });
  mirror.writeNodeFile(localPath, await payload());
  originalFile = readFileSync(join(localPath, 'target.md'));
  warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  jobs = [];
  const realWrite = mirror.writeNodeToGit;
  vi.spyOn(mirror, 'writeNodeToGit').mockImplementation((...args) => {
    const job = realWrite(...args);
    jobs.push(job);
    return job;
  });
});

afterEach(async () => {
  await Promise.allSettled(jobs);
  vi.restoreAllMocks();
  sessionKeyCache.clear();
  if (paths.root) rmSync(paths.root, { recursive: true, force: true });
});

const mergeTags = () => resolvers.Mutation.mergeNodes({}, { input: { source: sourceId, target: targetId, include: ['TAGS'] } }, ctx());

describe('#1273 encrypted node Git mirror', () => {
  it('defers a keyless metadata merge, preserves the existing file and encrypted DB originals', async () => {
    const source = await db.node.findUniqueOrThrow({ where: { id: sourceId } });
    const target = await db.node.findUniqueOrThrow({ where: { id: targetId } });
    const result = await mergeTags();
    await Promise.all(jobs);
    expect(result.tags).toEqual(['target-tag', 'source-tag']);
    expect(readFileSync(join(localPath, 'target.md'))).toEqual(originalFile);
    expect(execGit).not.toHaveBeenCalled();
    const savedSource = await db.node.findUniqueOrThrow({ where: { id: sourceId } });
    const savedTarget = await db.node.findUniqueOrThrow({ where: { id: targetId } });
    for (const field of ['content', 'abstract', 'data'] as const) {
      expect(savedSource[field]).toEqual(source[field]);
      expect(savedTarget[field]).toEqual(target[field]);
    }
  });

  it('defers a keyless request even when another session has warmed the memory cache', async () => {
    sessionKeyCache.set('another-session', memoryId, key);
    expect(sessionKeyCache.hasMemory(memoryId)).toBe(true);
    const before = await db.node.findUniqueOrThrow({ where: { id: targetId } });
    await mergeTags();
    await Promise.all(jobs);
    expect(readFileSync(join(localPath, 'target.md'))).toEqual(originalFile);
    expect(execGit).not.toHaveBeenCalled();
    const after = await db.node.findUniqueOrThrow({ where: { id: targetId } });
    expect(after.content).toBe(before.content);
    expect(after.abstract).toBe(before.abstract);
    expect(after.data).toEqual(before.data);
  });

  it('decrypts a session-cache-only merge response but defers its encrypted mirror', async () => {
    // MCP unlock / agent-session keys permit response decryption, but are not
    // request-carried export authority (Eden cycle-1 ruling, cor:sec:040:05).
    sessionKeyCache.set('requesting-session', memoryId, key);
    expect(requestKeyStorage.getStore()).toBeUndefined();
    const result = await mergeTags();
    await Promise.all(jobs);
    expect(result.content).toBe(fields.content);
    expect(result.abstract).toBe(fields.abstract);
    expect(result.data).toEqual(fields.data);
    expect(result.tags).toEqual(['target-tag', 'source-tag']);
    expect(readFileSync(join(localPath, 'target.md'))).toEqual(originalFile);
    expect(execGit).not.toHaveBeenCalled();
    expect((await db.node.findUniqueOrThrow({ where: { id: targetId } })).content).toMatch(/^enc:v1:/);
  });

  it.each(['content', 'abstract', 'data'] as const)('defers a stored %s envelope even if the live memory flag became plaintext', async field => {
    const raw = await db.node.findUniqueOrThrow({ where: { id: targetId } });
    const snapshot = { ...await payload(), [field]: raw[field] };
    await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: false } });
    await mirror.writeNodeToGit(snapshot, '', null, memoryId);
    expect(readFileSync(join(localPath, 'target.md'))).toEqual(originalFile);
    expect(vi.mocked(execGit).mock.calls.some(([args]) => ['add', 'commit', 'push'].includes(args[0]))).toBe(false);
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/Deferring.*ciphertext/i));
  });

  it('does not write a ciphertext payload even when this request carries a key', async () => {
    const raw = await db.node.findUniqueOrThrow({ where: { id: targetId }, include: { outgoingEdges: { include: { target: true } } } });
    await requestKeyStorage.run(new Map([[memoryId, key]]), () => mirror.writeNodeToGit(raw, '', null, memoryId));
    expect(readFileSync(join(localPath, 'target.md'))).toEqual(originalFile);
    expect(vi.mocked(execGit).mock.calls.some(([args]) => ['add', 'commit', 'push'].includes(args[0]))).toBe(false);
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/ENCRYPTED_GIT_SYNC_UNAVAILABLE/));
  });

  it('does NOT write plaintext when the authorized request carries the key, and changes nothing at rest (R206)', async () => {
    const result = await requestKeyStorage.run(new Map([[memoryId, key]]), mergeTags);
    await Promise.all(jobs);
    expect(result.content).toBe(fields.content);
    expect(readFileSync(join(localPath, 'target.md'))).toEqual(originalFile);
    expect(execGit).not.toHaveBeenCalled();
    expect(jobs).toHaveLength(0);
    expect((await db.node.findUniqueOrThrow({ where: { id: targetId } })).content).toMatch(/^enc:v1:/);
  });

  it('refuses a write queued behind another checkout when the memory became encrypted while it waited, key or not', async () => {
    await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: false } });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const occupying = withMirrorCheckout({ memoryId, commitSubject: 'fixture path operation', logPrefix: '[fixture]' }, async () => {
      entered();
      await gate;
      return false;
    });
    await ready;
    const queued = requestKeyStorage.run(new Map([[memoryId, key]]), () =>
      payload().then(p => mirror.writeNodeToGit({ ...p, content: 'queued plaintext snapshot' }, '', null, memoryId)));
    await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: true } });
    sessionKeyCache.set('later-unlock', memoryId, key);
    release();
    await Promise.all([occupying, queued]);
    expect(readFileSync(join(localPath, 'target.md'))).toEqual(originalFile);
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/ENCRYPTED_GIT_SYNC_UNAVAILABLE/));
    expect(vi.mocked(execGit).mock.calls.some(([args]) => args[0] === 'push')).toBe(false);
  });

  it('defers keyless exports even when every encrypted field is null', async () => {
    await mirror.writeNodeToGit({ ...await payload(), content: null, abstract: null, data: null }, '', null, memoryId);
    expect(readFileSync(join(localPath, 'target.md'))).toEqual(originalFile);
    expect(execGit).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/ENCRYPTED_GIT_SYNC_UNAVAILABLE/));
  });

  it('cannot bypass deferral using the legacy repo-slug lookup without a memory ID', async () => {
    await mirror.writeNodeToGit({ ...await payload(), content: 'keyless plaintext export' }, 'andi1273/fixture');
    expect(readFileSync(join(localPath, 'target.md'))).toEqual(originalFile);
    expect(execGit).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/ENCRYPTED_GIT_SYNC_UNAVAILABLE/));
  });

  it('continues mirroring ordinary unencrypted memory without a key', async () => {
    await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: false } });
    await mirror.writeNodeToGit({ ...await payload(), tags: ['plain-write'] }, '', null, memoryId);
    const written = readFileSync(join(localPath, 'target.md'), 'utf8');
    expect(written).toContain(fields.content);
    expect(written).toContain('plain-write');
    expect(execGit).toHaveBeenCalledWith(expect.arrayContaining(['push']), expect.anything());
    expect(warning).not.toHaveBeenCalledWith(expect.stringMatching(/ENCRYPTED_GIT_SYNC_UNAVAILABLE/));
  });

  it('rechecks encryption after Git preparation before writing the node file', async () => {
    await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: false } });
    await db.node.update({ where: { id: targetId }, data: { ...fields, tags: ['pending-write'] } });
    let flipped = false;
    vi.mocked(execGit).mockImplementation(async args => {
      if (args[0] === 'fetch') {
        flipped = true;
        await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: true } });
      }
      return { stdout: args[0] === 'status' ? ' M target.md\n' : '', stderr: '' };
    });
    await mirror.writeNodeToGit(await payload(), '', null, memoryId);
    expect(flipped).toBe(true);
    expect(execGit).toHaveBeenCalledWith(['remote', 'set-url', 'origin', 'https://github.com/andi1273/fixture'], { cwd: localPath });
    expect(readFileSync(join(localPath, 'target.md'))).toEqual(originalFile);
    expect(vi.mocked(execGit).mock.calls.some(([args]) => ['add', 'commit', 'push'].includes(args[0]))).toBe(false);
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/ENCRYPTED_GIT_SYNC_UNAVAILABLE/));
  });

  it('makes a memory deletion wait for an in-flight mirror instead of pulling the row out from under it (R206 row fence)', async () => {
    await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: false } });
    let deletion: Promise<unknown> | undefined;
    let deletedDuringMirror = false;
    vi.mocked(execGit).mockImplementation(async args => {
      if (args[0] === 'fetch') {
        deletion = db.memory.delete({ where: { id: memoryId } }).then(() => { deletedDuringMirror = true; });
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      if (args[0] === 'push') expect(deletedDuringMirror).toBe(false);
      return { stdout: args[0] === 'status' ? ' M target.md\n' : '', stderr: '' };
    });
    await mirror.writeNodeToGit(await payload(), '', null, memoryId);
    expect(vi.mocked(execGit).mock.calls.some(([args]) => args[0] === 'push')).toBe(true);
    await deletion;
    expect(await db.memory.findUnique({ where: { id: memoryId } })).toBeNull();
  });

  it('does not use key possession to bypass the merge owner gate', async () => {
    const other = await db.user.create({ data: { handle: 'mirror-outsider', roles: ['READER'] } });
    await requestKeyStorage.run(new Map([[memoryId, key]]), async () => {
      await expect(resolvers.Mutation.mergeNodes({}, { input: { source: sourceId, target: targetId, include: ['TAGS'] } }, { db, userId: other.id, roles: ['READER'] }))
        .rejects.toThrow();
    });
    expect(jobs).toHaveLength(0);
    expect(readFileSync(join(localPath, 'target.md'))).toEqual(originalFile);
  });
});
