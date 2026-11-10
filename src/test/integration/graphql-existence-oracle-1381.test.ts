/**
 * #1381 — the GraphQL fields #1316 left must not tell an unreadable memory (or
 * a node inside one) from a missing one (`cor:api:140:03`).
 *
 * #1319, #1350 and #1379 closed the direct node doors, six memory-ref reads,
 * the MCP tools and the resolvers they delegate to. These are the rest: each
 * resolved the ref (only a MISSING target refuses there), then ran its own
 * authorization with its own denial — or, worse, ran a CLASS / ENCRYPTION
 * check first and echoed the answer — so "exists but not yours" differed from
 * "no such memory". Memory URNs are guessable.
 *
 * Every probe is PAIRED over real `/graphql` with a real UserApiKey: the same
 * request against an existing target and a missing one, compared as the whole
 * response after substituting only the caller-supplied ref. Every probe also
 * DECLARES what its missing side must answer, so a probe refused earlier than
 * the gate it means to test (input validation, a role check) fails loudly
 * instead of passing vacuously. Controls pin what must not change: a reader
 * keeps the actionable denial, a permitted owner still succeeds, faults
 * propagate, and a denied call leaves no side effect.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { mintUserApiKey, type OAuthScope } from '../../middleware/auth.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null, writtenNodes: [] }),
}));
vi.mock('../../integrations/github/pushMemoryToGit.js', () => ({
  pushMemoryToGit: vi.fn().mockResolvedValue({ error: null }),
}));

type GqlError = { message: string; extensions?: Record<string, unknown> };
type Gql = { status: number; data: unknown; errors: GqlError[] | undefined };

let server: Server;
let baseUrl: string;
let suffix: string;
let orgUrn: string;
const key: Record<string, string> = {};
const ids: Record<string, string> = {};

/** A target: the ref form a probe sends, for the existing and the missing side. */
type Target = { existing: string; missing: string; existingSlug?: string; missingSlug?: string };
const target: Record<string, Target> = {};

async function gql(principal: string, query: string, variables: Record<string, unknown>): Promise<Gql> {
  const response = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${key[principal]}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as { data?: unknown; errors?: GqlError[] };
  return { status: response.status, data: body.data, errors: body.errors };
}

const code = (r: Gql) => r.errors?.[0]?.extensions?.code;

/** The whole response with the caller's own ref replaced — the only permitted difference. */
function wire(r: Gql, ref: string, slug?: string): string {
  const out = JSON.stringify(r).split(ref).join('<REF>');
  return slug ? out.split(slug).join('<SLUG>') : out;
}

