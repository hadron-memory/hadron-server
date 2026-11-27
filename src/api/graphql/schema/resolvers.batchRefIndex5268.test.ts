/**
 * #5268 — the wrong-type (shape) refusal of `nodeBatch(refs:)` names the
 * failing ref by its POSITION in the caller's list, never by its text.
 *
 * Builds on #5255 (the echo sweep took the caller's reference text out of the
 * refusal); a position is not caller-typed, so the no-echo rule
 * (cor:api:140:01) holds while the caller no longer has to bisect the batch.
 *
 * Pins:
 *   - The refusal message ends `(the ref at index N)` and the error carries
 *     `extensions.index: N` (an integer), with `code: 'BAD_USER_INPUT'`
 *     unchanged. Both are set: the message for a reader, the extension for code.
 *   - N is the 0-based index in the caller's `refs` AS SENT: first occurrence
 *     for a duplicated wrong-type ref, first failing ref in caller order.
 *   - The index is computed in a synchronous pre-pass BEFORE any resolution
 *     (the #5268 spec-FIT condition): a resolvable URN preceding the bad ref,
 *     or following it, changes nothing about which index is named — never the
 *     `Promise.all` rejection order. The pre-pass also decides MIXED shape
 *     input: a wrong-type ref is named even when an unqualified ref precedes
 *     it (the spec-FIT left unqualified refs out, so they carry no index;
 *     this is the precedence the surface already had before #5268, now
 *     deterministic instead of a rejection race).
 *   - No echo: the refusal names no caller-typed text (the typeErr carries the
 *     URN KIND, not the value; the index is a number).
 *   - The quiet path is untouched (cor:api:040:03): a well-formed ref that
 *     names nothing the caller may read still lands in `unavailable`,
 *     indistinguishable from a denial, with no error, no index, no shape
 *     change — the position is for the shape refusal only.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph, createDbNode } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';

let org: { id: string; urn: string };
let graph: { id: string };
let admin: { id: string };

function adminCtx(): Context {
  return { db, roles: ['ADMIN'], userId: admin.id } as Context;
}
const nodeBatch = (args: Record<string, unknown>, ctx: Context = adminCtx()) =>
  (resolvers.Query as any).nodeBatch({}, args, ctx);

/** Canonical node URN for a loc in the shared knowledge memory. */
const memUrn = (loc: string) => `bg-org::bgmem::${loc}`;

/** A URN of the WRONG entity type — the shape error this issue names. */
const wrongType = (n: number) => `hrn:mem:bg-org:bgmem-wrong-${n}`;

beforeEach(async () => {
  await cleanDb(db);
  const made = await createDbOrgAndGraph(db, { orgName: 'bg-org', graphName: 'bgmem' });
  org = made.org;
  graph = made.graph;
  admin = await db.user.create({
    data: { githubId: 9941, githubUsername: 'bri-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
});

/** Runs nodeBatch expecting the wrong-type shape refusal; returns the error. */
async function shapeRefusal(refs: string[]): Promise<GraphQLError> {
  const err: unknown = await nodeBatch({ refs }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GraphQLError);
  return err as GraphQLError;
}

describe('nodeBatch — wrong-type refusal names the failing ref by position (#5268)', () => {
  it('ends the message with (the ref at index N) and carries extensions.index', async () => {
    const a = await createDbNode(db, { loc: 'a', memoryId: graph.id, content: 'A body' });
    const b = await createDbNode(db, { loc: 'b', memoryId: graph.id, content: 'B body' });

    const err = await shapeRefusal([a.id, b.id, wrongType(1)]);

    expect(err.extensions.code).toBe('BAD_USER_INPUT');
    expect(err.extensions.index).toBe(2);
    expect(err.message).toMatch(/Expected node URN/);
    expect(err.message).toMatch(/\(the ref at index 2\)$/);
  });

  it('a duplicated wrong-type ref is named at its FIRST occurrence', async () => {
    const a = await createDbNode(db, { loc: 'a', memoryId: graph.id, content: 'A body' });
    const bad = wrongType(1);

    const err = await shapeRefusal([a.id, bad, a.id, bad]);

    expect(err.extensions.index).toBe(1);
    expect(err.message).toMatch(/\(the ref at index 1\)$/);
  });

  it('mixed shape: the wrong-type ref is named even when an unqualified ref precedes it', async () => {
    await createDbNode(db, { loc: 'a', memoryId: graph.id, content: 'A body' });

    // 'relative-loc' is unqualified — UrnNotQualifiedError once resolution
    // reaches it — and sits BEFORE the wrong-type ref. The pre-pass screens
    // the whole list before any resolution, so index 1 is named: the same
    // precedence this resolver had before #5268 (the screen's rejection beat
    // the unqualified rejection out of Promise.all), now deterministic and
    // pinned rather than a microtask race. MCP hadron_get_nodes matches.
    const err = await shapeRefusal(['relative-loc', 'hrn:app:bg-org:some-app']);

    expect(err.extensions.code).toBe('BAD_USER_INPUT');
    expect(err.extensions.index).toBe(1);
    expect(err.message).toMatch(/Expected node URN/);
    expect(err.message).toMatch(/\(the ref at index 1\)$/);
    expect(err.message).not.toContain('relative-loc');
  });

  it('a resolvable URN before or after the bad ref changes nothing — the index is pre-resolution (#5268 FIT)', async () => {
    await createDbNode(db, { loc: 'a', memoryId: graph.id, content: 'A body' });

    // Resolvable URN first: the bad ref is still index 1 in the order sent.
    const after = await shapeRefusal([memUrn('a'), 'hrn:app:bg-org:some-app']);
    expect(after.extensions.index).toBe(1);
    expect(after.message).toMatch(/\(the ref at index 1\)$/);

    // Bad ref first: index 0. The pre-pass decides before any resolution, so
    // neither direction can depend on which rejection Promise.all surfaces.
    const before = await shapeRefusal(['hrn:app:bg-org:some-app', memUrn('a')]);
    expect(before.extensions.index).toBe(0);
    expect(before.message).toMatch(/\(the ref at index 0\)$/);
  });

  it('names no caller-typed text — only the URN kind and the position', async () => {
    const a = await createDbNode(db, { loc: 'a', memoryId: graph.id, content: 'A body' });
    const bad = wrongType(1);

    const err = await shapeRefusal([a.id, bad]);

    // The message carries the expected/actual KIND, not the ref's value; the
    // index is a number. Neither the message nor the extensions echo `bad`.
    expect(err.message).not.toContain(bad);
    expect(err.message).not.toContain('bgmem-wrong');
    expect(JSON.stringify(err.extensions)).not.toContain(bad);
  });
});

describe('nodeBatch — the quiet path is untouched by the position (#5268 FIT condition 1)', () => {
  it('a well-formed ref that names nothing readable lands in unavailable, no error, no index', async () => {
    const a = await createDbNode(db, { loc: 'a', memoryId: graph.id, content: 'A body' });

    const res = await nodeBatch({ refs: [a.id, memUrn('nope')] });

    expect(res.nodes.map((n: any) => n.id)).toEqual([a.id]);
    expect(res.unavailable).toEqual([memUrn('nope')]);
    // Denied and not-found keep their exact pre-#5268 shape (cor:api:040:03):
    // no position anywhere in the quiet outcome.
    expect(JSON.stringify(res)).not.toContain('index');
  });
});
