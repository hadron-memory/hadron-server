/**
 * `EntityNotFoundError` — the shared base of every "that ref names nothing"
 * error (#1174).
 *
 * These classes always carried their code: `ORGANIZATION_NOT_FOUND: <ref>` is
 * the message each one builds. The code just never reached the wire, because
 * the class extends `Error` rather than `GraphQLError`, so Apollo sent the
 * prose under `extensions.code: "INTERNAL_SERVER_ERROR"`. The not-found was
 * then recoverable ONLY by parsing the message — which cost twice over:
 *
 *   - a client cannot classify it (hadron-cli routes `*_NOT_FOUND` CODES, so a
 *     missing org exited 1, "internal error", for a plain typo);
 *   - `INTERNAL_SERVER_ERROR` is what an operator builds a page-me rule on, so
 *     every user typo trips the alarm that should mean "the server broke".
 *
 * Exactly #918's shape one layer over, and it takes #918's remedy: put the
 * code on the INSTANCE and map the CLASS once in `formatError`, so a not-found
 * added later reaches the wire typed without anyone remembering to come back.
 * `conventions:the-error-code-is-the-contract-the-prose-is-not` is the rule
 * this serves — and the reason the fix is here rather than in the clients.
 *
 * This lives in its own module so `asset/gate.ts` (which owns
 * `MemoryNotFoundError`) and `entityRef/errors.ts` (which re-exports it) can
 * both extend it without an import cycle.
 *
 * #5168: the message no longer carries the ref. It was `<CODE>: <ref>`, the
 * caller's value verbatim (padded if padded), so a token pasted into a ref
 * argument came back in every terminal and log that printed the refusal. It is
 * now `<CODE>: nothing found for the given ref.`, the same text for every value, so
 * the existence posture of every door is what it was (the text never varied by
 * whether the row exists). The CODE is the contract and is unchanged
 * (hrn:node:hadronmemory.com:specs:cor:api:140:01, "Typed errors"); `ref` stays
 * on the instance for server-side logs and is not relayed on the wire.
 */

export abstract class EntityNotFoundError extends Error {
  /**
   * The stable wire code — `AGENT_NOT_FOUND`, `ORGANIZATION_NOT_FOUND`, … —
   * read off the instance by `formatError`'s single mapping.
   */
  readonly code: string;

  /** The reference string the caller passed (an id, a bare URN, or a prefixed URN). */
  readonly ref: string;

  /**
   * @param detail SERVER-AUTHORED text naming what was looked up (e.g. `template rule "spec" authorTask`), never the
   *   caller's input: it is the one thing a not-found may say beyond its code.
   */
  constructor(code: string, ref: string, detail?: string) {
    super(`${code}: nothing found for ${detail ?? 'the given ref'}.`);
    this.code = code;
    this.ref = ref;
  }
}
