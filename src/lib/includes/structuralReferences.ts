import type { Prisma } from '../../generated/prisma/index.js';
import { parseIncludeTags } from './parseIncludeTags.js';
import { includeUrnTarget } from './includeUrnTarget.js';

export const INCLUDE_RETENTION_SCHEMA_VERSION = 1;
export const INCLUDE_RETENTION_PARSER_VERSION = 1;

/** Generic refusal: never leaks a source's identity, address, content or counts. */
export class IncludeRetentionInactiveError extends Error {
  readonly code = 'INCLUDE_RETENTION_INACTIVE';
  constructor() {
    super('Include retention requires a verified active structural inventory');
    this.name = 'IncludeRetentionInactiveError';
  }
}

/**
 * #2063 / cor:dmo:150:07, cor:sec:040:03: capture ALL tags from supplied
 * plaintext, including unresolved addresses, with the sole S1 parser. References,
 * settings and stored-byte fingerprints are plaintext structural metadata needed
 * without encryption keys. No prose, raw tags or decrypted content is persisted.
 *
 * Caller owns a fenced transaction and must have already written/revalidated the
 * final source state. This helper never reads Node.content into the application:
 * PostgreSQL fingerprints the stored bytes, even when those bytes are sealed.
 * It is not an authorization gate, a source writer or a maintenance activator.
 * R1 deliberately has no production caller; R2 supplies every outer write root.
 */
export async function replaceStructuralReferences(
  tx: Prisma.TransactionClient,
  includerId: string,
  plaintext: string | null,
): Promise<void> {
  const tags = parseIncludeTags(plaintext ?? '');
  const generation = await tx.includeRetentionGeneration.findUnique({ where: { id: 'singleton' } });
  if (!generation || generation.schemaVersion !== INCLUDE_RETENTION_SCHEMA_VERSION
    || generation.parserVersion !== INCLUDE_RETENTION_PARSER_VERSION) throw new IncludeRetentionInactiveError();
  const source = await tx.node.findUniqueOrThrow({
    where: { id: includerId },
    select: { memoryId: true, loc: true, revSeq: true, memory: { select: { isEncrypted: true } } },
  });
  const [stored] = await tx.$queryRaw<Array<{ fingerprint: string }>>`
    SELECT encode(sha256(convert_to(CASE WHEN content IS NULL THEN 'null' ELSE 'text:' || content END, 'UTF8')), 'hex') AS fingerprint
    FROM nodes WHERE id = ${includerId}`;
  if (!stored) throw new IncludeRetentionInactiveError();
  const references: Prisma.IncludeReferenceCreateManyInput[] = [];
  for (const [ordinal, tag] of tags.entries()) {
    // The parser permits arbitrary numeric syntax; PostgreSQL revision numbers
    // are int32. Never silently turn an unrepresentable pin into an unpinned tag.
    if (tag.settings.rev !== undefined && (!Number.isSafeInteger(tag.settings.rev) || tag.settings.rev > 2_147_483_647)) {
      throw new IncludeRetentionInactiveError();
    }
    const binding = tag.kind === 'loc'
      ? { memoryId: source.memoryId, loc: tag.target }
      : await includeUrnTarget(tx, tag.target);
    references.push({
      includerId, ordinal, kind: tag.kind, reference: tag.target,
      targetMemoryId: binding?.memoryId ?? null, targetLoc: binding?.loc ?? null,
      pinnedRevNo: tag.settings.rev ?? null,
      requiresApproved: tag.settings.approved === true, requiresSigned: tag.settings.signed === true,
      metadataGeneration: generation.metadataGeneration,
    });
  }
  await tx.includeReference.deleteMany({ where: { includerId } });
  if (references.length) await tx.includeReference.createMany({ data: references });
  const coverage = {
    sourceRevision: source.revSeq, sourceMemoryId: source.memoryId, sourceLoc: source.loc,
    sourceContentFingerprint: stored.fingerprint, sourceEncrypted: source.memory.isEncrypted,
    parserVersion: INCLUDE_RETENTION_PARSER_VERSION, metadataGeneration: generation.metadataGeneration,
    referenceCount: references.length,
    state: references.length ? 'COMPLETE_TAGS' as const : 'COMPLETE_EMPTY' as const,
  };
  await tx.includeSourceCoverage.upsert({ where: { includerId }, create: { includerId, ...coverage }, update: coverage });
}
