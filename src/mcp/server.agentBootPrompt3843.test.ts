/**
 * #3843 (cor:agt:040:05, :10; cor:dmo:150:08; cor:agt:020:03): an MCP-only agent reads its compiled boot prompt as
 * served, with no worker binding and no serving record.
 *
 * GraphQL `agentServedBootPrompt(agentRef, appRef, llmModel)` and MCP `hadron_agent_boot_prompt` are one read: the serve
 * resolver every surface uses (`resolveServedBootPrompt`), filled the way a chat fills it (`agentPlatformValues` plus the
 * client-reported model, no derived blocks). Every assertion goes through the REAL wire: an HTTP POST to `/graphql`
 * selecting the real SDL field, and the MCP tool over real Streamable HTTP `/mcp`
 * (findings:serve-refusal-needs-sdl-selection-pin).
 *
 * Pins, by the gate's numbering (attachment 6766087519 §6, CHECKED 6766226589):
 *  1 served (Agent only), with GraphQL/MCP text parity;  2 the older approved revision when the newest is unapproved;
 *  3 typed refusals on both surfaces;  4 a hidden Agent answers as a nonexistent one, with or without a pointer;
 *  5 cross-App, not-installed and a lapsed licence answer as not-found;  6 install-pointer precedence, no worker
 *  override;  7 no binding and no record, for a user key, an App key and a sign-in carrying a session;
 *  8 no derived blocks;  11 the model fill.  (9 = mutants, run by hand; 10 = the tool goldens.)
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { hashUserApiKey, USER_API_KEY_PREFIX } from '../middleware/auth.js';
import { signJwt } from '../auth/jwt.js';
import { createSignIn } from '../auth/signIn.js';
import { serveAgentBootPrompt } from '../test/servedBootPrompt.js';
import { withCompileWrite } from '../lib/bootPrompt.js';
import { sha256Hex } from '../lib/bootCompile/provenance.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
import { ensureChannelWithRoot } from '../lib/channels.js';
import { readAgentServedBootPrompt } from '../api/graphql/schema/resolvers.bootPromptPointer.js';
import { runAuthContext } from '../lib/auth/runPrincipal.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const TOOL = 'hadron_agent_boot_prompt';
const PROMPT = 'You are {{worker.name}} ({{worker.role}}). Model: [{{session.llmModel}}]. Signature: [{{worker.signature}}].';
const rendered = (model = '') => `You are Role (tester). Model: [${model}]. Signature: [].`;
const QUERY = `query($a: String!, $p: String, $m: String) {
  agentServedBootPrompt(agentRef: $a, appRef: $p, llmModel: $m) { text decision { pointerLevel compiledNodeId servedRevSeq } }
}`;

type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };
type Gql = { data?: { agentServedBootPrompt: { text: string; decision: { pointerLevel: string; compiledNodeId: string; servedRevSeq: number } } | null } | null; errors?: Array<{ message: string; extensions?: Record<string, unknown> }> };

let http: Server;
let base: string;
const clients: Client[] = [];

let orgId: string;
let agentId: string;
let agentCompiledId: string;
let appId: string;
let otherAppId: string;
let personalAppId: string;
let holderId: string;
let adminId: string;
let sessionId: string;
const tokens: Record<'admin' | 'outsider' | 'member' | 'appKey' | 'otherAppKey' | 'signIn', string> = {} as never;

beforeAll(async () => {
  http = createHttpServer(await createServer());
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  await new Promise<void>((r) => http.close(() => r()));
});
afterEach(() => { vi.unstubAllEnvs(); });

async function userKey(userId: string): Promise<string> {
  const raw = `${USER_API_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  await db.userApiKey.create({ data: { userId, oauthScopes: [], keyHash: hashUserApiKey(raw), keyPreview: raw.slice(-4) } });
  return raw;
}
async function appKey(forApp: string): Promise<string> {
  const raw = `hdr_app_${randomBytes(32).toString('hex')}`;
  await db.appKey.create({ data: { appId: forApp, keyHash: createHash('sha256').update(raw).digest('hex'), keyPreview: raw.slice(0, 12) } });
  return raw;
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'BootRead3843', urn: 'bp3843.test' } });
  orgId = org.id;
  const admin = await db.user.create({ data: { handle: 'bp3843-admin', roles: ['READER'] } });
  adminId = admin.id;
  const outsider = await db.user.create({ data: { handle: 'bp3843-outsider', roles: ['READER'] } });
  const member = await db.user.create({ data: { handle: 'bp3843-member', roles: ['READER'] } });
  const holder = await db.user.create({ data: { handle: 'bp3843-holder', roles: ['READER'] } });
  holderId = holder.id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: member.id, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: holder.id, role: 'READER' } });

  const system = await db.memory.create({ data: { class: 'system', organizationId: orgId, name: 'System', urn: 'bp3843.test:system' } });
  const agent = await db.agent.create({ data: {
    organizationId: orgId, name: 'Role', urn: 'bp3843.test:role', visibility: 'ORGANIZATION', personaRole: 'tester', systemMemoryId: system.id,
  } });
  agentId = agent.id;
  agentCompiledId = await serveAgentBootPrompt(db, agentId, PROMPT);

  const app = await db.app.create({ data: { organizationId: orgId, name: 'Team', urn: 'bp3843.test:team' } });
  appId = app.id;
  await db.appAgent.create({ data: { appId, agentId } });
  const other = await db.app.create({ data: { organizationId: orgId, name: 'Other', urn: 'bp3843.test:other' } });
  otherAppId = other.id; // the Agent is NOT installed here

  // A personal App of `holder`, running the org Agent on holder's licence; `member` is its AppMember (and an org reader,
  // so the chat gate alone would admit them). Ending holder's membership lapses the licence.
  await db.agentSubscription.create({ data: { userId: holder.id, agentId, activatedAt: new Date('2020-01-01') } });
  const personal = await db.app.create({ data: { ownerUserId: holder.id, name: 'Personal', urn: '@bp3843-holder:personal' } });
  personalAppId = personal.id;
  await db.appMember.create({ data: { appId: personalAppId, userId: holder.id, role: 'owner' } });
  await db.appMember.create({ data: { appId: personalAppId, userId: member.id, role: 'member' } });
  await db.appAgent.create({ data: { appId: personalAppId, agentId } });

  tokens.admin = await userKey(admin.id);
  tokens.outsider = await userKey(outsider.id);
  tokens.member = await userKey(member.id);
  tokens.appKey = await appKey(appId);
  tokens.otherAppKey = await appKey(otherAppId);
  const signIn = await db.$transaction((tx) => createSignIn(tx, { userId: admin.id, method: 'email', passkeyId: null }));
  tokens.signIn = await signJwt({ sub: admin.id, roles: [], email: 'admin@bp3843.test', sid: signIn.id });
  sessionId = (await db.session.create({ data: { id: generateId(), appId, userId: admin.id, agentId, type: 'DEVELOPER', startedAt: new Date() } })).id;
});

const headersFor = (token: string, session?: string) => ({
  Authorization: `Bearer ${token}`, ...(session ? { 'x-hadron-session': session } : {}),
});

async function gql(token: string, vars: { a: string; p?: string | null; m?: string | null }, session?: string): Promise<Gql> {
  const res = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headersFor(token, session) },
    body: JSON.stringify({ query: QUERY, variables: vars }),
  });
  return (await res.json()) as Gql;
}

async function mcp(token: string, args: Record<string, unknown>, session?: string): Promise<ToolResult> {
  const client = new Client({ name: 'boot-read-3843', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: headersFor(token, session) } }));
  clients.push(client);
  const result = (await client.callTool({ name: TOOL, arguments: args })) as ToolResult;
  expect(textOf(result)).not.toMatch(/Input validation error|Tool .* not found/);
  return result;
}

const textOf = (r: ToolResult) => (r.content ?? []).map((c) => c.text ?? '').join('\n');
/** A GraphQL refusal as the MCP tool writes it: `[CODE] message`. */
const wireRefusal = (r: Gql) => {
  expect(r.data?.agentServedBootPrompt ?? null).toBeNull();
  expect(r.errors).toHaveLength(1);
  return `[${r.errors![0].extensions?.code}] ${r.errors![0].message}`;
};
/** Everything after the MCP header's first blank line: the text itself. */
const bodyOf = (r: ToolResult) => { const t = textOf(r); const i = t.indexOf('\n\n'); return i < 0 ? null : t.slice(i + 2); };
const mcpArgs = (v: { a: string; p?: string | null; m?: string | null }) => ({ agentRef: v.a, ...(v.p ? { appRef: v.p } : {}), ...(v.m != null ? { llmModel: v.m } : {}) });

