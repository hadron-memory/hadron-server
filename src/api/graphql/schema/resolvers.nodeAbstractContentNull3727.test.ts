/**
 * #3727 / cor:api:210:01 / cor:dmo:020:03 — explicit `abstract:null` /
 * `content:null` CLEAR the nullable string columns on an encrypted memory;
 * omission preserves. Unlocked encrypted GraphQL was the dropped cell: the
 * shared mapping in `writeNodeCoreRaw` (`enc.abstract ?? undefined`) turned
 * an explicit clear into an omission, silently retaining the old ciphertext
 * while the abstract-null still cleared the derived hash.
 *
 * Red on main `dc88d4a618` (verified): every pin marked RED below failed
 * with the old value retained. Cells marked CONTROL pin neighbouring
 * semantics the fix must not move (plain GraphQL, strings, omission,
 * refusals) — they pass on main by design and exist to hold the line.
 */
import { ApolloServer } from '@apollo/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAgentImport, createDbAgentOrgGrant, createDbAppMember } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { parseDataKey } from '../../../lib/crypto.js';
import { computeContentHash } from '../../../lib/contentHash.js';
import { encryptNodeFieldsWithKey, decryptNodeFieldsWithKey } from '../../../lib/nodeCrypto.js';
import { isCiphertext } from '../../../lib/crypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { revisionStateHashRefreshMarker } from '../../../lib/nodeRevisionSnapshot.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../lib/bus/index.js', () => ({
  getBusClient: vi.fn(async () => null),
}));
const server = new ApolloServer<Context>({ typeDefs, resolvers });
beforeAll(() => server.start());
afterAll(() => server.stop());
afterEach(() => sessionKeyCache.clear());
const key = parseDataKey(Buffer.alloc(32, 37).toString('base64'));

let owner: string, outsider: string;
let memory: { id: string; urn: string }, node: { id: string; loc: string };
const OLD_ABSTRACT = 'old abstract worth clearing';
const OLD_CONTENT = 'body with an abstract';

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  owner = (await db.user.create({ data: { handle: `n3727-owner-${generateId()}`, roles: ['READER'] } })).id;
  outsider = (await db.user.create({ data: { handle: `n3727-other-${generateId()}`, roles: ['READER'] } })).id;
  memory = await db.memory.create({
    data: {
      name: 'n3727',
      urn: `n3727-${generateId()}:private`,
      class: 'private',
      userId: owner,
      ownerUserId: owner,
      vectorIndexEnabled: false,
    },
  });
  node = await db.node.create({
    data: {
      id: generateId(),
      memoryId: memory.id,
      loc: 'probe',
      name: 'Before',
      ...plainFields(),
      abstractOriginHash: computeContentHash(OLD_CONTENT),
    } as never,
  });
});
function plainFields() {
  return { content: OLD_CONTENT, abstract: OLD_ABSTRACT };
}
async function encrypted() {
  await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true } });
  await db.node.update({
    where: { id: node.id },
    data: {
      ...encryptNodeFieldsWithKey(plainFields(), key),
      revisionContentHash: revisionStateHashRefreshMarker(),
    } as never,
  });
  sessionKeyCache.set('n3727', memory.id, key);
}
/** The at-rest row, never decrypted: SQL truth, not the logical view. */
async function raw() {
  return db.node.findUniqueOrThrow({ where: { id: node.id } });
}
async function logical() {
  return decryptNodeFieldsWithKey(await raw(), key);
}
async function revisionState() {
  return {
    count: await db.nodeRevision.count({ where: { nodeId: node.id } }),
    revSeq: (await raw()).revSeq,
  };
}
async function gql<T = unknown>(query: string, variables: Record<string, unknown>, userId = owner): Promise<T> {
  const out = await server.executeOperation({ query, variables }, { contextValue: { db, userId, roles: ['READER'] } });
  if (out.body.kind !== 'single') throw new Error('unexpected incremental response');
  if (out.body.singleResult.errors?.length) throw out.body.singleResult.errors[0]!;
  return out.body.singleResult.data as T;
}
async function update(patch: Record<string, unknown>, userId = owner) {
  return gql(
    'mutation($input:UpdateNodeInput!){updateNode(input:$input){id abstract content abstractOriginHash}}',
    { input: { id: node.id, ...patch } },
    userId,
  );
}
async function updateExpectingCode(patch: Record<string, unknown>, userId = owner): Promise<string> {
  const out = await server.executeOperation(
    { query: 'mutation($input:UpdateNodeInput!){updateNode(input:$input){id}}', variables: { input: { id: node.id, ...patch } } },
    { contextValue: { db, userId, roles: ['READER'] } },
  );
  if (out.body.kind !== 'single') throw new Error('unexpected incremental response');
  const code = out.body.singleResult.errors?.[0]?.extensions?.code;
  return typeof code === 'string' ? code : 'NONE';
}