beforeAll(async () => {
  await cleanDb(db);
  suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  orgUrn = `oracle-1381-${suffix}`;
  const org = await db.organization.create({ data: { id: generateId(), name: 'victim org', urn: orgUrn } });
  const otherOrg = await db.organization.create({
    data: { id: generateId(), name: 'outsider org', urn: `oracle-1381-other-${suffix}` },
  });
  const mkUser = (label: string) =>
    db.user.create({
      data: { id: generateId(), handle: `${label}-${suffix}`, githubUsername: `${label}-${suffix}`, roles: ['READER'] },
    });
  const owner = await mkUser('owner');
  const reader = await mkUser('reader');
  const outsider = await mkUser('outsider');
  ids.owner = owner.id;
  ids.outsider = outsider.id;
  ids.reader = reader.id;
  ids.otherOrg = otherOrg.id;
  // An org the outsider does NOT administer: naming it sends deleteMemorySubscription
  // through its authorization refusal, not just its missing-row check.
  const neutralOrg = await db.organization.create({
    data: { id: generateId(), name: 'neutral org', urn: `oracle-1381-neutral-${suffix}` },
  });
  ids.neutralOrg = neutralOrg.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: owner.id, role: 'OWNER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader.id, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: otherOrg.id, userId: outsider.id, role: 'OWNER' } });

  const mint = async (userId: string, label: string, oauthScopes: OAuthScope[]) =>
    (await mintUserApiKey(db, { userId, label, createdBy: userId, issuedVia: 'test', oauthScopes })).rawKey;
  key.owner = await mint(owner.id, 'owner', ['account']);
  key.reader = await mint(reader.id, 'reader', ['account']);
  key.outsider = await mint(outsider.id, 'outsider', ['account']);

  // The victim: org knowledge, not PUBLIC. The reader may open and read it but
  // not administer it; the outsider may do neither.
  const victim = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${orgUrn}:victim-${suffix}`,
      name: 'victim',
      class: 'knowledge',
      visibility: 'ORGANIZATION',
    },
  });
  ids.victim = victim.id;
  const victimNode = await db.node.create({
    data: { id: generateId(), memoryId: victim.id, loc: 'probe', name: 'probe', content: 'needle' },
  });
  ids.victimNode = victimNode.id;
  // The owner's personal memory — the only shape attachMemoryToApp accepts.
  const personal = await db.memory.create({
    data: {
      id: generateId(),
      urn: `${orgUrn}:personal-${suffix}`,
      name: 'owner personal',
      class: 'personal',
      userId: owner.id,
      ownerUserId: owner.id,
    },
  });
  // The outsider's OWN writable memory — a legitimate other end for moves,
  // clones and merges, so the victim side is the only thing a pair varies.
  const own = await db.memory.create({
    data: {
      id: generateId(),
      urn: `${otherOrg.urn}:own-${suffix}`,
      name: 'outsider own',
      class: 'knowledge',
      ownerUserId: outsider.id,
    },
  });
  ids.own = own.id;
  ids.ownUrn = `hrn:mem:${own.urn}`;
  const ownNode = await db.node.create({ data: { id: generateId(), memoryId: own.id, loc: 'mine', name: 'mine' } });
  ids.ownNode = ownNode.id;
  // The reader's own writable memory + node, for the same reason: a reader
  // control must fail on the VICTIM's gate, not on a source it cannot see.
  const readerOwn = await db.memory.create({
    data: { id: generateId(), urn: `${orgUrn}:reader-own-${suffix}`, name: 'reader own', class: 'knowledge', ownerUserId: reader.id },
  });
  ids.reader_ownUrn = `hrn:mem:${readerOwn.urn}`;
  ids.reader_ownNode = (
    await db.node.create({ data: { id: generateId(), memoryId: readerOwn.id, loc: 'mine', name: 'mine' } })
  ).id;
  ids.outsider_ownUrn = ids.ownUrn;
  ids.outsider_ownNode = ownNode.id;

  target.memUrn = { existing: `hrn:mem:${victim.urn}`, missing: `hrn:mem:${orgUrn}:absent-${suffix}` };
  target.memId = { existing: victim.id, missing: generateId() };
  target.personalUrn = { existing: `hrn:mem:${personal.urn}`, missing: `hrn:mem:${orgUrn}:absent-personal-${suffix}` };
  target.nodeId = { existing: victimNode.id, missing: generateId() };
  // A destination NODE URN (moveNode/cloneNode `targetUrn`): the error names
  // only its memory part, so the slug is substituted as well as the whole ref.
  target.destNodeUrn = {
    existing: `hrn:node:${orgUrn}:victim-${suffix}:moved-in`,
    missing: `hrn:node:${orgUrn}:absent-${suffix}:moved-in`,
    existingSlug: `victim-${suffix}`,
    missingSlug: `absent-${suffix}`,
  };
  // An App-scoped PUBLIC knowledge memory: App-internal (#653), so the shared
  // read gate excludes it despite PUBLIC — and subscribing to it used to
  // SUCCEED for a caller who could not open it.
  const victimApp = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'victim app', urn: `${orgUrn}:victim-app-${suffix}` },
  });
  const appScoped = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      appId: victimApp.id,
      urn: `${orgUrn}:app-public-${suffix}`,
      name: 'app-scoped public',
      class: 'knowledge',
      visibility: 'PUBLIC',
    },
  });
  target.appPublicUrn = { existing: `hrn:mem:${appScoped.urn}`, missing: `hrn:mem:${orgUrn}:absent-app-${suffix}` };
  ids.appScoped = appScoped.id;
  ids.victimAppUrn = `hrn:app:${victimApp.urn}`;
  // A PUBLIC agent in the victim org: openable by anyone via agent(ref:) even
  // though the outsider holds no grant on it — the control that "can open" is
  // the kind's own read gate, not the audit's canRead.
  const publicAgent = await db.agent.create({
    data: { id: generateId(), organizationId: org.id, name: 'public agent', urn: `${orgUrn}:pubagent-${suffix}`, visibility: 'PUBLIC' } as never,
  });
  ids.publicAgentUrn = `hrn:agent:${orgUrn}:pubagent-${suffix}`;
  ids.publicAgentId = publicAgent.id;
  // A SYSTEM-class memory: mergeMemories refused its class before authorizing,
  // echoing `memoryClass` to anyone who named it.
  const system = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${orgUrn}:system-${suffix}`, name: 'sys', class: 'system' },
  });
  target.systemUrn = { existing: `hrn:mem:${system.urn}`, missing: `hrn:mem:${orgUrn}:absent-system-${suffix}` };
  // Neither this record nor its nodes admit an uninstalled org reader (#1807).
  await db.node.create({ data: { id: generateId(), memoryId: system.id, loc: 'brain', name: 'brain' } });
  ids.systemSlug = `system-${suffix}`;
  ids.victimOrgUrn = `hrn:org:${orgUrn}`;

  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

