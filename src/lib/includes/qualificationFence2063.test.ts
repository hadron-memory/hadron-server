import { withAuthorizedMemoryTx } from '../../api/graphql/schema/authorizedTx.js';
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

import { createNodeRevision, buildNodeRevisionSnapshot, revisionStateHashRefreshMarker } from '../nodeRevisionSnapshot.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
let userId: string;
let memoryId: string;
let presentedKeyId: string | undefined;
let requestRoles: string[] = ['ADMIN'];
const ctx = (): Context => ({ db, userId, roles: requestRoles, ...(presentedKeyId ? { apiKeyId: presentedKeyId } : {}) });
beforeEach(async () => {
  presentedKeyId = undefined;
  requestRoles = ['ADMIN'];
  await cleanDb(db);
  vi.stubEnv('PASSKEY_RP_ID', 'qualification.example');
  userId = (await db.user.create({ data: { handle: 'qualification-admin', roles: ['ADMIN'] } })).id;
  const org = await db.organization.create({ data: { name: 'Qualification fence', urn: 'qualification-fence.example' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  memoryId = (await db.memory.create({ data: { organizationId: org.id, urn: 'qualification-fence.example:mem', name: 'Qualification', class: 'knowledge' } })).id;
});

afterEach(() => vi.unstubAllEnvs());

it.each(['approveNode', 'approveMemoryNodes', 'requestNodeSignature', 'withdrawSigningRequest', 'deleteNodeRevision', 'clearNodeHistory', 'deleteMemory', 'restoreNodeRevision'] as const)(
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
                : surface === 'restoreNodeRevision' ? resolvers.Mutation.restoreNodeRevision(null, { revisionId: revision.id }, ctx())
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

type QualificationSurface = 'createAgentMemoryReclaim' | 'createMemoryInAppReclaim' | 'repairMemoryReclaim' | 'createMemoryReclaim' | 'cloneMemoryReclaim' | 'extractReclaim' | 'createAppReclaim' | 'reserveSpecCitation' | 'specReplace' | 'mergeMemories' | 'extractCopy' | 'extractMove' | 'cloneMemory' | 'updateNode' | 'updateNodeProperties' | 'moveNode' | 'cloneNode' | 'mergeNodes' | 'deleteNode' | 'searchReplaceInNodes' | 'restoreNodeRevision' | 'updateTeamRole' | 'deleteTeamRole' | 'encryptMemory' | 'cleanupAnonymousMemories' | 'deleteMemory' | 'approveNode' | 'approveMemoryNodes' | 'requestNodeSignature' | 'withdrawSigningRequest' | 'deleteNodeRevision' | 'clearNodeHistory' | 'cancelFirstPasskey' | 'endWindowEarly' | 'finishRevoke';
async function qualificationAct(surface: QualificationSurface): Promise<{
  run: (database: typeof db) => Promise<unknown>;
  check: (value: unknown) => void;
}> {
  if (surface === 'createMemoryReclaim' || surface === 'createAppReclaim' || surface === 'createAgentMemoryReclaim' || surface === 'createMemoryInAppReclaim' || surface === 'repairMemoryReclaim') {
    const memory = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    const old = await db.node.create({ data: { memoryId, loc: 'reclaimed-source', name: 'Old', content: '# Old retained source' } });
    await db.nodeRevision.create({ data: { nodeId: old.id, memoryId, loc: old.loc, name: old.name, content: '# Old history', revNo: 0 } });
    if (surface === 'createAgentMemoryReclaim') {
      await db.memory.update({ where: { id: memoryId }, data: { urn: 'qualification-fence.example:reclaimed-agent-system', deletedAt: new Date() } });
      return { run: (database) => resolvers.Mutation.createAgent(null, { orgId: memory.organizationId!, name: 'Reclaimed agent' }, { ...ctx(), db: database }), check: (value) => expect(value).toMatchObject({ urn: 'qualification-fence.example:reclaimed-agent' }) };
    }
    if (surface === 'createMemoryInAppReclaim') {
      await db.memory.update({ where: { id: memoryId }, data: { deletedAt: new Date() } });
      const agent = await db.agent.create({ data: { organizationId: memory.organizationId, name: 'Installed', urn: 'qualification-fence.example:installed' } });
      const app = await db.app.create({ data: { organizationId: memory.organizationId, name: 'Installed', urn: 'qualification-fence.example:installed-app' } });
      await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
      await db.agentOrgGrant.create({ data: { orgId: memory.organizationId!, agentId: agent.id, activatedAt: new Date() } });
      return { run: (database) => resolvers.Mutation.createMemoryInApp(null, { appRef: app.id, agentRef: agent.id, memoryClass: 'app', name: 'mem' }, { ...ctx(), db: database }), check: (value) => expect(value).toMatchObject({ urn: 'qualification-fence.example:mem' }) };
    }
    if (surface === 'repairMemoryReclaim') {
      await db.memory.update({ where: { id: memoryId }, data: { urn: 'qualification-fence.example:repair-agent-system', deletedAt: new Date() } });
      const org = await db.organization.create({ data: { urn: 'foreign-qualification.example', name: 'Foreign' } });
      const foreign = await db.memory.create({ data: { organizationId: org.id, class: 'system', urn: 'foreign-qualification.example:repair-source', name: 'Mismatched' } });
      const agent = await db.agent.create({ data: { organizationId: memory.organizationId, systemMemoryId: foreign.id, name: 'Repair', urn: 'qualification-fence.example:repair-agent' } });
      return { run: (database) => resolvers.Mutation.repairAgentSystemMemory(null, { agentRef: agent.id }, { ...ctx(), db: database }), check: (value) => expect(value).toMatchObject({ urn: agent.urn }) };
    }
    if (surface === 'createMemoryReclaim') {
      await db.memory.update({ where: { id: memoryId }, data: { deletedAt: new Date() } });
      return { run: (database) => resolvers.Mutation.createMemory(null, { orgId: memory.organizationId!, name: 'mem' }, { ...ctx(), db: database }), check: (value) => expect(value).toMatchObject({ urn: 'qualification-fence.example:mem' }) };
    }
    const app = await db.app.create({ data: { organizationId: memory.organizationId, name: 'Reclaimed app', urn: 'qualification-fence.example:reclaimed-app', deletedAt: new Date() } });
    await db.memory.update({ where: { id: memoryId }, data: { class: 'app', appId: app.id } });
    const agent = await db.agent.create({ data: { organizationId: memory.organizationId, name: 'Installer', urn: 'qualification-fence.example:installer' } });
    return { run: (database) => resolvers.Mutation.createApp(null, { orgRef: memory.organizationId!, agentRef: agent.id, name: 'Reclaimed app' }, { ...ctx(), db: database }), check: (value) => expect(value).toMatchObject({ urn: 'qualification-fence.example:reclaimed-app' }) };
  }
  if (surface === 'updateTeamRole' || surface === 'deleteTeamRole') {
    const memory = await db.memory.update({ where: { id: memoryId }, data: { class: 'system' } });
    const agent = await db.agent.create({ data: { organizationId: memory.organizationId, systemMemoryId: memory.id, name: 'Team', urn: 'qualification-fence.example:role-agent' } });
    const app = await db.app.create({ data: { organizationId: memory.organizationId, name: 'Team App', urn: 'qualification-fence.example:role-app' } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    await db.node.create({ data: { memoryId, loc: 'roles:qa', name: 'QA', description: 'Before', data: {} } });
    return surface === 'updateTeamRole'
      ? { run: (database) => resolvers.Mutation.updateTeamRole(null, { appRef: app.id, role: 'qa', description: 'After' }, { ...ctx(), db: database }), check: (value) => expect(value).toMatchObject({ role: 'qa', description: 'After' }) }
      : { run: (database) => resolvers.Mutation.deleteTeamRole(null, { appRef: app.id, role: 'qa' }, { ...ctx(), db: database }), check: (value) => expect(value).toMatchObject({ role: 'qa', nodesDeleted: 1 }) };
  }
  if (surface === 'encryptMemory') {
    await db.memory.update({ where: { id: memoryId }, data: { class: 'private', userId } });
    await db.node.create({ data: { memoryId, loc: 'encrypt-source', name: 'Encrypt source', content: '# Plaintext before flip' } });
    return { run: (database) => resolvers.Mutation.encryptMemory(null, { memoryId, dataKey: Buffer.alloc(32, 7).toString('base64') }, { ...ctx(), db: database }), check: (value) => expect(value).toMatchObject({ isEncrypted: true }) };
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
  if (surface === 'cloneMemoryReclaim' || surface === 'extractReclaim') {
    const source = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    const target = await db.memory.create({ data: { organizationId: source.organizationId, class: 'knowledge', name: 'Tombstone', urn: `qualification-fence.example:${surface === 'cloneMemoryReclaim' ? 'copy' : 'extracted'}`, deletedAt: new Date() } });
    const old = await db.node.create({ data: { memoryId: target.id, loc: 'old', name: 'Old', content: '# Retained old source' } });
    await db.nodeRevision.create({ data: { nodeId: old.id, memoryId: target.id, loc: old.loc, name: old.name, content: '# Retained old history', revNo: 0 } });
  }
  if (surface === 'reserveSpecCitation') {
    await db.memory.update({ where: { id: memoryId }, data: { corpusDraft: true } });
    return { run: (database) => resolvers.Mutation.reserveSpecCitation(null, { memoryRef: memoryId, loc: 'pas:010:01' }, { ...ctx(), db: database }), check: (value) => expect(value).toMatchObject({ isPlaceholder: true }) };
  }
  if (surface === 'specReplace') {
    await db.memory.update({ where: { id: memoryId }, data: { corpusDraft: true } });
    await db.node.update({ where: { id: node.id }, data: { role: 'spec', revisionContentHash: revisionStateHashRefreshMarker() } });
    const input = { memoryRef: memoryId, nodeIds: [node.id], oldText: 'Inverse', newText: 'Spec', fields: ['content'], dryRun: true };
    const preview = await resolvers.Mutation.searchReplaceInSpecNodes(null, { input } as never, ctx());
    return { run: (database) => resolvers.Mutation.searchReplaceInSpecNodes(null, { input: { ...input, dryRun: false, expectedPlan: preview.plan } } as never, { ...ctx(), db: database }), check: (value) => expect(value).toMatchObject({ nodesChanged: 1 }) };
  }
  if (surface === 'mergeMemories') {
    const source = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    const target = await db.memory.create({ data: { organizationId: source.organizationId, class: 'knowledge', urn: 'qualification-fence.example:merged-memory', name: 'Target' } });
    await db.node.create({ data: { memoryId: target.id, loc: node.loc, name: 'Target', content: '# Target' } });
    return { run: (database) => resolvers.Mutation.mergeMemories(null, { input: { source: memoryId, target: target.id, include: ['CONTENT'], deleteSourceMem: true } }, { ...ctx(), db: database }), check: (value) => expect(value).toMatchObject({ id: target.id }) };
  }
  if (surface === 'extractCopy' || surface === 'extractMove' || surface === 'extractReclaim') {
    if (surface === 'extractMove') await db.node.create({ data: { memoryId, loc: 'survivor', name: 'Survivor', content: '# Stays' } });
    return { run: (database) => resolvers.Mutation.extractParentNodeToMemory(null, { parentRef: node.id, targetUrn: 'qualification-fence.example::extracted', move: surface === 'extractMove' }, { ...ctx(), db: database }), check: (value) => expect(value).toMatchObject({ urn: 'qualification-fence.example:extracted' }) };
  }
  if (surface === 'cloneMemory' || surface === 'cloneMemoryReclaim') return { run: (database) => resolvers.Mutation.cloneMemory(null, { ref: memoryId, targetUrn: 'qualification-fence.example::copy' }, { ...ctx(), db: database }), check: (value) => expect(value).toMatchObject({ urn: 'qualification-fence.example:copy' }) };
  if (surface === 'updateNode') return { run: (database) => resolvers.Mutation.updateNode(null, { input: { id: node.id, content: '# Changed' } }, { ...ctx(), db: database }), check: (value) => expect(value).toMatchObject({ id: node.id, content: '# Changed' }) };
  if (surface === 'updateNodeProperties') return { run: (database) => resolvers.Mutation.updateNodeProperties(null, { nodeRef: node.id, properties: { checked: true } }, { ...ctx(), db: database }), check: (value) => expect(value).toMatchObject({ id: node.id, properties: { checked: true } }) };
  if (surface === 'moveNode' || surface === 'cloneNode') return { run: (database) => resolvers.Mutation[surface](null, { sourceRef: node.id, targetUrn: 'hrn:node:qualification-fence.example:mem:relocated' }, { ...ctx(), db: database }), check: (value) => expect(value).toMatchObject({ loc: 'relocated', content: '# Inverse' }) };
  if (surface === 'mergeNodes') {
    const target = await db.node.create({ data: { memoryId, loc: 'merge-target', name: 'Target', content: '# Target' } });
    return { run: (database) => resolvers.Mutation.mergeNodes(null, { input: { source: node.id, target: target.id, include: ['CONTENT'], deleteSource: true } }, { ...ctx(), db: database }), check: (value) => expect(value).toMatchObject({ id: target.id, content: '# Target\n\n# Inverse' }) };
  }
  if (surface === 'deleteNode') return { run: (database) => resolvers.Mutation.deleteNode(null, { nodeRef: node.id, hard: true }, { ...ctx(), db: database }), check: (value) => expect(value).toBe(true) };
  if (surface === 'searchReplaceInNodes') return { run: (database) => resolvers.Mutation.searchReplaceInNodes(null, { input: { oldText: 'Inverse', newText: 'Bulk', nodeIds: [node.id], fields: ['content'] } }, { ...ctx(), db: database }), check: (value) => expect(value).toMatchObject({ nodesChanged: 1 }) };
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
  if (surface === 'restoreNodeRevision') return { run: (database) => resolvers.Mutation.restoreNodeRevision(null, { revisionId: revision.id }, { ...ctx(), db: database }), check: (value) => expect(value).toMatchObject({ content: '# Before' }) };
  return surface === 'deleteNodeRevision'
    ? { run: (database) => resolvers.Mutation.deleteNodeRevision(null, { revisionId: revision.id }, { ...ctx(), db: database }), check: (value) => expect(value).toBe(true) }
    : { run: (database) => resolvers.Mutation.clearNodeHistory(null, { nodeRef: node.id }, { ...ctx(), db: database }), check: (value) => expect(value).toBe(1) };
}

it.each<QualificationSurface>(['approveNode', 'approveMemoryNodes', 'requestNodeSignature', 'withdrawSigningRequest', 'deleteNodeRevision', 'clearNodeHistory', 'cancelFirstPasskey', 'endWindowEarly', 'finishRevoke', 'deleteMemory', 'cleanupAnonymousMemories', 'encryptMemory', 'updateTeamRole', 'deleteTeamRole', 'restoreNodeRevision', 'updateNode', 'updateNodeProperties', 'moveNode', 'cloneNode', 'mergeNodes', 'deleteNode', 'searchReplaceInNodes', 'cloneMemory', 'extractCopy', 'extractMove', 'mergeMemories', 'specReplace', 'reserveSpecCitation', 'createMemoryReclaim', 'cloneMemoryReclaim', 'extractReclaim', 'createAppReclaim', 'createAgentMemoryReclaim', 'createMemoryInAppReclaim', 'repairMemoryReclaim'])(
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

it.each(['updateNode', 'deleteNode', 'approveNode', 'clearNodeHistory', 'encryptMemory', 'restoreNodeRevision', 'cloneNode', 'mergeNodes', 'searchReplaceInNodes', 'cloneMemory', 'extractCopy', 'extractMove', 'reserveSpecCitation'] as const)(
  '%s refuses a credential revoked while waiting on the history fence without changing source or history', async (surface) => {
    const node = await db.node.create({ data: { memoryId, loc: 'revoked-writer', name: 'Original', content: '# Original' } });
    if (surface === 'reserveSpecCitation') await db.memory.update({ where: { id: memoryId }, data: { corpusDraft: true } });
    if (surface === 'encryptMemory') await db.memory.update({ where: { id: memoryId }, data: { class: 'private', userId } });
    const key = await db.userApiKey.create({ data: { userId, keyHash: `qualification-${surface}`, keyPreview: 'test', oauthScopes: [] } });
    const snapshot = surface === 'restoreNodeRevision' ? await db.nodeRevision.create({ data: { nodeId: node.id, memoryId, loc: node.loc, name: 'History', content: '# History', revNo: 0 } }) : null;
    const mergeTarget = surface === 'mergeNodes' ? await db.node.create({ data: { memoryId, loc: 'revoked-merge-target', name: 'Target', content: '# Target' } }) : null;
    if (surface === 'extractMove') await db.node.create({ data: { memoryId, loc: 'survivor', name: 'Survivor', content: '# Stays' } });
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
            : surface === 'restoreNodeRevision' ? resolvers.Mutation.restoreNodeRevision(null, { revisionId: snapshot!.id }, context)
              : surface === 'reserveSpecCitation' ? resolvers.Mutation.reserveSpecCitation(null, { memoryRef: memoryId, loc: 'pas:revoked' }, context)
              : surface === 'cloneMemory' ? resolvers.Mutation.cloneMemory(null, { ref: memoryId, targetUrn: 'qualification-fence.example::revoked-memory' }, context)
                : surface === 'extractCopy' || surface === 'extractMove' ? resolvers.Mutation.extractParentNodeToMemory(null, { parentRef: node.id, targetUrn: 'qualification-fence.example::revoked-extract', move: surface === 'extractMove' }, context)
                  : surface === 'cloneNode' ? resolvers.Mutation.cloneNode(null, { sourceRef: node.id, targetUrn: 'hrn:node:qualification-fence.example:mem:revoked-clone' }, context)
                : surface === 'mergeNodes' ? resolvers.Mutation.mergeNodes(null, { input: { source: node.id, target: mergeTarget!.id, deleteSource: true } }, context)
                  : surface === 'searchReplaceInNodes' ? resolvers.Mutation.searchReplaceInNodes(null, { input: { oldText: 'Original', newText: 'Changed', nodeIds: [node.id], fields: ['content'] } }, context)
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
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(surface === 'restoreNodeRevision' ? 1 : 0);
    if (surface === 'encryptMemory') expect((await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).isEncrypted).toBe(false);
    if (mergeTarget) expect((await db.node.findUniqueOrThrow({ where: { id: mergeTarget.id } })).content).toBe('# Target');
    if (surface === 'cloneNode') expect(await db.node.findFirst({ where: { memoryId, loc: 'revoked-clone' } })).toBeNull();
    if (surface === 'reserveSpecCitation') expect(await db.node.findFirst({ where: { memoryId, loc: 'pas:revoked' } })).toBeNull();
    if (surface === 'cloneMemory') expect(await db.memory.findUnique({ where: { urn: 'qualification-fence.example:revoked-memory' } })).toBeNull();
    if (surface === 'extractCopy' || surface === 'extractMove') expect(await db.memory.findUnique({ where: { urn: 'qualification-fence.example:revoked-extract' } })).toBeNull();
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


it.each<QualificationSurface>(['updateNode', 'updateNodeProperties', 'moveNode', 'cloneNode', 'mergeNodes', 'deleteNode', 'searchReplaceInNodes', 'cloneMemory', 'extractCopy', 'extractMove', 'mergeMemories', 'specReplace', 'reserveSpecCitation', 'createMemoryReclaim', 'cloneMemoryReclaim', 'extractReclaim', 'createAppReclaim', 'createAgentMemoryReclaim', 'createMemoryInAppReclaim', 'repairMemoryReclaim'])(
  '%s waits on the history fence before its actual snapshot/source row locks', async (surface) => {
    const act = await qualificationAct(surface);
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
        await tx.$queryRaw`SELECT id FROM nodes WHERE memory_id = ${memoryId} ORDER BY id FOR UPDATE NOWAIT`;
      });
    } finally { release(); await holder; await outcome; }
    act.check(await pending);
  },
);


it('a copy authorization callback reuses only the same live prepared client', async () => {
  await withIncludeHistoryTransaction(db, async (proof) => {
    const outer = includeHistoryClient(proof);
    const result = await withAuthorizedMemoryTx(ctx(), memoryId, [], async () => {}, async (tx, fresh) => {
      expect(tx).toBe(outer);
      expect(fresh.db).toBe(outer);
      return tx.memory.count({ where: { id: memoryId } });
    }, { preparedTransaction: outer });
    expect(result).toBe(1);
  });
  let ran = false;
  await expect(db.$transaction((tx) => withAuthorizedMemoryTx(ctx(), memoryId, [], async () => { ran = true; }, async () => true, { preparedTransaction: tx }))).rejects.toThrow('prepared include-history client');
  expect(ran).toBe(false);
});

it('a prepared authorization scope change refuses without retrying under held anchors', async () => {
  let ownerReads = 0;
  let authorized = false;
  const staleOwnerDb = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'memory') return Reflect.get(target, property, receiver);
      return new Proxy(target.memory, {
        get(model, key, modelReceiver) {
          if (key !== 'findUnique') return Reflect.get(model, key, modelReceiver);
          return async () => { ownerReads++; return { organizationId: null, ownerUserId: null, userId: null }; };
        },
      });
    },
  });
  await expect(withIncludeHistoryTransaction(db, (proof) => withAuthorizedMemoryTx(
    { ...ctx(), db: staleOwnerDb }, memoryId, [],
    async () => { authorized = true; }, async () => { throw new Error('must not write'); },
    { preparedTransaction: includeHistoryClient(proof) },
  ))).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' }, message: 'Memory ownership changed; retry the operation' });
  expect(ownerReads).toBe(1);
  expect(authorized).toBe(false);
});

it('every encryption conversion root takes authority anchors before Memory rows', async () => {
  const act = await qualificationAct('encryptMemory');
  const transactions: Array<Array<{ sql: string; values: unknown[] }>> = [];
  const transaction = db.$transaction.bind(db);
  const recordedDb = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== '$transaction') return Reflect.get(target, property, receiver);
      return (work: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<unknown>, options: unknown) => transaction(async (tx) => {
        const events: Array<{ sql: string; values: unknown[] }> = [];
        transactions.push(events);
        const recorded = new Proxy(tx, {
          get(client, method, recv) {
            if (method !== '$queryRaw' && method !== '$executeRaw') return Reflect.get(client, method, recv);
            return (strings: TemplateStringsArray, ...values: unknown[]) => {
              events.push({ sql: strings.join('?'), values });
              return (client[method] as (...args: unknown[]) => unknown).call(client, strings, ...values);
            };
          },
        });
        return work(recorded);
      }, options as never);
    },
  });
  act.check(await act.run(recordedDb));
  expect(transactions.length).toBeGreaterThanOrEqual(2);
  for (const events of transactions) expect(events[0].sql).toContain('pg_advisory_xact_lock(2063, 1772)');
  for (const events of transactions) {
    const authority = events.findIndex((event) => event.values.includes('authorization:user'));
    const memoryRow = events.findIndex((event) => event.sql.includes('FROM memories') && event.sql.includes('FOR '));
    expect(authority).toBeGreaterThan(0);
    expect(memoryRow).toBeGreaterThan(authority);
  }
});

