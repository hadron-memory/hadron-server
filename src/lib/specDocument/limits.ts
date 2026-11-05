/**
 * The most nodes one document covers, the Feature included. Largest corpus feature today is well under
 * 100 parts; each part costs one reconcile read, so the cap bounds the work as well as the bytes. Over
 * it the call refuses and never shortens the document (cor:spc:030:01). The VALUE may change; the
 * refusal may not. Admission prices `SpecDocument.entries` at this number.
 */
export const SPEC_DOCUMENT_MAX_NODES = 300;
export const SPEC_DOCUMENT_TOO_LARGE = 'SPEC_DOCUMENT_TOO_LARGE';

/**
 * Bytes (UTF-8): the cap on nodes does not bound a document (300 parts of 96 KB is 28.8 MB), so the stored bodies
 * of the covered parts, the bodies as served (`entries[].content`, includes resolved, superseded and tails included)
 * and the rendered Markdown are each bounded too. Over either the call refuses with
 * `SPEC_DOCUMENT_TOO_LARGE` and `limit: 'bytes'`; it never shortens the document.
 */
export const SPEC_DOCUMENT_MAX_BYTES = 2_000_000;

/**
 * What one `specDocument` call costs admission before its selection (cor:api:040:02): the resolver builds
 * the whole document whatever is selected, so `{ markdown }` is not cheap and each alias repeats the work.
 */
export const SPEC_DOCUMENT_CALL_COST = 20_000;

/**
 * Distinct wikilink targets one document may resolve. Each costs a database round trip, so without a bound
 * a few MB of short links is minutes of work for one call. Judged before the first resolve.
 */
export const SPEC_DOCUMENT_MAX_LINK_TARGETS = 500;