/** Everything a denied request must leave untouched. */
async function sideEffects() {
  const [memories, nodes, subscriptions] = await Promise.all([
    db.memory.findMany({
      where: { id: { in: [ids.victim!, ids.own!] } },
      select: { id: true, name: true, deletedAt: true, isEncrypted: true, sourceTokenEncrypted: true, appId: true },
      orderBy: { id: 'asc' },
    }),
    db.node.findMany({
      where: { memoryId: { in: [ids.victim!, ids.own!] } },
      select: { id: true, loc: true, memoryId: true, deletedAt: true, content: true },
      orderBy: { id: 'asc' },
    }),
    db.memorySubscription.count(),
  ]);
  return { memories, nodes, subscriptions, memoryCount: await db.memory.count() };
}

type Probe = {
  name: string;
  query: string;
  /** Which target this probe varies. */
  on: keyof typeof target | string;
  /** `p` is the calling principal, so its OWN resources fill the other end. */
  vars: (ref: string, p: string) => Record<string, unknown>;
  /** The missing side's error code — pinned, so a masked probe fails. */
  missingCode: string;
  /** Fields a reader may open but not administer: must keep a denial. `null` = reads, not denied. */
  readerDenied?: boolean;
};

const PROBES: Probe[] = [
  {
    name: 'usageEvents(memoryId:)',
    query: `query($r: ID!) { usageEvents(memoryId: $r) { id } }`,
    on: 'memUrn', vars: (r) => ({ r }), missingCode: 'MEMORY_NOT_FOUND', readerDenied: false,
  },
  {
    name: 'memoryAssets',
    query: `query($r: ID!) { memoryAssets(memoryId: $r) { total } }`,
    on: 'memUrn', vars: (r) => ({ r }), missingCode: 'NOT_FOUND', readerDenied: false,
  },
  {
    name: 'moveNode(targetMemoryRef:)',
    query: `mutation($s: ID!, $r: ID!) { moveNode(sourceRef: $s, targetMemoryRef: $r) { id } }`,
    on: 'memUrn', vars: (r, p) => ({ s: ids[`${p}_ownNode`], r }), missingCode: 'MEMORY_NOT_FOUND',
  },
  {
    name: 'moveNode(sourceRef:)',
    query: `mutation($r: ID!, $t: ID!) { moveNode(sourceRef: $r, targetMemoryRef: $t) { id } }`,
    on: 'nodeId', vars: (r, p) => ({ r, t: ids[`${p}_ownUrn`] }), missingCode: 'NODE_NOT_FOUND',
  },
  {
    name: 'moveNode(targetUrn:)',
    query: `mutation($s: ID!, $r: String!) { moveNode(sourceRef: $s, targetUrn: $r) { id } }`,
    on: 'destNodeUrn', vars: (r, p) => ({ s: ids[`${p}_ownNode`], r }), missingCode: 'MEMORY_NOT_FOUND',
  },
  {
    name: 'cloneNode(targetMemoryRef:)',
    query: `mutation($s: ID!, $r: ID!) { cloneNode(sourceRef: $s, targetMemoryRef: $r) { id } }`,
    on: 'memUrn', vars: (r, p) => ({ s: ids[`${p}_ownNode`], r }), missingCode: 'MEMORY_NOT_FOUND',
  },
  {
    name: 'replaceSubtree',
    query: `mutation($r: String!) { replaceSubtree(ownerRepo: "x", memoryId: $r, nodes: [], edges: []) }`,
    on: 'memUrn', vars: (r) => ({ r }), missingCode: 'MEMORY_NOT_FOUND',
  },
  {
    name: 'mergeMemories(source:)',
    query: `mutation($r: String!, $t: String!) { mergeMemories(input: {source: $r, target: $t}) { id } }`,
    on: 'memUrn', vars: (r, p) => ({ r, t: ids[`${p}_ownUrn`] }), missingCode: 'MEMORY_NOT_FOUND',
  },
  {
    name: 'mergeMemories(target:)',
    query: `mutation($s: String!, $r: String!) { mergeMemories(input: {source: $s, target: $r}) { id } }`,
    on: 'memUrn', vars: (r, p) => ({ s: ids[`${p}_ownUrn`], r }), missingCode: 'MEMORY_NOT_FOUND',
  },
  {
    name: 'mergeMemories(source: a system-class memory)',
    query: `mutation($r: String!, $t: String!) { mergeMemories(input: {source: $r, target: $t}) { id } }`,
    on: 'systemUrn', vars: (r, p) => ({ r, t: ids[`${p}_ownUrn`] }), missingCode: 'MEMORY_NOT_FOUND',
  },
  {
    name: 'deleteMemory(a personal memory)',
    query: `mutation($r: ID!) { deleteMemory(id: $r) }`,
    on: 'personalUrn', vars: (r) => ({ r }), missingCode: 'MEMORY_NOT_FOUND',
  },
  {
    name: 'attachMemoryToApp',
    query: `mutation($r: ID!) { attachMemoryToApp(memoryRef: $r, appRef: "no-such-app", agentRef: "no-such-agent") { id } }`,
    on: 'personalUrn', vars: (r) => ({ r }), missingCode: 'MEMORY_NOT_FOUND',
  },
  {
    name: 'deleteMemory',
    query: `mutation($r: ID!) { deleteMemory(id: $r) }`,
    on: 'memUrn', vars: (r) => ({ r }), missingCode: 'MEMORY_NOT_FOUND',
  },
  {
    name: 'encryptMemory',
    query: `mutation($r: ID!) { encryptMemory(memoryId: $r, passphrase: "correct horse battery staple") { id } }`,
    on: 'memUrn', vars: (r) => ({ r }), missingCode: 'MEMORY_NOT_FOUND',
  },
  {
    name: 'createMemorySubscription',
    query: `mutation($r: String!, $o: String!) { createMemorySubscription(memoryRef: $r, orgRef: $o, role: READER) { role } }`,
    on: 'memUrn', vars: (r) => ({ r, o: ids.otherOrg }), missingCode: 'NOT_FOUND',
  },
  {
    name: 'updateMemorySubscription',
    query: `mutation($r: String!, $o: String!) { updateMemorySubscription(memoryRef: $r, orgRef: $o, role: READER) { role } }`,
    on: 'memUrn', vars: (r) => ({ r, o: ids.otherOrg }), missingCode: 'NOT_FOUND',
  },
  {
    name: 'deleteMemorySubscription',
    query: `mutation($r: String!, $o: String!) { deleteMemorySubscription(memoryRef: $r, orgRef: $o) }`,
    on: 'memUrn', vars: (r) => ({ r, o: ids.otherOrg }), missingCode: 'NOT_FOUND',
  },
  {
    name: 'deleteMemorySubscription (an org the caller does not administer)',
    query: `mutation($r: String!, $o: String!) { deleteMemorySubscription(memoryRef: $r, orgRef: $o) }`,
    on: 'memUrn', vars: (r) => ({ r, o: ids.neutralOrg }), missingCode: 'NOT_FOUND',
  },
  {
    name: 'createMemorySubscription (an App-scoped PUBLIC memory the caller cannot open)',
    query: `mutation($r: String!, $o: String!) { createMemorySubscription(memoryRef: $r, orgRef: $o, role: READER) { role } }`,
    on: 'appPublicUrn', vars: (r) => ({ r, o: ids.otherOrg }), missingCode: 'NOT_FOUND',
  },
  // The org resolves AFTER the memory: an org error must not arrive first for
  // an existing memory when a missing memory refuses before it (@codex, PR #1383).
  ...(['create', 'update', 'delete'] as const).map((verb) => ({
    name: `${verb}MemorySubscription (a missing orgRef)`,
    query:
      verb === 'delete'
        ? `mutation($r: String!, $o: String!) { deleteMemorySubscription(memoryRef: $r, orgRef: $o) }`
        : `mutation($r: String!, $o: String!) { ${verb}MemorySubscription(memoryRef: $r, orgRef: $o, role: READER) { role } }`,
    on: 'memUrn',
    vars: (r: string) => ({ r, o: `no-such-org-${suffix}` }),
    missingCode: 'NOT_FOUND',
  })),
  {
    name: 'updateMemory(id:)',
    query: `mutation($r: ID!) { updateMemory(id: $r, name: "renamed") { id } }`,
    on: 'memId', vars: (r) => ({ r }), missingCode: 'MEMORY_NOT_FOUND',
  },
  {
    name: 'setMemorySourceToken(id:)',
    query: `mutation($r: ID!) { setMemorySourceToken(id: $r, token: "t") { id } }`,
    on: 'memId', vars: (r) => ({ r }), missingCode: 'MEMORY_NOT_FOUND',
  },
  {
    name: 'syncMemory(id:)',
    query: `mutation($r: ID!) { syncMemory(id: $r) { id } }`,
    on: 'memId', vars: (r) => ({ r }), missingCode: 'MEMORY_NOT_FOUND',
  },
  {
    name: 'pushMemoryToGit(id:)',
    query: `mutation($r: ID!) { pushMemoryToGit(id: $r) }`,
    on: 'memId', vars: (r) => ({ r }), missingCode: 'MEMORY_NOT_FOUND',
  },
];

