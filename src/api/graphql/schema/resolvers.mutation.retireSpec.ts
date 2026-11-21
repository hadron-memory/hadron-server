/**
 * #3429 — the retire door (cor:spc:010:02, rulings 0212-0214 and 0218-0220).
 *
 * ONE transaction retires a spec, by rescind or by supersede to an EXISTING successor in the same memory. It takes the
 * locks in `writeNodeCore`'s own order (the spec memory's channel key, the spec's loc key, the memory row, the spec row
 * `FOR UPDATE`), judges the refusals on the locked row, and then writes the tag, banner and abstract through the SAME
 * writer `updateSpecNode` uses (`writeNodeCore`, ownsKind `spec`): the same write authority and concealment, the same
 * authoring judgement, one revision. The `superseded-by` edge is inserted in that transaction. There is no raw node
 * update and no write that skips authoring or the revision writer. The door adds no authority.
 *
 * The successor is read, never locked: locking it could deadlock against a snapshot restore. Its checks hold against
 * other door calls, which the memory key orders (under 0218 the successor is in the spec's own memory, so there is
 * exactly one key). They do not hold against a raw edge or node writer, a stated limit of cor:spc:010:02.
 */
import { GraphQLError } from 'graphql';
import { Prisma } from '../../../generated/prisma/index.js';
import { deserializeTags, serializeTags } from '../../../integrations/db/provider.js';
import { generateId } from '../../../lib/id.js';
import { deriveEdgeLoc } from '../../../lib/edgeLoc.js';
import { lockEdgeEndpointMemories } from '../../../lib/edgeEndpointLock.js';
import { lockLocForWrite } from '../../../lib/nodeSubtreeLock.js';
import { assertEdgeSourceWritersById } from '../../../lib/nodeRoleWriters.js';
import { authoringFromRequest, type AuthoredWith } from '../../../lib/authoringAttestation.js';
import { decryptNodeFields, getMemoryEncryptionInfo } from '../../../lib/nodeCrypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { NodeAbstractTooLongError, NodeNotFoundError } from '../../../lib/entityRef/errors.js';
import { ABSTRACT_MAX_LENGTH } from '../../../lib/nodeMerge.js';
import { assertStorableText } from '../../../lib/unstorableTextInput.js';
import { retirementAbstract, retirementBanner, withBanner, withSupersededTag, type RetireForm } from '../../../lib/retireSpecText.js';
import { mirrorEdgeSourceAfterCommit } from '../../../integrations/github/mirrorEdgeSource.js';
import type { Context } from './resolvers.js';
import { writeNodeCore } from './resolvers.mutation.node.js';
import { resolveNodeRefForCaller } from './resolvers.nodeRefAccess.js';
import { lockInstallAuthorityFirst } from './installMemory.js';
import {
  concealUnreadableNodeDenial,
  isMemoryReadableCached,
  nodeNotFoundError,
  requireMemoryWriteAccess,
  withoutRequestCaches,
} from './resolvers.helpers.js';

/** The edge a supersede inserts, as the door selects it. */
export type RetiredEdge = Prisma.EdgeGetPayload<{ include: { source: true; target: true } }>;

export interface RetireSpecInput {
  ref: string;
  form: RetireForm;
  withdrawn?: boolean | null;
  successorRef?: string | null;
  expectedRevision: number;
  reason?: string | null;
  summary?: string | null;
  authoredWith?: AuthoredWith | null;
}

const SUPERSEDED_BY = 'superseded-by';

const badInput = (message: string, field: string) =>
  new GraphQLError(`retireSpec: ${message}`, { extensions: { code: 'BAD_USER_INPUT', field } });
const conflict = (ref: string) =>
  new GraphQLError('The spec cannot be retired in its current state; re-read it and retry.', {
    extensions: { code: 'NODE_WRITE_CONFLICT', ref },
  });
const nonBlank = (v: string | null | undefined): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * The shape of the input, judged before anything is read, so it reveals nothing about any node (a malformed call on an
 * unreadable ref answers exactly as on a missing one).
 */
function assertInputShape(input: RetireSpecInput): void {
  if (!nonBlank(input.ref)) throw badInput('`ref` is required.', 'ref');
  if (input.form !== 'RESCIND' && input.form !== 'SUPERSEDE') throw badInput('`form` must be RESCIND or SUPERSEDE.', 'form');
  const rev = input.expectedRevision;
  if (typeof rev !== 'number' || !Number.isInteger(rev) || rev <= 0 || rev > 2_147_483_647) {
    throw badInput('`expectedRevision` is required and must be a positive 32-bit integer.', 'expectedRevision');
  }
  if (input.form === 'RESCIND') {
    if (input.successorRef != null) throw badInput('`successorRef` is only for SUPERSEDE.', 'successorRef');
    if (!nonBlank(input.reason)) throw badInput('`reason` is required to rescind.', 'reason');
    if (!nonBlank(input.summary)) throw badInput('`summary` is required to rescind.', 'summary');
  } else {
    if (!nonBlank(input.successorRef)) throw badInput('`successorRef` is required to supersede.', 'successorRef');
    if (input.withdrawn === true) throw badInput('`withdrawn` is only for RESCIND.', 'withdrawn');
    if (input.reason != null && !nonBlank(input.reason)) throw badInput('`reason` must not be blank when given.', 'reason');
    if (input.summary != null && !nonBlank(input.summary)) throw badInput('`summary` must not be blank when given.', 'summary');
  }
  assertStorableText({ reason: input.reason, summary: input.summary });
}