describe('#3727 encrypted update — the changed cell', () => {
  beforeEach(async () => {
    await encrypted();
  });

  it('RED: abstract:null clears the column, the hash and the logical value; the first revision keeps the prior state', async () => {
    await update({ abstract: null });
    const row = await raw();
    expect(row.abstract).toBeNull(); // SQL NULL — no ciphertext, no sentinel
    expect(row.abstractOriginHash).toBeNull(); // cor:dmo:020:03: hash agrees with the cleared abstract
    expect((await logical()).abstract).toBeNull();
    // One revision captured the pre-clear state at rest: the OLD ciphertext.
    const revs = await db.nodeRevision.findMany({ where: { nodeId: node.id } });
    expect(revs).toHaveLength(1);
    expect(revs[0]!.abstract).not.toBeNull();
    expect(isCiphertext(revs[0]!.abstract!)).toBe(true);
    expect(decryptNodeFieldsWithKey({ abstract: revs[0]!.abstract! }, key).abstract).toBe(OLD_ABSTRACT);
  });

  it('RED: content:null clears content while omitted abstract and hash keep their values', async () => {
    const before = await raw();
    await update({ content: null });
    const row = await raw();
    expect(row.content).toBeNull();
    expect((await logical()).content).toBeNull();
    expect(row.abstract).toBe(before.abstract); // omitted abstract preserved at rest
    expect((await logical()).abstract).toBe(OLD_ABSTRACT);
    expect(row.abstractOriginHash).toBe(before.abstractOriginHash); // omitted hash preserved
  });

  it('RED: a repeated identical clear is a true no-op — no revision row, no revSeq bump', async () => {
    await update({ abstract: null });
    const afterFirst = await revisionState();
    expect(afterFirst.count).toBe(1);
    await update({ abstract: null });
    expect(await revisionState()).toEqual(afterFirst);
    expect((await raw()).abstract).toBeNull();
  });

  it('CONTROL: a string abstract stores ciphertext at rest; the hash follows plaintext content', async () => {
    await update({ abstract: 'fresh summary' });
    const row = await raw();
    expect(isCiphertext(row.abstract!)).toBe(true);
    expect((await logical()).abstract).toBe('fresh summary');
    // Abstract-only write: content is unchanged, so the derived hash keeps the
    // seeded value (matrix: a string abstract hashes the CURRENT content).
    expect(row.abstractOriginHash).toBe(computeContentHash(OLD_CONTENT));
    // Recomputation made OBSERVABLE (BLIND on bf3828e9): the assertion above
    // equals the seeded hash and alone cannot tell a recompute from a
    // never-touched hash. Changing content in the same write as an abstract
    // must move the hash to the NEW plaintext's — never-touched would leave
    // the old value, and hashing ciphertext would give anything but this.
    await update({ abstract: 'second summary', content: 'fresh body' });
    const written = await raw();
    expect(written.abstractOriginHash).toBe(computeContentHash('fresh body'));
    // #3752: at rest BOTH columns are ciphertext and both round-trip, so a
    // regression that stored plaintext or dropped a column cannot pass.
    expect(isCiphertext(written.abstract!)).toBe(true);
    expect(isCiphertext(written.content!)).toBe(true);
    expect((await logical()).abstract).toBe('second summary');
    expect((await logical()).content).toBe('fresh body');
  });

  it('RED (#3752): { abstract:null, content:null } in one call clears both columns and the hash', async () => {
    await update({ abstract: null, content: null });
    const row = await raw();
    expect(row.abstract).toBeNull();
    expect(row.content).toBeNull();
    expect(row.abstractOriginHash).toBeNull();
    const l = await logical();
    expect(l.abstract).toBeNull();
    expect(l.content).toBeNull();
  });

  it('RED (#3752): { abstract:null, content:"new body" } clears the abstract and hash, stores the new body as ciphertext', async () => {
    await update({ abstract: null, content: 'new body' });
    const row = await raw();
    expect(row.abstract).toBeNull();
    // A cleared abstract has no origin: the hash goes with it even though the
    // content changed in the same write (cor:dmo:020:03).
    expect(row.abstractOriginHash).toBeNull();
    expect(isCiphertext(row.content!)).toBe(true);
    expect((await logical()).content).toBe('new body');
  });

  it('RED (#3752): { content:null, abstract:"kept" } clears content, stores the abstract as ciphertext', async () => {
    await update({ content: null, abstract: 'kept summary' });
    const row = await raw();
    expect(row.content).toBeNull();
    expect(isCiphertext(row.abstract!)).toBe(true);
    expect((await logical()).abstract).toBe('kept summary');
  });

  it('CONTROL: an unrelated update preserves abstract, content and hash', async () => {
    const before = await raw();
    expect(before.abstract).not.toBeNull(); // #3752: a null seed would make the checks below null === null
    expect(before.content).not.toBeNull();
    expect(before.abstractOriginHash).not.toBeNull();
    await update({ name: 'Renamed' });
    const row = await raw();
    expect(row.abstract).toBe(before.abstract);
    expect(row.content).toBe(before.content);
    expect(row.abstractOriginHash).toBe(before.abstractOriginHash);
  });
});