it('final memory-merge disposition takes Channel keys before strong Memory locks, without a prior SHARE upgrade', async () => {
  const act = await qualificationAct('mergeMemories');
  const target = await db.memory.findUniqueOrThrow({ where: { urn: 'qualification-fence.example:merged-memory' } });
  const transactions: Array<Array<{ sql: string; values: unknown[] }>> = [];
  const transaction = db.$transaction.bind(db);
  const recordedDb = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== '$transaction') return Reflect.get(target, property, receiver);
      return (work: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<unknown>, options: unknown) => transaction(async (tx) => {
        const events: Array<{ sql: string; values: unknown[] }> = [];
        transactions.push(events);
        const recorded = new Proxy(tx, {
          get(client, method, recv) {
            if (method !== '$queryRaw' && method !== '$executeRaw') return Reflect.get(client, method, recv);
            return (strings: TemplateStringsArray, ...values: unknown[]) => {
              events.push({ sql: strings.join('?'), values });
              return (client[method] as (...args: unknown[]) => unknown).call(client, strings, ...values);
            };
          },
        });
        return work(recorded);
      }, options as never);
    },
  });
  act.check(await act.run(recordedDb));
  expect(transactions.length).toBeGreaterThanOrEqual(2);
  for (const events of transactions) expect(events[0].sql).toContain('pg_advisory_xact_lock(2063, 1772)');
  const final = transactions.at(-1)!;
  const sourceLock = final.findIndex((event) => event.sql.includes('FROM memories') && event.sql.includes('FOR ') && event.values.includes(memoryId));
  const targetLock = final.findIndex((event) => event.sql.includes('FROM memories') && event.sql.includes('FOR ') && event.values.includes(target.id));
  expect(sourceLock).toBeGreaterThan(0);
  expect(targetLock).toBeGreaterThan(0);
  expect(final[sourceLock].sql).toContain('FOR UPDATE');
  expect(final[targetLock].sql).toContain('FOR NO KEY UPDATE');
  for (const id of [memoryId, target.id]) {
    const key = final.findIndex((event) => event.values.includes(`channel-host:${id}`));
    expect(key).toBeGreaterThan(0);
    expect(key).toBeLessThan(Math.min(sourceLock, targetLock));
  }
  expect((await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).deletedAt).not.toBeNull();
});

