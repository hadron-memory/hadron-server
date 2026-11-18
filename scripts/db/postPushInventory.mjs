// Structural-object inventory of the post-push SQL closure (#434 slice B).
//
// post-push.sql is the raw-SQL invariants file applied after every `db push`
// (dev/test); its `\ir` includes pull in the per-feature invariant files. The
// migration-smoke-test lane and the completeness test
// (src/test/postPushManifest.test.ts) both need the same answer to "which
// durable objects does this corpus create?", so the parser lives here and is
// shared. The parser is deliberately strict: any statement it cannot classify
// is reported as `unrecognized`, and the completeness test turns any
// unrecognized statement red — a new object kind (say, CREATE POLICY) cannot
// slip past the inventory silently; it must be taught here and given a
// manifest row.
//
// Object identity is (kind, name). An idempotent re-declare (CREATE … IF NOT
// EXISTS / CREATE OR REPLACE) of the same (kind, name) dedupes into one row
// with every site listed. A FUNCTION name seen with two different normalized
// argument lists is a true overload: two distinct objects under one name,
// which the inventory cannot tell apart by name — that throws and must be
// taught explicitly. Names are normalized by dropping a `public.` schema
// prefix (the default search_path): `fn` and `public.fn` are one object.
//
// One statement can create MORE than one object (`ALTER TABLE t ADD
// CONSTRAINT a CHECK (…), ADD CONSTRAINT b UNIQUE (…)`), so `classify`
// returns a LIST of classifications; an empty list is a recognized
// non-object (guards, session state, data surgery).

import { readFileSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';

/** Kinds the parser knows how to classify. Every other CREATE-shaped statement is unrecognized. */
export const OBJECT_KINDS = [
  'extension',
  'index',
  'unique-index',
  'check-constraint',
  'foreign-key-constraint',
  'unique-constraint',
  'generated-column',
  'function',
  'trigger',
  'table',
  'sequence',
];

/** Statement shapes that are recognized as NON-objects (guards, session state, data surgery). DO is handled on its own: its payload is scanned for DDL. */
const NON_OBJECT_HEADS = /^(INSERT|UPDATE|DELETE|SELECT|SET|RESET|GRANT|REVOKE|COMMENT|ANALYZE|VACUUM|LOCK|TRUNCATE|NOTIFY|LISTEN|CALL|VALUES|WITH)\b/i;

/**
 * DDL-shaped text that may not REMAIN in a DO block's payload after the
 * EXECUTE'd statements were extracted: any verb+word (`CREATE EVENT TRIGGER`,
 * `ALTER COLLATION`, …) refuses the block. The allow-by-default bigram list
 * this replaces silently admitted object kinds it had never been taught
 * (Brooks delta2 A4): top level defaults to deny, so a DO body must too. The
 * remainder is comment- AND string-stripped first (stripPayloadComments +
 * stripPayloadStrings), so prose in RAISE messages — "refusing to create the
 * unique index" — cannot false-positive; the EXECUTE'd DDL itself was already
 * extracted and classified.
 */
const REMAINDER_DDL = /\b(CREATE|ALTER|DROP)\s+\w/i;

/**
 * DDL verb+noun bigram for the RAW remainder (comments stripped, strings
 * INTACT). The second disjunct of the DO-remainder refusal (delta3 B1):
 * string-blanking alone made DDL hiding in string literals the EXECUTE
 * extractor never captured — `EXECUTE format('CREATE INDEX …')`,
 * `v := 'CREATE …'; EXECUTE v`, `EXECUTE E'CREATE …'` — pass as []. The
 * bigram still sees that text because it reads strings; and it ignores
 * prose ("refusing to create the unique index") by requiring the verb's
 * noun (with the usual modifiers) to follow. Prose whose verb IS directly
 * followed by its noun — `RAISE NOTICE 'will create index on %'` — still
 * hits: that is the accepted LOUD direction of this disjunct (delta4 C5),
 * because a false refusal costs one taught head while a missed DDL string
 * costs an inventory hole.
 */
const DO_BLOCK_DDL = /\b(CREATE|ALTER|DROP)\s+((OR\s+REPLACE|TEMP|TEMPORARY|UNLOGGED|MATERIALIZED|UNIQUE|CONCURRENTLY|GLOBAL|LOCAL|RECURSIVE|IF\s+NOT\s+EXISTS)\s+)*(TABLE|INDEX|CONSTRAINT|EXTENSION|FUNCTION|PROCEDURE|TRIGGER|SEQUENCE|SCHEMA|TYPE|DOMAIN|RULE|AGGREGATE|VIEW|POLICY|COLUMN)\b/i;

/**
 * ALTER TABLE actions that are recognized as non-object maintenance, anchored
 * at the action (never the whole statement — `ALTER` is the statement's own
 * head keyword). RENAME is deliberately NOT here: every rename (CONSTRAINT,
 * COLUMN, or the table's own TO) changes an inventoried identity while the
 * manifest keeps the old name — such an action must be taught explicitly,
 * not skipped. `ALTER COLUMN … ADD GENERATED` (identity sequence) is refused
 * separately below.
 */
const BENIGN_ALTER_ACTIONS = /^(DROP|ALTER|VALIDATE\s+CONSTRAINT|CLUSTER|SET|RESET|ENABLE|DISABLE|OWNER|ATTACH|DETACH|FORCE|REPLICA)\b/i;

/** An inline clause that makes a plain ADD COLUMN create objects beyond the column (a constraint, an identity sequence). */
const ADD_COLUMN_OBJECT_CLAUSE = /\b(CONSTRAINT|CHECK|REFERENCES|UNIQUE|PRIMARY\s+KEY|EXCLUDE|GENERATED|IDENTITY)\b/i;

/** psql meta-commands the parser FOLLOWS (relative to the current file, except `\i` which psql resolves against the working directory). A bare path may not start with a quote: `\ir "unterminated` is an odd shape to REFUSE, not a file literally named `"unterminated` (delta2 A1). */
const FOLLOWED_METAS = /^\\(?<cmd>ir|include_relative|i)\s+(?:"(?<dq>[^"]+)"|'(?<sq>[^']+)'|(?<bare>[^"'\s]\S*))\s*$/;
/** psql meta-commands recognized as benign session/output state and silently skipped. */
const ALLOWED_METAS = /^\\(set|unset|echo|qecho|warn)\b/;