describe('#3727 plain GraphQL control — already clears, must stay', () => {
  it('abstract:null and content:null clear; omission preserves', async () => {
    // Omission is checked FIRST, while the seeded values are still in place:
    // after the clears both columns are NULL, and a null-to-null comparison
    // cannot tell preservation from clearing (BLIND on bf3828e9).
    const seeded = await raw();
    expect(seeded.abstract).not.toBeNull(); // #3752: non-null seed guard
    expect(seeded.content).not.toBeNull();
    expect(seeded.abstractOriginHash).not.toBeNull();
    await update({ name: 'Renamed plain' });
    const preserved = await raw();
    expect(preserved.abstract).toBe(seeded.abstract);
    expect(preserved.content).toBe(seeded.content);
    expect(preserved.abstractOriginHash).toBe(seeded.abstractOriginHash);
    await update({ abstract: null });
    expect((await raw()).abstract).toBeNull();
    expect((await raw()).abstractOriginHash).toBeNull();
    await update({ content: null });
    const row = await raw();
    expect(row.content).toBeNull();
    expect(row.abstract).toBeNull();
  });
});

describe('#3727 entry points', () => {
  beforeEach(async () => {
    await encrypted();
  });

  it('RED: the memoryId+loc selector clears too (shared core, both selectors)', async () => {
    await gql(
      'mutation($input:UpdateNodeInput!){updateNode(input:$input){id abstract}}',
      { input: { memoryId: memory.id, loc: node.loc, abstract: null } },
    );
    expect((await raw()).abstract).toBeNull();
    expect((await raw()).abstractOriginHash).toBeNull();
  });

  it('RED (#3752): the memoryId+loc selector clears content; the omitting control preserves it', async () => {
    const before = await raw();
    await gql(
      'mutation($input:UpdateNodeInput!){updateNode(input:$input){id}}',
      { input: { memoryId: memory.id, loc: node.loc, name: 'Selector rename' } },
    );
    expect((await raw()).content).toBe(before.content);
    expect((await raw()).abstract).toBe(before.abstract);
    await gql(
      'mutation($input:UpdateNodeInput!){updateNode(input:$input){id}}',
      { input: { memoryId: memory.id, loc: node.loc, content: null } },
    );
    const row = await raw();
    expect(row.content).toBeNull();
    expect(row.abstract).toBe(before.abstract); // the omitted abstract is untouched
    expect((await logical()).abstract).toBe(OLD_ABSTRACT);
    expect(row.abstractOriginHash).toBe(before.abstractOriginHash);
  });

  it('RED (#3752): tombstone resurrection — explicit content:null clears the old body', async () => {
    await db.node.update({ where: { id: node.id }, data: { deletedAt: new Date(), deletedBy: 'test' } });
    await gql(
      'mutation($input:CreateNodeInput!){createNode(input:$input){id}}',
      { input: { memoryId: memory.id, loc: node.loc, name: 'Back', abstract: 'revived summary', content: null } },
    );
    const row = await raw();
    expect(row.deletedAt).toBeNull();
    expect(row.content).toBeNull(); // the tombstone's body is cleared, not carried over
    expect((await logical()).abstract).toBe('revived summary');
  });

  it('CONTROL (#3752): tombstone resurrection that omits content keeps the tombstone body', async () => {
    await db.node.update({ where: { id: node.id }, data: { deletedAt: new Date(), deletedBy: 'test' } });
    await gql(
      'mutation($input:CreateNodeInput!){createNode(input:$input){id}}',
      { input: { memoryId: memory.id, loc: node.loc, name: 'Back', abstract: 'revived summary' } },
    );
    expect((await raw()).deletedAt).toBeNull();
    expect((await logical()).content).toBe(OLD_CONTENT);
  });

  it('RED: tombstone resurrection — explicit null clears the old field, omission preserves it', async () => {
    await db.node.update({ where: { id: node.id }, data: { deletedAt: new Date(), deletedBy: 'test' } });
    await gql(
      'mutation($input:CreateNodeInput!){createNode(input:$input){id abstract}}',
      { input: { memoryId: memory.id, loc: node.loc, name: 'Back', content: 'resurrected', abstract: null } },
    );
    const row = await raw();
    expect(row.deletedAt).toBeNull(); // resurrected
    expect(row.abstract).toBeNull(); // the old field cleared, not carried from the tombstone
    expect((await logical()).content).toBe('resurrected');

    // Omission on resurrection keeps the existing carry-over semantics: the
    // tombstone's field survives a resurrecting create that did not send it.
    await update({ content: 'resurrected twice', name: 'Back2' }); // restore a live row with an abstract
    await update({ abstract: 'kept through death' });
    await db.node.update({ where: { id: node.id }, data: { deletedAt: new Date(), deletedBy: 'test' } });
    await gql(
      'mutation($input:CreateNodeInput!){createNode(input:$input){id abstract}}',
      { input: { memoryId: memory.id, loc: node.loc, name: 'Back3', content: 'resurrected 3' } },
    );
    expect((await logical()).abstract).toBe('kept through death');
  });

  it('CONTROL: fresh create on the encrypted memory — null and omit both store SQL NULL, a string stores ciphertext', async () => {
    const created = async (extra: Record<string, unknown>) => {
      const loc = `fresh-${generateId()}`;
      const out = await gql<{ createNode: { id: string } }>(
        'mutation($input:CreateNodeInput!){createNode(input:$input){id}}',
        { input: { memoryId: memory.id, loc, name: 'Fresh', content: 'body', ...extra } },
      );
      return db.node.findUniqueOrThrow({ where: { id: out.createNode.id } });
    };
    expect((await created({ abstract: null })).abstract).toBeNull();
    expect((await created({})).abstract).toBeNull();
    const withAbstract = await created({ abstract: 'seeded' });
    expect(isCiphertext(withAbstract.abstract!)).toBe(true);
    expect(decryptNodeFieldsWithKey(withAbstract, key).abstract).toBe('seeded');
  });

  it('RED (#3752): fresh create — content:null and omitted content both store SQL NULL, a string stores ciphertext', async () => {
    const created = async (extra: Record<string, unknown>) => {
      const out = await gql<{ createNode: { id: string } }>(
        'mutation($input:CreateNodeInput!){createNode(input:$input){id}}',
        { input: { memoryId: memory.id, loc: `fresh-c-${generateId()}`, name: 'FreshC', ...extra } },
      );
      return db.node.findUniqueOrThrow({ where: { id: out.createNode.id } });
    };
    expect((await created({ content: null })).content).toBeNull();
    expect((await created({})).content).toBeNull();
    const withContent = await created({ content: 'seeded body' });
    expect(isCiphertext(withContent.content!)).toBe(true);
    expect(decryptNodeFieldsWithKey(withContent, key).content).toBe('seeded body');
  });

  it('CONTROL: a create onto a live loc still conflicts', async () => {
    const code = await gql(
      'mutation($input:CreateNodeInput!){createNode(input:$input){id}}',
      { input: { memoryId: memory.id, loc: node.loc, name: 'Clash', content: 'x', abstract: null } },
    ).then(
      () => 'NONE',
      (error: { extensions?: { code?: string } }) => error.extensions?.code ?? 'UNKNOWN',
    );
    expect(code).toBe('NodeLocConflictError');
  });

  it('RED: the internal upsert core — existing-row null clears, absent-row null/omit store SQL NULL', async () => {
    // Existing row (the update arm of upsert).
    await writeNodeCoreUpsert({ abstract: null });
    expect((await raw()).abstract).toBeNull();
    expect((await raw()).abstractOriginHash).toBeNull();
    // Absent row (the insert arm).
    const loc = `upsert-${generateId()}`;
    const insertedNull = await writeNodeCoreUpsert({ abstract: null }, loc);
    const rowNull = await db.node.findUniqueOrThrow({ where: { id: insertedNull.id } });
    expect(rowNull.abstract).toBeNull();
    const loc2 = `upsert-${generateId()}`;
    const insertedOmit = await writeNodeCoreUpsert({}, loc2);
    expect((await db.node.findUniqueOrThrow({ where: { id: insertedOmit.id } })).abstract).toBeNull();
  });

  it('RED (#3752): the internal upsert core — existing-row content:null clears, absent-row null stores SQL NULL, omission preserves', async () => {
    // Omission control first, while the seeded body is in place.
    const before = await raw();
    expect(before.content).not.toBeNull();
    await writeNodeCoreUpsert({ content: undefined, name: 'Upsert omit' });
    expect((await raw()).content).toBe(before.content);
    // Existing row (the update arm of upsert).
    await writeNodeCoreUpsert({ content: null });
    expect((await raw()).content).toBeNull();
    // Absent row (the insert arm).
    const inserted = await writeNodeCoreUpsert({ content: null }, `upsert-c-${generateId()}`);
    expect((await db.node.findUniqueOrThrow({ where: { id: inserted.id } })).content).toBeNull();
  });

  it('RED (#3752): the install door content:null clears on the install memory; omission preserves', async () => {
    const f = await installFixture();
    const M = resolvers.Mutation as Record<string, (a: unknown, b: { input: Record<string, unknown> }, c: Context) => Promise<unknown>>;
    const install = { appRef: f.appId, agentRef: f.agentId };
    const seeded = await db.node.findUniqueOrThrow({ where: { id: f.nodeId } });
    expect(seeded.content).not.toBeNull();
    await M.updateNode(null, { input: { install, loc: 'source', name: 'Install rename' } }, f.ctx);
    expect((await db.node.findUniqueOrThrow({ where: { id: f.nodeId } })).content).toBe(seeded.content);
    await M.updateNode(null, { input: { install, loc: 'source', content: null } }, f.ctx);
    const after = await db.node.findUniqueOrThrow({ where: { id: f.nodeId } });
    expect(after.content).toBeNull();
    expect(after.abstract).toBe(seeded.abstract); // the omitted abstract is untouched
    expect(after.abstractOriginHash).toBe(seeded.abstractOriginHash);
  });

  it('RED: the install door update clears on the install memory; a refusal leaves no artifacts', async () => {
    const f = await installFixture();
    const M = resolvers.Mutation as Record<string, (a: unknown, b: { input: Record<string, unknown> }, c: Context) => Promise<unknown>>;
    // A licensed manager's update through the install door clears.
    await M.updateNode(null, { input: { install: { appRef: f.appId, agentRef: f.agentId }, loc: 'source', abstract: null } }, f.ctx);
    const after = await db.node.findUniqueOrThrow({ where: { id: f.nodeId } });
    expect(after.abstract).toBeNull();
    expect(after.abstractOriginHash).toBeNull();
    // The licensed clear is the pinned first-clear semantics: exactly one
    // revision capturing the prior state (the old ciphertext) at rest.
    const revisions = await db.nodeRevision.count({ where: { nodeId: f.nodeId } });
    expect(revisions).toBe(1);
    // A refused caller (participant non-manager) leaves everything untouched.
    const refused = await M.updateNode(null, { input: { install: { appRef: f.appId, agentRef: f.agentId }, loc: 'source', abstract: null } }, f.memberCtx).then(
      () => 'NONE',
      (error: { extensions?: { code?: string } }) => error.extensions?.code ?? 'UNKNOWN',
    );
    expect(refused).toBe('FORBIDDEN');
    expect(await db.nodeRevision.count({ where: { nodeId: f.nodeId } })).toBe(revisions);
    expect(await db.node.findUniqueOrThrow({ where: { id: f.nodeId } })).toEqual(after);
  });
});

