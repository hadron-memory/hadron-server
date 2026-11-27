/**
 * #4142 (S6, chunks B–F) — the hard rename of entity-reference mutation args
 * to `<entity>Ref`, with no alias, plus the nine chunk-F alias-drops whose
 * survivor refs became REQUIRED.
 *
 * What these pins hold, per the slice contract:
 *
 * 1. SDL (static, exhaustive): every renamed field REJECTS its old `…Id` /
 *    `id` argument as an unknown argument, and every chunk-F survivor ref is
 *    non-null `ID!`. The wire is where a lagging client actually hits this —
 *    GraphQL refuses the whole operation, unlike MCP's silent argument drop.
 * 2. Behavior (mostly through a real ApolloServer so argument validation runs; the
 *    encryptMemory, linkMemoryToUser and restoreRevision pins call the resolvers
 *    directly, so they hold the resolver contract, not argument validation): the
 *    renamed args accept both the PK and the URN on every renamed field.
 * 3. `cor:api:140:03` parity: a gate refusal is byte-identical whether the
 *    caller passed the PK or the URN — the refusal surface must not vary with
 *    the input form (one pin per gate-helper family).
 * 4. Chunk F blank refs: `''` / whitespace refuse BAD_USER_INPUT naming only
 *    the ref, BEFORE any gate fires.
 * 5. Resource-before-counterparty resolve order (unchanged by the rename):
 *    with both refs unknown, the RESOURCE (memory/app/agent/org) error is the
 *    one the caller sees.
 * 6. `leaveApp`'s worker self-leave still threads through the internal
 *    `removeAppMemberWithAdmission` after the internal caller was re-pointed
 *    at `appRef`/`userRef`.
 * 7. `hadron_create_memory` (MCP) still maps its `org` input onto the renamed
 *    `orgRef` and emits its two prose fragments byte-identically.
 *
 * Chunk A (the memory reads) is pinned in resolvers.entityRefS6A.4142.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { buildSchema, parse, validate, GraphQLObjectType, type GraphQLSchema } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { generateDataKey } from '../../../lib/crypto.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import type { AuthContext } from '../../../middleware/auth.js';
import { formatGraphQLError } from '../formatError.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { encryptWithSecret } from '../../../test/encryptMemoryWithSecret.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));
vi.mock('../../../integrations/github/pushMemoryToGit.js', () => ({
  pushMemoryToGit: vi.fn().mockResolvedValue({ error: null, errorCode: null }),
}));

const graphql = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });

/** What a client receives: the data field, and the error's message and extensions. */
type Answer = { data: unknown; error: { message: string; extensions: Record<string, unknown> } | null };

async function ask(c: Context, query: string, variables: Record<string, unknown> = {}): Promise<Answer> {
  const res = await graphql.executeOperation({ query, variables }, { contextValue: c });
  if (res.body.kind !== 'single') throw new Error('unexpected incremental response');
  const { data, errors } = res.body.singleResult;
  const e = errors?.[0];
  const { stacktrace: _drop, ...extensions } = (e?.extensions ?? {}) as Record<string, unknown>;
  return { data: data ? Object.values(data)[0] ?? null : null, error: e ? { message: e.message, extensions } : null };
}

/** Both error facets, so a byte-identical comparison covers message AND code. */
const refusal = async (p: Promise<Answer>): Promise<{ message: string; code: unknown }> => {
  const a = await p;
  if (!a.error) throw new Error('expected a refusal, got a resolution');
  return { message: a.error.message, code: a.error.extensions.code };
};

// ---------------------------------------------------------------------------
// 1. SDL acceptance — every old name is an unknown argument; F survivors are ID!
// ---------------------------------------------------------------------------

const schema: GraphQLSchema = buildSchema(typeDefs);

/** [field, old argument names that must be GONE]. */
const RENAMED: Array<[string, string[]]> = [
  // B — memory writes
  ['createMemory', ['orgId']],
  ['deleteMemory', ['id']],
  ['setMemorySourceToken', ['id']],
  ['syncMemory', ['id']],
  ['pushMemoryToGit', ['id']],
  // replaceSubtree is NOT here: #4219 (blind P2-A) keeps its legacy
  // `memoryId: String!` shape on purpose — the field exists so legacy callers
  // reach REPLACE_SUBTREE_RETIRED instead of an unknown-argument error. Its
  // legacy shape is pinned in its own test below.
  ['linkMemoryToUser', ['memoryId']],
  ['encryptMemory', ['memoryId']],
  // C — org
  ['deleteOrganization', ['id']],
  ['linkGithubApp', ['orgId']],
  ['updateOrgGithubApp', ['orgId']],
  ['unlinkGithubApp', ['orgId']],
  ['createUserInvitation', ['orgId']],
  // D — agent
  ['startChat', ['agentId']],
  ['updateAgentAIConfig', ['agentId']],
  ['clearAgentAIConfig', ['agentId']],
  ['createRevision', ['agentId']],
  ['publishRevision', ['agentId']],
  ['restoreRevision', ['agentId']],
  ['acquireEditorLock', ['agentId']],
  ['releaseEditorLock', ['agentId']],
  // E — join/leave
  ['joinApp', ['appId']],
  ['leaveApp', ['appId']],
  // F — the nine alias-drops
  ['createMemorySubscription', ['memoryId', 'orgId']],
  ['updateMemorySubscription', ['memoryId', 'orgId']],
  ['deleteMemorySubscription', ['memoryId', 'orgId']],
  ['ensureAppMember', ['appId', 'userId']],
  ['removeAppMember', ['appId', 'userId']],
  ['revokeAgentSubscription', ['userId', 'agentId']],
  ['addOrgMember', ['orgId', 'userId']],
  ['updateOrgMember', ['orgId', 'userId']],
  ['removeOrgMember', ['orgId', 'userId']],
];