import { MERGE_BATCH_SIZE } from '../../controller/operations/mergeMemories.js';
import { generateId } from '../id.js';
it('memory merge rechecks the presented key between committed batches and preserves its partial receipt', async () => {
  const source = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
  const target = await db.memory.create({ data: { organizationId: source.organizationId, class: 'knowledge', urn: 'qualification-fence.example:partial-target', name: 'Target' } });
  await db.node.createMany({ data: Array.from({ length: MERGE_BATCH_SIZE + 1 }, (_, i) => ({ id: generateId(), memoryId, loc: `batch-${i}`, name: `Node ${i}`, content: '# Source' })) });
  const key = await db.userApiKey.create({ data: { userId, keyHash: generateId(), keyPreview: 'partial', oauthScopes: [] } });
  const transaction = db.$transaction.bind(db);
  let revoked = false;
  const pausedDb = new Proxy(db, {
    get(client, property, receiver) {
      if (property !== '$transaction') return Reflect.get(client, property, receiver);
      return async (work: never, options: never) => {
        const result = await transaction(work, options);
        if (!revoked) {
          revoked = true;
          await resolvers.Mutation.revokeUserApiKey(null, { id: key.id }, ctx());
        }
        return result;
      };
    },
  });
  const pending = resolvers.Mutation.mergeMemories(null, { input: { source: memoryId, target: target.id, include: ['CONTENT'], deleteSourceMem: true } }, { ...ctx(), db: pausedDb, apiKeyId: key.id });
  await expect(pending).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN', partialMerge: { applied: true, relocated: MERGE_BATCH_SIZE, remainingSourceNodes: 1, sourceIntact: true } } });
  expect(revoked).toBe(true);
  expect(await db.node.count({ where: { memoryId: target.id, deletedAt: null } })).toBe(MERGE_BATCH_SIZE);
  expect(await db.node.count({ where: { memoryId, deletedAt: null } })).toBe(1);
  expect((await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).deletedAt).toBeNull();
}, 30_000);