describe('#3727 generated kind doors — controls (acceptance 2: doors inherit the normalization, gates unchanged)', () => {
  // Ground truth from the door sources: the decision doors refuse encrypted
  // memories outright (decisions.ts: "a decision is verified by re-rendering
  // its plaintext") and re-supply a STRING abstract on every write
  // (logContentOf); the spec reservation door states nulls on CREATE only (the
  // resurrection shape pinned above); no kind door sends an update-mode null
  // abstract/content. The one internal caller that can carry a caller-supplied
  // explicit null into the changed line is the run tool hadron_update_node
  // (pickWriteFields drops undefined only).

  it('CONTROL: the decision door on its plain domain — string abstract stored verbatim on create and door-update, gate refuses identically', async () => {
    const M = resolvers.Mutation as unknown as Record<string, (a: unknown, b: Record<string, unknown>, c: Context) => Promise<{ id: string; row: { id: string } }>>;
    const org = await db.organization.create({ data: { name: 'Door', urn: `n3727-door-${generateId()}.example` } });
    const admin = (await db.user.create({ data: { handle: `n3727-adm-${generateId()}`, roles: ['ADMIN'] } })).id;
    await db.orgMember.create({ data: { organizationId: org.id, userId: admin, role: 'ADMIN' } });
    const doorMemory = (await M.createMemory(null, { orgId: org.id, name: 'Door memory' }, { db, userId: admin, roles: ['ADMIN'] } as Context)).id;
    const adminCtx = { db, userId: admin, roles: ['ADMIN'] } as Context;

    const log = await M.createDecisionLog(null, { memoryRef: doorMemory, loc: 'decisions', defaultDeciders: [admin] }, adminCtx);
    const row = await db.node.findUniqueOrThrow({ where: { id: log.row.id } });
    expect(row.abstract).toMatch(/^Decision log: codes /);

    // An update-mode door write re-supplies the string: preserved verbatim,
    // never an accidental clear.
    await M.setDecisionLogDeciders(
      null,
      { logRef: log.row.id, defaultDeciders: [admin], expectedRevision: 1, reason: 'n3727 door control' },
      adminCtx,
    );
    const after = await db.node.findUniqueOrThrow({ where: { id: log.row.id } });
    expect(after.abstract).toBe(row.abstract);

    // The door's own gate is unchanged: an org non-manager is refused, no artifact.
    const reader = (await db.user.create({ data: { handle: `n3727-rd-${generateId()}`, roles: ['READER'] } })).id;
    await db.orgMember.create({ data: { organizationId: org.id, userId: reader, role: 'READER' } });
    const before = await db.node.findFirst({ where: { memoryId: doorMemory } });
    const refused = await M.createDecisionLog(
      null,
      { memoryRef: doorMemory, loc: 'elsewhere', defaultDeciders: [admin] },
      { db, userId: reader, roles: ['READER'] } as Context,
    ).then(
      () => 'NONE',
      (error: { extensions?: { code?: string } }) => error.extensions?.code ?? 'UNKNOWN',
    );
    expect(refused).toBe('DECISION_FORBIDDEN');
    expect(await db.node.findFirst({ where: { memoryId: doorMemory } })).toEqual(before);
  });

  it('CONTROL: the hadron_update_node run tool — its own gate refuses encrypted memories before the core; on a plain memory null clears and omission preserves through the real tool', async () => {
    const { hadronUpdateNode } = await import('../../../lib/runner/tools/nodeTools.js');
    const org = await db.organization.create({ data: { name: 'Run', urn: `n3727-run-${generateId()}.example` } });
    const admin = (await db.user.create({ data: { handle: `n3727-run-${generateId()}`, roles: ['ADMIN'] } })).id;
    await db.orgMember.create({ data: { organizationId: org.id, userId: admin, role: 'ADMIN' } });
    const M = resolvers.Mutation as unknown as Record<string, (a: unknown, b: Record<string, unknown>, c: Context) => Promise<{ id: string }>>;
    const runMemory = (await M.createMemory(null, { orgId: org.id, name: 'Run memory' }, { db, userId: admin, roles: ['ADMIN'] } as Context)).id;
    const run = { principal: { db, roles: [], userId: admin }, db, run: { id: 'run-n3727', organizationId: org.id } } as never;
    const memRow = await db.memory.findUniqueOrThrow({ where: { id: runMemory } });
    const urn = `hrn:node:${memRow.urn}:runtool`;

    const nodeId = generateId();
    const seed = async (encrypted: boolean) => {
      await db.node.create({
        data: {
          id: nodeId, memoryId: runMemory, loc: 'runtool', name: 'Run',
          ...(encrypted
            ? { ...encryptNodeFieldsWithKey({ content: 'run body', abstract: 'run abstract' }, key), abstractOriginHash: computeContentHash('run body'), revisionContentHash: revisionStateHashRefreshMarker() }
            : { content: 'run body', abstract: 'run abstract', abstractOriginHash: computeContentHash('run body') }),
        } as never,
      });
    };

    // Encrypted: the tool's own gate refuses BEFORE the core — no run-tool
    // write can reach the encrypted mapping at all (existing gate, unchanged).
    await db.memory.update({ where: { id: runMemory }, data: { isEncrypted: true, vectorIndexEnabled: false } });
    sessionKeyCache.set('n3727-run', runMemory, key);
    await seed(true);
    const encryptedRow = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    const toolRefusal = await hadronUpdateNode.execute(run, { urn, abstract: null }).then(
      () => 'NONE',
      (error: Error) => error.message,
    );
    expect(toolRefusal).toMatch(/Headless runs are unavailable on encrypted memories/);
    expect(await db.node.findUniqueOrThrow({ where: { id: nodeId } })).toEqual(encryptedRow);

    // Plain: the tool inherits the core's normalization end-to-end — an
    // explicit null clears, an omitted abstract never becomes an accidental clear.
    await db.node.delete({ where: { id: nodeId } });
    await db.memory.update({ where: { id: runMemory }, data: { isEncrypted: false } });
    await seed(false);
    await hadronUpdateNode.execute(run, { urn, abstract: null });
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).abstract).toBeNull();
    await hadronUpdateNode.execute(run, { urn, abstract: 're-set', content: 'second body' });
    await hadronUpdateNode.execute(run, { urn, name: 'Renamed by tool' });
    const plainFinal = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect(plainFinal.abstract).toBe('re-set');
    expect(plainFinal.content).toBe('second body');
  });
});

