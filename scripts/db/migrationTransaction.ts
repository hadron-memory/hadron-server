/**
 * #3770: does this migration file end Prisma's implicit transaction?
 *
 * A refusing preflight (SQLSTATE HDPRF, resolve-refused-migrations.ts) is only safe to roll back and carry on from
 * because Prisma runs the file as ONE transaction, so the raise undoes every statement above it. A file that
 * commits earlier (COMMIT, END, ABORT/ROLLBACK, START TRANSACTION, BEGIN, CONCURRENTLY) leaves part of itself
 * committed. This is a real scanner, not a regex over raw text: comments (line, nested block), string literals
 * (including E'' and doubled quotes), quoted identifiers and dollar-quoted bodies are each skipped by the rules
 * of their own syntax, so a comment marker inside a string cannot hide a real COMMIT after it.
 *
 * Statement-level keywords are looked for OUTSIDE dollar-quoted bodies (a DO block's own BEGIN/END is not a
 * transaction statement); CONCURRENTLY is looked for everywhere outside comments and strings.
 */
// PostgreSQL's lexer accepts any byte >= 0x80 in an identifier, so a dollar tag may be non-ASCII ($é$, $日本$, $😀$).
// Without the u flag the range below also covers surrogate halves, i.e. astral characters.
const TAG = /^\$([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/;
const IDENT_CHAR = /[A-Za-z0-9_$\u0080-\uffff]/;

interface Scanned { top: string; code: string }

function scan(sql: string): Scanned {
  let top = '';
  let code = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      while (i < sql.length && sql[i] !== '\n') i++;
    } else if (two === '/*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      top += ' '; code += ' ';
    } else if (c === "'") {
      const escapes = i > 0 && /[Ee]/.test(sql[i - 1]!) && !(i > 1 && IDENT_CHAR.test(sql[i - 2]!));
      i++;
      while (i < sql.length) {
        if (escapes && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === "'") { if (sql[i + 1] === "'") { i += 2; continue; } break; }
        i++;
      }
      i++;
      top += "''"; code += "''";
    } else if (c === '"') {
      i++;
      while (i < sql.length && !(sql[i] === '"' && sql[i + 1] !== '"')) i += sql[i] === '"' ? 2 : 1;
      i++;
      top += '""'; code += '""';
    } else if (c === '$' && (i === 0 || !IDENT_CHAR.test(sql[i - 1]!)) && TAG.test(sql.slice(i))) {
      const tag = TAG.exec(sql.slice(i))![0];
      const end = sql.indexOf(tag, i + tag.length);
      const body = end === -1 ? sql.slice(i + tag.length) : sql.slice(i + tag.length, end);
      code += scan(body).code;
      top += ' ';
      i = end === -1 ? sql.length : end + tag.length;
    } else {
      top += c; code += c;
      i++;
    }
  }
  return { top, code };
}

const STATEMENT_LEVEL = /\b(COMMIT|ROLLBACK|ABORT|END|BEGIN|START\s+TRANSACTION)\b/i;
const ANYWHERE = /\bCONCURRENTLY\b/i;

export function endsImplicitTransaction(sql: string): boolean {
  const { top, code } = scan(sql);
  return STATEMENT_LEVEL.test(top) || ANYWHERE.test(code);
}