/** Both surfaces, the same arguments, the same credentials. */
async function both(token: string, v: { a: string; p?: string | null; m?: string | null }, session?: string) {
  return { g: await gql(token, v, session), t: await mcp(token, mcpArgs(v), session) };
}

/** The answer for a nonexistent Agent, with the caller's ref substituted, so a hidden one can be compared byte for byte. */
const GHOST = '01a0ffffffffffffffffffffffffffff';
async function notFound(token: string, ref: string) {
  const { g, t } = await both(token, { a: GHOST });
  return { g: wireRefusal(g).split(GHOST).join(ref), t: JSON.stringify(t).split(GHOST).join(ref) };
}
async function expectMasked(token: string, v: { a: string; p?: string | null; m?: string | null }) {
  const want = await notFound(token, v.a);
  const { g, t } = await both(token, v);
  expect(wireRefusal(g)).toBe(want.g);
  expect(JSON.stringify(t)).toBe(want.t);
  expect(want.g).toMatch(/^\[AGENT_NOT_FOUND\]/);
}

async function expectRefused(token: string, v: { a: string; p?: string | null }, code: string, message: string) {
  const { g, t } = await both(token, v);
  expect(g.errors?.[0]?.extensions).toMatchObject({ code, surface: 'chat', agentName: 'Role' });
  expect(wireRefusal(g)).toBe(`[${code}] ${message}`);
  expect(t.isError).toBe(true);
  expect(textOf(t)).toBe(`[${code}] ${message}`);
}