describe('#3727 refusals — controls, nothing widens', () => {
  it('CONTROL: no cached session key refuses SESSION_EXPIRED before any write', async () => {
    await encrypted();
    sessionKeyCache.clear(); // the locked-memory shape: encrypted, no live session key
    const before = await raw();
    const state = await revisionState();
    expect(await updateExpectingCode({ abstract: null })).toBe('SESSION_EXPIRED');
    expect(await updateExpectingCode({ content: null })).toBe('SESSION_EXPIRED');
    expect(await raw()).toEqual(before);
    expect(await revisionState()).toEqual(state);
  });

  it('CONTROL: an unauthorized caller refuses identically for null and non-null patches, row unchanged', async () => {
    await encrypted();
    const before = await raw();
    const state = await revisionState();
    const nameRefusal = await updateExpectingCode({ name: 'Denied' }, outsider);
    const nullRefusal = await updateExpectingCode({ abstract: null }, outsider);
    const contentRefusal = await updateExpectingCode({ content: null }, outsider);
    expect(nameRefusal).toBe(nullRefusal);
    expect(nameRefusal).toBe(contentRefusal);
    expect(nameRefusal).not.toBe('NONE');
    expect(await raw()).toEqual(before);
    expect(await revisionState()).toEqual(state);
  });
});

