/**
 * hadrontool-mcp conduit — the McpServer registry GraphQL surface.
 *
 * What this file pins:
 *   - createMcpServer: org-ADMIN gate, slug grammar + per-org uniqueness,
 *     URL validation, header encryption (plaintext never lands in a column,
 *     hasHeaders is all a reader gets).
 *   - updateMcpServer: field updates, headers replace/clear exclusivity,
 *     no-disclosure NOT_FOUND for outsiders.
 *   - deleteMcpServer: hard delete, ADMIN-gated.
 *   - mcpServer(ref): null for missing AND for non-member.
 *   - mcpServers: uniform page scoped to member orgs (cor:api:120).
 *   - mcpServerTools: live passthrough applies allowlist + name grammar,
 *     and composes run-tool names.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { listMcpTools } from '../../../lib/mcpToolClient.js';
import { decryptToken } from '../../../lib/tokenCrypto.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../lib/mcpToolClient.js', () => ({
  listMcpTools: vi.fn(),
  callMcpTool: vi.fn(),
}));

let org: { id: string };
let admin: { id: string };
let member: { id: string };
let outsider: { id: string };

function ctxFor(userId: string): Context {
  return { db, roles: ['READER'], userId } as Context;
}

async function createUser(name: string, orgId: string | null, role: 'OWNER' | 'ADMIN' | 'READER' = 'READER') {
  const user = await db.user.create({
    data: { id: generateId(), email: `${name}@mcp.test`, name },
  });
  if (orgId) {
    await db.orgMember.create({
      data: { id: generateId(), organizationId: orgId, userId: user.id, role },
    });
  }
  return user;
}

beforeEach(async () => {
  await cleanDb(db);
  vi.mocked(listMcpTools).mockReset();

  org = await db.organization.create({ data: { id: generateId(), name: 'mcp-org', urn: 'mcp-org' } });
  admin = await createUser('admin', org.id, 'ADMIN');
  member = await createUser('member', org.id, 'READER');
  outsider = await createUser('outsider', null);
});

async function createServer(overrides: Record<string, unknown> = {}, ctx?: Context) {
  return resolvers.Mutation.createMcpServer(
    {},
    {
      orgRef: org.id,
      slug: 'everart',
      name: 'EverArt',
      url: 'https://mcp.everart.example/mcp',
      ...overrides,
    } as never,
    ctx ?? ctxFor(admin.id),
  );
}

describe('createMcpServer', () => {
  it('registers a server (org ADMIN) with defaults', async () => {
    const server = await createServer();
    expect(server).toMatchObject({
      organizationId: org.id,
      slug: 'everart',
      name: 'EverArt',
      url: 'https://mcp.everart.example/mcp',
      toolAllowlist: [],
      enabled: true,
      headersEncrypted: null,
    });
  });

  it('encrypts headers at rest — the plaintext never lands in a column', async () => {
    const server = await createServer({ headers: { Authorization: 'Bearer sk-secret-123' } });
    const raw = await db.mcpServer.findUniqueOrThrow({ where: { id: server.id } });
    expect(JSON.stringify(raw)).not.toContain('sk-secret-123');
    expect(raw.headersEncrypted).toBeTruthy();
    // Round-trips through the token crypto used by AiServiceConfig keys.
    expect(JSON.parse(decryptToken(raw.headersEncrypted!))).toEqual({ Authorization: 'Bearer sk-secret-123' });
  });

  it('requires org ADMIN (plain member is Forbidden)', async () => {
    await expect(createServer({}, ctxFor(member.id))).rejects.toThrow('Forbidden');
  });

  it('rejects a bad slug, a bad URL, credentialed URLs, and malformed headers', async () => {
    await expect(createServer({ slug: 'Has_Underscore' })).rejects.toThrow(/slug/);
    await expect(createServer({ url: 'not-a-url' })).rejects.toThrow(/absolute URL/);
    await expect(createServer({ url: 'https://user:pw@x.example/mcp' })).rejects.toThrow(/credentials/);
    await expect(createServer({ headers: { 'Bad\nName': 'v' } })).rejects.toThrow(/Invalid header/);
    await expect(createServer({ headers: { 'X-Ok': 'bad\r\nvalue' } })).rejects.toThrow(/Invalid header/);
  });

  /** #5158: the refusal names the rule and never repeats what the caller typed (the #2898 no-echo policy); a credential typed without its
   *  `Name: ` part reaches the server as the header NAME, so the name is input too. */
  describe('#5158 the malformed-header refusal does not echo typed input', () => {
    const SECRET_NAME = 'Basic dXNlcjpwYXNzd29yZA==';
    let updates = 0;
    const refusal = async (headers: Record<string, string>, run: 'create' | 'update' = 'create') => {
      const err: any = await (run === 'create'
        ? createServer({ headers })
        : createServer({ slug: `upd-${++updates}` }).then((server: any) => resolvers.Mutation.updateMcpServer({}, { ref: server.id, headers } as never, ctxFor(admin.id)))
      ).then(() => null, (e: unknown) => e);
      expect(err?.extensions?.code).toBe('BAD_USER_INPUT');
      return String(err.message);
    };

    it('a credential typed as the header name is not repeated (create and update)', async () => {
      for (const run of ['create', 'update'] as const) {
        const message = await refusal({ [SECRET_NAME]: 'oops' }, run);
        expect(message).not.toContain(SECRET_NAME);
        expect(message).not.toContain('dXNlcjpwYXNzd29yZA');
        expect(message).toMatch(/^Invalid header/);
      }
    });

    it('a name too long, and a valid name with a line-break value, repeat neither the name nor the value', async () => {
      const longName = 'X-' + 'a'.repeat(200);
      expect(await refusal({ [longName]: 'v' })).not.toContain(longName);
      const message = await refusal({ 'X-Ok-Name': 'line one\nline two' });
      expect(message).not.toContain('X-Ok-Name');
      expect(message).not.toContain('line one');
    });

    it('every other malformed shape is refused the same way, on create and on update, without repeating its text', async () => {
      const cases: Array<[string, Record<string, unknown>, string[]]> = [
        ['a value over the maximum length', { 'X-Long-Value': 'v'.repeat(4097) }, ['X-Long-Value', 'vvvvvvvv']],
        ['a non-string value', { 'X-Num': 5 as unknown as string }, ['X-Num']],
        ['an empty name', { '': 'secret-value-123' }, ['secret-value-123']],
      ];
      for (const [label, headers, typed] of cases) {
        for (const run of ['create', 'update'] as const) {
          const message = await refusal(headers as Record<string, string>, run);
          expect(message, `${label} (${run})`).toMatch(/^Invalid header \(entry 1\)/);
          for (const text of typed) expect(message, `${label} (${run})`).not.toContain(text);
        }
      }
    });

    it('names the rule and the entry position, and a later bad entry is told apart from an earlier good one', async () => {
      const message = await refusal({ Authorization: 'Bearer fine', [SECRET_NAME]: 'oops' });
      expect(message).toContain('entry 2');
      expect(message).toMatch(/HTTP token/);
      expect(message).toMatch(/line break/);
    });

    it('a valid header still registers (control)', async () => {
      const server = await createServer({ headers: { Authorization: 'Bearer fine' } });
      expect(JSON.parse(decryptToken(server.headersEncrypted!))).toEqual({ Authorization: 'Bearer fine' });
    });

    it('a plain member and an outsider are Forbidden before any header is read', async () => {
      for (const who of [member, outsider]) {
        await expect(createServer({ headers: { [SECRET_NAME]: 'oops' } }, ctxFor(who.id))).rejects.toThrow('Forbidden');
      }
    });
  });

  it('rejects a duplicate slug in the same org, allows it in another org', async () => {
    await createServer();
    await expect(createServer()).rejects.toThrow(/already exists/);

    const org2 = await db.organization.create({ data: { id: generateId(), name: 'o2', urn: 'mcp-org-2' } });
    await db.orgMember.create({
      data: { id: generateId(), organizationId: org2.id, userId: admin.id, role: 'ADMIN' },
    });
    const other = await createServer({ orgRef: org2.id });
    expect(other.organizationId).toBe(org2.id);
  });
});

