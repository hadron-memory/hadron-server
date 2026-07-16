// URN compose/parse/normalize — EXTRACTED to @hadron-memory/urn-lib-js.
//
// Per #693 / design decision D-2026-07-15-005, this module moved to a
// standalone, fixture-corpus-driven package (paired with urn-lib-go) to end the
// copy-pasted URN-parser drift across server / portal / docs / cli (#239). The
// full surface — including the #684 `secret` URN type — is ported verbatim and
// verified against a 155-case conformance corpus in both TS and Go, and against
// this file's own former implementation before extraction.
//
// This re-export keeps every existing `./urn.js` import working unchanged.
// New code may import from '@hadron-memory/urn-lib-js' directly.
export * from '@hadron-memory/urn-lib-js';
