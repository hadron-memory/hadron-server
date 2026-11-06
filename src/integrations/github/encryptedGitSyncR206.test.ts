/**
 * R206 (cor:sec:040:05, cor:int:010:01, #2377): an encrypted memory never syncs
 * to or from Git, whatever key a request, session or cache carries. These tests
 * drive the real checkout, renderer and filesystem against a fixture repository
 * and assert that no Git command mutates it and no byte reaches the working tree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { db } from '../db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { generateDataKey } from '../../lib/crypto.js';
import { makeKeyVerifier } from '../../lib/memoryUnlock.js';
import { encryptNodeFieldsWithKey } from '../../lib/nodeCrypto.js';
import { sessionKeyCache } from '../../lib/sessionKeyCache.js';
import { requestKeyStorage } from '../../lib/requestKeys.js';
import { clearNodeWrittenLocalHandlers, registerNodeWrittenLocalHandler } from '../../lib/events/nodeWritten.js';
import { handleNodeWrittenForGit } from './nodeWrittenSubscriber.js';
import { withMirrorCheckout } from './gitMirrorCheckout.js';
import { pushMemoryToGit } from './pushMemoryToGit.js';
import { syncGraphFromGithub } from './syncGraphFromGithub.js';
import { writeNodeFile } from './writeNodeToGit.js';
import { execGit } from './execGit.js';
import { mirrorNodeMoveToGit } from './mirrorNodeMove.js';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../../config.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../config.js')>(),
  get GRAPHS_PATH() { return paths.root; },
}));
vi.mock('./gitBranch.js', () => ({ prepareWriteBranch: vi.fn(async () => {}) }));
vi.mock('./execGit.js', () => ({ execGit: vi.fn() }));

const key = generateDataKey();
const M = resolvers.Mutation as unknown as Record<string, (...args: unknown[]) => Promise<any>>;
const fields = { content: 'private body', abstract: 'private summary', data: { secret: 'private data' } };
const CODE = /ENCRYPTED_GIT_SYNC_UNAVAILABLE/;

let memoryId: string;
let ownerId: string;
let nodeId: string;
let otherId: string;
let localPath: string;
let originalFile: Buffer;
let warning: ReturnType<typeof vi.spyOn>;
const ctx = (): Context => ({ db, userId: ownerId, roles: ['READER'] });
const gitMutations = () => vi.mocked(execGit).mock.calls.filter(([args]) => ['add', 'commit', 'push', 'clone', 'fetch'].includes(args[0]));
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 150));

beforeEach(async () => {
  await cleanDb(db);
  clearNodeWrittenLocalHandlers();
  sessionKeyCache.clear();
  vi.mocked(execGit).mockReset();
  vi.mocked(execGit).mockImplementation(async args => ({ stdout: args[0] === 'status' ? ' M node.md\n' : '', stderr: '' }));
  paths.root = mkdtempSync(join(tmpdir(), 'r206-mirror-'));
  const org = await db.organization.create({ data: { name: 'R206 fixture', urn: 'r206.test' } });
  const owner = await db.user.create({ data: { handle: 'r206-owner', roles: ['READER'] } });
  ownerId = owner.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: ownerId, role: 'READER' } });
  const memory = await db.memory.create({ data: {
    organizationId: org.id, userId: ownerId, class: 'private', name: 'r206',
    urn: 'r206.test:r206', source: 'https://github.com/r206/fixture',
    isEncrypted: true, keyVerifier: makeKeyVerifier(key),
  } });
  memoryId = memory.id;
  const node = await db.node.create({ data: { memoryId, loc: 'node', name: 'Node', tags: ['t'], ...encryptNodeFieldsWithKey(fields, key) } });
  const other = await db.node.create({ data: { memoryId, loc: 'other', name: 'Other', tags: [], ...encryptNodeFieldsWithKey({ content: 'other body' }, key) } });
  nodeId = node.id;
  otherId = other.id;
  localPath = join(paths.root, org.urn, 'r206');
  mkdirSync(join(localPath, '.git'), { recursive: true });
  writeNodeFile(localPath, { ...node, ...fields, outgoingEdges: [] } as never);
  originalFile = readFileSync(join(localPath, 'node.md'));
  warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  registerNodeWrittenLocalHandler('r206-test', event => handleNodeWrittenForGit(db, event));
});

afterEach(() => {
  clearNodeWrittenLocalHandlers();
  vi.restoreAllMocks();
  sessionKeyCache.clear();
  if (paths.root) rmSync(paths.root, { recursive: true, force: true });
});

const expectUntouched = () => {
  expect(readFileSync(join(localPath, 'node.md'))).toEqual(originalFile);
  expect(gitMutations()).toHaveLength(0);
};

describe('R206: encrypted memories never sync to Git', () => {
  it.each([
    ['no key', () => undefined],
    ['a request key', () => new Map([[memoryId, key]])],
  ])('refuses the checkout for a path-only operation with %s, with a typed outcome', async (_label, keys) => {
    const run = () => withMirrorCheckout({ memoryId, commitSubject: 'path cleanup', logPrefix: '[fixture]' }, ({ localPath: p }) => {
      mkdirSync(join(p, 'touched'), { recursive: true });
    });
    const map = keys();
    const outcome = map ? await requestKeyStorage.run(map, run) : await run();
    expect(outcome).toBe('refused-encrypted');
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(CODE));
    expectUntouched();
  });

  it('does not export an update made with the request key, nor with only a warm session cache', async () => {
    sessionKeyCache.set('warm-session', memoryId, key);
    await requestKeyStorage.run(new Map([[memoryId, key]]), () => M.updateNode(null, { input: { id: nodeId, content: 'new plaintext body' } }, ctx()));
    await settle();
    expectUntouched();
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).content).toMatch(/^enc:v1:/);
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(CODE));
  });

  it('does not export a metadata-only update (all encrypted fields untouched)', async () => {
    sessionKeyCache.set('warm-session', memoryId, key);
    await M.updateNode(null, { input: { id: nodeId, tags: ['meta-only'] } }, ctx());
    await settle();
    expectUntouched();
  });

  it('does not export a search/replace made with the request key', async () => {
    await requestKeyStorage.run(new Map([[memoryId, key]]), () => M.searchReplaceInNodes(null, { input: { nodeIds: [nodeId], fields: ['content'], oldText: 'private', newText: 'changed', dryRun: false } }, ctx()));
    await settle();
    expectUntouched();
  });

  it('does not export a merge made with the request key', async () => {
    await requestKeyStorage.run(new Map([[memoryId, key]]), () => M.mergeNodes({}, { input: { source: otherId, target: nodeId, include: ['TAGS'] } }, ctx()));
    await settle();
    expectUntouched();
  });

  it('does not export an Edge change when the session key is warm', async () => {
    sessionKeyCache.set('warm-session', memoryId, key);
    await M.createEdge(null, { sourceRef: nodeId, targetRef: otherId, name: 'links' }, ctx());
    await settle();
    expectUntouched();
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(CODE));
  });

  it.each([
    ['no key', undefined],
    ['a request key', true],
  ])('refuses a full push with %s before any Git I/O, with a typed code', async (_label, keys) => {
    const run = () => pushMemoryToGit(memoryId);
    const result = keys ? await requestKeyStorage.run(new Map([[memoryId, key]]), run) : await run();
    expect(result.nodeCount).toBe(0);
    expect(result.errorCode).toBe('ENCRYPTED_GIT_SYNC_UNAVAILABLE');
    expect(vi.mocked(execGit)).not.toHaveBeenCalled();
    expectUntouched();
  });

  it('exposes the full push refusal as a typed GraphQL error', async () => {
    await expect(M.pushMemoryToGit({}, { id: memoryId }, ctx())).rejects.toMatchObject({ extensions: { code: 'ENCRYPTED_GIT_SYNC_UNAVAILABLE' } });
  });

  it('refuses Git import with a request key, writing no node or revision', async () => {
    const before = await db.node.findMany({ orderBy: { id: 'asc' } });
    const memory = await db.memory.findUniqueOrThrow({ where: { id: memoryId }, include: { organization: true } });
    const result = await requestKeyStorage.run(new Map([[memoryId, key]]), () => syncGraphFromGithub(memory as never));
    expect(result.error).toMatch(/encrypted memory/);
    expect(await db.node.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    expect(vi.mocked(execGit)).not.toHaveBeenCalled();
  });

  it.each([
    ['no key', undefined],
    ['a request key', true],
  ])('refuses an explicit sync of an encrypted memory with NO source, with %s, with the typed code', async (_label, keyed) => {
    await db.memory.update({ where: { id: memoryId }, data: { source: null } });
    const run = () => M.syncMemory({}, { id: memoryId }, ctx());
    const rejects = expect(keyed ? requestKeyStorage.run(new Map([[memoryId, key]]), run) : run())
      .rejects.toMatchObject({ extensions: { code: 'ENCRYPTED_GIT_SYNC_UNAVAILABLE' } });
    await rejects;
    expect(vi.mocked(execGit)).not.toHaveBeenCalled();
  });

  it.each([
    ['no key', undefined],
    ['a request key', true],
  ])('refuses MCP hadron_sync_graph of an encrypted memory with NO source, with %s, with the typed code', async (_label, keyed) => {
    await db.memory.update({ where: { id: memoryId }, data: { source: null } });
    const { createTestableMcpServer } = await import('../../mcp/server.js');
    const server = createTestableMcpServer({ userId: ownerId, roles: ['READER'], clientId: `user:${ownerId}` });
    const run = () => server.callToolText('hadron_sync_graph', { memoryUrn: 'hrn:mem:r206.test:r206' });
    const text = await (keyed ? requestKeyStorage.run(new Map([[memoryId, key]]), run) : run());
    expect(text).toMatch(CODE);
    expect(text).not.toMatch(/no source repository/);
    expect(vi.mocked(execGit)).not.toHaveBeenCalled();
  });

  it('records an observable typed skip for the configured mirror event, not a silent null', async () => {
    await handleNodeWrittenForGit(db, { nodeId, memoryId, ownerRepo: '', clientId: null } as never);
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(CODE));
    expectUntouched();
  });

  it('refuses the path-only source cleanup of a move out of an encrypted memory, with a typed skip', async () => {
    const dest = await db.memory.create({ data: { organizationId: (await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).organizationId, class: 'knowledge', name: 'dest', urn: 'r206.test:dest' } });
    await mirrorNodeMoveToGit(db, { srcMemoryId: memoryId, destMemoryId: dest.id, moved: [{ id: nodeId, previousLoc: 'node' }] });
    expectUntouched();
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(CODE));
  });

  it('refuses a move into an encrypted memory, with a typed skip', async () => {
    const org = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    const src = await db.memory.create({ data: { organizationId: org.organizationId, class: 'knowledge', name: 'src', urn: 'r206.test:src' } });
    await mirrorNodeMoveToGit(db, { srcMemoryId: src.id, destMemoryId: memoryId, moved: [{ id: nodeId, previousLoc: 'node' }] });
    expectUntouched();
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(CODE));
  });

  it('rechecks encryption at the last boundary before mutation when a plaintext memory flips during preparation', async () => {
    await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: false } });
    vi.mocked(execGit).mockImplementation(async args => {
      if (args[0] === 'fetch') await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: true } });
      return { stdout: args[0] === 'status' ? ' M node.md\n' : '', stderr: '' };
    });
    const outcome = await withMirrorCheckout({ memoryId, commitSubject: 'racing write', logPrefix: '[fixture]' }, ({ localPath: p }) => {
      mkdirSync(join(p, 'touched'), { recursive: true });
    });
    expect(outcome).toBe('refused-encrypted');
    expect(vi.mocked(execGit).mock.calls.some(([args]) => ['add', 'commit', 'push'].includes(args[0]))).toBe(false);
  });
});

describe('R206 positive controls: unencrypted memories still mirror', () => {
  beforeEach(async () => {
    await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: false, keyVerifier: null } });
    await db.node.updateMany({ where: { memoryId }, data: { content: 'plain body', abstract: null, data: {} as never } });
  });

  it('mirrors an unencrypted node update through the event subscriber', async () => {
    await M.updateNode(null, { input: { id: nodeId, content: 'plain edit' } }, ctx());
    await vi.waitFor(() => expect(execGit).toHaveBeenCalledWith(expect.arrayContaining(['push']), expect.anything()));
    expect(readFileSync(join(localPath, 'node.md'), 'utf8')).toContain('plain edit');
  });

  it('runs a path-only checkout for an unencrypted memory', async () => {
    const outcome = await withMirrorCheckout({ memoryId, commitSubject: 'path cleanup', logPrefix: '[fixture]' }, ({ localPath: p }) => {
      mkdirSync(join(p, 'touched'), { recursive: true });
      writeNodeFile(p, { id: nodeId, loc: 'node', name: 'Node', tags: [], content: 'x', outgoingEdges: [] } as never);
    });
    expect(['mirrored', 'no-changes']).toContain(outcome);
  });
});

describe('R206: a conversion cannot interleave with a mirror side effect (late-flip fence)', () => {
  beforeEach(async () => {
    await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: false, keyVerifier: null } });
    await db.node.updateMany({ where: { memoryId }, data: { content: 'plain body', abstract: null, data: {} as never } });
  });

  /** Starts a conversion exactly as encryptMemory does (row FOR UPDATE, then flip), without awaiting it. */
  const startConversion = () => db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memoryId} FOR UPDATE`;
    await tx.memory.update({ where: { id: memoryId }, data: { isEncrypted: true, keyVerifier: makeKeyVerifier(key) } });
  });
  const flagNow = async () => (await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).isEncrypted;

  it('serializes a conversion that starts mid-push behind the push (no plaintext push after the flag flips)', async () => {
    let conversion: Promise<unknown> | undefined;
    const flagAtPush: boolean[] = [];
    vi.mocked(execGit).mockImplementation(async args => {
      if (args[0] === 'fetch') {
        conversion = startConversion();
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      if (args[0] === 'push') flagAtPush.push(await flagNow());
      return { stdout: args[0] === 'status' ? ' M node.md\n' : '', stderr: '' };
    });
    const result = await pushMemoryToGit(memoryId);
    expect(result.errorCode).toBeUndefined();
    expect(flagAtPush).toEqual([false]);
    await conversion;
    expect(await flagNow()).toBe(true);
  });

  it('serializes a conversion that starts after the move rows were read (metadata-only rows)', async () => {
    const dest = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    const src = await db.memory.create({ data: { organizationId: dest.organizationId, class: 'knowledge', name: 'src', urn: 'r206.test:src2' } });
    let conversion: Promise<unknown> | undefined;
    const flagAtPush: boolean[] = [];
    vi.mocked(execGit).mockImplementation(async args => {
      if (args[0] === 'fetch') {
        conversion = startConversion();
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      if (args[0] === 'push') flagAtPush.push(await flagNow());
      return { stdout: args[0] === 'status' ? ' M node.md\n' : '', stderr: '' };
    });
    await mirrorNodeMoveToGit(db, { srcMemoryId: src.id, destMemoryId: memoryId, moved: [{ id: nodeId, previousLoc: 'node' }] });
    expect(flagAtPush).toEqual([false]);
    await conversion;
    expect(await flagNow()).toBe(true);
  });

  it('a conversion that wins first still refuses the mirror with the typed outcome', async () => {
    await startConversion();
    const outcome = await withMirrorCheckout({ memoryId, commitSubject: 'after flip', logPrefix: '[fixture]' }, () => {});
    expect(outcome).toBe('refused-encrypted');
  });
});
