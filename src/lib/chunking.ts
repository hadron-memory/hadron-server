/**
 * Spec 033 US2 — node content chunking for vector retrieval.
 *
 * Splits a node's markdown content into chunks the embedder can ingest
 * one at a time. Two strategies, chosen automatically per-node (FR-015):
 *
 *   - **structure-aware** (default for markdown with usable section
 *     structure): split at top-level heading boundaries. Preserves
 *     semantic units — a chunk corresponds to a thought, not a window.
 *   - **fixed-size** (fallback OR forced via `forceFixedSize`): sliding
 *     token-window with overlap. The right call when the content has no
 *     usable structure (plain prose, transcripts, code) so structure-
 *     aware would emit one giant chunk.
 *
 * **Locator metadata** lives in CHARACTERS, not tokens (FR-016). The
 * tokenization that drives embedding chunking is an internal detail of
 * the platform-fixed model; character offsets are stable across model
 * changes and round-trip cleanly through any text-rendering pipeline.
 * Tokens are approximated as 4 chars/token (rough average for English
 * + markdown; nomic-embed-text-v1.5 specifically uses BPE with this
 * approximate ratio). Exact token boundaries are NOT part of the
 * retrieval contract — only the character span is.
 */

/**
 * Per-memory chunking dials (FR-003). All optional; platform defaults
 * apply when unset. Spec: ~512 tokens / ~64 overlap.
 */
export interface ChunkingConfig {
  chunkTokens?: number;
  chunkOverlap?: number;
  forceFixedSize?: boolean;
}

/**
 * One chunk in a node's content (FR-016). All offsets in characters,
 * relative to the start of the input content string.
 */
export interface Chunk {
  /** 0-indexed position among the node's chunks. */
  chunkIndex: number;
  /** Inclusive character offset of the chunk's first character. */
  charStart: number;
  /** Exclusive character offset (i.e., one past the chunk's last character). */
  charEnd: number;
  /** The chunk's literal text, equal to `content.slice(charStart, charEnd)`. */
  text: string;
}

const DEFAULT_CHUNK_TOKENS = 512;
const DEFAULT_CHUNK_OVERLAP = 64;
const CHARS_PER_TOKEN = 4;

/**
 * Spec 033 US2 (T038) — split `content` into embedding-sized chunks.
 *
 * Strategy selection (FR-015):
 *   - if `forceFixedSize` is true → fixed-size window
 *   - else if content has 2+ top-level markdown headings → structure-aware
 *   - else → fixed-size window
 *
 * Empty / whitespace-only input → empty array (no chunks to embed; FR
 * edge-case "empty content").
 */
export function chunkNode(content: string, config: ChunkingConfig = {}): Chunk[] {
  if (!content || content.trim() === '') return [];

  const force = config.forceFixedSize === true;
  if (force) return fixedSizeChunks(content, config);

  // Structure-aware path: top-level markdown headings (`#`, `##`, `###`).
  // The condition for "usable structure" is 2+ such headings — one heading
  // is a title with no internal structure, and zero headings is plain prose.
  const headings = findHeadings(content);
  if (headings.length >= 2) {
    return structureAwareChunks(content, headings, config);
  }
  return fixedSizeChunks(content, config);
}

/**
 * Find character offsets of all top-level markdown headings (lines
 * starting with `#`, `##`, or `###`). Returns offsets in document order.
 *
 * Skips ATX headings inside fenced code blocks (```), so a Python
 * comment that happens to start with `#` doesn't get treated as a
 * heading. ATX-only — Setext headings (underlined H1/H2) are out of
 * scope for v1 (uncommon in practice, expensive to detect cleanly).
 */
function findHeadings(content: string): number[] {
  const offsets: number[] = [];
  const lines = content.split('\n');
  let pos = 0;
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
    } else if (
      !inFence &&
      (trimmed.startsWith('# ') ||
        trimmed.startsWith('## ') ||
        trimmed.startsWith('### '))
    ) {
      // The heading "starts" at the BOL — chunks should begin on the
      // line, not inside indentation.
      offsets.push(pos);
    }
    pos += line.length + 1; // +1 for the consumed newline
  }
  return offsets;
}

