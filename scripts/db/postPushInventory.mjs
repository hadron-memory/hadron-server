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
// Object identity is (kind, name). A duplicate (kind, name) is an error:
// `CREATE OR REPLACE FUNCTION` with the same name replaces, so a corpus that
// creates the same object twice is either a copy-paste bug or an overload the
// parser must be taught to distinguish (name + arg types).

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

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

/** Statement shapes that are recognized as NON-objects (guards, session state, data surgery). */
const NON_OBJECT_HEADS = /^(INSERT|UPDATE|DELETE|SELECT|SET|RESET|GRANT|REVOKE|COMMENT|ANALYZE|VACUUM|DO|LOCK|TRUNCATE|NOTIFY|LISTEN|CALL|VALUES|WITH)\b/i;

const IDENT = String.raw`(?:("[^"]+")|([A-Za-z_][\w$]*))`;
const QUALID = String.raw`(?:${IDENT}\s*\.\s*)?${IDENT}`; // schema-qualified, e.g. public.fn / public.tbl

function unquote(id) {
  return id.startsWith('"') ? id.slice(1, -1).replace(/""/g, '"') : id;
}

function firstIdent(rest) {
  const m = rest.match(new RegExp(`^\\s*${IDENT}`));
  return m ? unquote(m[1] ?? m[2]) : null;
}

/** Name of a QUALID match: groups are (schemaQ, schemaP, nameQ, nameP); schema kept when written. */
function qualidName(m) {
  return qualidNameFrom(m, 0);
}
function qualidNameFrom(m, offset) {
  const schema = m[offset + 1] ?? m[offset + 2];
  const name = unquote(m[offset + 3] ?? m[offset + 4]);
  return schema ? `${unquote(schema)}.${name}` : name;
}