/** [field, survivor ref args that must be required ID!]. */
const REQUIRED_REF_SURVIVORS: Array<[string, string[]]> = RENAMED.filter(([f]) =>
  ['createMemorySubscription', 'updateMemorySubscription', 'deleteMemorySubscription', 'ensureAppMember', 'removeAppMember', 'revokeAgentSubscription', 'addOrgMember', 'updateOrgMember', 'removeOrgMember'].includes(f),
) as Array<[string, string[]]>;

describe('#4142 S6 SDL — the old argument names are gone', () => {
  it.each(RENAMED)('%s refuses its old argument as unknown', (field, oldArgs) => {
    for (const oldArg of oldArgs) {
      const doc = parse(`mutation($v: ID) { ${field}(${oldArg}: $v) }`);
      const errors = validate(schema, doc);
      const messages = errors.map((e) => e.message);
      const unknownArg = messages.find((m) => m.startsWith(`Unknown argument "${oldArg}"`));
      if (!unknownArg) throw new Error(`${field}.${oldArg}: no unknown-argument error in ${JSON.stringify(messages)}`);
      expect(unknownArg).toMatch(new RegExp(`^Unknown argument "${oldArg}" on field "Mutation\\.${field}"`));
    }
  });

  it.each(REQUIRED_REF_SURVIVORS)('%s survivor refs are required ID!', (field) => {
    const args = schema.getMutationType()!.getFields()[field]!.args;
    const refArgs = args.filter((a) => /Ref$|^ref$/.test(a.name));
    expect(refArgs.length, `${field} must declare ref args`).toBeGreaterThan(0);
    for (const a of refArgs) {
      expect(a.type.toString(), `${field}.${a.name} must be ID! after the alias dropped`).toBe('ID!');
    }
  });
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

let org: { id: string; urn: string };
let adminUser: { id: string };
let readerUser: { id: string };
let knowledgeMemory: { id: string; urn: string };

const adminCtx = (): Context => ({ db, userId: adminUser.id, roles: ['READER'] });
const readerCtx = (): Context => ({ db, userId: readerUser.id, roles: ['READER'] });
const userCtx = (userId: string): Context => ({ db, userId, roles: ['READER'] });

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 's6-org', urn: `s6-org-${Date.now()}` },
  });
  adminUser = await db.user.create({
    data: { id: generateId(), githubId: 41421, githubUsername: 's6-admin', roles: ['READER'] },
  });
  readerUser = await db.user.create({
    data: { id: generateId(), githubId: 41422, githubUsername: 's6-reader', roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: adminUser.id, role: 'ADMIN' },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: readerUser.id, role: 'READER' },
  });
  knowledgeMemory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:knowledge`,
      name: 'knowledge',
      class: 'knowledge',
      visibility: 'ORGANIZATION',
    },
  });
});

// ---------------------------------------------------------------------------
// 2. Chunk B — memory writes: PK and URN both resolve the renamed arg
// ---------------------------------------------------------------------------

describe('#4142 S6 chunk B — memory writes', () => {
  it('createMemory accepts orgRef as PK and as URN', async () => {
    const byPk = await ask(
      adminCtx(),
      `mutation($ref: ID) { createMemory(orgRef: $ref, name: "by-pk", memoryClass: knowledge) { id organizationId class } }`,
      { ref: org.id },
    );
    expect(byPk.error).toBeNull();
    expect((byPk.data as { organizationId: string }).organizationId).toBe(org.id);

    const byUrn = await ask(
      adminCtx(),
      `mutation($ref: ID) { createMemory(orgRef: $ref, name: "by-urn", memoryClass: knowledge) { id organizationId } }`,
      { ref: org.urn },
    );
    expect(byUrn.error).toBeNull();
    expect((byUrn.data as { organizationId: string }).organizationId).toBe(org.id);
  });

  it('createMemory with orgRef OMITTED takes the user-owned branch (spec 047) with byte-identical prose', async () => {
    // The omitted-orgRef branch is the rename's one re-derivation risk: the
    // two refusal texts below are pinned byte-for-byte because clients and
    // the MCP tool surface them.
    const anonymous = await ask(
      { db, roles: [] },
      `mutation { createMemory(name: "anon", memoryClass: personal) { id } }`,
    );
    expect(anonymous.error?.extensions.code).toBe('UNAUTHENTICATED');
    expect(anonymous.error?.message).toBe(
      'Creating a user-owned memory (no orgRef) requires an authenticated user (the creator is the owner).',
    );

    const orgShared = await ask(
      readerCtx(),
      `mutation { createMemory(name: "shared", memoryClass: knowledge) { id } }`,
    );
    expect(orgShared.error?.extensions.code).toBe('UNSUPPORTED_MEMORY_CLASS');
    expect(orgShared.error?.message).toBe(
      `A user-owned memory (no orgRef) must be class 'personal' or 'private'; ` +
        `'knowledge' is org-shared — pass orgRef to create it.`,
    );

    const owned = await ask(
      readerCtx(),
      `mutation { createMemory(name: "mine", memoryClass: personal) { id organizationId userId class } }`,
    );
    expect(owned.error).toBeNull();
    expect(owned.data).toMatchObject({ organizationId: null, userId: readerUser.id, class: 'personal' });
  });

  it('createMemory with a BLANK orgRef refuses — it never falls into the user-owned branch (§10 F2)', async () => {
    // Only orgRef == null (omitted) takes the user-owned branch. A blank is
    // caller input and must refuse before anything is written, so a mutant
    // that treated '' as omitted cannot silently mint a user-owned memory.
    // Observed contract (pinned byte-for-byte): '' is the unqualified-URN
    // grammar refusal; whitespace resolves to nothing and reads EXACTLY like
    // an unknown ref's org miss — no distinct "blank" answer to branch on.
    const empty = await refusal(ask(
      readerCtx(),
      `mutation($o: ID!) { createMemory(name: "blank-empty", orgRef: $o, memoryClass: knowledge) { id } }`,
      { o: '' },
    ));
    expect(empty).toEqual({
      message: 'The ref is not a fully qualified org URN. Expected a org URN with at least 1 hierarchy segment (e.g., "acme.com").',
      code: 'URN_NOT_QUALIFIED',
    });
    const spaces = await refusal(ask(
      readerCtx(),
      `mutation($o: ID!) { createMemory(name: "blank-spaces", orgRef: $o, memoryClass: knowledge) { id } }`,
      { o: '   ' },
    ));
    const unknown = await refusal(ask(
      readerCtx(),
      `mutation($o: ID!) { createMemory(name: "blank-miss", orgRef: $o, memoryClass: knowledge) { id } }`,
      { o: generateId() },
    ));
    expect(spaces.code).toBe('ORGANIZATION_NOT_FOUND');
    expect(spaces.code).toBe(unknown.code);
    expect(await db.memory.count({ where: { name: { startsWith: 'blank' } } })).toBe(0);
  });

  it('deleteMemory accepts ref as PK and as URN; an unknown ref is the typed miss', async () => {
    const byPk = await ask(adminCtx(), `mutation($ref: ID!) { deleteMemory(ref: $ref) }`, { ref: knowledgeMemory.id });
    expect(byPk.error).toBeNull();
    expect(byPk.data).toBe(true);

    const second = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:second`, name: 'second',
        class: 'knowledge', visibility: 'ORGANIZATION',
      },
    });
    const byUrn = await ask(adminCtx(), `mutation($ref: ID!) { deleteMemory(ref: $ref) }`, { ref: second.urn });
    expect(byUrn.error).toBeNull();
    expect(byUrn.data).toBe(true);

    // deleteMemory resolves through resolveMemoryRef (pre-#4142 surface), so
    // its miss is that resolver's own typed error, not resolveRefArg's.
    const unknown = generateId();
    const miss = await ask(adminCtx(), `mutation($ref: ID!) { deleteMemory(ref: $ref) }`, { ref: unknown });
    expect(miss.error?.extensions.code).toBe('MEMORY_NOT_FOUND');
  });

  it('setMemorySourceToken accepts ref as PK and as URN', async () => {
    for (const ref of [knowledgeMemory.id, knowledgeMemory.urn]) {
      const a = await ask(
        adminCtx(),
        `mutation($ref: ID!) { setMemorySourceToken(ref: $ref, token: "ghp_x") { id } }`,
        { ref },
      );
      expect(a.error).toBeNull();
    }
    const row = await db.memory.findUniqueOrThrow({ where: { id: knowledgeMemory.id } });
    expect(row.sourceTokenEncrypted).not.toBeNull();
  });

  it('syncMemory accepts ref as PK and as URN', async () => {
    for (const ref of [knowledgeMemory.id, knowledgeMemory.urn]) {
      const a = await ask(adminCtx(), `mutation($ref: ID!) { syncMemory(ref: $ref) { id } }`, { ref });
      expect(a.error).toBeNull();
      expect((a.data as { id: string }).id).toBe(knowledgeMemory.id);
    }
  });

  it('pushMemoryToGit accepts ref as PK and as URN', async () => {
    for (const ref of [knowledgeMemory.id, knowledgeMemory.urn]) {
      const a = await ask(adminCtx(), `mutation($ref: ID!) { pushMemoryToGit(ref: $ref) }`, { ref });
      expect(a.error).toBeNull();
      expect(a.data).toBe(true);
    }
  });

  it('replaceSubtree keeps its LEGACY memoryId shape (P2-A) and refuses AFTER resolution', async () => {
    // #4219 (blind P2-A): this field exists ONLY so legacy callers get
    // REPLACE_SUBTREE_RETIRED — renaming its arg to memoryRef would break
    // them at argument validation before the retirement ever fires. Pin the
    // SDL shape first (memoryId: String! present, memoryRef unknown), then
    // drive the legacy name end to end.
    const legacy = parse(`mutation($r: String!) { replaceSubtree(ownerRepo: "o/r", memoryId: $r, nodes: [], edges: []) }`);
    expect(validate(schema, legacy)).toEqual([]);
    const renamed = parse(`mutation($r: ID!) { replaceSubtree(ownerRepo: "o/r", memoryRef: $r, nodes: [], edges: []) }`);
    expect(validate(schema, renamed).map((e) => e.message)).toContainEqual(
      expect.stringContaining('Unknown argument'),
    );
    const memoryIdArg = (schema.getType('Mutation') as GraphQLObjectType)
      .getFields().replaceSubtree.args.find((a) => a.name === 'memoryId');
    expect(memoryIdArg?.type.toString()).toBe('String!');
    // The legacy arg still resolves PK and URN, and the refusal is the typed
    // retirement, not a resolution miss.
    for (const ref of [knowledgeMemory.id, knowledgeMemory.urn]) {
      const a = await ask(
        adminCtx(),
        `mutation($ref: String!) { replaceSubtree(ownerRepo: "o/r", memoryId: $ref, nodes: [], edges: []) }`,
        { ref },
      );
      expect(a.error?.extensions.code).toBe('REPLACE_SUBTREE_RETIRED');
    }
    const miss = await ask(
      adminCtx(),
      `mutation($ref: String!) { replaceSubtree(ownerRepo: "o/r", memoryId: $ref, nodes: [], edges: []) }`,
      { ref: generateId() },
    );
    expect(miss.error?.extensions.code).toBe('MEMORY_NOT_FOUND');
  });

  it('encryptMemory accepts memoryRef as PK and as URN (owner ctx)', async () => {
    const key = generateDataKey();
    for (const byUrn of [true, false]) {
      const memory = await db.memory.create({
        data: {
          id: generateId(), organizationId: null, ownerUserId: adminUser.id, userId: adminUser.id,
          urn: `${org.urn}:enc-${generateId()}`, name: 'enc', class: 'private', visibility: null,
        },
      });
      const out = await encryptWithSecret(
        {},
        { memoryRef: byUrn ? memory.urn : memory.id, dataKey: key.raw.toString('base64') },
        adminCtx(),
      );
      expect(out.isEncrypted).toBe(true);
    }
  });

  it('linkMemoryToUser accepts memoryRef as PK and as URN (App-key ctx)', async () => {
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:link-agent`, name: 'link-agent' },
    });
    const app = await db.app.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:link-app`, name: 'link-app',
        identifyUserMethod: 'SECRET', createUserPermission: 'IMPLICIT',
      },
    });
    for (const byUrn of [true, false]) {
      const memory = await db.memory.create({
        data: {
          id: generateId(), organizationId: org.id, appId: app.id,
          userMemoryOfAgentId: agent.id, userId: null, createdBy: null,
          anonymousExpiresAt: new Date(Date.now() + 86400000),
          urn: `${org.urn}:anon-${generateId()}`, name: 'anon', class: 'app',
        },
      });
      const out = await resolvers.Mutation.linkMemoryToUser(
        {},
        { memoryRef: byUrn ? memory.urn : memory.id, externalUserId: `ext-${generateId()}` },
        { db, appId: app.id, roles: [] } as Context,
      );
      // The plaintext promotion rewrites the anon URN to the registered form
      // and stamps created_by; the App-scoped userId column stays NULL.
      expect(out.urn).not.toBe(memory.urn);
      expect(out.createdBy).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Chunk C — org mutations
// ---------------------------------------------------------------------------

describe('#4142 S6 chunk C — org mutations', () => {
  const throwawayOrg = async () =>
    db.organization.create({ data: { id: generateId(), name: `s6-del-${generateId()}`, urn: `s6-del-${generateId()}` } });

  it('deleteOrganization accepts ref as PK and as URN', async () => {
    const platformAdmin: Context = { db, roles: ['ADMIN'] };
    for (const byUrn of [false, true]) {
      const victim = await throwawayOrg();
      const a = await ask(platformAdmin, `mutation($ref: ID!) { deleteOrganization(ref: $ref) }`, {
        ref: byUrn ? victim.urn : victim.id,
      });
      expect(a.error).toBeNull();
      expect(a.data).toBe(true);
      expect((await db.organization.findUnique({ where: { id: victim.id } }))?.deletedAt).not.toBeNull();
    }
  });

  it('linkGithubApp accepts orgRef as PK and as URN', async () => {
    for (const [ref, installationId] of [[org.id, 1], [org.urn, 2]] as const) {
      const a = await ask(
        adminCtx(),
        `mutation($ref: ID!, $inst: Int!) { linkGithubApp(orgRef: $ref, installationId: $inst) { id } }`,
        { ref, inst: installationId },
      );
      expect(a.error).toBeNull();
      expect((await db.organization.findUniqueOrThrow({ where: { id: org.id } })).githubInstallationId).toBe(installationId);
    }
  });

  it('updateOrgGithubApp accepts orgRef as PK and as URN', async () => {
    for (const ref of [org.id, org.urn]) {
      const a = await ask(
        adminCtx(),
        `mutation($ref: ID!) { updateOrgGithubApp(orgRef: $ref, appId: "123", privateKey: "pk") { id } }`,
        { ref },
      );
      expect(a.error).toBeNull();
      expect((await db.organization.findUniqueOrThrow({ where: { id: org.id } })).githubAppId).toBe('123');
    }
  });

  it('unlinkGithubApp accepts orgRef as PK and as URN', async () => {
    await db.organization.update({
      where: { id: org.id },
      data: { githubInstallationId: 9, githubAppId: '9', githubAppPrivateKeyEncrypted: 'x' },
    });
    for (const ref of [org.id, org.urn]) {
      const a = await ask(adminCtx(), `mutation($ref: ID!) { unlinkGithubApp(orgRef: $ref) { id } }`, { ref });
      expect(a.error).toBeNull();
    }
    const row = await db.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(row.githubInstallationId).toBeNull();
    expect(row.githubAppId).toBeNull();
  });

  it('createUserInvitation accepts orgRef as PK and as URN', async () => {
    for (const ref of [org.id, org.urn]) {
      const a = await ask(
        adminCtx(),
        `mutation($ref: ID!) { createUserInvitation(orgRef: $ref, memberRole: CONTRIBUTOR, email: "s6@example.com") { id } }`,
        { ref },
      );
      expect(a.error).toBeNull();
    }
    expect(await db.userInvitation.count()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. Chunk D — agent mutations
// ---------------------------------------------------------------------------

describe('#4142 S6 chunk D — agent mutations', () => {
  let agent: { id: string; urn: string };

  beforeEach(async () => {
    const systemMemory = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:sys-${generateId()}`,
        name: 'sys', class: 'system', visibility: null,
      },
    });
    agent = await db.agent.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:s6-agent`,
        name: 's6-agent', systemMemoryId: systemMemory.id, visibility: 'ORGANIZATION',
      },
    });
    await serveAgentBootPrompt(db, agent.id, 'You are the S6 agent.');

    // The chat script startChat reads: one non-setup conversation with a
    // single stage, same shape as resolvers.agentChat.test.ts seeds — without
    // it the chat refuses AGENT_HAS_NO_CONVERSATIONS before anything else.
    const script: Array<{ loc: string; name: string; content?: string; data?: Record<string, unknown> }> = [
      { loc: 'conversations:research', name: 'research', data: { stageOrder: ['scope'], isSetup: false } },
      { loc: 'conversations:research:scope', name: 'scope', data: { promptRef: 'prompts:research:scope' } },
      { loc: 'prompts:research', name: 'research' },
      { loc: 'prompts:research:scope', name: 'scope', content: 'Scope the research.' },
    ];
    for (const n of script) {
      await db.node.create({
        data: {
          id: generateId(), memoryId: systemMemory.id, loc: n.loc, name: n.name,
          nodeType: 'system', content: n.content, data: n.data as never,
        },
      });
    }
    // The App that hosts the caller's per-person memory (the JWT-user start
    // path resolves it via the agent link).
    await db.app.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:s6-chat-app`, name: 's6-chat-app',
        appAgents: { create: { agentId: agent.id } },
      },
    });
  });

  it('startChat accepts agentRef as PK and as URN', async () => {
    // The chat's nodes are provisioned in the agent's system memory, so the
    // caller needs more than a read: the org ADMIN qualifies.
    for (const ref of [agent.id, agent.urn]) {
      const a = await ask(adminCtx(), `mutation($ref: ID!) { startChat(agentRef: $ref) { chatId } }`, { ref });
      expect(a.error).toBeNull();
      expect((a.data as { chatId: string }).chatId).toBeTruthy();
    }
  });

  it('updateAgentAIConfig and clearAgentAIConfig accept agentRef as PK and as URN', async () => {
    for (const ref of [agent.id, agent.urn]) {
      const set = await ask(
        adminCtx(),
        `mutation($ref: ID!) { updateAgentAIConfig(agentRef: $ref, provider: "anthropic", apiKey: "sk-probe", model: "m") { id } }`,
        { ref },
      );
      expect(set.error).toBeNull();
      const clear = await ask(adminCtx(), `mutation($ref: ID!) { clearAgentAIConfig(agentRef: $ref) { id } }`, { ref });
      expect(clear.error).toBeNull();
    }
  });

  it('the revision/editor-lock quintet accepts agentRef as PK and as URN', async () => {
    const revisionLocs: string[] = [];
    for (const ref of [agent.id, agent.urn]) {
      const rev = await ask(
        adminCtx(),
        `mutation($ref: ID!) { createRevision(agentRef: $ref, description: "s6") { revisionLoc published } }`,
        { ref },
      );
      expect(rev.error).toBeNull();
      revisionLocs.push((rev.data as { revisionLoc: string }).revisionLoc);
    }

    const published = await ask(
      adminCtx(),
      `mutation($ref: ID!, $loc: String!) { publishRevision(agentRef: $ref, revisionLoc: $loc) { published } }`,
      { ref: agent.urn, loc: revisionLocs[0] },
    );
    expect(published.error).toBeNull();
    expect((published.data as { published: boolean }).published).toBe(true);

    // restoreRevision's full restore machinery is covered by its own suite;
    // this pin proves the renamed agentRef RESOLVES on both forms before the
    // revision lookup — a resolved ref answers "Revision not found: …" (the
    // text main switched to in the #4219 carry) while a miss answers the
    // Agent miss.
    for (const ref of [agent.id, agent.urn]) {
      await expect(
        resolvers.Mutation.restoreRevision({}, { agentRef: ref, revisionLoc: 'revisions:none' }, adminCtx()),
      ).rejects.toThrow(/^Revision not found$/); // #5168: the loc is not quoted back
    }
    await expect(
      resolvers.Mutation.restoreRevision({}, { agentRef: generateId(), revisionLoc: 'revisions:none' }, adminCtx()),
    ).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });

    for (const ref of [agent.id, agent.urn]) {
      const lock = await ask(adminCtx(), `mutation($ref: ID!) { acquireEditorLock(agentRef: $ref) { locked } }`, { ref });
      expect(lock.error).toBeNull();
      expect((lock.data as { locked: boolean }).locked).toBe(true);
      const release = await ask(adminCtx(), `mutation($ref: ID!) { releaseEditorLock(agentRef: $ref) }`, { ref });
      expect(release.error).toBeNull();
      expect(release.data).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2/6. Chunk E — joinApp / leaveApp, including the worker self-leave
// ---------------------------------------------------------------------------

describe('#4142 S6 chunk E — joinApp / leaveApp', () => {
  let app: { id: string; urn: string };

  beforeEach(async () => {
    const agent = await db.agent.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:s6-join-agent`, name: 's6-join-agent',
        installationPolicy: { maxMembers: 'unlimited', memberRoles: ['owner', 'member'], selfJoinRole: 'member' } as never,
      },
    });
    app = await db.app.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:s6-app`, name: 's6-app',
        appAgents: { create: { agentId: agent.id } },
      },
    });
  });

  it('joinApp accepts appRef as PK and as URN; leaveApp accepts appRef as PK and as URN', async () => {
    const joinedByPk = await ask(readerCtx(), `mutation($ref: ID!) { joinApp(appRef: $ref) { appMember { userId } } }`, { ref: app.id });
    expect(joinedByPk.error).toBeNull();

    const leftByUrn = await ask(readerCtx(), `mutation($ref: ID!) { leaveApp(appRef: $ref) { appId userId } }`, { ref: app.urn });
    expect(leftByUrn.error).toBeNull();
    expect(await db.appMember.findUnique({ where: { appId_userId: { appId: app.id, userId: readerUser.id } } })).toBeNull();

    const joinedByUrn = await ask(readerCtx(), `mutation($ref: ID!) { joinApp(appRef: $ref) { appMember { userId } } }`, { ref: app.urn });
    expect(joinedByUrn.error).toBeNull();

    const leftByPk = await ask(readerCtx(), `mutation($ref: ID!) { leaveApp(appRef: $ref) { appId userId } }`, { ref: app.id });
    expect(leftByPk.error).toBeNull();
  });

  it('a worker self-leave still threads through the internal removeAppMemberWithAdmission', async () => {
    const agent = await db.agent.findFirstOrThrow({ where: { appAgents: { some: { appId: app.id } } } });
    const worker = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'S6W', slug: 's6w', heldByUserId: adminUser.id },
    });
    await db.appMember.create({ data: { appId: app.id, userId: adminUser.id, role: 'owner' } });
    const session = await db.session.create({
      data: { id: generateId(), appId: app.id, agentId: agent.id, workerId: worker.id, userId: adminUser.id, tool: 'vitest' },
    });
    const workerCtx: Context = { db, userId: adminUser.id, roles: ['READER'], sessionId: session.id };

    // Bound worker without a grant or instruction: refused, membership kept.
    const refused = await ask(workerCtx, `mutation($ref: ID!) { leaveApp(appRef: $ref) { appId } }`, { ref: app.urn });
    expect(refused.error?.extensions.code).toBe('FORBIDDEN');
    expect(await db.appMember.findUnique({ where: { appId_userId: { appId: app.id, userId: adminUser.id } } })).not.toBeNull();

    // With a live instruction the same call removes the member through the
    // locked member-removal path (removeAppMemberWithAdmission), re-pointed
    // at { appRef, userRef } by this slice.
    const removed = await ask(
      workerCtx,
      `mutation($ref: ID!, $instruction: ActInstructionInput) { leaveApp(appRef: $ref, instruction: $instruction) { appId userId } }`,
      { ref: app.urn, instruction: { kind: 'LIVE_CHAT', ref: 'client-chat:s6-self-leave' } },
    );
    expect(removed.error).toBeNull();
    expect((removed.data as { appId: string; userId: string })).toMatchObject({ appId: app.id, userId: adminUser.id });
    expect(await db.appMember.findUnique({ where: { appId_userId: { appId: app.id, userId: adminUser.id } } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2/4/5. Chunk F — the nine alias-drops
// ---------------------------------------------------------------------------

describe('#4142 S6 chunk F — required survivor refs', () => {
  let app: { id: string; urn: string };
  let subscriberOrg: { id: string; urn: string };
  let publicMemory: { id: string; urn: string };
  let targetUser: string;
  let agent: { id: string; urn: string };

  beforeEach(async () => {
    subscriberOrg = await db.organization.create({
      data: { id: generateId(), name: 's6-sub', urn: `s6-sub-${Date.now()}` },
    });
    await db.orgMember.create({ data: { organizationId: subscriberOrg.id, userId: adminUser.id, role: 'ADMIN' } });
    publicMemory = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:s6-public`, name: 's6-public',
        class: 'knowledge', visibility: 'PUBLIC',
      },
    });
    targetUser = (await db.user.create({
      data: { id: generateId(), githubId: 41423, githubUsername: 's6-target', roles: ['READER'] },
    })).id;
    agent = await db.agent.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:s6-f-agent`, name: 's6-f-agent',
        // ensureAppMember validates the role against the primary Agent's policy.
        installationPolicy: { maxMembers: 'unlimited', memberRoles: ['owner', 'member'], selfJoinRole: 'member' } as never,
      },
    });
    app = await db.app.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:s6-f-app`, name: 's6-f-app',
        // ensureAppMember refuses an App with no installed Agents (OrphanAppError).
        appAgents: { create: { agentId: agent.id } },
      },
    });
  });

  // -- the subscription trio ------------------------------------------------

  it('create/update/delete MemorySubscription accept memoryRef and orgRef as PK and as URN', async () => {
    const created = await ask(
      adminCtx(),
      `mutation($m: ID!, $o: ID!) { createMemorySubscription(memoryRef: $m, orgRef: $o, role: READER) { memory { id } organization { id } role } }`,
      { m: publicMemory.id, o: subscriberOrg.urn },
    );
    expect(created.error).toBeNull();
    expect(created.data).toMatchObject({ memory: { id: publicMemory.id }, organization: { id: subscriberOrg.id }, role: 'READER' });

    const updated = await ask(
      adminCtx(),
      `mutation($m: ID!, $o: ID!) { updateMemorySubscription(memoryRef: $m, orgRef: $o, role: CONTRIBUTOR) { role } }`,
      { m: publicMemory.urn, o: subscriberOrg.id },
    );
    expect(updated.error).toBeNull();
    expect((updated.data as { role: string }).role).toBe('CONTRIBUTOR');

    const deleted = await ask(
      adminCtx(),
      `mutation($m: ID!, $o: ID!) { deleteMemorySubscription(memoryRef: $m, orgRef: $o) }`,
      { m: publicMemory.urn, o: subscriberOrg.urn },
    );
    expect(deleted.error).toBeNull();
    expect(deleted.data).toBe(true);
  });

  it('a PADDED memoryRef to a hidden memory refuses byte-identically to a missing one (§10 F1, trim parity)', async () => {
    // If the concealment paths dropped their memoryRef.trim(), a padded ref
    // to a HIDDEN memory would echo the padding while the resolution miss
    // echoes trimmed — the padding itself would become an oracle separating
    // "hidden" from "missing". Pin the trimmed echo on both paths (#1381).
    const hidden = await db.memory.create({
      data: {
        id: generateId(), organizationId: subscriberOrg.id, urn: `${subscriberOrg.urn}:s6-hidden`,
        name: 's6-hidden', class: 'knowledge', visibility: 'ORGANIZATION',
      },
    });
    const missing = generateId();
    // readerUser is not a member of subscriberOrg, so `hidden` is unreadable
    // to readerCtx — exactly the caller the concealment protects.
    const paddedHidden = await refusal(ask(
      readerCtx(),
      `mutation($m: ID!) { createMemorySubscription(memoryRef: $m, orgRef: $m, role: READER) { role } }`,
      { m: `  ${hidden.id}  ` },
    ));
    expect(paddedHidden).toEqual({
      message: 'No match for memoryRef.',
      code: 'NOT_FOUND',
    });
    const paddedMissing = await refusal(ask(
      readerCtx(),
      `mutation($m: ID!) { createMemorySubscription(memoryRef: $m, orgRef: $m, role: READER) { role } }`,
      { m: `  ${missing}  ` },
    ));
    expect(paddedMissing).toEqual({
      message: 'No match for memoryRef.',
      code: 'NOT_FOUND',
    });
    // deleteMemorySubscription's caller-input conversion carries the same
    // trim: a padded ref to the hidden memory, with the org ref missing,
    // converts to the identical memory miss.
    const paddedHiddenDelete = await refusal(ask(
      readerCtx(),
      `mutation($m: ID!, $o: ID!) { deleteMemorySubscription(memoryRef: $m, orgRef: $o) }`,
      { m: `  ${hidden.id}  `, o: `  ${missing}  ` },
    ));
    expect(paddedHiddenDelete).toEqual(paddedHidden);
  });

  // -- app membership ---------------------------------------------------

  it('ensureAppMember / removeAppMember accept appRef and userRef as PK and as URN', async () => {
    const ensuredByPk = await ask(
      adminCtx(),
      `mutation($a: ID!, $u: ID!) { ensureAppMember(appRef: $a, userRef: $u, role: "member") { userId role } }`,
      { a: app.id, u: targetUser },
    );
    expect(ensuredByPk.error).toBeNull();

    const ensuredByUrn = await ask(
      adminCtx(),
      `mutation($a: ID!, $u: ID!) { ensureAppMember(appRef: $a, userRef: $u, role: "member") { userId role } }`,
      { a: app.urn, u: targetUser },
    );
    expect(ensuredByUrn.error).toBeNull();

    const removed = await ask(
      adminCtx(),
      `mutation($a: ID!, $u: ID!) { removeAppMember(appRef: $a, userRef: $u) }`,
      { a: app.urn, u: targetUser },
    );
    expect(removed.error).toBeNull();
    expect(removed.data).toBe(true);
    expect(await db.appMember.findUnique({ where: { appId_userId: { appId: app.id, userId: targetUser } } })).toBeNull();
  });

  // -- agent subscription -------------------------------------------------

  it('revokeAgentSubscription accepts userRef and agentRef as PK and as URN', async () => {
    await db.agentSubscription.create({
      data: { userId: targetUser, agentId: agent.id, createdBy: adminUser.id },
    });
    // A second row is revoked by the URN path.
    const secondUser = await db.user.create({
      data: { id: generateId(), githubId: 41424, githubUsername: 's6-target2', roles: ['READER'] },
    });
    await db.agentSubscription.create({
      data: { userId: secondUser.id, agentId: agent.id, createdBy: adminUser.id },
    });

    const byPk = await ask(
      adminCtx(),
      `mutation($u: ID!, $a: ID!) { revokeAgentSubscription(userRef: $u, agentRef: $a) { revokedAt } }`,
      { u: targetUser, a: agent.id },
    );
    expect(byPk.error).toBeNull();

    const byUrn = await ask(
      adminCtx(),
      `mutation($u: ID!, $a: ID!) { revokeAgentSubscription(userRef: $u, agentRef: $a) { revokedAt } }`,
      { u: secondUser.id, a: agent.urn },
    );
    expect(byUrn.error).toBeNull();
    expect(
      (await db.agentSubscription.findUnique({ where: { userId_agentId: { userId: secondUser.id, agentId: agent.id } } }))?.revokedAt,
    ).not.toBeNull();
  });

  // -- the org-member trio --------------------------------------------------

  it('add/update/remove OrgMember accept orgRef and userRef as PK and as URN', async () => {
    const added = await ask(
      adminCtx(),
      `mutation($o: ID!, $u: ID!) { addOrgMember(orgRef: $o, userRef: $u, role: CONTRIBUTOR) { id } }`,
      { o: org.id, u: targetUser },
    );
    expect(added.error).toBeNull();

    const updated = await ask(
      adminCtx(),
      `mutation($o: ID!, $u: ID!) { updateOrgMember(orgRef: $o, userRef: $u, role: READER) { id } }`,
      { o: org.urn, u: targetUser },
    );
    expect(updated.error).toBeNull();
    const member = await db.orgMember.findFirstOrThrow({
      where: { organizationId: org.id, userId: targetUser, deletedAt: null },
    });
    expect(member.role).toBe('READER');

    const removed = await ask(
      adminCtx(),
      `mutation($o: ID!, $u: ID!) { removeOrgMember(orgRef: $o, userRef: $u) }`,
      { o: org.urn, u: targetUser },
    );
    expect(removed.error).toBeNull();
    expect(removed.data).toBe(true);
  });

  // -- 4. blank refs: BAD_USER_INPUT naming only the ref, before any gate ---

  it.each([
    ['createMemorySubscription.memoryRef', `mutation { createMemorySubscription(memoryRef: "", orgRef: "x", role: READER) { role } }`, 'memoryRef is required.'],
    ['createMemorySubscription.orgRef', `mutation($m: ID!) { createMemorySubscription(memoryRef: $m, orgRef: " ", role: READER) { role } }`, 'orgRef is required.'],
    ['addOrgMember.orgRef', `mutation { addOrgMember(orgRef: "", userRef: "x", role: CONTRIBUTOR) { id } }`, 'orgRef is required.'],
    ['ensureAppMember.appRef', `mutation { ensureAppMember(appRef: "", userRef: "x", role: "member") { userId } }`, 'appRef is required.'],
    ['revokeAgentSubscription.agentRef', `mutation { revokeAgentSubscription(userRef: "x", agentRef: " ") { revokedAt } }`, 'agentRef is required.'],
  ])('%s: a blank ref refuses BAD_USER_INPUT before any gate', async (_label, query, message) => {
    const a = await ask(adminCtx(), query, { m: publicMemory.id });
    expect(a.error?.extensions.code).toBe('BAD_USER_INPUT');
    expect(a.error?.message).toBe(message);
  });

  // -- 5. resource-before-counterparty order (unchanged by the rename) ------

  it.each([
    ['createMemorySubscription', `mutation($m: ID!, $o: ID!) { createMemorySubscription(memoryRef: $m, orgRef: $o, role: READER) { role } }`, 'No match for memoryRef', (u: string) => ({ m: u, o: generateId() })],
    ['addOrgMember', `mutation($o: ID!, $u: ID!) { addOrgMember(orgRef: $o, userRef: $u, role: CONTRIBUTOR) { id } }`, 'No match for orgRef', (u: string) => ({ o: u, u: generateId() })],
    ['ensureAppMember', `mutation($a: ID!, $u: ID!) { ensureAppMember(appRef: $a, userRef: $u, role: "member") { userId } }`, 'No match for appRef', (u: string) => ({ a: u, u: generateId() })],
    ['revokeAgentSubscription', `mutation($u: ID!, $a: ID!) { revokeAgentSubscription(userRef: $u, agentRef: $a) { revokedAt } }`, 'No match for agentRef', (u: string) => ({ u: generateId(), a: u })],
  ])('%s resolves the resource before the counterparty', async (_label, query, expected, vars) => {
    const a = await ask(adminCtx(), query, vars(generateId()));
    expect(a.error?.extensions.code).toBe('NOT_FOUND');
    expect(a.error?.message).toContain(expected);
  });

  // -- 3. parity: a gate refusal is byte-identical for PK and URN inputs ----

  // Each case is a THUNK: the table is collected before beforeEach runs, so
  // touching the fixture rows at collection time reads undefined.
  it.each([
    // Memory gate family: a reader (can open, may not manage) hits the same
    // gate text whichever form named the memory.
    ['deleteMemory (memory gate)', `mutation($ref: ID!) { deleteMemory(ref: $ref) }`,
      () => ({ ctx: readerCtx(), pk: { ref: knowledgeMemory.id }, urn: { ref: knowledgeMemory.urn } })],
    // Subscription family: a non-ADMIN caller on a PUBLIC memory — the gate
    // is requireOrgRole, whose text names no input.
    ['createMemorySubscription (org gate)', `mutation($m: ID!, $o: ID!) { createMemorySubscription(memoryRef: $m, orgRef: $o, role: READER) { role } }`,
      () => ({ ctx: { db, userId: readerUser.id, roles: [] } as Context, pk: { m: publicMemory.id, o: subscriberOrg.id }, urn: { m: publicMemory.urn, o: subscriberOrg.urn } })],
    // App-member family: an unrelated caller removing someone else (self-removal
    // is legitimately allowed, so the caller must differ from the target).
    ['removeAppMember (app gate)', `mutation($a: ID!, $u: ID!) { removeAppMember(appRef: $a, userRef: $u) }`,
      () => ({ ctx: { db, userId: readerUser.id, roles: [] } as Context, pk: { a: app.id, u: targetUser }, urn: { a: app.urn, u: targetUser } })],
    // Org-member family: a non-admin caller.
    ['addOrgMember (org gate)', `mutation($o: ID!, $u: ID!) { addOrgMember(orgRef: $o, userRef: $u, role: CONTRIBUTOR) { id } }`,
      () => ({ ctx: readerCtx(), pk: { o: org.id, u: targetUser }, urn: { o: org.urn, u: targetUser } })],
  ])('%s: refused by PK and refused by URN are byte-identical (cor:api:140:03)', async (_label, query, make) => {
    const { ctx, pk, urn } = make();
    const byPk = await refusal(ask(ctx, query, pk));
    const byUrn = await refusal(ask(ctx, query, urn));
    expect(byUrn).toEqual(byPk);
    expect(byPk.code).toBe('FORBIDDEN');
  });

  // -- #4357 N1: the role gate runs BEFORE the target user is resolved (cor:api:140:02) --
  // The order is pinned as built: a non-admin names an EXISTING user and a MISSING one and gets the same refusal,
  // so a NOT_FOUND for the missing target would show that user resolution ran before the gate.
  it.each([
    ['addOrgMember', `mutation($o: ID!, $u: ID!) { addOrgMember(orgRef: $o, userRef: $u, role: CONTRIBUTOR) { id } }`],
    ['updateOrgMember', `mutation($o: ID!, $u: ID!) { updateOrgMember(orgRef: $o, userRef: $u, role: CONTRIBUTOR) { id } }`],
    ['removeOrgMember', `mutation($o: ID!, $u: ID!) { removeOrgMember(orgRef: $o, userRef: $u) }`],
  ])('%s: a non-admin gets one FORBIDDEN for an existing and a missing user', async (_label, query) => {
    const existing = await refusal(ask(readerCtx(), query, { o: org.id, u: targetUser }));
    const missing = await refusal(ask(readerCtx(), query, { o: org.id, u: `ghost-${generateId()}` }));
    expect(existing.code).toBe('FORBIDDEN');
    expect(missing).toEqual(existing);
  });

  it('removeAppMember: an unrelated caller gets one FORBIDDEN for an existing and a missing target (self-only miss-to-Forbidden)', async () => {
    const query = `mutation($a: ID!, $u: ID!) { removeAppMember(appRef: $a, userRef: $u) }`;
    const unrelated = (): Context => ({ db, userId: readerUser.id, roles: [] });
    const existing = await refusal(ask(unrelated(), query, { a: app.id, u: targetUser }));
    const missing = await refusal(ask(unrelated(), query, { a: app.id, u: `ghost-${generateId()}` }));
    expect(existing.code).toBe('FORBIDDEN');
    expect(missing).toEqual(existing);
  });
});

// ---------------------------------------------------------------------------
// 7. MCP: hadron_create_memory still maps `org` onto the renamed orgRef
// ---------------------------------------------------------------------------

describe('#4142 S6 — MCP hadron_create_memory', () => {
  it('maps its org input onto createMemory(orgRef) and emits the same prose', async () => {
    const auth: AuthContext = { userId: adminUser.id, roles: [], clientId: `user:${adminUser.id}` };
    const text = await createTestableMcpServer(auth).callToolText('hadron_create_memory', {
      name: 's6-mcp-memory', class: 'knowledge', org: org.urn,
    });
    // The two prose fragments are pinned byte-for-byte: clients parse them.
    expect(text).toMatch(/^Memory created: /);
    expect(text).toContain(' (class: knowledge, id: ');
    expect(text.endsWith('). Use hadron_set_active_memory to work in it.')).toBe(true);

    const row = await db.memory.findFirstOrThrow({ where: { name: 's6-mcp-memory' } });
    expect(row.organizationId).toBe(org.id); // the org input reached createMemory as orgRef
  });
});