describe('#1381 — an unreadable target answers exactly as a missing one', () => {
  it.each(PROBES.map((p) => [p.name, p] as const))('%s', async (_n, p) => {
    const t = target[p.on]!;
    const before = await sideEffects();
    const existing = await gql('outsider', p.query, p.vars(t.existing, 'outsider'));
    const missing = await gql('outsider', p.query, p.vars(t.missing, 'outsider'));
    // Pinned so a probe refused before the gate it tests cannot pass.
    expect(code(missing), JSON.stringify(missing.errors)).toBe(p.missingCode);
    expect(wire(existing, t.existing, t.existingSlug)).toBe(wire(missing, t.missing, t.missingSlug));
    // Nothing about the victim may surface beyond the caller's own ref — not
    // its id, class or encryption state. (An id-form ref IS the victim's id;
    // echoing the caller's own ref back is what the missing branch does too.)
    expect(wire(existing, t.existing)).not.toContain(ids.victim!);
    expect(await sideEffects()).toEqual(before);
  });
});

describe('#1381 — the id-only memory mutations resolve refs and miss typed', () => {
  // They used `findUniqueOrThrow` on the raw id: a miss surfaced Prisma's own
  // error text (server paths included), and a URN — which cor:api:140:01 says
  // every write reference accepts — got the same raw error.
  it.each(PROBES.filter((p) => p.on === 'memId').map((p) => [p.name, p] as const))(
    '%s: a missing URN is MEMORY_NOT_FOUND, and no Prisma text leaks',
    async (_n, p) => {
      const byUrn = await gql('outsider', p.query, p.vars(target.memUrn!.missing, 'outsider'));
      expect(code(byUrn)).toBe('MEMORY_NOT_FOUND');
      expect(JSON.stringify(byUrn)).not.toMatch(/prisma|findUniqueOrThrow|invocation/i);
    },
  );
});