async function compiledNode(content: string, approved: boolean): Promise<string> {
  const id = await serveAgentBootPrompt(db, agentId, content);
  if (!approved) await db.node.update({ where: { id }, data: { approvedRevNo: null, approvedAt: null, approvedByInfo: null, approvalHash: null } });
  return id;
}
const pointer = (id: string | null) => ({ bootPromptNodeId: id, bootPromptUrn: id ? `u:${id}` : null });

describe('1, 8, 11: served text, parity, no derived blocks, the model', () => {
  it('1: an approved Agent prompt is served, filled as a chat fills it, identically on GraphQL and MCP', async () => {
    const { g, t } = await both(tokens.admin, { a: agentId });
    expect(g.errors).toBeUndefined();
    expect(g.data!.agentServedBootPrompt).toEqual({ text: rendered(), decision: { pointerLevel: 'AGENT', compiledNodeId: agentCompiledId, servedRevSeq: 1 } });
    expect(t.isError).toBeFalsy();
    expect(bodyOf(t)).toBe(g.data!.agentServedBootPrompt!.text);
    const [l1, l2, l3, blank] = textOf(t).split('\n');
    expect(l1).toBe(`Served boot prompt for Agent ${agentId}: AGENT pointer, revision 1.`);
    expect(l2).toBe(`Compiled node: hrn:node:bp3843.test:system:${(await db.node.findUniqueOrThrow({ where: { id: agentCompiledId } })).loc}`);
    expect(l3).toBe('Rendered as a chat or run would be given it: no worker, no derived blocks; session.llmModel = .');
    expect(blank).toBe('');
  });

  it('11: a client-reported model fills session.llmModel on both surfaces; without one it is empty', async () => {
    const withModel = await both(tokens.admin, { a: agentId, m: 'm-1' });
    expect(withModel.g.data!.agentServedBootPrompt!.text).toBe(rendered('m-1'));
    expect(bodyOf(withModel.t)).toBe(rendered('m-1'));
    expect(textOf(withModel.t).split('\n')[2]).toBe('Rendered as a chat or run would be given it: no worker, no derived blocks; session.llmModel = m-1.');
    const without = await both(tokens.admin, { a: agentId });
    expect(without.g.data!.agentServedBootPrompt!.text).toBe(rendered());
    expect(bodyOf(without.t)).toBe(rendered());
  });

  it('8: a worker of the App with register entries (whose own briefing carries a derived block) does not change the text', async () => {
    const shared = await db.memory.create({ data: { organizationId: orgId, urn: 'bp3843.test:team-shared', name: 'shared', class: 'app', appId, sharedMemoryOfAgentId: agentId } });
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name: 'Dara', slug: 'dara' } });
    const made = await ensureChannelWithRoot(db, { memoryId: shared.id, loc: 'chats:team', name: 'team', createdBy: adminId, asDefaultOfAppId: appId });
    await db.registerEntry.create({ data: { id: generateId(), appId, channelId: made.channel.id, attendeeWorkerId: worker.id, role: 'BOTH' } });
    // Control: the worker's own briefing (a worker path) does append a derived block.
    const briefing = await fetch(`${base}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json', ...headersFor(tokens.admin) },
      body: JSON.stringify({ query: 'query($w: ID!) { worker(ref: $w) { prompt } }', variables: { w: worker.id } }) }).then((r) => r.json()) as { data: { worker: { prompt: string } } };
    expect(briefing.data.worker.prompt.length).toBeGreaterThan(rendered().length);
    for (const v of [{ a: agentId }, { a: agentId, p: appId }]) {
      const { g, t } = await both(tokens.admin, v);
      expect(g.data!.agentServedBootPrompt!.text).toBe(rendered());
      expect(bodyOf(t)).toBe(rendered());
    }
  });
});

describe('2, 3: the served revision, and the typed refusals', () => {
  it('2: a newer unapproved revision leaves the older approved text served, not a refusal', async () => {
    const n = await db.node.findUniqueOrThrow({ where: { id: agentCompiledId } });
    await db.nodeRevision.create({ data: { nodeId: n.id, memoryId: n.memoryId, loc: n.loc, name: n.name, content: n.content, revNo: n.revSeq, tags: [],
      approvedAt: n.approvedAt, approvedByInfo: n.approvedByInfo, approvalHash: n.approvalHash } as never });
    await withCompileWrite(() => db.node.update({ where: { id: n.id }, data: { content: 'Unapproved draft.', revSeq: n.revSeq + 1, contentRevSeq: n.revSeq + 1 } }));
    await db.compiledPromptRevision.create({ data: { compiledNodeId: n.id, compiledRevNo: n.revSeq + 1, contentHash: sha256Hex('Unapproved draft.'), targetKind: 'AGENT',
      targetAgentId: agentId, provenance: { version: 1, occurrences: [] } as never, occurrenceCount: 0 } });
    const { g, t } = await both(tokens.admin, { a: agentId });
    expect(g.errors).toBeUndefined();
    expect(g.data!.agentServedBootPrompt).toMatchObject({ text: rendered(), decision: { servedRevSeq: 1 } });
    expect(bodyOf(t)).toBe(rendered());
  });

  it('3: NOT_SET', async () => {
    await db.agent.update({ where: { id: agentId }, data: pointer(null) });
    await expectRefused(tokens.admin, { a: agentId }, 'BOOT_PROMPT_NOT_SET', 'No boot prompt is set for this Agent, so it cannot be served.');
  });

  it('3: NOT_APPROVED', async () => {
    await db.agent.update({ where: { id: agentId }, data: pointer(await compiledNode('Draft.', false)) });
    await expectRefused(tokens.admin, { a: agentId }, 'BOOT_PROMPT_NOT_APPROVED', "This Agent's boot prompt has no approved revision, so it cannot be served.");
  });

  it('3: TARGET_DELETED', async () => {
    await db.node.delete({ where: { id: agentCompiledId } });
    await expectRefused(tokens.admin, { a: agentId }, 'BOOT_PROMPT_TARGET_DELETED', "This Agent's boot prompt was deleted, so it cannot be served.");
  });

  it('3: NOT_SIGNED (the App arm, with the org switch and deployment signing on)', async () => {
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
    await db.organization.update({ where: { id: orgId }, data: { bootPromptSigningRequired: true } });
    await expectRefused(tokens.admin, { a: agentId, p: appId }, 'BOOT_PROMPT_NOT_SIGNED', "This Agent's boot prompt has no signed revision, so it cannot be served.");
  });
});

describe('4, 5: masking, judged before anything is resolved', () => {
  it('4: a caller who cannot read the system memory gets the nonexistent-Agent answer, with or without a pointer', async () => {
    await expectMasked(tokens.outsider, { a: agentId });
    await db.agent.update({ where: { id: agentId }, data: pointer(null) });
    await expectMasked(tokens.outsider, { a: agentId });
  });

  it('5: a non-participant App, an App key for another App, a missing App and an App without the install are not-found', async () => {
    await expectMasked(tokens.outsider, { a: agentId, p: appId });
    await expectMasked(tokens.otherAppKey, { a: agentId, p: appId });
    await expectMasked(tokens.admin, { a: agentId, p: GHOST });
    await expectMasked(tokens.admin, { a: agentId, p: otherAppId });
    await db.agent.update({ where: { id: agentId }, data: pointer(null) });
    await expectMasked(tokens.admin, { a: agentId, p: otherAppId });
  });

  it('5: each App-arm gate masks on its own (participation, the own-App key rule, the chat audience)', async () => {
    // Participation alone: an org reader may chat with the Agent and read its system memory, but is not a participant
    // of App P (an org App admits CONTRIBUTOR+ or an AppMember). The Agent-only arm stays readable to them.
    await expectMasked(tokens.member, { a: agentId, p: appId });
    expect((await gql(tokens.member, { a: agentId })).data!.agentServedBootPrompt!.text).toBe(rendered());

    // The own-App key rule alone: a key for App Z, which ALSO installs the Agent (so the chat gate admits that key),
    // names App P. Control: the same key reads its own App.
    const z = await db.app.create({ data: { organizationId: orgId, name: 'Zed', urn: 'bp3843.test:zed' } });
    await db.appAgent.create({ data: { appId: z.id, agentId } });
    const zKey = await appKey(z.id);
    expect((await gql(zKey, { a: agentId, p: z.id })).data!.agentServedBootPrompt!.text).toBe(rendered());
    await expectMasked(zKey, { a: agentId, p: appId });

    // The chat audience alone: App P installs another organisation's Agent. A CONTRIBUTOR of P's org participates in P,
    // the Agent is installed and P is an org App (licence rule n/a), but the caller can't chat with an Agent of an org
    // they are not in and through no App they are a member of.
    const org2 = await db.organization.create({ data: { name: 'Publisher3843', urn: 'pub3843.test' } });
    const sys2 = await db.memory.create({ data: { class: 'system', organizationId: org2.id, name: 'System', urn: 'pub3843.test:system' } });
    const foreign = await db.agent.create({ data: { organizationId: org2.id, name: 'Foreign', urn: 'pub3843.test:foreign', visibility: 'ORGANIZATION', systemMemoryId: sys2.id } });
    await serveAgentBootPrompt(db, foreign.id, 'Foreign text.');
    await db.appAgent.create({ data: { appId, agentId: foreign.id } });
    const contributor = await db.user.create({ data: { handle: 'bp3843-contrib', roles: ['READER'] } });
    await db.orgMember.create({ data: { organizationId: orgId, userId: contributor.id, role: 'CONTRIBUTOR' } });
    await expectMasked(await userKey(contributor.id), { a: foreign.id, p: appId });
  });

  it('5 (amendment 6766414749): principal shape — own key reads, anonymous, run-shaped and hybrid-selection callers do not', async () => {
    // Own-App key positive, on both surfaces.
    const own = await both(tokens.appKey, { a: agentId, p: appId });
    expect(own.g.data!.agentServedBootPrompt!.text).toBe(rendered());
    expect(bodyOf(own.t)).toBe(rendered());
    // Anonymous over real GraphQL: the not-found a nonexistent Agent gets.
    const anon = async (a: string) => (await fetch(`${base}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { a, p: appId } }) }).then((r) => r.json())) as Gql;
    expect(wireRefusal(await anon(agentId))).toBe(wireRefusal(await anon(GHOST)).split(GHOST).join(agentId));
    // The resolver itself, for principals HTTP can't mint: answers compared with a nonexistent Agent's.
    const read = async (ctx: Context, a: string) => { try { await readAgentServedBootPrompt(ctx, { agentRef: a, appRef: appId }); return 'SERVED'; }
      catch (e) { return `${(e as { code?: string }).code ?? (e as Error).name}: ${(e as Error).message.split(a).join('<A>')}`; } };
    const masked = async (ctx: Context) => { const want = await read(ctx, GHOST); expect(want).toMatch(/AGENT_NOT_FOUND|AgentNotFound/); expect(await read(ctx, agentId)).toBe(want); };
    // A headless run of App P with no person: its appId is not an App key.
    await masked({ db, ...runAuthContext({ id: generateId(), appId, userId: null, organizationId: orgId }) } as unknown as Context);
    // Even with an appKeyId copied in, a run-shaped principal is not an App key.
    const keyRow = await db.appKey.findFirstOrThrow({ where: { appId } });
    await masked({ db, ...runAuthContext({ id: generateId(), appId, userId: null, organizationId: orgId }), appKeyId: keyRow.id } as unknown as Context);
    // An on-behalf-of run carries its person's userId (amendment 6766414749: "run clientId can carry userId too"). The
    // person here is the App's participating admin, so only the run exclusion masks it, with or without an appKeyId.
    const adminId = (await db.user.findFirstOrThrow({ where: { handle: 'bp3843-admin' } })).id;
    await masked({ db, ...runAuthContext({ id: generateId(), appId, userId: adminId, organizationId: orgId }) } as unknown as Context);
    await masked({ db, ...runAuthContext({ id: generateId(), appId, userId: adminId, organizationId: orgId }), appKeyId: keyRow.id } as unknown as Context);
    // Control: the same person, not as a run (a hybrid with App P selected), reads.
    expect(await read({ db, userId: adminId, appId, roles: ['READER'] } as unknown as Context, agentId)).toBe('SERVED');
    // A hybrid: a person with App P SELECTED but no participation of their own is judged on the person. `member` is an
    // org reader (the chat gate admits them), so only the person-first rule masks this.
    await masked({ db, userId: (await db.user.findFirstOrThrow({ where: { handle: 'bp3843-member' } })).id, appId, roles: ['READER'] } as unknown as Context);
    // An App id with no person and no App key behind it (not a run either) is not an App key.
    await masked({ db, appId, roles: [], clientId: 'client:x' } as unknown as Context);
    // Control: the real own-App key principal on the resolver reads.
    expect(await read({ db, appId, appKeyId: keyRow.id, roles: [] } as unknown as Context, agentId)).toBe('SERVED');
  });

  it('5: revoked participation and a deleted App are masked', async () => {
    expect((await gql(tokens.member, { a: agentId, p: personalAppId })).data!.agentServedBootPrompt!.text).toBe(rendered());
    await db.appMember.delete({ where: { appId_userId: { appId: personalAppId, userId: (await db.user.findFirstOrThrow({ where: { handle: 'bp3843-member' } })).id } } });
    await expectMasked(tokens.member, { a: agentId, p: personalAppId });
    expect((await gql(tokens.admin, { a: agentId, p: appId })).data!.agentServedBootPrompt!.text).toBe(rendered());
    await db.app.update({ where: { id: appId }, data: { deletedAt: new Date() } });
    await expectMasked(tokens.admin, { a: agentId, p: appId });
  });

  it('5: a lapsed App licence is masked as not-found, never the typed INSTALL_LICENSE_INACTIVE (control: served while it holds)', async () => {
    const live = await both(tokens.member, { a: agentId, p: personalAppId });
    expect(live.g.errors).toBeUndefined();
    expect(live.g.data!.agentServedBootPrompt!.text).toBe(rendered());
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: orgId, userId: holderId } }, data: { deletedAt: new Date() } });
    await expectMasked(tokens.member, { a: agentId, p: personalAppId });
  });
});

