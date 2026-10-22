import { cleanupAnonymousMemories } from '../../jobs/cleanupAnonymousMemories.js';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { waitForLockWaitersOfType } from '../../test/lockWait.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { withIncludeHistoryTransaction, includeHistoryClient } from './includeHistoryFence.js';

import { insertSoftPasskey, softPasskey } from '../../test/softPasskey.js';
import { cancelFirstPasskey, issueCancelToken } from '../passkeys/cancel.js';
import { endWindowEarly } from '../passkeys/endWindow.js';
import { finishRevoke, bindRevokeByIdp } from '../passkeys/revoke.js';
import { createCeremony } from '../passkeys/ceremony.js';
import { confirmFreshSignIn, recordIdpSignIn } from '../passkeys/freshSignIn.js';

import { createNodeRevision, buildNodeRevisionSnapshot } from '../nodeRevisionSnapshot.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
let userId: string;
let memoryId: string;
const ctx = (): Context => ({ db, userId, roles: ['ADMIN'] });
beforeEach(async () => {
  await cleanDb(db);
  vi.stubEnv('PASSKEY_RP_ID', 'qualification.example');
  userId = (await db.user.create({ data: { handle: 'qualification-admin', roles: ['ADMIN'] } })).id;
  const org = await db.organization.create({ data: { name: 'Qualification fence', urn: 'qualification-fence.example' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  memoryId = (await db.memory.create({ data: { organizationId: org.id, urn: 'qualification-fence.example:mem', name: 'Qualification', class: 'knowledge' } })).id;
});

afterEach(() => vi.unstubAllEnvs());

it.each(['approveNode', 'approveMemoryNodes', 'requestNodeSignature', 'withdrawSigningRequest', 'deleteNodeRevision', 'clearNodeHistory', 'deleteMemory'] as const)(
  '%s takes the history fence before authority and Node locks', async (surface) => {
    const node = await db.node.create({ data: { memoryId, loc: 'source', name: 'Source', content: '# Source' } });
    const revision = await db.nodeRevision.create({ data: { nodeId: node.id, memoryId, loc: node.loc, name: node.name, content: '# Before', revNo: 0 } });
    const request = surface === 'withdrawSigningRequest'
      ? await resolvers.Mutation.requestNodeSignature(null, { nodeRef: node.id }, ctx()) : null;
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const holder = withIncludeHistoryTransaction(db, async () => { entered(); await gate; });
    await ready;
    const pending = surface === 'approveNode' ? resolvers.Mutation.approveNode(null, { nodeRef: node.id }, ctx())
      : surface === 'approveMemoryNodes' ? resolvers.Mutation.approveMemoryNodes(null, { memoryRef: memoryId }, ctx())
        : surface === 'requestNodeSignature' ? resolvers.Mutation.requestNodeSignature(null, { nodeRef: node.id }, ctx())
          : surface === 'withdrawSigningRequest' ? resolvers.Mutation.withdrawSigningRequest(null, { id: request!.id }, ctx())
            : surface === 'deleteNodeRevision' ? resolvers.Mutation.deleteNodeRevision(null, { revisionId: revision.id }, ctx())
              : surface === 'clearNodeHistory' ? resolvers.Mutation.clearNodeHistory(null, { nodeRef: node.id }, ctx())
                : resolvers.Mutation.deleteMemory(null, { id: memoryId }, ctx());
    const outcome = pending.then((value: unknown) => ({ value }), (error: unknown) => ({ error }));
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1, 750);
      // A waiting qualification writer must not hold a row before its outer fence.
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${node.id} FOR UPDATE NOWAIT`;
        await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memoryId} FOR UPDATE NOWAIT`;
      });
    } finally {
      release();
      await holder;
      await outcome;
    }
    await pending;
  },
);

