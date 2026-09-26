/**
 * Shared node field-merge primitives — the per-field strategy that folds one
 * node's fields into another's. Used by both the single-node `mergeNodes`
 * mutation (spec cor:api:070:01) and the memory-level `mergeMemories`
 * mutation (spec cor:api:080), so the merge contract stays identical across
 * the two surfaces.
 *
 * All inputs here are PLAINTEXT: callers decrypt content/abstract/data before
 * calling and re-encrypt the result afterward. `properties` is never encrypted.
 */

import { deserializeTags, serializeTags } from '../integrations/db/provider.js';
import { NodeAbstractTooLongError } from './entityRef/errors.js';

export type NodeMergeField =
  | 'CONTENT'
  | 'ABSTRACT'
  | 'DESCRIPTION'
  | 'TAGS'
  | 'DATA'
  | 'PROPERTIES'
  | 'EDGES';

/** Every mergeable field — the set used when a caller omits an explicit selection. */
export const ALL_NODE_MERGE_FIELDS: readonly NodeMergeField[] = [
  'CONTENT',
  'ABSTRACT',
  'DESCRIPTION',
  'TAGS',
  'DATA',
  'PROPERTIES',
  'EDGES',
];

/** Spec 031 abstract length ceiling, enforced on the COMBINED result. */
export const ABSTRACT_MAX_LENGTH = 2000;

/**
 * Text merge: target first, source appended after a blank line, skipping empty
 * operands so a one-sided value passes through unchanged. Returns null only
 * when both operands are empty.
 */
export function combineText(
  a: string | null | undefined,
  b: string | null | undefined,
): string | null {
  const at = a ?? '';
  const bt = b ?? '';
  if (at === '') return bt === '' ? null : bt;
  if (bt === '') return at;
  return `${at}\n\n${bt}`;
}

/**
 * JSON merge: target wins on key collision; source fills the gaps. Returns the
 * new value only when the source actually contributes a key (else `undefined`
 * = no change). A non-plain-object source (array/scalar/null) never merges —
 * checked BEFORE the `tgt == null` branch so it can't slip through as the
 * result and write an unexpected shape into data/properties.
 */
export function mergeJson(
  src: unknown,
  tgt: unknown,
): Record<string, unknown> | undefined {
  if (src == null || typeof src !== 'object' || Array.isArray(src)) {
    return undefined;
  }
  if (tgt == null) return src as Record<string, unknown>;
  if (typeof tgt !== 'object' || Array.isArray(tgt)) {
    return undefined;
  }
  const merged = { ...(src as Record<string, unknown>), ...(tgt as Record<string, unknown>) };
  const tgtKeys = new Set(Object.keys(tgt as Record<string, unknown>));
  const added = Object.keys(src as Record<string, unknown>).some((k) => !tgtKeys.has(k));
  return added ? merged : undefined;
}

/** Plaintext field view of a node (content/abstract/data already decrypted). */
export interface NodeFieldsView {
  content: string | null;
  abstract: string | null;
  description: string | null;
  /** Raw tags column (serialized form); deserialized internally. */
  tags: unknown;
  data: unknown;
  properties: unknown;
}

export interface NodeMergeResult {
  /** Plaintext field → new value, for the fields that actually changed. */
  changed: Record<string, unknown>;
  abstractChanged: boolean;
  contentChanged: boolean;
}

/**
 * Fold `source`'s selected fields into `target` (the survivor) per the
 * cor:api:070:01 strategy. Both views are PLAINTEXT. Returns the plaintext
 * changes plus flags for the two embedded/hashed fields. Edge transfer is NOT
 * handled here (it lives at the row level); pass EDGES through and act on it
 * separately. Throws NodeAbstractTooLongError if the combined abstract exceeds
 * the cap.
 */
export function mergeNodeFields(
  source: NodeFieldsView,
  target: NodeFieldsView,
  fields: Set<NodeMergeField>,
): NodeMergeResult {
  const changed: Record<string, unknown> = {};
  let abstractChanged = false;
  let contentChanged = false;

  if (fields.has('CONTENT')) {
    const v = combineText(target.content, source.content);
    if (v !== (target.content ?? null)) {
      changed.content = v;
      contentChanged = true;
    }
  }
  if (fields.has('ABSTRACT')) {
    const v = combineText(target.abstract, source.abstract);
    if (v !== (target.abstract ?? null)) {
      if (v != null && v.length > ABSTRACT_MAX_LENGTH) {
        // #1117: report delta/headroom when the merge GROWS an existing
        // abstract; adopting into an empty one (null or '' — combineText
        // treats both as absent) is a full replacement, which has no
        // truthful "current" to report (Copilot round 1 on PR #1371).
        throw new NodeAbstractTooLongError(
          v.length,
          target.abstract ? { currentLength: target.abstract.length } : undefined,
        );
      }
      changed.abstract = v;
      abstractChanged = true;
    }
  }
  if (fields.has('DESCRIPTION')) {
    const v = combineText(target.description, source.description);
    if (v !== (target.description ?? null)) changed.description = v;
  }
  if (fields.has('TAGS')) {
    const tt = deserializeTags(target.tags as string | string[]) as string[];
    const st = deserializeTags(source.tags as string | string[]) as string[];
    const union = [...tt];
    for (const t of st) if (!union.includes(t)) union.push(t);
    if (union.length !== tt.length) changed.tags = serializeTags(union);
  }
  if (fields.has('DATA')) {
    const v = mergeJson(source.data, target.data);
    if (v !== undefined) changed.data = v;
  }
  if (fields.has('PROPERTIES')) {
    const v = mergeJson(source.properties, target.properties);
    if (v !== undefined) changed.properties = v;
  }

  return { changed, abstractChanged, contentChanged };
}
