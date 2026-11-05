/**
 * The most nodes one document covers, the Feature included. Largest corpus feature today is well under
 * 100 parts; each part costs one reconcile read, so the cap bounds the work as well as the bytes. Over
 * it the call refuses and never shortens the document (cor:spc:030:01). The VALUE may change; the
 * refusal may not. Admission prices `SpecDocument.entries` at this number.
 */
export const SPEC_DOCUMENT_MAX_NODES = 300;
export const SPEC_DOCUMENT_TOO_LARGE = 'SPEC_DOCUMENT_TOO_LARGE';
