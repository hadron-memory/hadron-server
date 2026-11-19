/**
 * Types for the post-push inventory parser (#434 slice B).
 *
 * The parser is a `.mjs` script so the CI lane (`migrateDiffFilter.mjs`) and
 * the regenerator (`gen-post-push-manifest.mjs`) can run it with plain `node`
 * — no build step in the workflow. Its contract is unit-tested from
 * TypeScript, though, so the exports carry declarations; an
 * `// @ts-expect-error` at the test's import would have silenced every FUTURE
 * type error in that test too, which is the cheaper fix and the wrong one
 * (same call as scripts/check-sdl-enumerations.d.mts).
 */

/** Kinds the parser can classify; anything else is `unrecognized`. */
export type ObjectKind =
  | 'extension'
  | 'index'
  | 'unique-index'
  | 'check-constraint'
  | 'foreign-key-constraint'
  | 'unique-constraint'
  | 'generated-column'
  | 'function'
  | 'trigger'
  | 'table'
  | 'sequence';

/** The parser's own kind vocabulary, in order. */
export const OBJECT_KINDS: readonly ObjectKind[];

/** What `classify` returns for one statement it could fully name. */
export type ClassifiedObject =
  | { kind: 'function'; name: string; args: string }
  | { kind: 'trigger'; name: string; table: string; trigger: string }
  | { kind: Exclude<ObjectKind, 'function' | 'trigger'>; name: string };

/**
 * One classification: a named object, or an `unrecognized` marker (the
 * completeness test turns any of these red).
 */
export type ClassifiedEntry = ClassifiedObject | { unrecognized: string };

/**
 * Classify one already-scanned statement into ZERO OR MORE entries. An empty
 * list is a recognized non-object (guard drops, DML, session state); one
 * statement can create several objects (an ALTER TABLE with multiple
 * object-creating actions). `payloads` carries the statement's dollar-quoted
 * body text, scanned only for DO blocks (EXECUTE'd DDL inside them creates
 * real objects); `file`/`line` are accepted so scan results can be passed
 * straight through.
 */
export function classify(stmt: { sql: string; payloads?: string }): readonly ClassifiedEntry[];

/** One durable object the closure creates. Identity is `kind:name`. */
export interface InventoryRow {
  kind: ObjectKind;
  name: string;
  file: string;
  line: number;
  /** Every declare site (an idempotent re-declare appends here). */
  sites: Array<{ file: string; line: number }>;
}

/** A statement the parser could not classify — a red condition, never noise. */
export interface UnrecognizedStatement {
  sql: string;
  file: string;
  line: number;
}

/**
 * The full inventory of the `\ir` closure rooted at `entryFile`. Throws when a
 * FUNCTION name appears with two different normalized argument lists (a true
 * overload the parser must be taught to name).
 */
export function postPushInventory(entryFile: string): {
  objects: InventoryRow[];
  unrecognized: UnrecognizedStatement[];
  statementCount: number;
};