describe('6: precedence', () => {
  it('the install pointer wins on the App arm, the Agent pointer otherwise, and a customised worker never changes either', async () => {
    const installNode = await compiledNode('Install text for {{worker.name}}.', true);
    const workerNode = await compiledNode('Worker text.', true);
    await db.agent.update({ where: { id: agentId }, data: pointer(agentCompiledId) });
    await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name: 'Iris', slug: 'iris', ...pointer(workerNode) } });
    const before = await both(tokens.admin, { a: agentId, p: appId });
    expect(before.g.data!.agentServedBootPrompt).toMatchObject({ text: rendered(), decision: { pointerLevel: 'AGENT', compiledNodeId: agentCompiledId } });
    await db.appAgent.update({ where: { appId_agentId: { appId, agentId } }, data: pointer(installNode) });
    const install = await both(tokens.admin, { a: agentId, p: appId });
    expect(install.g.data!.agentServedBootPrompt).toMatchObject({ text: 'Install text for Role.', decision: { pointerLevel: 'APP_AGENT', compiledNodeId: installNode } });
    expect(bodyOf(install.t)).toBe('Install text for Role.');
    expect(textOf(install.t).split('\n')[0]).toBe(`Served boot prompt for Agent ${agentId} in App ${appId}: APP_AGENT pointer, revision 1.`);
    const agentOnly = await both(tokens.admin, { a: agentId });
    expect(agentOnly.g.data!.agentServedBootPrompt).toMatchObject({ text: rendered(), decision: { pointerLevel: 'AGENT' } });
  });
});