it.each(['cancelFirstPasskey', 'endWindowEarly', 'finishRevoke'] as const)(
  '%s takes the history fence before user/credential locks', async (surface) => {
    const key = softPasskey();
    const passkeyId = await insertSoftPasskey(db, userId, key, { firstWindow: true });
    const browserHash = createHash('sha256').update('qualification-browser').digest('hex');
    const token = surface === 'cancelFirstPasskey' ? await db.$transaction((tx) => issueCancelToken(tx, passkeyId)) : '';
    let ceremonyId = '';
    if (surface !== 'cancelFirstPasskey') {
      const { legId } = await recordIdpSignIn(db, { userId, method: 'google', browserNonceHash: browserHash });
      expect(await confirmFreshSignIn(db, { legSecret: legId, browserNonceHash: browserHash, channel: 'idp' })).toBe(true);
      if (surface === 'finishRevoke') {
        ceremonyId = (await db.$transaction((tx) => createCeremony(tx, { purpose: 'REVOKE', browserNonceHash: browserHash, ttlSeconds: 300, challengeIsId: true }))).id;
        expect(await bindRevokeByIdp(db, { ceremonyId, ceremonyNonceHash: browserHash, signInBrowserHash: browserHash })).not.toBeNull();
      }
    }
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const holder = withIncludeHistoryTransaction(db, async () => { entered(); await gate; });
    await ready;
    const pending = surface === 'cancelFirstPasskey'
      ? cancelFirstPasskey(db, { token, ip: '192.0.2.1', userAgent: 'qualification-test' })
      : surface === 'endWindowEarly' ? endWindowEarly(db, { signInBrowserHash: browserHash })
        : finishRevoke(db, { ceremonyId, ceremonyNonceHash: browserHash, signInBrowserHash: browserHash, targetCredentialId: key.credentialId });
    const outcome = pending.then((value: unknown) => ({ value }), (error: unknown) => ({ error }));
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1, 750);
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE NOWAIT`;
        await tx.$queryRaw`SELECT id FROM passkey_credentials WHERE id = ${passkeyId} FOR UPDATE NOWAIT`;
      });
      expect((await db.passkeyCredential.findUniqueOrThrow({ where: { id: passkeyId } })).revokedAt).toBeNull();
    } finally {
      release();
      await holder;
      await outcome;
    }
    const result = await pending;
    if (surface === 'cancelFirstPasskey') expect(result).toBe(true);
    else expect(result).toMatchObject({ passkeyId });
  },
);

it('snapshot helpers reject a pooled client, raw/manual-lock transaction, and escaped client before mutation', async () => {
  const node = await db.node.create({ data: { memoryId, loc: 'proof', name: 'Proof', content: '# Proof' } });
  const snapshot = buildNodeRevisionSnapshot(node, { userId }, { changes: ['content'] });
  await expect(createNodeRevision(db, snapshot)).rejects.toThrow('prepared include-history client');
  await expect(db.$transaction((tx) => createNodeRevision(tx, snapshot))).rejects.toThrow('prepared include-history client');
  await expect(db.$transaction(async (tx) => {
    // Holding the SQL key alone is not a forgeable substitute for the opaque proof.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(2063, 1772)`;
    await createNodeRevision(tx, snapshot);
  })).rejects.toThrow('prepared include-history client');
  let escaped: unknown;
  await withIncludeHistoryTransaction(db, async (history) => {
    escaped = includeHistoryClient(history);
    // The pool is not the prepared connection even inside the correct async scope.
    await expect(createNodeRevision(db, snapshot)).rejects.toThrow('prepared include-history client');
  });
  await expect(createNodeRevision(escaped as never, snapshot)).rejects.toThrow('prepared include-history client');
  expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).revSeq).toBe(1);
  expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(0);
});