/** The successor test of 0213 and 0214, one literal-prefix predicate over live edges and non-deleted pending edges. */
async function hasSuccessorLink(tx: Prisma.TransactionClient, nodeId: string): Promise<boolean> {
  const live = await tx.edge.count({ where: { sourceId: nodeId, deletedAt: null, name: { startsWith: SUPERSEDED_BY } } });
  if (live > 0) return true;
  const pending = await tx.pendingEdge.count({ where: { sourceId: nodeId, deletedAt: null, name: { startsWith: SUPERSEDED_BY } } });
  return pending > 0;
}

const isRetired = (tags: unknown): boolean => (deserializeTags(tags as string | string[]) as string[]).includes('superseded');

export async function retireSpecDoor(input: RetireSpecInput, ctx: Context) {
  // #876: an impersonated session is read-only. The GraphQL plugin already blocks the mutation, but a delegate
  // (the MCP twin, a direct call) must not depend on it, and this judges before any shape check or read, so the
  // refusal reveals nothing about any node.
  if (ctx.impersonation) {
    throw new GraphQLError('This is a read-only impersonation session; mutations are disabled.', {
      extensions: { code: 'IMPERSONATION_READ_ONLY', http: { status: 403 } },
    });
  }
  assertInputShape(input);
  const ref = input.ref;

  // Items 1 and 2: the node write path's own authorization and concealment, unchanged.
  let specId: string;
  try {
    ({ id: specId } = await resolveNodeRefForCaller(ctx, ref));
  } catch (e) {
    if (e instanceof NodeNotFoundError) throw nodeNotFoundError(ref);
    throw e;
  }
  const pre = await ctx.db.node.findUnique({
    where: { id: specId },
    select: { memoryId: true, loc: true, memory: { select: { deletedAt: true } } },
  });
  if (!pre || pre.memory.deletedAt) throw nodeNotFoundError(ref);
  await concealUnreadableNodeDenial(ctx, pre.memoryId, () => nodeNotFoundError(ref), () =>
    requireMemoryWriteAccess({ ...ctx, installWritePreflight: true }, pre.memoryId),
  );

  const effects: Array<() => void> = [];
  const done = await ctx.db.$transaction(async (tx) => {
    // The locks, in writeNodeCore's order. The successor is not locked.
    await lockInstallAuthorityFirst(tx, ctx, pre.memoryId);
    await lockEdgeEndpointMemories(tx, [pre.memoryId]);
    await lockLocForWrite(tx, pre.memoryId, pre.loc, { op: 'update' });
    await tx.$queryRaw`SELECT id FROM memories WHERE id = ${pre.memoryId} FOR SHARE`;
    await tx.$queryRaw`SELECT "id" FROM "nodes" WHERE "id" = ${specId} FOR UPDATE`;
    const txCtx = withoutRequestCaches(ctx, tx);
    // Access can change while this waited for the locks: judge it again on the transaction, before any state-dependent
    // refusal, so a caller who lost access learns nothing from the refusals below.
    await concealUnreadableNodeDenial(txCtx, pre.memoryId, () => nodeNotFoundError(ref), () =>
      requireMemoryWriteAccess({ ...txCtx, installWritePreflight: true }, pre.memoryId),
    );

    // The predicates are judged on the LOCKED row.
    const locked = await tx.node.findUnique({ where: { id: specId } });
    if (!locked || locked.deletedAt) throw nodeNotFoundError(ref);
    if (locked.memoryId !== pre.memoryId || locked.loc !== pre.loc) throw conflict(ref);

    // Item 3: for a supersede, the successor must exist, be live and be readable by the caller.
    let successor: { id: string; loc: string; name: string; memoryId: string; tags: unknown } | null = null;
    if (input.form === 'SUPERSEDE') {
      let successorId: string;
      try {
        ({ id: successorId } = await resolveNodeRefForCaller(txCtx, input.successorRef!));
      } catch (e) {
        if (e instanceof NodeNotFoundError) throw nodeNotFoundError(input.successorRef!);
        throw e;
      }
      const row = await tx.node.findUnique({
        where: { id: successorId },
        select: { id: true, loc: true, name: true, memoryId: true, tags: true, deletedAt: true, memory: { select: { deletedAt: true } } },
      });
      if (!row || row.deletedAt || row.memory.deletedAt || !(await isMemoryReadableCached(txCtx, row.memoryId))) {
        throw nodeNotFoundError(input.successorRef!);
      }
      successor = row;
    }

    // Item 4: already retired, already has a successor (0213, 0214), or the caller's read is stale.
    if (isRetired(locked.tags) || (await hasSuccessorLink(tx, specId)) || locked.revSeq !== input.expectedRevision) {
      throw conflict(ref);
    }

    // Item 5: a readable successor that cannot be used (0218, 0219). One uniform answer, no edge identity.
    if (successor) {
      if (
        successor.id === specId ||
        successor.memoryId !== pre.memoryId ||
        isRetired(successor.tags) ||
        (await hasSuccessorLink(tx, successor.id))
      ) {
        throw conflict(ref);
      }
    }

    // Item 6: compose, then measure, only after the successor is known to be readable and usable.
    const enc = await getMemoryEncryptionInfo(txCtx.db, pre.memoryId);
    if (enc.isEncrypted && !sessionKeyCache.getByMemoryId(enc.id)) {
      throw new GraphQLError(`SESSION_EXPIRED: memory ${enc.id} is encrypted but no active session key is available.`, {
        extensions: { code: 'SESSION_EXPIRED', memoryId: enc.id },
      });
    }
    const plain = enc.isEncrypted ? decryptNodeFields({ ...locked }, enc) : locked;
    const [{ d: date }] = await tx.$queryRaw<Array<{ d: string }>>`SELECT to_char((now() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS d`;
    const withdrawn = input.withdrawn === true;
    const succ = successor ? { loc: successor.loc, name: successor.name } : null;
    const abstract = retirementAbstract({
      form: input.form, withdrawn, date, reason: input.reason ?? null, summary: input.summary ?? null,
      storedAbstract: plain.abstract ?? null, successor: succ,
    });
    if (abstract.length > ABSTRACT_MAX_LENGTH) {
      // The shared typed envelope, as updateNode answers it: a bare class is masked as INTERNAL_SERVER_ERROR on the wire.
      const tooLong = new NodeAbstractTooLongError(abstract.length);
      throw new GraphQLError(tooLong.message, { extensions: tooLong.extensionFields() });
    }
    const banner = retirementBanner({ form: input.form, withdrawn, date, reason: input.reason ?? null, successor: succ });
    const tags = withSupersededTag(deserializeTags(locked.tags as string | string[]) as string[]);

    // The write: the spec-write path, in this transaction. Authoring (judgeAuthoring / authoredWith), the revision
    // writer and the expectedRevision compare-and-swap are writeNodeCore's own.
    const written = await writeNodeCore(
      { memoryId: pre.memoryId, loc: pre.loc, content: withBanner(plain.content ?? null, banner), abstract, tags: serializeTags(tags) as string[] },
      txCtx,
      'update',
      {
        authoring: authoringFromRequest(ctx, input.authoredWith),
        targetNodeId: specId,
        guardRevSeq: input.expectedRevision,
        ownsKind: 'spec',
        governedContext: 'node-write',
        concealUnreadable: { entity: 'node', ref },
        transaction: { tx, pooledDb: ctx.db, requestContext: ctx, afterCommit: (effect) => effects.push(effect) },
      },
    );

    let edge: RetiredEdge | null = null;
    if (successor) {
      // The edge writer's own source check, then the one insert, in this transaction. A loc a soft-deleted edge still
      // holds is numbered past, as the unique index covers every row.
      await assertEdgeSourceWritersById(tx, txCtx, specId);
      const base = deriveEdgeLoc(locked.loc, SUPERSEDED_BY, successor.loc);
      const taken = new Set((await tx.edge.findMany({
        where: { memoryId: pre.memoryId, OR: [{ loc: base }, { loc: { startsWith: `${base}:` } }] },
        select: { loc: true },
      })).map((r) => r.loc));
      let loc = base;
      for (let k = 2; taken.has(loc); k++) loc = `${base}:${k}`;
      edge = await tx.edge.create({
        data: {
          id: generateId(), memoryId: pre.memoryId, sourceId: specId, targetId: successor.id, loc, name: SUPERSEDED_BY,
          createdBy: ctx.userId ?? ctx.clientId ?? null,
        },
        include: { source: true, target: true },
      });
    }
    return { written, edge };
  });
  // After the commit the retirement is DONE: a failing effect (the node-written announcement, the embedding wake, usage
  // recording) is reported, never raised, or the caller would be told a committed retirement failed. The announcements
  // themselves already downgrade a broker failure to local dispatch and log a handler failure.
  for (const effect of effects) {
    try { effect(); } catch (error) { console.error('[retireSpec] post-commit effect failed after the retirement committed:', error); }
  }
  if (done.edge) {
    await mirrorEdgeSourceAfterCommit(ctx.db, done.edge.source, ctx.clientId)
      .catch((error: unknown) => console.error('[retireSpec] post-commit edge mirror failed after the retirement committed:', error));
  }
  return { node: done.written, successorEdge: done.edge };
}

export const retireSpecMutations = {
  retireSpec: (_: unknown, { input }: { input: RetireSpecInput }, ctx: Context) => retireSpecDoor(input, ctx),
};