it('encryption conversion rechecks a credential revoked after the flag-flip transaction', async () => {
  await db.memory.update({ where: { id: memoryId }, data: { class: 'private', userId } });
  const node = await db.node.create({ data: { memoryId, loc: 'conversion', name: 'Conversion', content: '# Plaintext' } });
  const key = await db.userApiKey.create({ data: { userId, keyHash: generateId(), keyPreview: 'conversion', oauthScopes: [] } });
  const transaction = db.$transaction.bind(db);
  let revoked = false;
  const pausedDb = new Proxy(db, {
    get(client, property, receiver) {
      if (property !== '$transaction') return Reflect.get(client, property, receiver);
      return async (work: never, options: never) => {
        const result = await transaction(work, options);
        if (!revoked) {
          revoked = true;
          await resolvers.Mutation.revokeUserApiKey(null, { id: key.id }, ctx());
        }
        return result;
      };
    },
  });
  await expect(resolvers.Mutation.encryptMemory(null, { memoryId, dataKey: Buffer.alloc(32, 7).toString('base64') }, { ...ctx(), db: pausedDb, apiKeyId: key.id })).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  expect(revoked).toBe(true);
  expect((await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).isEncrypted).toBe(true);
  expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).content).toBe('# Plaintext');
  expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(0);
});