const IDENT = String.raw`(?:("[^"]+")|([A-Za-z_][\w$]*))`;
const QUALID = String.raw`(?:${IDENT}\s*\.\s*)?${IDENT}`; // schema-qualified, e.g. public.fn / public.tbl

function unquote(id) {
  return id.startsWith('"') ? id.slice(1, -1).replace(/""/g, '"') : id;
}

/** `public.x` and `x` are the same object (default search_path); other schemas stay qualified. */
function normalizeName(name) {
  return name.replace(/^public\./i, '');
}

function firstIdent(rest) {
  const m = rest.match(new RegExp(`^\\s*${IDENT}`));
  return m ? unquote(m[1] ?? m[2]) : null;
}

/** Name of a QUALID match: groups are (schemaQ, schemaP, nameQ, nameP); schema kept when written. */
function qualidNameFrom(m, offset) {
  const schema = m[offset + 1] ?? m[offset + 2];
  const name = unquote(m[offset + 3] ?? m[offset + 4]);
  return schema ? `${unquote(schema)}.${name}` : name;
}

/** Split `text` on commas at paren depth 0, respecting single/double-quoted strings (E-strings with backslash escapes included). */
function splitTopLevel(text) {
  const parts = [];
  let cur = '';
  let depth = 0;
  let inS = false;
  let eS = false; // that string opened with E'…' (backslash escapes)
  let inD = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inS) {
      if (eS && ch === '\\') { cur += ch + (text[i + 1] ?? ''); i++; continue; } // \' keeps the string open
      cur += ch;
      if (ch === "'" && text[i + 1] === "'") { cur += "'"; i++; }
      else if (ch === "'") inS = false;
      continue;
    }
    if (inD) {
      cur += ch;
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inD = false;
      continue;
    }
    if (ch === "'") {
      const prev = cur.slice(-1);
      const prev2 = cur.slice(-2, -1);
      eS = (prev === 'E' || prev === 'e') && !/[A-Za-z0-9_$]/.test(prev2);
      inS = true;
      cur += ch;
      continue;
    }
    if (ch === '"') { inD = true; cur += ch; continue; }
    if (ch === '(') { depth++; cur += ch; continue; }
    if (ch === ')') { depth--; cur += ch; continue; }
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/**
 * Type-openers usable in a function parameter after an optional parameter
 * name. Used only to DECIDE whether a parameter's first token is a name
 * (`a text`) or the type itself (`character varying`); anything unrecognized
 * keeps the whole parameter text, which can only make identities MORE
 * distinct (loud), never merge two different signatures.
 */
const TYPE_STARTERS = new Set([
  'int', 'integer', 'int2', 'int4', 'int8', 'smallint', 'bigint', 'numeric', 'decimal',
  'real', 'float', 'float4', 'float8', 'double', 'text', 'varchar', 'char', 'character',
  'boolean', 'bool', 'date', 'time', 'timestamp', 'timestamptz', 'timetz', 'interval',
  'json', 'jsonb', 'uuid', 'bytea', 'inet', 'cidr', 'macaddr', 'xml', 'money',
  'regclass', 'regproc', 'regprocedure', 'regtype', 'trigger', 'anyelement', 'anyarray',
  'anynonarray', 'record', 'void', 'name', 'oid', 'bit', 'varbit', 'tsvector', 'tsquery',
  'pg_lsn', 'point', 'line', 'lseg', 'box', 'path', 'polygon', 'circle', 'setof', 'table',
]);

/** Strip a leading parameter NAME (`a text` → `text`), never a type word (`character varying` stays). */
function stripParamName(param) {
  const m = param.match(/^([A-Za-z_][\w$]*)\s+(.+)$/);
  if (!m) return param;
  const rest = m[2].replace(/\s*\[\s*\]/g, '[]').trim();
  const firstWord = rest.match(/^(?:"([^"]+)"|setof\s+([A-Za-z_][\w$]*)|([A-Za-z_][\w$]*))/i);
  if (!firstWord) return param;
  const probe = (firstWord[1] ?? firstWord[2] ?? firstWord[3] ?? '').toLowerCase();
  const looksLikeType = firstWord[1] !== undefined || TYPE_STARTERS.has(probe) || TYPE_STARTERS.has(probe.replace(/\[\]$/, ''));
  return looksLikeType ? rest : param;
}