describe('updateMcpServer', () => {
  it('updates fields, replaces headers, clears headers', async () => {
    const server = await createServer({ headers: { Authorization: 'Bearer one' } });

    const renamed = await resolvers.Mutation.updateMcpServer(
      {},
      { ref: server.id, name: 'EverArt v2', headers: { Authorization: 'Bearer two' } } as never,
      ctxFor(admin.id),
    );
    expect(renamed.name).toBe('EverArt v2');
    expect(JSON.parse(decryptToken(renamed.headersEncrypted!))).toEqual({ Authorization: 'Bearer two' });

    const cleared = await resolvers.Mutation.updateMcpServer(
      {},
      { ref: server.id, clearHeaders: true } as never,
      ctxFor(admin.id),
    );
    expect(cleared.headersEncrypted).toBeNull();
  });

  it('rejects headers + clearHeaders together', async () => {
    const server = await createServer();
    await expect(
      resolvers.Mutation.updateMcpServer(
        {},
        { ref: server.id, headers: { A: 'b' }, clearHeaders: true } as never,
        ctxFor(admin.id),
      ),
    ).rejects.toThrow(/not both/);
  });

  it('answers NOT_FOUND identically for missing and for an outsider (no disclosure)', async () => {
    const server = await createServer();
    await expect(
      resolvers.Mutation.updateMcpServer({}, { ref: 'nope', name: 'x' } as never, ctxFor(admin.id)),
    ).rejects.toThrow('MCP server not found.');
    await expect(
      resolvers.Mutation.updateMcpServer({}, { ref: server.id, name: 'x' } as never, ctxFor(outsider.id)),
    ).rejects.toThrow('MCP server not found.');
  });
});