it.each(['createMemoryReclaim', 'cloneMemoryReclaim', 'extractReclaim', 'createAppReclaim', 'createAgentMemoryReclaim', 'createMemoryInAppReclaim', 'repairMemoryReclaim'] as const)(
  '%s refuses a revoked credential before destroying retained history', async (surface) => {
    const act = await qualificationAct(surface);
    const nodes = await db.node.findMany({ select: { id: true, memoryId: true, content: true }, orderBy: { id: 'asc' } });
    const history = await db.nodeRevision.findMany({ select: { id: true, nodeId: true, content: true }, orderBy: { id: 'asc' } });
    const key = await db.userApiKey.create({ data: { userId, keyHash: generateId(), keyPreview: 'reclaim', oauthScopes: [] } });
    presentedKeyId = key.id;
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = withIncludeHistoryTransaction(db, async () => { entered(); await gate; });
    await ready;
    const pending = act.run(db);
    const result = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1, 1000);
      await db.userApiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    } finally { release(); await holder; }
    expect(await result).toMatchObject({ error: { extensions: { code: 'FORBIDDEN' } } });
    expect(await db.node.findMany({ where: { id: { in: nodes.map((row) => row.id) } }, select: { id: true, memoryId: true, content: true }, orderBy: { id: 'asc' } })).toEqual(nodes);
    expect(await db.nodeRevision.findMany({ where: { id: { in: history.map((row) => row.id) } }, select: { id: true, nodeId: true, content: true }, orderBy: { id: 'asc' } })).toEqual(history);
  },
);

