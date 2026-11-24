/**
 * #433 (Holger, 2026-11-22: "reword the disclosure now"): FR_026_DISCLOSURE understated what an encrypted memory with an opted-in vector
 * index keeps in the database. Its points (b) and (c) said inversion can only PARTIALLY reconstruct text, but `node_embeddings.chunk_text`
 * holds the VERBATIM text of every indexed content chunk, unencrypted (embedNodes.ts passes `chunkText: ch.text`, vectors.ts
 * `upsertChunkVectors` inserts it with no encryption branch). The wording is the acceptance, so it is pinned here exactly, and each point
 * by what it must say, so a later edit that softens one fails a named pin. The four points stay four (3009-encrypted-refusal-codes pins
 * the count on the wire); point (d) names the chunk text because revoking really deletes whole `node_embeddings` rows (the revoke pin is
 * in 033-us5-encrypted.test.ts). The disclosure is conditional on the index including content passages, because an abstract-only index
 * (the default source) stores no chunk text: saying otherwise would overstate it the other way.
 *
 * No behaviour or storage change, and no re-consent for memories that acknowledged the older wording (the ruling's scope).
 */
import { describe, expect, it } from 'vitest';
import { EncryptedVectorIndexNotAcknowledgedError, FR_026_DISCLOSURE } from './errors.js';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';

const [a, b, c, d] = FR_026_DISCLOSURE;

describe('#433 FR_026_DISCLOSURE says that verbatim chunk text is stored unencrypted', () => {
  it('is exactly this text, four points', () => {
    expect(FR_026_DISCLOSURE).toEqual([
      '(a) Stored vectors are plaintext — they are NOT encrypted at rest the way the content column is.',
      '(b) When the index includes content passages (embeddingSource contentChunks or both), the verbatim text of each indexed chunk is ALSO stored UNENCRYPTED, in node_embeddings.chunk_text next to its vector: a database dump holds that text in full, readable form. Embedding inversion can additionally reconstruct source text, partially, from a vector alone.',
      '(c) Anyone with database access is therefore a potential viewer of that text (the full text of every indexed chunk, and whatever inversion recovers from the vectors), even though the content column itself is encrypted.',
      '(d) The opt-in is revocable; revoking stops further indexing AND removes the memory\'s already-stored vectors and their chunk text.',
    ]);
    expect(FR_026_DISCLOSURE).toHaveLength(4);
  });

  it('(b) names the column, the verbatim text, that it is unencrypted and the condition (content passages)', () => {
    expect(b).toMatch(/verbatim text of each indexed chunk/);
    expect(b).toMatch(/UNENCRYPTED/);
    expect(b).toMatch(/node_embeddings\.chunk_text/);
    expect(b).toMatch(/in full, readable form/);
    expect(b).toMatch(/contentChunks or both/);
  });

  it('(c) no longer calls what a dump shows "partial content"', () => {
    expect(c).not.toMatch(/partial content/);
    expect(c).toMatch(/full text of every indexed chunk/);
    expect(c).toMatch(/even though the content column itself is encrypted/);
  });

  it('(a) is unchanged and (d) says the revoke removes the chunk text too', () => {
    expect(a).toMatch(/NOT encrypted at rest/);
    expect(d).toMatch(/AND removes the memory's already-stored vectors and their chunk text/);
  });

  it('the refusal message quotes every point, and the error carries the same four on `disclosure`', () => {
    const err = new EncryptedVectorIndexNotAcknowledgedError('hrn:mem:o:m');
    for (const point of FR_026_DISCLOSURE) expect(err.message).toContain(point);
    expect(err.message).toContain('node_embeddings.chunk_text');
    expect(err.disclosure).toEqual([...FR_026_DISCLOSURE]);
  });

  it('the SDL that quotes the constant says the chunk text is stored too (Memory.vectorIndexEncryptedAckAt and updateMemory)', () => {
    const sdl = typeDefs as unknown as string;
    const at = sdl.indexOf('vectorIndexEncryptedAckAt: DateTime');
    expect(at).toBeGreaterThan(0);
    expect(sdl.slice(at - 900, at)).toMatch(/verbatim chunk text/);
    const um = sdl.indexOf('Spec 033 FR-026: enabling');
    expect(um).toBeGreaterThan(0);
    expect(sdl.slice(um, um + 900)).toMatch(/verbatim (chunk )?text/);
  });
});