/**
 * Structure-aware chunks: one chunk per heading-bounded section.
 *
 * The chunk starts at the heading's line-start and runs up to (but not
 * including) the next heading. Content BEFORE the first heading
 * (preamble) becomes its own chunk too, so no content is lost.
 *
 * Long sections that exceed `chunkTokens * 4` characters fall through
 * to fixed-size windowing within that section's boundaries, so a giant
 * section doesn't end up as one over-long chunk.
 */
function structureAwareChunks(
  content: string,
  headingOffsets: number[],
  config: ChunkingConfig,
): Chunk[] {
  const tokens = config.chunkTokens ?? DEFAULT_CHUNK_TOKENS;
  const maxChars = tokens * CHARS_PER_TOKEN;

  // Build section bounds: [(start, end), ...]. First section may be
  // preamble starting at 0 if there's text before the first heading.
  const bounds: Array<{ start: number; end: number }> = [];
  if (headingOffsets[0] > 0) {
    bounds.push({ start: 0, end: headingOffsets[0] });
  }
  for (let i = 0; i < headingOffsets.length; i++) {
    const start = headingOffsets[i];
    const end = i + 1 < headingOffsets.length ? headingOffsets[i + 1] : content.length;
    bounds.push({ start, end });
  }

  const chunks: Chunk[] = [];
  let chunkIndex = 0;
  for (const { start, end } of bounds) {
    const sectionText = content.slice(start, end);
    if (sectionText.trim() === '') continue;
    if (sectionText.length <= maxChars) {
      chunks.push({
        chunkIndex: chunkIndex++,
        charStart: start,
        charEnd: end,
        text: sectionText,
      });
    } else {
      // Section too long → fixed-size window WITHIN the section bounds.
      // Use the same dial but bias chunkIndex to keep the overall ordering.
      const sub = fixedSizeChunks(sectionText, config);
      for (const c of sub) {
        chunks.push({
          chunkIndex: chunkIndex++,
          charStart: start + c.charStart,
          charEnd: start + c.charEnd,
          text: c.text,
        });
      }
    }
  }
  return chunks;
}

/**
 * Fixed-size sliding-window chunks measured in approximate tokens.
 *
 * Window size = `chunkTokens * 4` characters. Step = `(chunkTokens -
 * chunkOverlap) * 4` characters (so consecutive windows overlap by
 * `chunkOverlap` tokens). Overlap MUST be < window size; spec FR-003
 * (validated upstream in `createMemory`/`updateMemory`).
 *
 * Last window is truncated to the input length rather than padded, so
 * the final chunk is shorter when the content doesn't divide evenly.
 */
function fixedSizeChunks(content: string, config: ChunkingConfig): Chunk[] {
  // PR-225 review (Gemini med + Copilot): defensive clamping. If
  // `chunkOverlap >= chunkTokens` slips past API validation (e.g., a
  // test inserts directly into the row), the unclamped step would be
  // ≤ 0 and the `Math.max(1, …)` below would force a 1-char slide —
  // potentially emitting millions of chunks for a moderately-sized
  // document. Clamp the inputs at the chunking layer too.
  const tokens = Math.max(1, config.chunkTokens ?? DEFAULT_CHUNK_TOKENS);
  const overlap = Math.max(
    0,
    Math.min(config.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP, tokens - 1),
  );
  const windowChars = tokens * CHARS_PER_TOKEN;
  const stepChars = (tokens - overlap) * CHARS_PER_TOKEN;
  // Belt-and-suspenders: even with the clamping above, keep the
  // floor-at-1 guard so the loop can never spin infinitely.
  const step = Math.max(1, stepChars);

  const chunks: Chunk[] = [];
  let chunkIndex = 0;
  let start = 0;
  while (start < content.length) {
    const end = Math.min(content.length, start + windowChars);
    const text = content.slice(start, end);
    chunks.push({ chunkIndex: chunkIndex++, charStart: start, charEnd: end, text });
    if (end >= content.length) break;
    start += step;
  }
  return chunks;
}