it.each(['createMemoryReclaim', 'createAppReclaim'] as const)(
  '%s rechecks revoked org authority after its fence wait, preserving tombstones and history', async (surface) => {
    const act = await qualificationAct(surface);
    // Use org authority, without the platform-admin shortcut.
    requestRoles = ['READER'];
    await db.user.update({ where: { id: userId }, data: { roles: ['READER'] } });
    const memories = await db.memory.findMany({ select: { id: true, urn: true, deletedAt: true }, orderBy: { id: 'asc' } });
    const nodes = await db.node.findMany({ select: { id: true, memoryId: true, content: true }, orderBy: { id: 'asc' } });
    const history = await db.nodeRevision.findMany({ select: { id: true, nodeId: true, content: true }, orderBy: { id: 'asc' } });
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = withIncludeHistoryTransaction(db, async () => { entered(); await gate; });
    await ready;
    const result = act.run(db).then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1, 1000);
      await db.orgMember.updateMany({ where: { userId, deletedAt: null }, data: { deletedAt: new Date() } });
    } finally { release(); await holder; }
    expect(await result).toMatchObject({ error: { extensions: { code: 'FORBIDDEN' } } });
    expect(await db.memory.findMany({ select: { id: true, urn: true, deletedAt: true }, orderBy: { id: 'asc' } })).toEqual(memories);
    expect(await db.node.findMany({ select: { id: true, memoryId: true, content: true }, orderBy: { id: 'asc' } })).toEqual(nodes);
    expect(await db.nodeRevision.findMany({ select: { id: true, nodeId: true, content: true }, orderBy: { id: 'asc' } })).toEqual(history);
  },
);