/**
 * Normalize a function argument list for overload identity: each parameter is
 * cut at `DEFAULT …`, stripped of IN/OUT/INOUT mode words and of a leading
 * parameter name, whitespace-collapsed and lowercased — so `fn(a text)` and
 * `fn(text)` are one signature while `fn(text, integer)` and `fn(numeric, integer)`
 * stay two. Whitespace around STRUCTURAL punctuation (parens, commas) is
 * canonicalized away, so `numeric(10,2)` and `numeric(10, 2)` are one type:
 * two spellings of one signature must never read as a false overload.
 */
function normalizeArgs(raw) {
  return splitTopLevel(raw)
    .map((param) =>
      param
        .split(/\s+DEFAULT\s+/i)[0]
        .replace(/^(IN|OUT|INOUT)\s+/i, '')
        .replace(/\s*\[\s*\]/g, '[]'),
    )
    .map(stripParamName)
    .join(', ')
    .replace(/\s+/g, ' ')
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)\s*/g, ')')
    .replace(/\s*,\s*/g, ', ')
    .trim()
    .toLowerCase();
}

/** Capture a function's argument list with BALANCED parens (`numeric(10,2)` keeps its inner comma-paren content). */
function functionArgs(head) {
  const open = head.indexOf('(');
  if (open === -1) return null;
  let depth = 0;
  let inS = false;
  let eS = false;
  let inD = false;
  for (let i = open; i < head.length; i++) {
    const ch = head[i];
    if (inS) {
      if (eS && ch === '\\') i++; // \' keeps the string open
      else if (ch === "'" && head[i + 1] === "'") i++;
      else if (ch === "'") inS = false;
      continue;
    }
    if (inD) {
      if (ch === '"' && head[i + 1] === '"') i++;
      else if (ch === '"') inD = false;
      continue;
    }
    if (ch === "'") {
      const prev = i > 0 ? head[i - 1] : '';
      const prev2 = i > 1 ? head[i - 2] : '';
      eS = (prev === 'E' || prev === 'e') && !/[A-Za-z0-9_$]/.test(prev2);
      inS = true;
      continue;
    }
    if (ch === '"') { inD = true; continue; }
    if (ch === '(') depth++;
    if (ch === ')') {
      depth--;
      if (depth === 0) return head.slice(open + 1, i);
    }
  }
  return null; // unbalanced — let the caller's unanchored fallback or refusal handle it
}

/**
 * Parse one file's text into statements, following `\ir` includes recursively.
 * Dollar-quoted bodies ($$…$$ / $tag$…$tag$) are kept OUT of the statement
 * text but captured as `payloads` (a DO block's payload is scanned for DDL);
 * `/* … *​/` block comments are skipped, line comments are stripped outside
 * strings, double-quoted identifiers and E'…' escape strings are lexed
 * whole, and multi-line statements are accumulated until a top-level `;`.
 */
