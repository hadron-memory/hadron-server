/**
 * #2199 (cor:rag:010:01 r17) — what a memory is embedded for.
 *
 * Every `class = 'system'` memory (an Agent's definition; later an App's install memory, #1772) is ALWAYS indexed by
 * the summary (abstract) vector, whatever its `vectorIndexEnabled` / `embeddingSource` say; those two settings only
 * ADD passages (content chunks) for a system memory, and cannot switch the summary off. Every other class keeps the
 * opt-in rule untouched. The stored columns are never rewritten and never reflect this, so every projection and
 * client keeps reading exactly what it stored. Indexing grants no read access: search still filters by the caller's
 * readable memories.
 *
 * ONE definition, used by enqueue, the drain, search scope, the memory-config reactions, the move/channel paths, the
 * startup warning and the backfill, so no site re-derives it.
 */

import type { Prisma } from '../../generated/prisma/index.js';

export const SYSTEM_MEMORY_CLASS = 'system';

export type EmbeddingSourceValue = 'abstract' | 'contentChunks' | 'both';

type IndexingInputs = {
  class: string;
  vectorIndexEnabled: boolean;
  embeddingSource?: EmbeddingSourceValue | string | null;
};

/** Is this memory embedded at all (summary and/or passages)? */
export function memoryIsVectorIndexed(m: Pick<IndexingInputs, 'class' | 'vectorIndexEnabled'>): boolean {
  return m.class === SYSTEM_MEMORY_CLASS || m.vectorIndexEnabled;
}

/** Which vector kinds the memory wants: the summary, the content chunks. */
export function embeddingKindsWanted(m: IndexingInputs): { abstract: boolean; chunks: boolean } {
  const usesAbstract = m.embeddingSource === 'abstract' || m.embeddingSource === 'both';
  const usesChunks = m.embeddingSource === 'contentChunks' || m.embeddingSource === 'both';
  if (m.class === SYSTEM_MEMORY_CLASS) {
    // The summary is not optional; the setting only adds passages.
    return { abstract: true, chunks: m.vectorIndexEnabled && usesChunks };
  }
  if (!m.vectorIndexEnabled) return { abstract: false, chunks: false };
  return { abstract: usesAbstract, chunks: usesChunks };
}

/** The same predicate as a Prisma `where` fragment over Memory. */
export const INDEXED_MEMORY_WHERE: Prisma.MemoryWhereInput = {
  OR: [{ vectorIndexEnabled: true }, { class: SYSTEM_MEMORY_CLASS }],
};
