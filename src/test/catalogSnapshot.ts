/**
 * #434: the catalog comparator, shared by Slice A's template parity test (templateCatalogParity434.test.ts) and Slice C's
 * migration replay check (scripts/db/migration-replay.ts), so the two can never compare by different rules.
 */
import type { Client } from 'pg';

/** Every definition a re-applied DDL copy could change, keyed by object identity. */
export const SNAPSHOT = `
  SELECT 'col:' || c.relname || '.' || a.attname AS k,
         format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull
           || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || ' generated=' || a.attgenerated::text
           -- #4338 BLIND F2: identity semantics ('a' ALWAYS, 'd' BY DEFAULT, '' none); attgenerated does not carry them.
           || ' identity=' || a.attidentity::text AS d
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'con:' || c.relname || '.' || k.conname, pg_get_constraintdef(k.oid) || ' validated=' || k.convalidated
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'idx:' || i.relname, pg_get_indexdef(i.oid) || ' valid=' || x.indisvalid
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_namespace n ON n.oid = i.relnamespace
   WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'fn:' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', pg_get_functiondef(p.oid)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
     AND NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.objid = p.oid AND e.deptype = 'e')
  UNION ALL
  SELECT 'seq:' || sequencename, data_type::text || ' start=' || start_value || ' inc=' || increment_by
           || ' min=' || min_value || ' max=' || max_value || ' cycle=' || cycle
    FROM pg_sequences WHERE schemaname = 'public'
  UNION ALL
  SELECT 'view:' || viewname, definition FROM pg_views WHERE schemaname = 'public'
  UNION ALL
  SELECT 'tg:' || c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid) || ' enabled=' || t.tgenabled::text
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND NOT t.tgisinternal
  ORDER BY 1`;

export type Snapshot = Map<string, string>;

export async function snapshot(client: Pick<Client, 'query'>): Promise<Snapshot> {
  const { rows } = await client.query<{ k: string; d: string }>(SNAPSHOT);
  return new Map(rows.map((r) => [r.k, r.d]));
}

/** Normalize only SQL whitespace, preserving literals, quoted identifiers and comments byte-for-byte.
 * pg_get_functiondef wraps the source in AS $tag$...$tag$: that outer wrapper holds SQL to scan,
 * while any dollar-quoted value INSIDE the source is literal text and must stay exact.
 * This is deliberately conservative (including backslash escapes and comment formatting).
 */
export function squash(d: string, functionDefinition = true): string {
  let out = '';
  for (let i = 0; i < d.length;) {
    const start = i;
    if (/\s/.test(d[i])) {
      while (i < d.length && /\s/.test(d[i])) i++;
      // A line comment already emitted its significant newline; indentation after it adds no token.
      out += out.endsWith('\n') ? '' : ' ';
    } else if (d[i] === "'" || d[i] === '"') {
      const quote = d[i++];
      const escaped = quote === "'" && /(?:^|[^A-Za-z_0-9$])E$/i.test(d.slice(0, start));
      while (i < d.length) {
        // Ordinary strings depend on standard_conforming_strings: keep the entire source exact rather than guess.
        if (d[i] === '\\' && quote === "'" && !escaped) return d;
        if (d[i] === '\\' && escaped) { i = Math.min(i + 2, d.length); continue; }
        if (d[i++] === quote) {
          if (d[i] === quote) { i++; continue; }
          break;
        }
      }
      out += d.slice(start, i);
    } else if (d.startsWith('--', i)) {
      const end = d.indexOf('\n', i);
      i = end < 0 ? d.length : end + 1;
      out += d.slice(start, i);
    } else if (d.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < d.length && depth > 0) {
        if (d.startsWith('/*', i)) { depth++; i += 2; }
        else if (d.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      out += d.slice(start, i);
    } else {
      const tag = d.slice(i).match(/^\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z_0-9\u0080-\uFFFF]*)?\$/)?.[0];
      const end = tag ? d.indexOf(tag, i + tag.length) : -1;
      if (tag && end >= 0) {
        const body = d.slice(i + tag.length, end);
        // Only the function's AS wrapper contains SQL; nested dollar strings are opaque.
        out += tag + (functionDefinition && /\bAS\s*$/i.test(out) ? squash(body, false) : body) + tag;
        i = end + tag.length;
      } else {
        out += d[i++];
      }
    }
  }
  return out.trim();
}

/**
 * Objects added, removed or redefined between two snapshots, one line each. A function whose body differs
 * ONLY in whitespace outside literals/comments is `reformatted`, not `changed`: Postgres stores
 * an SQL function's body as written
 * (constraints, indexes and triggers are deparsed canonically, so they cannot differ that way), and a
 * copy indented inside a JS template literal differs from post-push.sql in nothing else. It is still
 * reported, never dropped.
 */
export function diff(before: Snapshot, after: Snapshot): string[] {
  const out: string[] = [];
  for (const [k, d] of before) {
    const a = after.get(k);
    if (a === undefined) out.push(`removed ${k}`);
    else if (a !== d) {
      const kind = k.startsWith('fn:') && squash(a) === squash(d) ? 'reformatted' : 'changed';
      out.push(`${kind} ${k}\n  before: ${d}\n  after:  ${a}`);
    }
  }
  for (const k of after.keys()) if (!before.has(k)) out.push(`added ${k}`);
  return out;
}