function scan(entryFile) {
  const files = new Set();
  const statements = []; // {sql, payloads, file, line}

  function scanFile(file) {
    if (files.has(file)) return;
    files.add(file);
    const text = readFileSync(file, 'utf8');

    let inDollar = null; // closing tag while inside a dollar-quoted body
    let inString = false; // inside a single-quoted literal ('' escapes)
    let eString = false; // that literal was E'…' prefixed (backslash escapes)
    let inDQuote = false; // inside a double-quoted identifier ("" escapes)
    let blockCommentDepth = 0; // Postgres nests /* /* */ */; track depth
    let stmt = ''; // current statement text
    let payload = ''; // dollar-quoted body text of the current statement
    let stmtLine = 0;
    let line = 1;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\n') line++;

      if (inDollar) {
        payload += ch;
        if (text.startsWith(inDollar, i)) { i += inDollar.length - 1; inDollar = null; }
        continue; // body payload is not part of any statement's SQL text
      }
      if (inString) {
        stmt += ch;
        if (eString && ch === '\\') { stmt += text[i + 1] ?? ''; i++; continue; } // \' escape
        if (ch === "'" && text[i + 1] === "'") { stmt += "'"; i++; continue; } // '' escape
        if (ch === "'") { inString = false; eString = false; }
        continue;
      }
      if (inDQuote) {
        stmt += ch;
        if (ch === '"' && text[i + 1] === '"') { stmt += '"'; i++; continue; } // "" escape
        if (ch === '"') inDQuote = false;
        continue;
      }
      if (blockCommentDepth > 0) {
        // Block comments never reach a statement (a `;` inside cannot split
        // it) and nest in Postgres. The single space inserted on entry keeps
        // `CREATE INDEX/*c*/foo` two tokens, not `CREATE INDEXfoo`.
        if (ch === '/' && text[i + 1] === '*') { blockCommentDepth++; i++; continue; }
        if (ch === '*' && text[i + 1] === '/') { blockCommentDepth--; i++; continue; }
        continue;
      }

      if (ch === "'") {
        // E'…' escape-string literals take backslash escapes; a preceding E
        // counts only when it is a standalone opener, not an identifier's tail.
        const prev = i > 0 ? text[i - 1] : '';
        const prev2 = i > 1 ? text[i - 2] : '';
        eString = (prev === 'e' || prev === 'E') && !/[A-Za-z0-9_$"]/.test(prev2);
        inString = true;
        stmt += ch;
        continue;
      }
      if (ch === '"') { inDQuote = true; stmt += ch; continue; }
      if (ch === '$') {
        const m = text.slice(i).match(/^(\$[A-Za-z_]*\$)/);
        if (m && isDollarOpener(text, i)) {
          // Enter the dollar-quoted body: keep the opener in the statement.
          stmt += m[1];
          i += m[1].length - 1;
          inDollar = m[1];
          continue;
        }
        stmt += ch;
        continue;
      }
      if (ch === '\\' && !stmt.trim()) {
        // psql backslash command at line level: read to EOL and dispatch.
        let j = i;
        while (j < text.length && text[j] !== '\n') j++;
        const raw = text.slice(i, j);
        const cmd = stripMetaComment(raw).trim();
        const follow = cmd.match(FOLLOWED_METAS);
        if (follow) {
          const rel = follow.groups.dq ?? follow.groups.sq ?? follow.groups.bare;
          const base = follow.groups.cmd === 'i' ? process.cwd() : dirname(file);
          scanFile(isAbsolute(rel) ? rel : join(base, rel));
        } else if (ALLOWED_METAS.test(cmd)) {
          // benign session/output state: recognized, skipped
        } else {
          // An unfollowed, un-allowlisted meta-command (\i variants with odd
          // argument shapes, \copy, \connect, …) must not vanish: surface it
          // as a statement so classify() reports it unrecognized.
          stmt = cmd;
          stmtLine = stmtLine || line;
          push();
        }
        i = j - 1; // resume at the newline (the loop's i++ lands on it, bumping `line`)
        continue;
      }
      if (ch === '-' && text[i + 1] === '-') {
        // line comment: skip to just before the newline so the loop's own
        // i++ lands ON it and `line` still counts it (inherited bug: the
        // terminating newline was skipped past and every later line lagged).
        while (i < text.length && text[i] !== '\n') i++;
        if (text[i] === '\n') i--;
        continue;
      }
      if (ch === '/' && text[i + 1] === '*') { blockCommentDepth = 1; stmt += ' '; i++; continue; }
      if (ch === ';') {
        push();
        continue;
      }
      if (ch === '\n' || ch === '\r' || ch === '\t') { stmt += ' '; continue; }
      if (!stmt.trim() && stmtLine === 0) stmtLine = line;
      stmt += ch;
    }
    push();

    function push() {
      const sql = stmt.trim().replace(/\s+/g, ' ');
      if (sql) statements.push({ sql, payloads: payload.trim(), file, line: stmtLine });
      stmt = '';
      payload = '';
      stmtLine = 0;
    }

    // A `$tag$` opener is only a dollar-quote DELIMITER when it is not part of
    // an identifier/number (e.g. `a$b$1` is not a quote). At statement level in
    // this corpus every `$` that follows whitespace, `(` or AS is an opener;
    // heuristic: the char before it is not alnum/underscore/dollar.
    function isDollarOpener(_text, i) {
      const prev = i > 0 ? _text[i - 1] : '';
      if (/[A-Za-z0-9_$]/.test(prev)) return false;
      return true;
    }
  }

  scanFile(entryFile);
  return statements;
}

/** An EXECUTE match whose literal is concatenated on either side — by `||`, or
 *  by an adjacent literal (Postgres concatenates quoted strings across
 *  whitespace holding a newline) — is unanalyzable: the tail can carry DDL
 *  only the code-only rule knows, and the loop's replace would hide the verb
 *  from it. Both loops call this with their own match: it reads `m.input`,
 *  the string the match came from, never a mutable copy — the plain loop
 *  rewrites its `remainder` between iterations while `m.index` stays
 *  snapshot-true (#4381 E1).
 *
 *  invariant: no comment can sit in the gap this guard reads. The DO body is
 *  comment-stripped once (`const body = stripPayloadComments(stmt.payloads …)`,
 *  before either EXECUTE loop runs) and both loops slice their matches out of
 *  that stripped text, so by the time the guard looks, the gap is code or
 *  whitespace only. If that ever stops holding — a new comment style the
 *  stripper leaves standing, or a loop fed unstripped text — the comment-gap
 *  pins in src/test/postPushManifest.test.ts ('comments cannot separate a
 *  continuation') go red; they fail on a stripper bypass, not just on a guard
 *  regression. */