/** Normalize a function argument list for overload identity (whitespace-collapsed, lowercased). */
function normalizeArgs(raw) {
  return raw.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Parse one file's text into statements, following `\ir` includes recursively.
 * Dollar-quoted bodies ($$…$$ / $tag$…$tag$) are skipped as payloads, line
 * comments are stripped outside strings, and multi-line statements are
 * accumulated until a top-level `;`.
 */
function scan(entryFile) {
  const files = new Set();
  const statements = []; // {sql, file, line}

  function scanFile(file) {
    if (files.has(file)) return;
    files.add(file);
    const text = readFileSync(file, 'utf8');

    let inDollar = null; // closing tag while inside a dollar-quoted body
    let inString = false; // inside a single-quoted literal ('' escapes)
    let stmt = ''; // current statement text
    let stmtLine = 0;
    let line = 1;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\n') line++;

      if (inDollar) {
        if (text.startsWith(inDollar, i)) { i += inDollar.length - 1; inDollar = null; }
        continue; // body payload is not part of any statement
      }
      if (inString) {
        stmt += ch;
        if (ch === "'" && text[i + 1] === "'") { stmt += "'"; i++; continue; } // '' escape
        if (ch === "'") inString = false;
        continue;
      }

      if (ch === "'") { inString = true; stmt += ch; continue; }
      if (ch === '$') {
        const m = text.slice(i).match(/^(\$[A-Za-z_]*\$)/);
        if (m && isDollarOpener(text, i, m[1], stmt)) {
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
        // psql backslash command at line level (e.g. \ir "file.sql"): read to EOL.
        let j = i;
        while (j < text.length && text[j] !== '\n') j++;
        const cmd = text.slice(i, j).trim();
        const irMatch = cmd.match(/^\\ir\s+(?:"([^"]+)"|(\S+))\s*$/);
        if (irMatch) scanFile(join(dirname(file), irMatch[1] ?? irMatch[2]));
        i = j - 1; // resume at the newline (the loop's i++ lands on it, bumping `line`)
        continue;
      }
      if (ch === '-' && text[i + 1] === '-') {
        // line comment: skip to end of line
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      if (ch === ';' ) {
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
      if (sql) statements.push({ sql, file, line: stmtLine });
      stmt = '';
      stmtLine = 0;
    }

    // A `$tag$` opener is only a dollar-quote DELIMITER when it is not part of
    // an identifier/number (e.g. `a$b$1` is not a quote). At statement level in
    // this corpus every `$` that follows whitespace, `(` or AS is an opener;
    // heuristic: the char before it is not alnum/underscore/dollar.
    function isDollarOpener(_text, i, tag, sofar) {
      const prev = i > 0 ? _text[i - 1] : '';
      if (/[A-Za-z0-9_$]/.test(prev)) return false;
      return true;
    }
  }

  scanFile(entryFile);
  scanFile(entryFile);
  return statements;
}

/** Classify one statement into `{ kind, name } | null (recognized non-object) | { unrecognized: sql }`. */
export function classify(stmt) {
  const sql = stmt.sql.replace(/\s+/g, ' ').trim();
  const head = sql; // full statement: ON/OF clauses can sit past any fixed window

  let m;
  if ((m = head.match(new RegExp(`^CREATE EXTENSION (?:IF NOT EXISTS )?${IDENT}`, 'i')))) {
    return { kind: 'extension', name: unquote(m[1] ?? m[2]) };
  }
  if ((m = head.match(new RegExp(`^CREATE UNIQUE INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?${IDENT}`, 'i')))) {
    return { kind: 'unique-index', name: unquote(m[1] ?? m[2]) };
  }
  if ((m = head.match(new RegExp(`^CREATE INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?${IDENT}`, 'i')))) {
    return { kind: 'index', name: unquote(m[1] ?? m[2]) };
  }
  if ((m = head.match(new RegExp(`^CREATE (?:OR REPLACE )?FUNCTION ${QUALID}\\s*\\(([^)]*)\\)`, 'i')))) {
    return { kind: 'function', name: qualidName(m), args: normalizeArgs(m[5]) };
  }
  if ((m = head.match(new RegExp(`^CREATE (?:OR REPLACE )?FUNCTION ${QUALID}`, 'i')))) {
    return { kind: 'function', name: qualidName(m), args: '' };
  }
  if ((m = head.match(new RegExp(`^CREATE (?:CONSTRAINT )?TRIGGER (?:IF NOT EXISTS )?${IDENT}`, 'i')))) {
    const on = head.match(new RegExp(`\\bON\\s+${QUALID}`, 'i'));
    const table = on ? qualidNameFrom(on, 0) : null;
    const name = unquote(m[1] ?? m[2]);
    if (!table) return { unrecognized: sql };
    return { kind: 'trigger', name: `${table}.${name}`, table, trigger: name };
  }
  if ((m = head.match(new RegExp(`^CREATE SEQUENCE (?:IF NOT EXISTS )?${IDENT}`, 'i')))) {
    return { kind: 'sequence', name: unquote(m[1] ?? m[2]) };
  }
  if ((m = head.match(new RegExp(`^CREATE (?:TEMP|TEMPORARY) TABLE`, 'i')))) {
    return null; // session-scoped: not a durable object
  }
  if ((m = head.match(new RegExp(`^CREATE TABLE (?:IF NOT EXISTS )?${IDENT}`, 'i')))) {
    return { kind: 'table', name: unquote(m[1] ?? m[2]) };
  }
  // ALTER TABLE … ADD CONSTRAINT name CHECK/FOREIGN KEY/UNIQUE
  if ((m = head.match(new RegExp(`^ALTER TABLE (?:ONLY )?(?:IF EXISTS )?${IDENT}\\s+ADD CONSTRAINT (?:IF NOT EXISTS )?${IDENT}\\s+(CHECK|FOREIGN KEY|UNIQUE|EXCLUDE|PRIMARY KEY)`, 'i')))) {
    const what = m[5].toUpperCase();
    const kind = what === 'CHECK' ? 'check-constraint'
      : what === 'FOREIGN KEY' ? 'foreign-key-constraint'
        : what === 'UNIQUE' ? 'unique-constraint' : null;
    if (!kind) return { unrecognized: sql };
    return { kind, name: unquote(m[3] ?? m[4]) };
  }
  // ALTER TABLE … ADD COLUMN name … GENERATED ALWAYS AS (…) STORED
  if ((m = head.match(new RegExp(`^ALTER TABLE (?:ONLY )?(?:IF EXISTS )?${IDENT}\\s+ADD COLUMN (?:IF NOT EXISTS )?${IDENT}[^;]*?GENERATED ALWAYS AS`, 'i')))) {
    return { kind: 'generated-column', name: `${unquote(m[1] ?? m[2])}.${unquote(m[3] ?? m[4])}` };
  }
  // Guard drops and other recognized non-object statements.
  if (/^ALTER TABLE\b/i.test(head) && /\b(DROP|ALTER|VALIDATE CONSTRAINT|CLUSTER|SET|RESET|ENABLE|DISABLE|OWNER|RENAME|ATTACH|DETACH)\b/i.test(head)) return null;
  if (/^DROP (INDEX|TRIGGER|FUNCTION|VIEW|TABLE|CONSTRAINT|POLICY|SCHEMA|EXTENSION|TYPE|SEQUENCE)\b/i.test(head)) return null;
  if (NON_OBJECT_HEADS.test(head)) return null;
  if (/^\\(ir|include)\b/.test(head)) return null;
  if (/^(BEGIN|COMMIT|ROLLBACK|START TRANSACTION|END)\b/i.test(head)) return null;
  return { unrecognized: sql };
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
    const c = classify(stmt);
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
  return { objects, unrecognized, statementCount: statements.length };
}