type QualificationSurface = 'encryptMemory' | 'ownerHandleReclamation' | 'cleanupAnonymousMemories' | 'deleteMemory' | 'approveNode' | 'approveMemoryNodes' | 'requestNodeSignature' | 'withdrawSigningRequest' | 'deleteNodeRevision' | 'clearNodeHistory' | 'cancelFirstPasskey' | 'endWindowEarly' | 'finishRevoke';
async function qualificationAct(surface: QualificationSurface): Promise<{
  run: (database: typeof db) => Promise<unknown>;
  check: (value: unknown) => void;
}> {
  if (surface === 'encryptMemory') {
    await db.memory.update({ where: { id: memoryId }, data: { class: 'private', userId } });
    await db.node.create({ data: { memoryId, loc: 'encrypt-source', name: 'Encrypt source', content: '# Plaintext before flip' } });
    return { run: (database) => resolvers.Mutation.encryptMemory(null, { memoryId, dataKey: Buffer.alloc(32, 7).toString('base64') }, { ...ctx(), db: database }), check: (value) => expect(value).toMatchObject({ isEncrypted: true }) };
  }
  if (surface === 'ownerHandleReclamation') {
    const dead = await db.memory.create({ data: { ownerUserId: userId, class: 'knowledge', name: 'Reclaimed tombstone', urn: 'qualification-next:dead', deletedAt: new Date() } });
    await db.node.create({ data: { memoryId: dead.id, loc: 'retained', name: 'Retained source', content: '# Old history' } });
    return { run: (database) => resolvers.Mutation.updateMyProfile(null, { handle: 'qualification-next' }, { ...ctx(), db: database }), check: (value) => expect(value).toMatchObject({ handle: 'qualification-next' }) };
  }
  if (surface === 'cleanupAnonymousMemories') {
    const agent = await db.agent.create({ data: { ownerUserId: userId, urn: 'qualification-admin:cleanup-agent', name: 'Cleanup', type: 'CHATBOT' } });
    await db.memory.update({ where: { id: memoryId }, data: { userMemoryOfAgentId: agent.id, anonymousExpiresAt: new Date(Date.now() - 60_000) } });
    await db.node.create({ data: { memoryId, loc: 'cleanup-source', name: 'Cleanup source', content: '# Retained before cleanup' } });
    return { run: (database) => cleanupAnonymousMemories(database), check: (value) => expect(value).toBe(1) };
  }
  if (surface === 'deleteMemory') return {
    run: (database) => resolvers.Mutation.deleteMemory(null, { id: memoryId }, { ...ctx(), db: database }),
    check: (value) => expect(value).toBe(true),
  };
  if (surface === 'cancelFirstPasskey' || surface === 'endWindowEarly' || surface === 'finishRevoke') {
    const key = softPasskey();
    const passkeyId = await insertSoftPasskey(db, userId, key, { firstWindow: true });
    const browserHash = createHash('sha256').update('qualification-inverse-browser').digest('hex');
    if (surface === 'cancelFirstPasskey') {
      const token = await db.$transaction((tx) => issueCancelToken(tx, passkeyId));
      return { run: (database) => cancelFirstPasskey(database, { token, ip: '192.0.2.1', userAgent: 'qualification-test' }), check: (value) => expect(value).toBe(true) };
    }
    const { legId } = await recordIdpSignIn(db, { userId, method: 'google', browserNonceHash: browserHash });
    expect(await confirmFreshSignIn(db, { legSecret: legId, browserNonceHash: browserHash, channel: 'idp' })).toBe(true);
    if (surface === 'endWindowEarly') {
      return { run: (database) => endWindowEarly(database, { signInBrowserHash: browserHash }), check: (value) => expect(value).toMatchObject({ passkeyId }) };
    }
    const ceremonyId = (await db.$transaction((tx) => createCeremony(tx, { purpose: 'REVOKE', browserNonceHash: browserHash, ttlSeconds: 300, challengeIsId: true }))).id;
    expect(await bindRevokeByIdp(db, { ceremonyId, ceremonyNonceHash: browserHash, signInBrowserHash: browserHash })).not.toBeNull();
    return {
      run: (database) => finishRevoke(database, { ceremonyId, ceremonyNonceHash: browserHash, signInBrowserHash: browserHash, targetCredentialId: key.credentialId }),
      check: (value) => expect(value).toMatchObject({ passkeyId }),
    };
  }
  const node = await db.node.create({ data: { memoryId, loc: 'inverse', name: 'Inverse', content: '# Inverse' } });
  if (surface === 'approveNode') return {
    run: (database) => resolvers.Mutation.approveNode(null, { nodeRef: node.id }, { ...ctx(), db: database }), check: (value) => expect(value).toMatchObject({ nodeId: node.id }),
  };
  if (surface === 'approveMemoryNodes') return {
    run: (database) => resolvers.Mutation.approveMemoryNodes(null, { memoryRef: memoryId }, { ...ctx(), db: database }), check: (value) => expect(value).toMatchObject({ approvedCount: 1 }),
  };
  if (surface === 'requestNodeSignature') return {
    run: (database) => resolvers.Mutation.requestNodeSignature(null, { nodeRef: node.id }, { ...ctx(), db: database }), check: (value) => expect(value).toMatchObject({ nodeId: node.id, state: 'open' }),
  };
  if (surface === 'withdrawSigningRequest') {
    const request = await resolvers.Mutation.requestNodeSignature(null, { nodeRef: node.id }, ctx());
    return { run: (database) => resolvers.Mutation.withdrawSigningRequest(null, { id: request.id }, { ...ctx(), db: database }), check: (value) => expect(value).toMatchObject({ id: request.id, state: 'withdrawn' }) };
  }
  const revision = await db.nodeRevision.create({ data: { nodeId: node.id, memoryId, loc: node.loc, name: node.name, content: '# Before', revNo: 0 } });
  return surface === 'deleteNodeRevision'
    ? { run: (database) => resolvers.Mutation.deleteNodeRevision(null, { revisionId: revision.id }, { ...ctx(), db: database }), check: (value) => expect(value).toBe(true) }
    : { run: (database) => resolvers.Mutation.clearNodeHistory(null, { nodeRef: node.id }, { ...ctx(), db: database }), check: (value) => expect(value).toBe(1) };
}