describe('7: no binding, no record, for every credential', () => {
  const counts = async () => ({
    served: await db.servedPrompt.count(), sessions: await db.session.count(), runs: await db.appRun.count(),
    bound: await db.worker.count({ where: { heldByUserId: { not: null } } }),
    ended: await db.session.count({ where: { endedAt: { not: null } } }),
  });

  it('a user key, an App key and a sign-in with a session header each read (and refuse) the same way, and nothing is written', async () => {
    const start = await counts();
    const ok = { text: rendered(), decision: { pointerLevel: 'AGENT', compiledNodeId: agentCompiledId, servedRevSeq: 1 } };
    for (const [token, session] of [[tokens.admin, undefined], [tokens.signIn, sessionId]] as const) {
      for (const v of [{ a: agentId }, { a: agentId, p: appId }]) {
        const { g, t } = await both(token, v, session);
        expect(g.errors).toBeUndefined();
        expect(g.data!.agentServedBootPrompt).toEqual(ok);
        expect(bodyOf(t)).toBe(rendered());
      }
    }
    const key = await both(tokens.appKey, { a: agentId, p: appId });
    expect(key.g.errors).toBeUndefined();
    expect(key.g.data!.agentServedBootPrompt).toEqual(ok);
    expect(bodyOf(key.t)).toBe(rendered());

    await db.agent.update({ where: { id: agentId }, data: pointer(await compiledNode('Draft.', false)) });
    for (const [token, session, p] of [[tokens.admin, undefined, null], [tokens.signIn, sessionId, appId], [tokens.appKey, undefined, appId]] as const) {
      const { g, t } = await both(token, { a: agentId, p }, session);
      expect(g.errors?.[0]?.extensions?.code).toBe('BOOT_PROMPT_NOT_APPROVED');
      expect(textOf(t)).toBe(wireRefusal(g));
    }
    expect(await counts()).toEqual(start);
  });

  it('a session that was served an older revision does not change the answer: it is the current serve', async () => {
    // A worker session that was served the Agent's first revision; then a newer one is approved.
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name: 'Iris', slug: 'iris', heldByUserId: adminId } });
    const served = (await db.session.create({ data: { id: generateId(), appId, userId: adminId, workerId: worker.id, agentId, type: 'DEVELOPER', startedAt: new Date() } })).id;
    await db.servedPrompt.create({ data: {
      id: generateId(), kind: 'BIND', sessionId: served, workerId: worker.id, appId, agentId, pointerLevel: 'AGENT', compiledNodeId: agentCompiledId,
      servedRevSeq: 1, provenanceRevSeq: 1, compiledContentHash: sha256Hex(PROMPT),
    } });
    const newer = await compiledNode('Newer approved text.', true);
    const records = await db.servedPrompt.count();
    const { g, t } = await both(tokens.signIn, { a: agentId, p: appId }, served);
    expect(await db.servedPrompt.count()).toBe(records);
    expect(g.data!.agentServedBootPrompt).toMatchObject({ text: 'Newer approved text.', decision: { compiledNodeId: newer } });
    expect(bodyOf(t)).toBe('Newer approved text.');
  });
});

