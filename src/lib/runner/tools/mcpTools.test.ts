// Unit-only materialization fixtures mock the consent seam; real pin tests
// exercise this guard against persisted adoption and the loaded registry row.
vi.mock('../../automation/pins.js', () => ({ assertPinnedToolIdentity: vi.fn() }));
/**
 * Dynamic MCP run tools (hadrontool-mcp conduit) — what this file pins:
 *   - unknownMcpToolNames: grammar, registration, enabled, allowlist, and
 *     the provider name-length cap — all checked WITHOUT calling the
 *     conduit (loadNodeSpec's fail-loud contract, D-TL-6).
 *   - materializeMcpRunTools: one live tools/list per referenced server,
 *     proxy defs (cost 1, upstream schema verbatim), vanished-upstream-tool
 *     fails loud (D-TL-8), execute flattens content and returns isError
 *     results to the LLM instead of throwing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { listMcpTools, callMcpTool } from '../../mcpToolClient.js';
import { encryptToken } from '../../tokenCrypto.js';
import { unknownMcpToolNames, materializeMcpRunTools } from './mcpTools.js';
import type { RunToolContext } from './types.js';
import type { AppRun } from '../../../generated/prisma/index.js';

vi.mock('../../mcpToolClient.js', () => ({
  listMcpTools: vi.fn(),
  callMcpTool: vi.fn(),
}));

let orgId: string;

beforeEach(async () => {
  await cleanDb(db);
  vi.mocked(listMcpTools).mockReset();
  vi.mocked(callMcpTool).mockReset();
  const org = await db.organization.create({
    data: { id: generateId(), name: 'mcp-run-org', urn: 'mcp-run-org' },
  });
  orgId = org.id;
});

async function registerServer(overrides: Record<string, unknown> = {}) {
  return db.mcpServer.create({
    data: {
      id: generateId(),
      organizationId: orgId,
      slug: 'everart',
      name: 'EverArt',
      url: 'https://mcp.everart.example/mcp',
      ...overrides,
    } as never,
  });
}

function fakeRun(): AppRun {
  return { id: 'run-1', organizationId: orgId } as AppRun;
}

function fakeCtx(logs: string[]): RunToolContext {
  return { log: (m) => logs.push(m), db, run: fakeRun(), principal: { db } as never };
}

describe('unknownMcpToolNames', () => {
  it('admits a registered, enabled, allowlisted tool and rejects everything else', async () => {
    await registerServer({ toolAllowlist: ['generate_image'] });
    await registerServer({ slug: 'disabled', enabled: false });

    const unknown = await unknownMcpToolNames(db, orgId, [
      'mcp__everart__generate_image', // OK
      'mcp__everart__list_models', // not in allowlist
      'mcp__disabled__anything', // disabled server
      'mcp__missing__tool', // unregistered slug
      'mcp__everart', // malformed (no tool part)
      `mcp__everart__${'x'.repeat(64)}`, // over the 64-char provider cap
    ]);
    expect(unknown).toEqual([
      'mcp__everart__list_models',
      'mcp__disabled__anything',
      'mcp__missing__tool',
      'mcp__everart',
      `mcp__everart__${'x'.repeat(64)}`,
    ]);
  });

  it('scopes registration to the run org — another org\'s server does not count', async () => {
    const otherOrg = await db.organization.create({
      data: { id: generateId(), name: 'other', urn: 'mcp-other-org' },
    });
    await db.mcpServer.create({
      data: {
        id: generateId(),
        organizationId: otherOrg.id,
        slug: 'everart',
        name: 'EverArt',
        url: 'https://mcp.everart.example/mcp',
      },
    });
    expect(await unknownMcpToolNames(db, orgId, ['mcp__everart__generate_image'])).toEqual([
      'mcp__everart__generate_image',
    ]);
  });
});

describe('materializeMcpRunTools', () => {
  it('builds proxy defs from the live tools/list (cost 1, schema verbatim, headers decrypted)', async () => {
    await registerServer({
      headersEncrypted: encryptToken(JSON.stringify({ Authorization: 'Bearer tok' })),
    });
    const schema = { type: 'object', properties: { prompt: { type: 'string' } } };
    vi.mocked(listMcpTools).mockResolvedValue([
      { name: 'generate_image', description: 'Make an image', inputSchema: schema },
    ]);

    const defs = await materializeMcpRunTools(db, fakeRun(), ['mcp__everart__generate_image']);
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ name: 'mcp__everart__generate_image', cost: 1, inputSchema: schema });
    expect(defs[0].description).toContain('EverArt');
    expect(defs[0].description).toContain('Make an image');
    expect(listMcpTools).toHaveBeenCalledWith({
      url: 'https://mcp.everart.example/mcp',
      headers: { Authorization: 'Bearer tok' },
    });
  });

  it('fails loud when the server no longer advertises a declared tool (D-TL-8)', async () => {
    await registerServer();
    vi.mocked(listMcpTools).mockResolvedValue([]);
    await expect(materializeMcpRunTools(db, fakeRun(), ['mcp__everart__generate_image'])).rejects.toThrow(
      /does not advertise/,
    );
  });

  it('fails loud when the row was deleted or disabled between validation and the hop', async () => {
    await expect(materializeMcpRunTools(db, fakeRun(), ['mcp__everart__generate_image'])).rejects.toThrow(
      /not registered/,
    );
  });

  it('execute proxies the call, flattens content, and hands isError to the LLM instead of throwing', async () => {
    await registerServer();
    vi.mocked(listMcpTools).mockResolvedValue([
      { name: 'generate_image', inputSchema: { type: 'object' } },
    ]);
    const [def] = await materializeMcpRunTools(db, fakeRun(), ['mcp__everart__generate_image']);
    const logs: string[] = [];

    vi.mocked(callMcpTool).mockResolvedValue({
      isError: false,
      content: [
        { type: 'text', text: 'done' },
        { type: 'image', data: '...' },
      ],
    });
    const ok = await def.execute(fakeCtx(logs), { prompt: 'a cat' });
    expect(ok).toEqual({ result: 'done\n[unsupported image content omitted]' });
    expect(callMcpTool).toHaveBeenCalledWith(
      { url: 'https://mcp.everart.example/mcp', headers: undefined },
      'generate_image',
      { prompt: 'a cat' },
    );

    vi.mocked(callMcpTool).mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'quota exceeded' }],
    });
    const err = await def.execute(fakeCtx(logs), {});
    expect(err).toEqual({ isError: true, error: 'quota exceeded' });
    expect(logs.some((l) => l.includes('upstream tool error'))).toBe(true);
  });

  it('degrades on malformed content blocks and bounds the flattened result (third-party payload)', async () => {
    await registerServer();
    vi.mocked(listMcpTools).mockResolvedValue([
      { name: 'generate_image', inputSchema: { type: 'object' } },
    ]);
    const [def] = await materializeMcpRunTools(db, fakeRun(), ['mcp__everart__generate_image']);

    // Null / primitive / typeless blocks must degrade, never crash the hop
    // (PR-634 review). The conduit validates too, but core must not trust it.
    vi.mocked(callMcpTool).mockResolvedValue({
      isError: false,
      content: [null, 42, { text: 'no type' }, { type: 'text', text: 'ok' }] as never,
    });
    const mixed = await def.execute(fakeCtx([]), {});
    expect(mixed).toEqual({
      result:
        '[unsupported unknown content omitted]\n[unsupported unknown content omitted]\n' +
        '[unsupported unknown content omitted]\nok',
    });

    vi.mocked(callMcpTool).mockResolvedValue({
      isError: false,
      content: [{ type: 'text', text: 'y'.repeat(150_000) }],
    });
    const big = (await def.execute(fakeCtx([]), {})) as { result: string };
    expect(big.result.length).toBeLessThan(101_000);
    expect(big.result.endsWith('[truncated by hadron-server]')).toBe(true);
  });

  it('fetches multi-server tool lists in parallel (no sequential timeout stacking)', async () => {
    await registerServer();
    await registerServer({ slug: 'other', name: 'Other' });
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(listMcpTools).mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return [{ name: 'tool_a', inputSchema: { type: 'object' } }];
    });
    await materializeMcpRunTools(db, fakeRun(), ['mcp__everart__tool_a', 'mcp__other__tool_a']);
    expect(maxInFlight).toBe(2);
  });
});