it.each<QualificationSurface>(['approveNode', 'approveMemoryNodes', 'requestNodeSignature', 'withdrawSigningRequest', 'deleteNodeRevision', 'clearNodeHistory', 'cancelFirstPasskey', 'endWindowEarly', 'finishRevoke', 'deleteMemory', 'cleanupAnonymousMemories', 'ownerHandleReclamation', 'encryptMemory'])(
  '%s holds the fence through its actual deciding write and commit (inverse order)', async (surface) => {
    const act = await qualificationAct(surface);
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const transaction = db.$transaction.bind(db);
    const heldDb = new Proxy(db, {
      get(target, key, receiver) {
        if (key !== '$transaction') return Reflect.get(target, key, receiver);
        return (work: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<unknown>, options: unknown) => transaction(async (tx) => {
          const value = await work(tx); // run the REAL gate and write, then pause before commit
          entered();
          await gate;
          return value;
        }, options as never);
      },
    });
    const writer = act.run(heldDb);
    const writerOutcome = writer.then((value) => ({ value }), (error: unknown) => ({ error }));
    await Promise.race([ready, writerOutcome.then((result) => {
      if ('error' in result) throw result.error;
      throw new Error('Writer returned before the commit barrier');
    })]);
    let otherEntered = false;
    const other = withIncludeHistoryTransaction(db, async () => { otherEntered = true; });
    const otherOutcome = other.then(() => undefined, (error: unknown) => error);
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1, 750);
      expect(otherEntered).toBe(false);
    } finally {
      release();
      await writerOutcome;
      await otherOutcome;
    }
    act.check(await writer);
    await other;
    expect(otherEntered).toBe(true);
  },
);

it.each(['updateNode', 'deleteNode', 'approveNode', 'clearNodeHistory', 'encryptMemory'] as const)(
  '%s refuses a credential revoked while waiting on the history fence without changing source or history', async (surface) => {
    const node = await db.node.create({ data: { memoryId, loc: 'revoked-writer', name: 'Original', content: '# Original' } });
    if (surface === 'encryptMemory') await db.memory.update({ where: { id: memoryId }, data: { class: 'private', userId } });
    const key = await db.userApiKey.create({ data: { userId, keyHash: `qualification-${surface}`, keyPreview: 'test', oauthScopes: [] } });
    const context: Context = { ...ctx(), apiKeyId: key.id };
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const holder = withIncludeHistoryTransaction(db, async () => { entered(); await gate; });
    await ready;
    const pending = surface === 'updateNode' ? resolvers.Mutation.updateNode(null, { input: { id: node.id, content: '# Changed' } }, context)
      : surface === 'deleteNode' ? resolvers.Mutation.deleteNode(null, { nodeRef: node.id, hard: true }, context)
        : surface === 'approveNode' ? resolvers.Mutation.approveNode(null, { nodeRef: node.id }, context)
          : surface === 'clearNodeHistory' ? resolvers.Mutation.clearNodeHistory(null, { nodeRef: node.id }, context)
            : resolvers.Mutation.encryptMemory(null, { memoryId, dataKey: Buffer.alloc(32, 7).toString('base64') }, context);
    const outcome = pending.then(() => ({ accepted: true }), (error: unknown) => ({ error }));
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1, 750);
      await db.userApiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    } finally {
      release();
      await holder;
    }
    expect(await outcome).toHaveProperty('error');
    expect(await db.node.findUniqueOrThrow({ where: { id: node.id } })).toMatchObject({ content: '# Original', deletedAt: null, approvalHash: null, revSeq: 1 });
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(0);
    if (surface === 'encryptMemory') expect((await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).isEncrypted).toBe(false);
  },
);