describe('#1381 — combinations cannot rebuild the oracle', () => {
  // Concealing only at the later write gate would leak through ORDER: a missing
  // destination refuses at resolution, before the source's gate ever runs.
  it('moveNode: unreadable source + missing destination ≡ missing source + missing destination', async () => {
    const q = `mutation($s: ID!, $t: ID!) { moveNode(sourceRef: $s, targetMemoryRef: $t) { id } }`;
    const t = target.memUrn!.missing;
    const existing = await gql('outsider', q, { s: target.nodeId!.existing, t });
    const missing = await gql('outsider', q, { s: target.nodeId!.missing, t });
    expect(code(missing)).toBe('NODE_NOT_FOUND');
    expect(wire(existing, target.nodeId!.existing)).toBe(wire(missing, target.nodeId!.missing));
  });
});

describe('#1381 — controls: what concealment must not change', () => {
  it('an uninstalled system-memory reader gets the same refusal as a missing source', async () => {
    const probe = PROBES.find(p => p.on === 'systemUrn')!;
    const t = target.systemUrn!;
    const existing = await gql('reader', probe.query, probe.vars(t.existing, 'reader'));
    const missing = await gql('reader', probe.query, probe.vars(t.missing, 'reader'));
    expect(code(existing)).toBe(probe.missingCode);
    expect(wire(existing, t.existing)).toBe(wire(missing, t.missing));
  });

  it.each(PROBES.filter((p) => p.readerDenied !== false && p.on !== 'personalUrn' && p.on !== 'systemUrn').map((p) => [p.name, p] as const))(
    '%s: a reader who can open the memory keeps an actionable refusal',
    async (_n, p) => {
      const t = target[p.on]!;
      const before = await sideEffects();
      const refused = await gql('reader', p.query, p.vars(t.existing, 'reader'));
      const missing = await gql('reader', p.query, p.vars(t.missing, 'reader'));
      expect(refused.errors, p.name).toBeDefined();
      expect(wire(refused, t.existing, t.existingSlug)).not.toBe(wire(missing, t.missing, t.missingSlug));
      expect(await sideEffects()).toEqual(before);
    },
  );

  it.each(PROBES.filter((p) => p.readerDenied === false).map((p) => [p.name, p] as const))(
    '%s: a reader still reads',
    async (_n, p) => {
      const r = await gql('reader', p.query, p.vars(target[p.on]!.existing, 'reader'));
      expect(r.errors).toBeUndefined();
    },
  );

  it('a DB fault while classifying a denial propagates as a fault, never as not-found', async () => {
    // The record-gate classifier reads the memory row with `findUnique`; the
    // authorization it wraps here (requireOwnerOrOrgRole) does not, having
    // loaded the row already. The spy must fire, or this proves nothing.
    const probe = PROBES.find((p) => p.name === 'syncMemory(id:)')!;
    const before = await sideEffects();
    const fault = vi.spyOn(db.memory, 'findUnique').mockRejectedValueOnce(new Error('injected classification db failure'));
    try {
      const result = await gql('outsider', probe.query, probe.vars(target.memId!.existing, 'outsider'));
      expect(fault).toHaveBeenCalled();
      expect(code(result)).toBe('INTERNAL_SERVER_ERROR');
      // #1789: a fault is the generic envelope (detail goes to the log), and never NOT_FOUND/FORBIDDEN (Pin 1).
      expect(result.errors![0]!.message).toBe('Internal server error.');
      expect(result.errors![0]!.extensions).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', requestId: expect.any(String) });
    } finally {
      fault.mockRestore();
    }
    expect(await sideEffects()).toEqual(before);
  });

  it('deleteMemorySubscription: a MALFORMED orgRef on a hidden memory answers as the missing memory', async () => {
    // Both-or-neither is caller input: a missing memory refuses before the org
    // is parsed, so a hidden one must not answer BAD_USER_INPUT instead.
    const q = `mutation($r: String!, $o: String!, $i: ID!) { deleteMemorySubscription(memoryRef: $r, orgRef: $o, orgId: $i) }`;
    const existing = await gql('outsider', q, { r: target.memUrn!.existing, o: ids.otherOrg, i: ids.otherOrg });
    const missing = await gql('outsider', q, { r: target.memUrn!.missing, o: ids.otherOrg, i: ids.otherOrg });
    expect(code(missing)).toBe('NOT_FOUND');
    expect(wire(existing, target.memUrn!.existing)).toBe(wire(missing, target.memUrn!.missing));
  });

  it('deleteMemorySubscription: an AMBIGUOUS org alias on a hidden memory answers as the missing memory', async () => {
    // Two live orgs claiming one legacy URN make resolveOrgRef throw
    // AmbiguousLegacyUrnError — caller input, like a malformed ref (@codex, PR #1383).
    const shared = `oracle-1381-ambig-${suffix}`;
    const a = await db.organization.create({ data: { id: generateId(), name: 'ambig a', urn: `${shared}-a` } });
    const b = await db.organization.create({ data: { id: generateId(), name: 'ambig b', urn: `${shared}-b` } });
    await db.urnAlias.createMany({
      data: [a, b].map((o) => ({ id: generateId(), urn: shared, entityType: 'ORGANIZATION' as const, entityId: o.id, reason: 'RENAME' as const })),
    });
    const q = `mutation($r: String!, $o: String!) { deleteMemorySubscription(memoryRef: $r, orgRef: $o) }`;
    // Positive control: a caller who CAN open the memory sees the ambiguity itself.
    const visible = await gql('reader', q, { r: target.memUrn!.existing, o: `hrn:org:${shared}` });
    expect(visible.errors?.[0]?.message ?? '', 'precondition: the alias really is ambiguous').toMatch(/ambiguous|more than one/i);
    const existing = await gql('outsider', q, { r: target.memUrn!.existing, o: `hrn:org:${shared}` });
    const missing = await gql('outsider', q, { r: target.memUrn!.missing, o: `hrn:org:${shared}` });
    expect(code(missing)).toBe('NOT_FOUND');
    expect(wire(existing, target.memUrn!.existing)).toBe(wire(missing, target.memUrn!.missing));
  });

  it('deleteMemorySubscription: a fault resolving the org propagates, even for a hidden memory', async () => {
    const q = `mutation($r: String!, $o: String!) { deleteMemorySubscription(memoryRef: $r, orgRef: $o) }`;
    const fault = vi.spyOn(db.organization, 'findFirst').mockRejectedValueOnce(new Error('injected org-resolution db failure'));
    try {
      const result = await gql('outsider', q, { r: target.memUrn!.existing, o: `oracle-1381-neutral-${suffix}` });
      expect(fault).toHaveBeenCalled();
      expect(code(result)).toBe('INTERNAL_SERVER_ERROR');
      // #1789: a fault is the generic envelope (detail goes to the log), and never NOT_FOUND/FORBIDDEN (Pin 1).
      expect(result.errors![0]!.message).toBe('Internal server error.');
      expect(result.errors![0]!.extensions).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', requestId: expect.any(String) });
    } finally {
      fault.mockRestore();
    }
  });

  it('a fault inside the write authorization at resolution propagates, never as not-found', async () => {
    // resolveMemoryRefForWrite runs requireMemoryWriteAccess to decide
    // "hidden"; its first DB read is this `findUniqueOrThrow` (resolution
    // itself uses findFirst). A fault there must reach the caller as itself —
    // treating it as "cannot write" would turn an outage into "no such memory".
    const probe = PROBES.find((p) => p.name === 'replaceSubtree')!;
    const fault = vi
      .spyOn(db.memory, 'findUniqueOrThrow')
      .mockRejectedValueOnce(new Error('injected write-authorization db failure'));
    try {
      const result = await gql('outsider', probe.query, probe.vars(target.memUrn!.existing, 'outsider'));
      expect(fault).toHaveBeenCalled();
      expect(code(result)).toBe('INTERNAL_SERVER_ERROR');
      // #1789: a fault is the generic envelope (detail goes to the log), and never NOT_FOUND/FORBIDDEN (Pin 1).
      expect(result.errors![0]!.message).toBe('Internal server error.');
      expect(result.errors![0]!.extensions).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', requestId: expect.any(String) });
    } finally {
      fault.mockRestore();
    }
  });

  // Last: it succeeds, so it moves the side-effect baseline.
  it('the owner still administers the memory, by id and by URN', async () => {
    const byId = await gql('owner', `mutation($r: ID!) { updateMemory(id: $r, name: "by id") { name } }`, { r: ids.victim });
    expect(byId.errors, JSON.stringify(byId.errors)).toBeUndefined();
    const byUrn = await gql('owner', `mutation($r: ID!) { updateMemory(id: $r, name: "by urn") { name } }`, {
      r: target.memUrn!.existing,
    });
    expect(byUrn.errors, JSON.stringify(byUrn.errors)).toBeUndefined();
    expect((byUrn.data as { updateMemory: { name: string } }).updateMemory.name).toBe('by urn');
  });
});