/** Direct internal-upsert pin: writeNodeCore is not a public GraphQL surface. */
async function writeNodeCoreUpsert(patch: Record<string, unknown>, loc = node.loc) {
  const { writeNodeCore } = await import('./resolvers.mutation.node.js');
  const { attestedAuthoring } = await import('../../../lib/authoringAttestation.js');
  return writeNodeCore(
    { memoryId: memory.id, loc, name: 'Upsert', content: 'upserted body', ...patch } as never,
    { db, roles: ['READER'], userId: owner, clientId: `user:${owner}` } as never,
    'upsert',
    { authoring: attestedAuthoring(null) },
  );
}

/** An App install memory with one node, encrypted, key cached: the install door target. */
async function installFixture() {
  const keyId = generateId().toLowerCase();
  const holder = await db.organization.create({ data: { name: 'Holder', urn: `n3727-holder-${keyId}.example` } });
  const importer = await db.organization.create({ data: { name: 'Importer', urn: `n3727-imp-${keyId}.example` } });
  const manager = await db.user.create({ data: { handle: `n3727-mgr-${keyId}`, roles: ['READER'] } });
  const member = await db.user.create({ data: { handle: `n3727-mem-${keyId}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: holder.id, userId: manager.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: holder.id, userId: member.id, role: 'READER' } });
  const app = await db.app.create({ data: { organizationId: holder.id, name: 'App', urn: `${holder.urn}:app` } });
  await createDbAppMember(db, app.id, manager.id, 'member');
  await createDbAppMember(db, app.id, member.id, 'member');
  const agent = await db.agent.create({ data: { organizationId: importer.id, name: 'Target', urn: `${importer.urn}:target` } });
  const parent = await db.agent.create({ data: { organizationId: importer.id, name: 'Parent', urn: `${importer.urn}:parent` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: parent.id } });
  await createDbAgentOrgGrant(db, importer.id, agent.id);
  await createDbAgentOrgGrant(db, holder.id, agent.id);
  await createDbAgentImport(db, parent.id, agent.id);
  const install = await db.memory.create({
    data: {
      organizationId: holder.id, appId: app.id, installOfAgentId: agent.id,
      isInstallMemory: true, class: 'system', name: 'Install', urn: `${holder.urn}:install`,
      isEncrypted: true,
    },
  });
  const nodeId = generateId();
  await db.node.create({
    data: {
      id: nodeId, memoryId: install.id, loc: 'source', name: 'Source',
      ...encryptNodeFieldsWithKey({ content: 'install body', abstract: 'install abstract' }, key),
      abstractOriginHash: computeContentHash('install body'),
      revisionContentHash: revisionStateHashRefreshMarker(),
    } as never,
  });
  sessionKeyCache.set('n3727', install.id, key);
  return {
    appId: app.id, agentId: agent.id, nodeId,
    ctx: { db, userId: manager.id, roles: ['READER'] } as Context,
    memberCtx: { db, userId: member.id, roles: ['READER'] } as Context,
  };
}
