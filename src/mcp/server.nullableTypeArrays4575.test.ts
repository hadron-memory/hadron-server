/**
 * #4575 — zod >= 4.4 spells a nullable tool input as a JSON Schema type array (`["string","null"]`) where 4.3 wrote
 * `anyOf: [{type:"string"},{type:"null"}]`. Same value set, new spelling (accepted: Holger, 2026-11-22). The wire-surface
 * golden (`server.sharedToolShapes2260.test.ts`, named for the #2260 ticket that introduced it) pins hashes only; this file
 * pins WHY those hashes moved and that the server still parses the three input shapes the same way:
 * a string and null are accepted, omission is accepted, anything else is refused as input.
 *
 * Twelve fields on five tools move: hadron_edit_comment.quote, hadron_update_node.{role,abstract,content},
 * hadron_update_edge.{name,description}, hadron_update_review.role, hadron_amend_question.{background,whyNow,assignee,
 * neededBy,defaultAction}. Fields that were already a union with another member (`data`, `condition`, ...) keep `anyOf`.
 */
import { describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServerInstance } from './server.js';

const AUTH = { userId: 'u-a', roles: ['ADMIN'], clientId: 'github:a' };

/** tool -> the string-or-null inputs, and the required arguments that make a call otherwise well-formed. */
const NULLABLE: Record<string, { fields: string[]; required: Record<string, unknown> }> = {
  hadron_edit_comment: { fields: ['quote'], required: { commentRef: 'x', expectedRevision: 1 } },
  hadron_update_node: { fields: ['role', 'abstract', 'content'], required: { urn: 'x' } },
  hadron_update_edge: { fields: ['name', 'description'], required: { edgeRef: 'x' } },
  hadron_update_review: { fields: ['role'], required: { urn: 'x' } },
  hadron_amend_question: {
    fields: ['background', 'whyNow', 'assignee', 'neededBy', 'defaultAction'],
    required: { ref: 'x', expectedRevision: 1, reason: 'r' },
  },
};

async function withClient<T>(fn: (client: Client, server: ReturnType<typeof createMcpServerInstance>) => Promise<T>): Promise<T> {
  const server = createMcpServerInstance(AUTH as never, () => undefined, { kind: 'multi-app' });
  const client = new Client({ name: 'nullable-4575', version: '1' });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(remote);
    await client.connect(local);
    return await fn(client, server);
  } finally {
    await client.close();
    await server.close();
  }
}

const textOf = (r: unknown) => ((r as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? '').join('\n');
/** True when the call was refused by input validation (before the tool body ran). */
const refusedAsInput = (r: unknown) => (r as { isError?: boolean }).isError === true && /Input validation error|Invalid arguments for tool/i.test(textOf(r));

describe('#4575 nullable inputs on the wire', () => {
  it('lists each string-or-null input as a type array, never anyOf', async () => {
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      for (const [tool, { fields }] of Object.entries(NULLABLE)) {
        const props = (tools.find((t) => t.name === tool)?.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties;
        for (const f of fields) {
          expect(props[f]?.type, `${tool}.${f}`).toEqual(['string', 'null']);
          expect(props[f]?.anyOf, `${tool}.${f}`).toBeUndefined();
        }
      }
    });
  });

  it('keeps update_edge.condition and .data (unions with another member) as anyOf', async () => {
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      const edge = tools.find((t) => t.name === 'hadron_update_edge')?.inputSchema as { properties: Record<string, { anyOf?: unknown[] }> };
      expect(edge.properties.condition.anyOf).toHaveLength(2);
      expect(edge.properties.data.anyOf).toHaveLength(2);
    });
  });
});

describe('#4575 the server parses a nullable input as before', () => {
  for (const [tool, { fields, required }] of Object.entries(NULLABLE)) {
    it(`${tool}: null, a string and omission pass input validation; a number is refused`, async () => {
      await withClient(async (client) => {
        for (const f of fields) {
          for (const value of [null, 'text']) {
            const r = await client.callTool({ name: tool, arguments: { ...required, [f]: value } });
            expect(refusedAsInput(r), `${tool}.${f}=${JSON.stringify(value)}: ${textOf(r)}`).toBe(false);
          }
          const bad = await client.callTool({ name: tool, arguments: { ...required, [f]: 123 } });
          expect(refusedAsInput(bad), `${tool}.${f}=123 must be refused: ${textOf(bad)}`).toBe(true);
          expect(textOf(bad), `${tool}.${f}`).toContain(f);
        }
        const omitted = await client.callTool({ name: tool, arguments: { ...required } });
        expect(refusedAsInput(omitted), `${tool} omitted: ${textOf(omitted)}`).toBe(false);
      });
    });
  }
});

describe('#4575 the PARSED arguments keep omission and null apart', () => {
  // `validateToolInput` is the SDK's own step: the value it returns is exactly what the tool handler receives. Omission must stay
  // absent (the handler keeps the stored value) and null must stay null (the handler clears it), or a clear would turn into a no-op.
  type Registered = Record<string, unknown>;
  const parsed = (server: unknown, tool: string, args: Record<string, unknown>) =>
    (server as { validateToolInput: (t: unknown, a: unknown, n: string) => Promise<Record<string, unknown>> }).validateToolInput(
      (server as { _registeredTools: Registered })._registeredTools[tool], args, tool);

  for (const [tool, { fields, required }] of Object.entries(NULLABLE)) {
    it(`${tool}: null arrives as null, a string as itself, an omitted field stays absent`, async () => {
      await withClient(async (_client, server) => {
        const omitted = await parsed(server, tool, { ...required });
        for (const f of fields) {
          expect(Object.prototype.hasOwnProperty.call(omitted, f), `${tool}.${f} omitted`).toBe(false);
          const withNull = await parsed(server, tool, { ...required, [f]: null });
          expect(withNull[f], `${tool}.${f} null`).toBeNull();
          // Only the field that was given appears: no sibling is filled in by a default.
          expect(Object.keys(withNull).sort(), `${tool}.${f} keys`).toEqual([...Object.keys(required), f].sort());
          const withText = await parsed(server, tool, { ...required, [f]: 'text' });
          expect(withText[f], `${tool}.${f} string`).toBe('text');
        }
      });
    });
  }
});