const isGlued = (m) =>
  /^\s*(?:\|\||')/.test(m.input.slice(m.index + m[0].length)) || /\|\|\s*$/.test(m.input.slice(0, m.index));

/**
 * Strip `-- comments` from a DO payload WITHOUT touching string literals: a
 * bare global replace would cut at a `--` inside a quoted message and shift
 * the quote pairing the plain-`EXECUTE '…'` extraction depends on. String
 * literals are lexed whole — `''` escapes, `E'…'` backslash escapes, and
 * dollar-quoted spans (`RAISE NOTICE $m$can't$m$`) included — so an
 * apostrophe inside a dollar-quoted message cannot leave the lexer thinking a
 * string is open and keep a LATER comment (delta2 A4: that is how a
 * commented-out `-- EXECUTE 'CREATE INDEX …'` came back as a phantom row).
 */

function stripPayloadComments(body) {
  let out = '';
  let inS = false;
  let eS = false; // that string opened with E'…' (backslash escapes)
  let inD = false; // inside a double-quoted identifier (delta3 B6)
  let blk = 0; // block-comment nesting depth (delta3 B5)
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inS) {
      out += ch;
      if (eS && ch === '\\') { out += body[i + 1] ?? ''; i++; continue; } // \' keeps the string open
      if (ch === "'" && body[i + 1] === "'") { out += "'"; i++; }
      else if (ch === "'") inS = false;
      continue;
    }
    if (blk > 0) {
      // inside a block comment: Postgres nests them, so count depth; the
      // single space emitted at the open stands in for the whole comment.
      if (ch === '/' && body[i + 1] === '*') { blk++; i++; }
      else if (ch === '*' && body[i + 1] === '/') { blk--; i++; }
      continue;
    }
    if (inD) {
      // inside a double-quoted identifier: an apostrophe here is part of the
      // name, not a quote; a -- here is part of the name, not a comment.
      out += ch;
      if (ch === '"' && body[i + 1] === '"') { out += '"'; i++; }
      else if (ch === '"') inD = false;
      continue;
    }
    if (ch === "'") {
      const prev = i > 0 ? body[i - 1] : '';
      const prev2 = i > 1 ? body[i - 2] : '';
      eS = (prev === 'e' || prev === 'E') && !/[A-Za-z0-9_$"]/.test(prev2);
      inS = true;
      out += ch;
      continue;
    }
    const dollar = ch === '$' ? body.slice(i).match(/^(\$[A-Za-z_]*\$)/) : null;
    if (dollar && isPayloadDollarOpener(body, i)) {
      // A dollar-quoted span inside the payload: copy it through verbatim,
      // apostrophes and all, so nothing inside it is mistaken for a comment
      // or a quote.
      const close = body.indexOf(dollar[1], i + dollar[1].length);
      const end = close === -1 ? body.length : close + dollar[1].length;
      out += body.slice(i, end);
      i = end - 1;
      continue;
    }
    if (ch === '/' && body[i + 1] === '*') { blk = 1; out += ' '; i++; continue; }
    if (ch === '"') { inD = true; out += ch; continue; }
    if (ch === '-' && body[i + 1] === '-') {
      while (i < body.length && body[i] !== '\n') i++;
      i--; // the loop's i++ lands ON the newline, preserving it
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

/** A `$tag$` at `i` opens a dollar-quote only when it does not continue an identifier/number (mirrors scan's isDollarOpener). */
function isPayloadDollarOpener(text, i) {
  const prev = i > 0 ? text[i - 1] : '';
  return !/[A-Za-z0-9_$]/.test(prev);
}

/**
 * Blank out string literals and dollar-quoted spans (each becomes one space),
 * leaving identifiers and code. Applied to a DO payload's REMAINDER — after
 * EXECUTE'd statements were extracted and comments stripped — before the
 * REMAINDER_DDL test, so DDL-shaped PROSE inside a string ("refusing to
 * create the unique index") cannot false-positive while real DDL text left in
 * the body still refuses (delta2 A4).
 */
function stripPayloadStrings(text) {
  let out = '';
  let inS = false;
  let eS = false;
  let inD = false; // inside a double-quoted identifier — code, kept (delta3 B6)
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inS) {
      if (eS && ch === '\\') i++; // \' keeps the string open
      else if (ch === "'" && text[i + 1] === "'") i++;
      else if (ch === "'") { inS = false; out += ' '; }
      continue;
    }
    if (inD) {
      out += ch;
      if (ch === '"' && text[i + 1] === '"') { out += '"'; i++; }
      else if (ch === '"') inD = false;
      continue;
    }
    if (ch === "'") {
      const prev = i > 0 ? text[i - 1] : '';
      const prev2 = i > 1 ? text[i - 2] : '';
      eS = (prev === 'e' || prev === 'E') && !/[A-Za-z0-9_$"]/.test(prev2);
      inS = true;
      continue;
    }
    const dollar = ch === '$' ? text.slice(i).match(/^(\$[A-Za-z_]*\$)/) : null;
    if (dollar && isPayloadDollarOpener(text, i)) {
      const close = text.indexOf(dollar[1], i + dollar[1].length);
      const end = close === -1 ? text.length : close + dollar[1].length;
      out += ' ';
      i = end - 1;
      continue;
    }
    if (ch === '"') { inD = true; out += ch; continue; }
    out += ch;
  }
  return out;
}

/**
 * Index just past the `)` that balances the `(` at `openAt`, respecting
 * single-quoted (incl. E'…') and double-quoted spans; -1 when unbalanced.
 */
function balancedClose(text, openAt) {
  let depth = 0;
  let inS = false;
  let eS = false;
  let inD = false;
  for (let i = openAt; i < text.length; i++) {
    const ch = text[i];
    if (inS) {
      if (eS && ch === '\\') i++;
      else if (ch === "'" && text[i + 1] === "'") i++;
      else if (ch === "'") inS = false;
      continue;
    }
    if (inD) {
      if (ch === '"' && text[i + 1] === '"') i++;
      else if (ch === '"') inD = false;
      continue;
    }
    if (ch === "'") {
      const prev = i > 0 ? text[i - 1] : '';
      const prev2 = i > 1 ? text[i - 2] : '';
      eS = (prev === 'e' || prev === 'E') && !/[A-Za-z0-9_$"]/.test(prev2);
      inS = true;
      continue;
    }
    if (ch === '"') { inD = true; continue; }
    if (ch === '(') depth++;
    if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Cut a trailing `-- comment` off a psql meta-command line (outside quoted arguments). */
function stripMetaComment(raw) {
  let inS = false;
  let inD = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inS) { if (ch === "'") inS = false; continue; }
    if (inD) { if (ch === '"') inD = false; continue; }
    if (ch === "'") { inS = true; continue; }
    if (ch === '"') { inD = true; continue; }
    if (ch === '-' && raw[i + 1] === '-') return raw.slice(0, i);
  }
  return raw;
}

/**
 * Classify one already-scanned statement into ZERO OR MORE results: each is a
 * named object (`{kind, name, …}`), an `unrecognized` marker (the
 * completeness test turns any of these red), or — for the list as a whole —
 * empty for a recognized non-object (guard drops, DML, session state). One
 * ALTER TABLE can carry several object-creating actions.
 */
export function classify(stmt) {
  const sql = stmt.sql.replace(/\s+/g, ' ').trim();
  const head = sql; // full statement: ON/OF clauses can sit past any fixed window

  let m;
  if ((m = head.match(new RegExp(`^CREATE EXTENSION (?:IF NOT EXISTS )?${IDENT}`, 'i')))) {
    return [{ kind: 'extension', name: unquote(m[1] ?? m[2]) }];
  }
  if ((m = head.match(new RegExp(`^CREATE UNIQUE INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?${IDENT}`, 'i')))) {
    return [{ kind: 'unique-index', name: normalizeName(unquote(m[1] ?? m[2])) }];
  }
  if ((m = head.match(new RegExp(`^CREATE INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?${IDENT}`, 'i')))) {
    return [{ kind: 'index', name: normalizeName(unquote(m[1] ?? m[2])) }];
  }
  if ((m = head.match(new RegExp(`^CREATE (?:OR REPLACE )?FUNCTION ${QUALID}\\s*\\(`, 'i')))) {
    const args = functionArgs(head);
    if (args === null) return [{ unrecognized: sql }]; // unbalanced parens — refuse, never guess a signature
    return [{ kind: 'function', name: normalizeName(qualidNameFrom(m, 0)), args: normalizeArgs(args) }];
  }
  if ((m = head.match(new RegExp(`^CREATE (?:OR REPLACE )?FUNCTION ${QUALID}`, 'i')))) {
    return [{ kind: 'function', name: normalizeName(qualidNameFrom(m, 0)), args: '' }];
  }
  if ((m = head.match(new RegExp(`^CREATE (?:CONSTRAINT )?TRIGGER (?:IF NOT EXISTS )?${IDENT}`, 'i')))) {
    const on = head.match(new RegExp(`\\bON\\s+${QUALID}`, 'i'));
    const table = on ? normalizeName(qualidNameFrom(on, 0)) : null;
    const name = unquote(m[1] ?? m[2]);
    if (!table) return [{ unrecognized: sql }];
    return [{ kind: 'trigger', name: `${table}.${name}`, table, trigger: name }];
  }
  if ((m = head.match(new RegExp(`^CREATE SEQUENCE (?:IF NOT EXISTS )?${IDENT}`, 'i')))) {
    return [{ kind: 'sequence', name: normalizeName(unquote(m[1] ?? m[2])) }];
  }
  if ((m = head.match(/^CREATE (?:TEMP|TEMPORARY) TABLE/i))) {
    return []; // session-scoped: not a durable object
  }
  if ((m = head.match(new RegExp(`^CREATE TABLE (?:IF NOT EXISTS )?${IDENT}`, 'i')))) {
    return [{ kind: 'table', name: normalizeName(unquote(m[1] ?? m[2])) }];
  }
  // ALTER TABLE: split the action list and classify EACH action. The table
  // may be schema-qualified (QUALID); the benign-action test is anchored at
  // the ACTION text, never the whole statement — `ALTER` is the statement's
  // own head keyword and would vacuously match.
  if ((m = head.match(new RegExp(`^ALTER TABLE (?:ONLY )?(?:IF EXISTS )?${QUALID}\\s+(?<actions>.+)$`, 'is')))) {
    const table = normalizeName(qualidNameFrom(m, 0));
    const out = [];
    for (const action of splitTopLevel(m.groups.actions)) {
      let am;
      if ((am = action.match(new RegExp(`^ADD CONSTRAINT (?:IF NOT EXISTS )?${IDENT}\\s+(?<what>CHECK|FOREIGN KEY|UNIQUE|EXCLUDE|PRIMARY KEY)\\b`, 'i')))) {
        const what = am.groups.what.toUpperCase();
        const kind = what === 'CHECK' ? 'check-constraint'
          : what === 'FOREIGN KEY' ? 'foreign-key-constraint'
            : what === 'UNIQUE' ? 'unique-constraint' : null;
        if (!kind) { out.push({ unrecognized: sql }); continue; } // EXCLUDE / PRIMARY KEY: teach me here
        out.push({ kind, name: normalizeName(unquote(am[1] ?? am[2])) });
        continue;
      }
      if ((am = action.match(new RegExp(`^ADD COLUMN (?:IF NOT EXISTS )?${IDENT}(?<pre>.*?)GENERATED ALWAYS AS\\s*\\(`, 'is')))) {
        // Postgres accepts column constraints in ANY order, so a clause may
        // sit BEFORE the generation expression too: the lazy `pre` capture
        // must stay clean of object clauses or the row names the column and
        // loses them (delta3 B4). CONSTRAINT is not in the list — it can
        // legitimately name the generation clause itself.
        if (/\b(CHECK|REFERENCES|UNIQUE|PRIMARY\s+KEY|EXCLUDE)\b/i.test(am.groups.pre ?? '')) {
          out.push({ unrecognized: sql });
          continue;
        }
        // An inline clause AFTER the generation expression (STORED CHECK …,
        // REFERENCES …) creates objects this row does not name: refuse rather
        // than inventory the column and lose them (delta2 A6).
        const openAt = am.index + am[0].length - 1;
        const closeAt = balancedClose(action, openAt);
        const tail = closeAt === -1 ? '' : action.slice(closeAt + 1);
        if (closeAt === -1 || /\b(CONSTRAINT|CHECK|REFERENCES|UNIQUE|PRIMARY\s+KEY|EXCLUDE|IDENTITY)\b/i.test(tail)) {
          out.push({ unrecognized: sql });
          continue;
        }
        out.push({ kind: 'generated-column', name: `${table}.${unquote(am[1] ?? am[2])}` });
        continue;
      }
      // A GUARDED plain ADD COLUMN is schema-owned skew repair (the corpus
      // idiom: every such column is @map'd in schema.prisma; raw-SQL-only
      // columns surface as drift lines in the smoke lane's filter, not as
      // inventory objects) — but ONLY when the column definition is plain. A
      // guarded column carrying an inline CONSTRAINT/identity still creates
      // objects the inventory must see; Prisma does not introspect CHECK
      // constraints, so an inline one is invisible to both fences. Refuse.
      if (/^ADD COLUMN IF NOT EXISTS\b/i.test(action) && !ADD_COLUMN_OBJECT_CLAUSE.test(action)) continue;
      // `ALTER [COLUMN] … ADD GENERATED … AS IDENTITY` attaches an identity
      // SEQUENCE to an existing column — a new durable object. Postgres makes
      // the COLUMN keyword optional, and the column name may be a QUOTED
      // identifier containing spaces, so the object word between ALTER and ADD
      // cannot be captured by \S+ — anchor on the verb pair alone (delta2 A5,
      // delta3 B2).
      if (/^ALTER\b.*\bADD\s+GENERATED\b/i.test(action)) {
        out.push({ unrecognized: sql });
        continue;
      }
      // `SET SCHEMA` moves the table to another schema — the same identity
      // change a RENAME TO makes, and RENAME is already refused on that
      // ground. It must not pass as benign `SET` (delta2 A5).
      if (/^SET\s+SCHEMA\b/i.test(action)) {
        out.push({ unrecognized: sql });
        continue;
      }
      if (BENIGN_ALTER_ACTIONS.test(action)) continue;
      out.push({ unrecognized: sql }); // unknown action: structural change the parser cannot name
    }
    return out;
  }
  // A DO block runs at apply time, so DDL inside its payload creates real
  // objects the inventory must see. The corpus idiom gates an idempotent
  // ensure-exists on a catalog check and EXECUTEs the DDL — usually from a
  // dollar-quoted ($ddl$…$ddl$), sometimes a plain string. Those are
  // extracted and classified like any other statement. DDL that cannot be
  // extracted (bare DDL statements in the body, EXECUTE format(...) with the
  // DDL hidden in the format string, a nested DO whose own payload this
  // extraction cannot capture) refuses the whole block.
  if (/^DO\b/i.test(head)) {
    // A DO whose payload was never captured — a plain-string or E-string body
    // (`DO 'BEGIN EXECUTE ''CREATE INDEX …''; END'`), which the scanner
    // carries in the statement text, not in `payloads` — must not vanish as a
    // recognized non-object: whatever DDL hides in that string is invisible
    // here. Refuse (delta2 A3).
    if (!(stmt.payloads ?? '').trim()) return [{ unrecognized: sql }];
    const body = stripPayloadComments(stmt.payloads ?? '');
    const out = [];
    let remainder = body;
    for (const m of body.matchAll(/\bEXECUTE\s+\$([A-Za-z_]*)\$([\s\S]*?)\$\1\$/gi)) {
      // A dollar-quoted payload is copied VERBATIM by the stripper, so its
      // own comments would reach classify raw and break its ^-anchored heads
      // — strip them here first (delta3 B7).
      const inner = stripPayloadComments(m[2]);
      // A PARTIALLY captured EXECUTE — concatenation glued to either side —
      // is unanalyzable (delta5 D1); isGlued reads m.input (#4381 E1/E3).
      const glued = isGlued(m);
      // A STATEMENT-LEADING nested DO (payload-in-payload, unextractable
      // here) refuses the block wherever in the string it sits;
      // `ON CONFLICT DO NOTHING` is not one (delta3 B3).
      if (glued || /(^|;)\s*DO\b/i.test(inner)) out.push({ unrecognized: sql });
      else out.push(...classify({ sql: inner }));
      remainder = remainder.replace(m[0], ' ');
    }
    for (const m of remainder.matchAll(/\bEXECUTE\s*'((?:[^']|'')*)'/gi)) {
      // Same shape as the dollar path (delta3 B7): the outer stripper sees a
      // plain-string payload as string CONTENT, so the payload's own comments
      // survive into the DO test and classify — strip them after unescaping
      // (delta4 C4). Same concatenation guard as the dollar path (delta5 D1);
      // isGlued reads m.input, not this loop's mutable `remainder` (#4381 E1).
      const inner = stripPayloadComments(m[1].replace(/''/g, "'"));
      const glued = isGlued(m);
      if (glued || /(^|;)\s*DO\b/i.test(inner)) out.push({ unrecognized: sql });
      else out.push(...classify({ sql: inner }));
      remainder = remainder.replace(m[0], ' ');
    }
    // Any EXECUTE still standing in the remainder after both extraction
    // loops is a shape the extractor cannot capture — format(…), a variable,
    // E'…', a comment glued into the verb: its DDL is unanalyzable here.
    // Refuse it outright rather than let the bigram's noun list decide which
    // uncaptured shapes count (delta4 C1: CREATE STATISTICS / EVENT TRIGGER /
    // PUBLICATION in a format string were silent; this subsumes the noun
    // list's job for EXECUTE shapes, leaving the bigram to cover assignments
    // whose DDL runs elsewhere). The PRIVILEGE spelling is not dynamic SQL:
    // `GRANT/REVOKE EXECUTE ON FUNCTION …` never carries DDL, and the
    // dynamic form is never followed by ON (delta5 D3). This final check
    // refuses at most once — the extraction loops above may each have pushed
    // their own refusals independently of it (delta5 D4).
    const codeOnly = stripPayloadStrings(remainder);
    if (/\bEXECUTE\b(?!\s+ON\b)/i.test(codeOnly) || REMAINDER_DDL.test(codeOnly) || DO_BLOCK_DDL.test(remainder)) out.push({ unrecognized: sql });
    return out;
  }
  if (/^DROP (INDEX|TRIGGER|FUNCTION|VIEW|TABLE|CONSTRAINT|POLICY|SCHEMA|EXTENSION|TYPE|SEQUENCE)\b/i.test(head)) return [];
  if (NON_OBJECT_HEADS.test(head)) return [];
  // No meta-command branch: the scanner only pushes a meta as a statement
  // when it neither followed nor allowlisted it, and every such line must be
  // unrecognized (an odd-shaped \i/\ir would otherwise vanish silently —
  // the delta review's N1). Followed and allowlisted metas never reach here.
  if (/^(BEGIN|COMMIT|ROLLBACK|START TRANSACTION|END)\b/i.test(head)) return [];
  return [{ unrecognized: sql }];
}

/**
 * The full inventory: every durable object in the post-push closure.
 *
 * The corpus may legitimately declare one object twice — an idempotent
 * re-declare (`CREATE … IF NOT EXISTS` / `CREATE OR REPLACE`), as with
 * `agent_task_counters_project_uniq`, which the #2666 backfill surgery and
 * the #2553 invariants file both create. Those dedupe. A FUNCTION name seen
 * with two different normalized argument lists is a true overload: two
 * distinct objects under one name, which the inventory cannot tell apart by
 * name — that throws and must be taught explicitly.
 */
export function postPushInventory(entryFile) {
  const statements = scan(entryFile);
  const objects = [];
  const byIdentity = new Map();
  const functionArgs = new Map(); // name -> Set of normalized arg lists
  const unrecognized = [];
  for (const stmt of statements) {
    for (const c of classify(stmt)) {
      if (!c) continue;
      if (c.unrecognized) {
        unrecognized.push({ sql: c.unrecognized, file: stmt.file, line: stmt.line });
        continue;
      }
      const identity = `${c.kind}:${c.name}`;
      if (c.kind === 'function') {
        const seen = functionArgs.get(c.name) ?? new Set();
        if (seen.size > 0 && !seen.has(c.args)) {
          throw new Error(
            `post-push closure declares function ${c.name} with two argument lists (${[...seen].join(' | ')} and ${c.args})` +
              ` at ${stmt.file}:${stmt.line} — a true overload; the inventory must be taught to name it`,
          );
        }
        seen.add(c.args);
        functionArgs.set(c.name, seen);
      }
      const existing = byIdentity.get(identity);
      if (existing) {
        existing.sites.push({ file: stmt.file, line: stmt.line });
        continue;
      }
      const row = { kind: c.kind, name: c.name, file: stmt.file, line: stmt.line, sites: [{ file: stmt.file, line: stmt.line }] };
      byIdentity.set(identity, row);
      objects.push(row);
    }
  }
  return { objects, unrecognized, statementCount: statements.length };
}