it('anonymous cleanup waits before taking any cascading memory/node lock', async () => {
  const act = await qualificationAct('cleanupAnonymousMemories');
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((r) => { entered = r; });
  const gate = new Promise<void>((r) => { release = r; });
  const holder = withIncludeHistoryTransaction(db, async () => { entered(); await gate; });
  await ready;
  const pending = act.run(db);
  const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    await waitForLockWaitersOfType(db, 'advisory', 1, 750);
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memoryId} FOR UPDATE NOWAIT`;
      await tx.$queryRaw`SELECT id FROM nodes WHERE memory_id = ${memoryId} FOR UPDATE NOWAIT`;
    });
  } finally {
    release();
    await holder;
    await outcome;
  }
  act.check(await pending);
  expect(await db.memory.findUnique({ where: { id: memoryId } })).toBeNull();
});


it('owner-handle reclamation waits before its user and cascading memory locks', async () => {
  const act = await qualificationAct('ownerHandleReclamation');
  const dead = await db.memory.findUniqueOrThrow({ where: { urn: 'qualification-next:dead' } });
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((r) => { entered = r; });
  const gate = new Promise<void>((r) => { release = r; });
  const holder = withIncludeHistoryTransaction(db, async () => { entered(); await gate; });
  await ready;
  const pending = act.run(db);
  const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    await waitForLockWaitersOfType(db, 'advisory', 1, 750);
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE NOWAIT`;
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${dead.id} FOR UPDATE NOWAIT`;
    });
  } finally {
    release(); await holder; await outcome;
  }
  act.check(await pending);
  expect(await db.memory.findUnique({ where: { id: dead.id } })).toBeNull();
});

// Evidence-only combined tree: these imports and controls require held #2258.
import { compileBootPrompt } from '../../api/graphql/schema/compileBootPrompt.js';
const combinedSurfaces: QualificationSurface[] = ['approveNode', 'approveMemoryNodes', 'requestNodeSignature', 'withdrawSigningRequest', 'deleteNodeRevision', 'clearNodeHistory', 'cancelFirstPasskey', 'endWindowEarly', 'finishRevoke', 'deleteMemory', 'cleanupAnonymousMemories', 'ownerHandleReclamation', 'encryptMemory'];
async function compileCounterparty() {
  const memory = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
  const system = await db.memory.create({ data: { class: 'system', organizationId: memory.organizationId, name: 'Compile system', urn: 'qualification-fence.example:compile-system' } });
  const agent = await db.agent.create({ data: { organizationId: memory.organizationId, systemMemoryId: system.id, urn: 'qualification-fence.example:compile-agent', name: 'Compile agent' } });
  await db.node.create({ data: { memoryId: system.id, loc: 'boot:source', role: 'boot-prompt', name: 'Source', content: 'Counterparty {{worker.name}}' } });
  return { agentId: agent.id, target: { kind: 'AGENT' as const, agentId: agent.id } };
}

it.each(combinedSurfaces.flatMap((surface) => (['read', 'write'] as const).map((phase) => ({ surface, phase }))))(
  'actual compile $phase holder excludes $surface through commit', async ({ surface, phase }) => {
    const act = await qualificationAct(surface);
    const compile = await compileCounterparty();
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const transaction = db.$transaction.bind(db);
    const heldDb = phase === 'read' ? db : new Proxy(db, {
      get(target, key, receiver) {
        if (key !== '$transaction') return Reflect.get(target, key, receiver);
        return (work: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<unknown>, options: unknown) => transaction(async (tx) => {
          const value = await work(tx);
          entered(); await gate;
          return value;
        }, options as never);
      },
    });
    const holder = compileBootPrompt({ ...ctx(), db: heldDb }, compile.target,
      phase === 'read' ? { seams: { beforeAssemble: async () => { entered(); await gate; } } } : {});
    const holderOutcome = holder.then((value) => ({ value }), (error: unknown) => ({ error }));
    await Promise.race([ready, holderOutcome.then((result) => {
      if ('error' in result) throw result.error;
      throw new Error('Compile returned before its phase barrier');
    })]);
    const writer = act.run(db);
    const writerOutcome = writer.then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1, 750);
      expect(await db.compiledPromptRevision.count()).toBe(0);
    } finally {
      release(); await holderOutcome; await writerOutcome;
    }
    expect(await holder).toMatchObject({ revNo: 1, pointerSet: true });
    act.check(await writer);
    expect((await db.agent.findUniqueOrThrow({ where: { id: compile.agentId } })).bootPromptNodeId).not.toBeNull();
  },
);

it.each(combinedSurfaces)(
  '$surface excludes actual compile until the qualification commit (inverse order)', async (surface) => {
    const act = await qualificationAct(surface);
    const compile = await compileCounterparty();
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const transaction = db.$transaction.bind(db);
    const heldDb = new Proxy(db, {
      get(target, key, receiver) {
        if (key !== '$transaction') return Reflect.get(target, key, receiver);
        return (work: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<unknown>, options: unknown) => transaction(async (tx) => {
          const value = await work(tx); entered(); await gate; return value;
        }, options as never);
      },
    });
    const writer = act.run(heldDb);
    const writerOutcome = writer.then((value) => ({ value }), (error: unknown) => ({ error }));
    await Promise.race([ready, writerOutcome.then((result) => {
      if ('error' in result) throw result.error;
      throw new Error('Qualification returned before its commit barrier');
    })]);
    let assembled = false;
    const holder = compileBootPrompt(ctx(), compile.target, { seams: { beforeAssemble: async () => { assembled = true; } } });
    const holderOutcome = holder.then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1, 750);
      expect(assembled).toBe(false);
      expect(await db.compiledPromptRevision.count()).toBe(0);
    } finally {
      release(); await writerOutcome; await holderOutcome;
    }
    act.check(await writer);
    expect(await holder).toMatchObject({ revNo: 1, pointerSet: true });
    expect(assembled).toBe(true);
  },
);

import { accountFenceClient, isSerializationConflict, withAccountFenceTransaction } from './includeHistoryFence.js';
it.each(combinedSurfaces)(
  '$surface commits before a queued account and forces stale-snapshot retry before account work', async (surface) => {
    const act = await qualificationAct(surface);
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const blocker = withIncludeHistoryTransaction(db, async () => { entered(); await gate; throw new Error('rollback staging holder'); });
    const blockerOutcome = blocker.catch(() => undefined);
    await ready;
    const writer = act.run(db);
    const writerOutcome = writer.then((value) => ({ value }), (error: unknown) => ({ error }));
    let worked = false;
    let account: Promise<unknown> | undefined;
    let accountOutcome: Promise<unknown> | undefined;
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1, 750);
      account = withAccountFenceTransaction(db, async (proof) => {
        worked = true;
        await accountFenceClient(proof).organization.create({ data: { name: 'Must not write', urn: 'qualification-stale-account' } });
      });
      accountOutcome = account.catch((error: unknown) => error);
      await waitForLockWaitersOfType(db, 'advisory', 2, 750);
    } finally {
      release(); await blockerOutcome; await writerOutcome; await accountOutcome;
    }
    act.check(await writer);
    expect(account).toBeDefined();
    expect(isSerializationConflict(await accountOutcome)).toBe(true);
    expect(worked).toBe(false);
    expect(await db.organization.count({ where: { urn: 'qualification-stale-account' } })).toBe(0);
  },
);

it.each(combinedSurfaces)(
  'account commit precedes the waiting $surface boundary without downgrade or nested fence', async (surface) => {
    const act = await qualificationAct(surface);
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const account = withAccountFenceTransaction(db, async (proof) => {
      await accountFenceClient(proof).organization.create({ data: { name: 'Committed account', urn: 'qualification-account-first' } });
      entered(); await gate;
    });
    const accountOutcome = account.then(() => undefined, (error: unknown) => error);
    await ready;
    const writer = act.run(db);
    const writerOutcome = writer.then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1, 750);
      expect(await db.organization.count({ where: { urn: 'qualification-account-first' } })).toBe(0);
    } finally {
      release(); await accountOutcome; await writerOutcome;
    }
    await account;
    act.check(await writer);
    expect(await db.organization.count({ where: { urn: 'qualification-account-first' } })).toBe(1);
  },
);
