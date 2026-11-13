/**
 * #4096 — caller text with a NUL (U+0000) cannot be stored: Postgres text rejects it with 22021, which reached the
 * caller as an untyped INTERNAL_SERVER_ERROR. A refusal the platform raises on purpose is typed (cor:api:260:01), so each
 * write ENTRY that takes caller text checks it here, before any write, and names the field without echoing the value
 * (the value carries the NUL; engineering convention from #2730/#2759, not a spec rule).
 *
 * This lives at the entries and NOT in `mapChatSeqConflict`: two of that wrapper's sites (`cloneMemory`, `extractParentNode`)
 * write text the server copied from stored rows, where a 22021 would be a server fault that must stay INTERNAL_SERVER_ERROR.
 */
import { GraphQLError } from 'graphql';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export type UnstorableText = { field: string; what: 'a NUL (U+0000) character' | 'an unpaired UTF-16 surrogate' };

function unstorable(value: string): UnstorableText['what'] | null {
  if (value.includes('\0')) return 'a NUL (U+0000) character';
  // Unpaired surrogates fail the same write (the driver cannot encode them as UTF-8); a valid non-BMP pair passes.
  if (LONE_SURROGATE.test(value)) return 'an unpaired UTF-16 surrogate';
  return null;
}

/** The first field whose text cannot be stored, or null. A string, or an array of strings (tags), is inspected; anything else is not text. */
export function findUnstorableText(fields: Record<string, unknown>): UnstorableText | null {
  for (const [field, value] of Object.entries(fields)) {
    const texts = typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
    for (const t of texts) {
      const what = unstorable(t);
      if (what) return { field, what };
    }
  }
  return null;
}

/** The refusal's text: names the field and the kind of character, never the value. */
export function unstorableTextMessage({ field, what }: UnstorableText): string {
  return `Invalid \`${field}\`: it contains ${what}, which cannot be stored. Remove it and retry.`;
}

/** Throws the typed BAD_USER_INPUT refusal when any listed caller text field cannot be stored. */
export function assertStorableText(fields: Record<string, unknown>): void {
  const found = findUnstorableText(fields);
  if (found) throw new GraphQLError(unstorableTextMessage(found), { extensions: { code: 'BAD_USER_INPUT', field: found.field } });
}