describe('deleteMcpServer', () => {
  it('hard-deletes (ADMIN); member is Forbidden', async () => {
    const server = await createServer();
    await expect(
      resolvers.Mutation.deleteMcpServer({}, { ref: server.id }, ctxFor(member.id)),
    ).rejects.toThrow('Forbidden');
    await expect(resolvers.Mutation.deleteMcpServer({}, { ref: server.id }, ctxFor(admin.id))).resolves.toBe(true);
    expect(await db.mcpServer.findUnique({ where: { id: server.id } })).toBeNull();
  });
});

describe('mcpServer / mcpServers reads', () => {
  it('find-one: member sees it, outsider and missing both get null', async () => {
    const server = await createServer();
    expect(await resolvers.Query.mcpServer({}, { ref: server.id }, ctxFor(member.id))).toMatchObject({
      slug: 'everart',
    });
    expect(await resolvers.Query.mcpServer({}, { ref: server.id }, ctxFor(outsider.id))).toBeNull();
    expect(await resolvers.Query.mcpServer({}, { ref: 'missing' }, ctxFor(member.id))).toBeNull();
  });

  it('list: scoped to member orgs; hasHeaders resolves without exposing the value', async () => {
    const server = await createServer({ headers: { Authorization: 'Bearer x' } });
    const page = await resolvers.Query.mcpServers({}, {}, ctxFor(member.id));
    expect(page.total).toBe(1);
    expect(page.items[0].id).toBe(server.id);

    const outsiderPage = await resolvers.Query.mcpServers({}, { orgId: org.id }, ctxFor(outsider.id));
    expect(outsiderPage).toEqual({ items: [], total: 0 });

    expect(resolvers.McpServer.hasHeaders(server)).toBe(true);
    expect(resolvers.McpServer.hasHeaders({ headersEncrypted: null })).toBe(false);
  });
});

describe('mcpServerTools', () => {
  it('applies the allowlist + name grammar and composes run-tool names', async () => {
    const server = await createServer({ toolAllowlist: ['generate_image', 'weird tool'] });
    vi.mocked(listMcpTools).mockResolvedValue([
      { name: 'generate_image', description: 'Make an image', inputSchema: { type: 'object' } },
      { name: 'list_models', inputSchema: { type: 'object' } }, // not in allowlist
      { name: 'weird tool', inputSchema: { type: 'object' } }, // bad charset
    ]);
    const tools = await resolvers.Query.mcpServerTools({}, { ref: server.id }, ctxFor(member.id));
    expect(tools).toEqual([
      {
        name: 'generate_image',
        description: 'Make an image',
        runToolName: 'mcp__everart__generate_image',
        inputSchema: { type: 'object' },
      },
    ]);
  });

  it('returns null for an outsider without calling the conduit', async () => {
    const server = await createServer();
    expect(await resolvers.Query.mcpServerTools({}, { ref: server.id }, ctxFor(outsider.id))).toBeNull();
    expect(listMcpTools).not.toHaveBeenCalled();
  });

  it('errors typed on a disabled server without calling the conduit (what-you-see-is-what-runs)', async () => {
    const server = await createServer({ enabled: false });
    await expect(resolvers.Query.mcpServerTools({}, { ref: server.id }, ctxFor(member.id))).rejects.toThrow(
      /disabled/,
    );
    expect(listMcpTools).not.toHaveBeenCalled();
  });

  it('caps third-party descriptions on the browse path (same cap as the runner)', async () => {
    const server = await createServer();
    vi.mocked(listMcpTools).mockResolvedValue([
      { name: 'verbose', description: 'x'.repeat(5000), inputSchema: { type: 'object' } },
    ]);
    const tools = await resolvers.Query.mcpServerTools({}, { ref: server.id }, ctxFor(member.id));
    expect(tools![0].description).toHaveLength(1024);
  });
});
