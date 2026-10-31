import { WORKER_SIGNATURE_DEFAULTS } from '../../src/lib/workerSignature.js';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { PrismaClient } from '../../src/generated/prisma/index.js';
import { computeApprovalHash } from '../../src/lib/approvalHash.js';
import { ensureCurrentNodeRevisionInTransaction } from '../../src/lib/nodeRevisionSnapshot.js';
import { resolveServedBootPrompt } from '../../src/lib/bootPrompt/serve.js';
import { seedE2eBootPrompt, E2E_BOOT_PROMPT } from '../../src/test/e2eBootPrompt.js';

// Separate from the narrative dev seed: every principal has global READER
// except the org-less platform-admin fixture, so org-role journeys exercise
// tenant gates rather than platform ADMIN.
import { users, orgs, workerNames, checkDocumentInventory } from './catalog.js';
import { provisionSignIns, disconnectSignInDb } from './provision-signins.js';
const classes = ['knowledge', 'group', 'personal', 'private', 'app', 'system'] as const;
const id = (name: string) => createHash('sha256').update(`hadron-e2e:${name}`).digest('hex').slice(0, 32);
const db = new PrismaClient();
const credentials: Record<string, string> = {};
const date = new Date('2026-01-01T00:00:00Z');
function key(prefix: string) {
  const raw = prefix + randomBytes(32).toString('hex');
  return { raw, keyHash: createHash('sha256').update(raw).digest('hex'), keyPreview: raw.slice(-4) };
}
async function node(memoryId: string, loc: string, extra: Record<string, unknown> = {}) {
  return db.node.create({ data: { id: id(`${memoryId}:${loc}`), memoryId, loc,
    name: loc, content: `Synthetic E2E fixture: ${loc}.`, tags: ['e2e'], ...extra } });
}
async function seed() {
  assert.equal(process.env.E2E_SEED, 'true', 'Seed is restricted to the E2E compose environment');
  const url = new URL(process.env.DATABASE_URL!);
  assert.equal(url.hostname, 'db');
  assert.equal(url.pathname, '/e2e');
  assert.equal(await db.user.count(), 0, 'Fresh DB required; use scoped down, then up');
  for (const [handle, fixture] of Object.entries(users)) {
    if (fixture.signup) continue;
    await db.user.create({ data: { id: id(handle), handle, name: `${handle} (synthetic)`,
      email: `${handle}@e2e.test`, identityProvider: fixture.provider ?? 'EMAIL', roles: fixture.roles ?? ['READER'] } });
  }
  const signIns = await provisionSignIns(db);
  const principals: Record<string, { id: string; handle: string; provider: string | null; signIn: { path: string; isNew?: boolean } }> = {};
  for (const [handle, fixture] of Object.entries(users)) {
    const user = await db.user.findUniqueOrThrow({ where: { email: `${handle}@e2e.test` } });
    const { raw, ...hash } = key('hdr_user_');
    await db.userApiKey.create({ data: { id: id(`${handle}:key`), userId: user.id,
      ...hash, oauthScopes: [], label: 'Disposable E2E', issuedVia: 'portal', createdBy: user.id } });
    credentials[handle] = raw;
    principals[handle] = { id: user.id, handle: user.handle, provider: user.identityProvider,
      signIn: signIns[handle] ?? { path: 'seeded-existing-user' } };
  }
  writeFileSync('/fixtures/principals.json', JSON.stringify(principals, null, 2) + '\n', { mode: 0o600 });
  for (const org of orgs) {
    const organizationId = id(org);
    const owner = id(org === 'e2e-alpha' ? 'alpha-admin' : 'beta-admin');
    await db.organization.create({ data: { id: organizationId, urn: org, name: org } });
    for (const [handle, fixture] of Object.entries(users)) {
      for (const membership of fixture.memberships) {
        const [root, role] = membership.split(':');
        if (root === org) await db.orgMember.create({ data: {
          id: id(`${org}:${handle}`), organizationId, userId: principals[handle].id,
          role: role as 'OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER' } });
      }
    }
    const appId = id(`${org}:team`);
    await db.app.create({ data: { id: appId, organizationId, urn: `${org}:team`,
      name: `${org} team`, surfaces: ['chat', 'web'], createdBy: owner } });
    const { raw, ...hash } = key('hdr_app_');
    await db.appKey.create({ data: { id: id(`${org}:app-key`), appId, ...hash, label: 'Disposable E2E' } });
    credentials[`${org}:team`] = raw;
    for (const [handle, fixture] of Object.entries(users)) {
      if (fixture.apps?.includes(`${org}:team`)) {
        await db.appMember.create({ data: { appId, userId: principals[handle].id, role: principals[handle].id === owner ? 'admin' : 'member' } });
      }
    }
    const memoryIds: Record<string, string> = {};
    for (const cls of classes) {
      const memoryId = id(`${org}:${cls}`);
      memoryIds[cls] = memoryId;
      await db.memory.create({ data: { id: memoryId, organizationId,
        urn: `${org}:${cls}`, name: `${org} ${cls}`, class: cls,
        visibility: cls === 'knowledge' ? 'ORGANIZATION' : cls === 'group' ? 'GROUP' : null,
        appId: cls === 'app' ? appId : null,
        userId: cls === 'personal' || cls === 'private' ? owner : null,
        tags: ['e2e'] } });
      await node(memoryId, 'welcome');
      if (cls === 'group') await db.memoryMember.create({ data: {
        memoryId, userId: owner, role: 'owner' } });
    }
    for (const role of ['coordinator', 'qa-engineer'] as const) {
      const agentId = id(`${org}:${role}`);
      await db.agent.create({ data: { id: agentId, organizationId,
        urn: `${org}:${role}`, name: role, personaRole: role,
        systemMemoryId: memoryIds.system, visibility: 'ORGANIZATION' } });
      await db.appAgent.create({ data: { appId, agentId } });
      // #2712: no literal prompt and no serving switch any more, so a stock Agent binds only with an approved compiled prompt.
      await seedE2eBootPrompt(db, { agentId, memoryId: memoryIds.system, slot: role, approvedAt: date,
        idFor: part => id(`${org}:${role}:boot-${part}`) });
      await db.agentMemoryItem.create({ data: { id: id(`${org}:${role}:item`),
        agentId, memoryId: memoryIds.app, role: 'read' } });
      const workerMemoryId = id(`${org}:${role}:worker-memory`);
      await db.memory.create({ data: { id: workerMemoryId, organizationId, appId,
        urn: `${org}:${role}-working`, name: `${role} working`, class: 'app', tags: ['e2e'] } });
      await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: id(`${org}:${role}:worker`), appId, agentId,
        name: workerNames[role],
        slug: role === 'coordinator' ? 'test-coordinator' : 'test-reviewer', role, memoryId: workerMemoryId } });
    }
    const root = await node(memoryIds.app, 'chats:team', { nodeType: 'chat', data: { lastSeq: 0 } });
    const channel = await db.channel.create({ data: { id: id(`${org}:channel`), memoryId: memoryIds.app,
      loc: 'chats:team', name: 'Team', chatRootNodeId: root.id } });
    await db.app.update({ where: { id: appId }, data: { defaultChannelId: channel.id } });
    await node(memoryIds.app, 'tasks:check-stack', { nodeType: 'task', isRunnable: true,
      content: 'Read the welcome fixture and report which disposable organization it belongs to.' });
    const specsId = id(`${org}:specs`);
    await db.memory.create({ data: { id: specsId, organizationId, urn: `${org}:specs`,
      name: `${org} specs`, class: 'knowledge', visibility: 'ORGANIZATION', tags: ['e2e'] } });
    const config = await db.memoryConfig.create({ data: { id: id(`${org}:config`), memoryId: specsId } });
    await db.nodeRoleRule.create({ data: { id: id(`${org}:spec-rule`), configId: config.id,
      role: 'spec.rule', writers: 'ADMIN', locked: true } });
    for (const loc of ['rule:001', 'rule:002']) {
      const name = `Rule: Synthetic fixture [${loc}]`;
      const content = `# Rule Spec: ${loc}\n\nSynthetic fixture for comments on approved and minted knowledge.`;
      const approvalHash = computeApprovalHash({ title: name, abstract: null, content });
      const n = await node(specsId, loc, { name, content, role: 'spec.rule', revSeq: 1,
        approvedRevNo: 1, approvedBy: owner, approvedAt: date, approvalHash,
        mintedAt: date, mintedBy: owner, mintedRevNo: 1, mintedHash: approvalHash });
      await db.$transaction(tx => ensureCurrentNodeRevisionInTransaction(tx, n.id, { expectedMemoryId: specsId }));
    }
  }
  // Org-less strict-owner fixtures, including both free-standing classes.
  for (const handle of ['outsider', 'visitor', 'personal-owner']) {
    for (const cls of handle === 'personal-owner' ? ['personal', 'private'] as const : ['private'] as const) {
      const memoryId = id(`${handle}:${cls}`);
      await db.memory.create({ data: { id: memoryId, ownerUserId: id(handle), userId: id(handle),
        urn: `${handle}:${cls}`, name: `${handle} ${cls}`, class: cls, tags: ['e2e'] } });
      await node(memoryId, 'welcome');
    }
  }
  await check();
  writeFileSync('/fixtures/credentials.json', JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600 });
  console.log('E2E fixture seed complete; inventory checked. Credentials printed by stack up.');
}
async function check() {
  assert.equal(await db.organization.count(), 2);
  assert.equal(await db.user.count(), Object.keys(users).length);
  assert.equal(await db.orgMember.count(), Object.values(users).reduce((count, u) => count + u.memberships.length, 0));
  checkDocumentInventory();
  const principals = JSON.parse(readFileSync('/fixtures/principals.json', 'utf8'));
  assert.equal(principals['fresh-user'].signIn.isNew, true);
  assert.equal(principals['email-code-user'].signIn.path, 'review-demo-code');
  for (const handle of ['google-user', 'apple-user']) assert.equal(principals[handle].signIn.path, `${handle.split('-')[0]}-local-token`);
  for (const [handle, fixture] of Object.entries(users)) {
    const user = await db.user.findUniqueOrThrow({ where: { email: `${handle}@e2e.test` } });
    assert.deepEqual(user.roles, fixture.roles ?? ['READER']);
    assert.equal(user.identityProvider, fixture.provider ?? 'EMAIL');
    if (fixture.provider === 'GOOGLE') assert.equal(user.googleId, 'synthetic-google-subject');
    if (fixture.provider === 'APPLE') assert.equal(user.appleId, 'synthetic-apple-subject');
    const appRows = await db.appMember.findMany({ where: { userId: user.id }, include: { app: true } });
    assert.deepEqual(appRows.map(r => r.app.urn).sort(), [...fixture.apps ?? []].sort());
    assert.equal(user.email, `${handle}@e2e.test`);
    assert.equal(user.id, principals[handle].id);
    assert.equal(user.handle, principals[handle].handle);
    const rows = await db.orgMember.findMany({ where: { userId: user.id } });
    assert.deepEqual(rows.map(r => `${orgs.find(o => id(o) === r.organizationId)}:${r.role}`).sort(), [...fixture.memberships].sort());
    assert.equal(await db.userApiKey.count({ where: { userId: user.id, revokedAt: null } }), 1);
  }
  for (const org of orgs) {
    assert.equal(await db.orgMember.count({ where: { organizationId: id(org), role: 'OWNER' } }), 1);
    for (const cls of classes) {
      const memory = await db.memory.findUniqueOrThrow({ where: { id: id(`${org}:${cls}`) } });
      assert.equal(memory.class, cls);
      assert.equal(memory.appId, cls === 'app' ? id(`${org}:team`) : null);
      assert(await db.node.count({ where: { memoryId: memory.id } }) > 0);
    }
    assert.equal(await db.worker.count({ where: { appId: id(`${org}:team`) } }), 2);
    // Every seeded worker's bind is serveable: the same resolution startSession runs (#2725 local review P2).
    for (const w of await db.worker.findMany({ where: { appId: id(`${org}:team`) }, include: { agent: true } })) {
      const served = await resolveServedBootPrompt(db, { surface: 'bind', appId: w.appId, agent: w.agent, workerId: w.id });
      assert.equal(served.content, E2E_BOOT_PROMPT);
      assert.equal(served.pointerLevel, 'AGENT');
    }
    assert.equal(await db.appKey.count({ where: { appId: id(`${org}:team`) } }), 1);
    const specs = await db.node.findMany({ where: { memoryId: id(`${org}:specs`) } });
    assert.equal(specs.length, 2);
    for (const n of specs) {
      assert.equal(n.approvedRevNo, n.revSeq);
      assert(n.mintedAt);
      assert.equal(n.mintedHash, computeApprovalHash({ title: n.name, abstract: n.abstract, content: n.content }));
      assert.equal(n.approvalHash, n.mintedHash);
    }
    assert.equal(await db.nodeRoleRule.count({ where: { configId: id(`${org}:config`), writers: 'ADMIN', locked: true } }), 1);
  }
  for (const cls of ['personal', 'private']) {
    const memory = await db.memory.findUniqueOrThrow({ where: { id: id(`personal-owner:${cls}`) } });
    assert.equal(memory.class, cls);
    assert.equal(memory.userId, id('personal-owner'));
    assert.equal(memory.ownerUserId, id('personal-owner'));
    assert.equal(memory.organizationId, null);
    assert.equal(memory.appId, null);
  }
  const fresh = await db.user.findUniqueOrThrow({ where: { email: 'fresh-user@e2e.test' } });
  assert.equal(await db.memory.count({ where: { OR: [{ userId: fresh.id }, { ownerUserId: fresh.id }, { createdBy: fresh.id }] } }), 0);
  const indexes = await db.$queryRaw<Array<{ name: string }>>`SELECT indexname AS name FROM pg_indexes WHERE indexname = 'node_embeddings_embedding_hnsw'`;
  assert.equal(indexes.length, 1);
  const columns = await db.$queryRaw<Array<{ name: string }>>`SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'nodes' AND column_name = 'tsv' AND is_generated = 'ALWAYS'`;
  assert.equal(columns.length, 1);
  const constraints = await db.$queryRaw<Array<{ name: string }>>`SELECT conname AS name FROM pg_constraint WHERE conname IN ('chk_personal_visibility_user', 'chk_memory_class_app_id', 'chk_memory_owner_xor')`;
  assert.equal(constraints.length, 3);
  console.log('Fixture inventory and post-push objects PASS');
}
try { await (process.argv.includes('--check') ? check() : seed()); }
finally { await db.$disconnect(); await disconnectSignInDb(); }