describe('#1381 — effectiveAccess (cor:acl:060:01, amended 2026-09-26)', () => {
  const AUDIT = `query($u: ID!, $r: ID!) { effectiveAccess(user: $u, resource: $r) { resourceUrn canRead } }`;
  const audit = (as: string, subject: string, resource: string) => gql(as, AUDIT, { u: subject, r: resource });
  const nodeUrn = (slug: string, loc: string) => `hrn:node:${orgUrn}:${slug}:${loc}`;

  it('self-audit of an unopenable memory ≡ a missing memory', async () => {
    const existing = await audit('outsider', ids.outsider!, target.memUrn!.existing);
    const missing = await audit('outsider', ids.outsider!, target.memUrn!.missing);
    expect(code(missing)).toBe('NOT_FOUND');
    expect(wire(existing, target.memUrn!.existing)).toBe(wire(missing, target.memUrn!.missing));
  });

  it('self-audit of a node in an unopenable memory ≡ a missing node, in it or anywhere', async () => {
    const slug = `victim-${suffix}`;
    const existing = await audit('outsider', ids.outsider!, nodeUrn(slug, 'probe'));
    const missingLoc = await audit('outsider', ids.outsider!, nodeUrn(slug, 'no-such-loc'));
    const missingMem = await audit('outsider', ids.outsider!, nodeUrn(`absent-${suffix}`, 'probe'));
    expect(code(missingLoc)).toBe('NOT_FOUND');
    expect(wire(existing, 'probe')).toBe(wire(missingLoc, 'no-such-loc'));
    expect(JSON.stringify(existing.errors)).toBe(JSON.stringify(missingMem.errors));
  });

  it('a memory-shaped resource conceals for EVERY caller, not only a self-auditor', async () => {
    // The outsider auditing the READER's access: the caller gate would answer
    // FORBIDDEN, but the memory is unopenable to the caller, so NOT_FOUND first.
    const existing = await audit('outsider', ids.reader!, target.memUrn!.existing);
    const missing = await audit('outsider', ids.reader!, target.memUrn!.missing);
    expect(code(missing)).toBe('NOT_FOUND');
    expect(wire(existing, target.memUrn!.existing)).toBe(wire(missing, target.memUrn!.missing));
  });

  it('self-audit of an unopenable App ≡ a missing App', async () => {
    const existing = await audit('outsider', ids.outsider!, ids.victimAppUrn!);
    const missing = await audit('outsider', ids.outsider!, `hrn:app:${orgUrn}:no-such-app-${suffix}`);
    expect(code(missing)).toBe('NOT_FOUND');
    expect(wire(existing, ids.victimAppUrn!)).toBe(wire(missing, `hrn:app:${orgUrn}:no-such-app-${suffix}`));
  });

  it('a node is judged by the NODE gate: an uninstalled system-memory reader gets NOT_FOUND for its node', async () => {
    const existing = await audit('reader', ids.reader!, nodeUrn(ids.systemSlug!, 'brain'));
    const missing = await audit('reader', ids.reader!, nodeUrn(ids.systemSlug!, 'no-such-loc'));
    expect(code(missing)).toBe('NOT_FOUND');
    expect(wire(existing, 'brain')).toBe(wire(missing, 'no-such-loc'));
  });

  it('self-audit of an org the caller cannot open (a denial, not a null) ≡ a missing org', async () => {
    const existing = await audit('outsider', ids.outsider!, ids.victimOrgUrn!);
    const missing = await audit('outsider', ids.outsider!, `hrn:org:no-such-org-${suffix}`);
    expect(code(missing)).toBe('NOT_FOUND');
    expect(wire(existing, ids.victimOrgUrn!)).toBe(wire(missing, `hrn:org:no-such-org-${suffix}`));
  });

  it('a fault while judging an App is never masked as NOT_FOUND (@codex / @copilot, PR #1383)', async () => {
    // app(ref:) swallows EVERY resolution error into null. Judging "can open"
    // through it turned a fault in its re-resolution into NOT_FOUND for a
    // caller who CAN open the App. The second app.findFirst is the one that
    // re-resolution would issue; fail only that one.
    const control = await audit('reader', ids.reader!, ids.victimAppUrn!);
    expect(control.errors, 'precondition: the reader can open this App').toBeUndefined();
    const real = db.app.findFirst.bind(db.app);
    const fault = vi
      .spyOn(db.app, 'findFirst')
      .mockImplementationOnce(((...a: Parameters<typeof real>) => real(...a)) as never)
      .mockRejectedValueOnce(new Error('injected app re-resolution failure'));
    try {
      const r = await audit('reader', ids.reader!, ids.victimAppUrn!);
      expect(code(r)).not.toBe('NOT_FOUND');
      expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    } finally {
      fault.mockRestore();
    }
  });

  it('control: a reader self-auditing a memory they can open still gets the audit', async () => {
    const r = await audit('reader', ids.reader!, target.memUrn!.existing);
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect((r.data as { effectiveAccess: { canRead: boolean } }).effectiveAccess.canRead).toBe(true);
  });

  it('control: a PUBLIC agent is openable by anyone, so its self-audit is answered, not concealed', async () => {
    const r = await audit('outsider', ids.outsider!, ids.publicAgentUrn!);
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
  });

  it('unchanged (open for Holger, per Vera): a non-self audit of a non-memory resource stays FORBIDDEN', async () => {
    const r = await audit('outsider', ids.reader!, ids.victimAppUrn!);
    expect(code(r)).toBe('FORBIDDEN');
  });
});
