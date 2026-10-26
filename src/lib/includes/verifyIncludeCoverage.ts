import type { Prisma } from '../../generated/prisma/index.js';
import { INCLUDE_RETENTION_PARSER_VERSION, INCLUDE_RETENTION_SCHEMA_VERSION } from './structuralReferences.js';

/**
 * #2063 / cor:dmo:150:07: independent global anti-join for the future maintenance
 * activator. Includes every source and restorable tombstone; no cursor/count-only
 * proof, no key access. Returns completeness only, never source identities.
 * Caller holds the include-history fence and quiescence/drain guard. R1 has NO
 * production caller or ACTIVE transition. R3 must verify and CAS under that same
 * fence; R2 writers maintain coverage atomically or dirty the binding generation.
 */
export async function verifyIncludeCoverage(tx: Prisma.TransactionClient): Promise<boolean> {
  const generation = await tx.includeRetentionGeneration.findUnique({ where: { id: 'singleton' } });
  if (!generation || generation.schemaVersion !== INCLUDE_RETENTION_SCHEMA_VERSION
    || generation.parserVersion !== INCLUDE_RETENTION_PARSER_VERSION
    || generation.verifiedBindingGeneration !== generation.bindingGeneration) return false;
  // Empty coverage must be affirmative, current evidence. This includes sources
  // with ZERO reference rows (a reverse lookup alone cannot discover a gap).
  // The fingerprint stays inside PostgreSQL; no stored source text is selected.
  const [coverage] = await tx.$queryRaw<Array<{ invalid: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM nodes n JOIN memories m ON m.id = n.memory_id
      LEFT JOIN include_source_coverage c ON c.includer_id = n.id
      WHERE c.includer_id IS NULL
        OR c.state = 'NEEDS_AUTHORIZED_REWRITE'
        OR c.parser_version <> ${generation.parserVersion}
        OR c.metadata_generation <> ${generation.metadataGeneration}
        OR c.source_revision <> n.rev_seq
        OR c.source_memory_id <> n.memory_id
        OR c.source_loc <> n.loc
        OR c.source_encrypted <> m.is_encrypted
        OR c.source_content_fingerprint <> encode(sha256(convert_to(CASE WHEN n.content IS NULL THEN 'null' ELSE 'text:' || n.content END, 'UTF8')), 'hex')
        OR c.reference_count <> (SELECT count(*) FROM include_references r WHERE r.includer_id = n.id)
        OR (c.state = 'COMPLETE_EMPTY' AND c.reference_count <> 0)
        OR (c.state = 'COMPLETE_TAGS' AND c.reference_count = 0)
        OR EXISTS (SELECT 1 FROM include_references r WHERE r.includer_id = n.id AND r.metadata_generation <> c.metadata_generation)
    ) AS invalid`;
  return coverage != null && !coverage.invalid;

}
