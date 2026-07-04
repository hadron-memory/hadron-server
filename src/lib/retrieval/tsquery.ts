/**
 * Boolean query grammar → Postgres tsquery expression (cor:api:090:01, D12).
 *
 * Surface grammar honored in lexical modes: bare terms, `"quoted phrases"`,
 * `AND` / `OR` / `NOT` (UPPERCASE-ONLY — the search-engine convention), leading
 * `-` as NOT, and parentheses. Lowercase/mixed-case `and`/`or`/`not` are plain
 * search terms, so a natural-language query like "not sure" or "cats or dogs"
 * is never silently rewritten into a boolean expression. Precedence:
 * NOT > AND > OR. Adjacent operands are implicitly ANDed
 * (`memory graph` == `memory AND graph`).
 *
 * Rather than hand-build a raw tsquery lexeme string (fragile, unstemmed, an
 * injection surface), we compile to a SQL expression that combines
 * `plainto_tsquery` / `phraseto_tsquery` leaves (which normalize + stem) with
 * the tsquery operators `&&` (and), `||` (or), `!!` (not). Leaf terms are bound
 * as parameters — never interpolated. Malformed input throws
 * BooleanQueryError; the findNodes resolver DEGRADES it to a literal
 * phrase search (envelope flag `literal_fallback`) rather than erroring, so a
 * search box never turns a typo into BAD_USER_INPUT. Use `literalQuery` to
 * pre-quote raw text.
 */

export class BooleanQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BooleanQueryError';
  }
}

type Tok =
  | { t: 'and' }
  | { t: 'or' }
  | { t: 'not' }
  | { t: 'lparen' }
  | { t: 'rparen' }
  | { t: 'term'; v: string }
  | { t: 'phrase'; v: string };

type Node =
  | { k: 'term'; v: string }
  | { k: 'phrase'; v: string }
  | { k: 'and'; l: Node; r: Node }
  | { k: 'or'; l: Node; r: Node }
  | { k: 'not'; c: Node };

function tokenize(input: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '(') { toks.push({ t: 'lparen' }); i++; continue; }
    if (c === ')') { toks.push({ t: 'rparen' }); i++; continue; }
    if (c === '"') {
      const end = input.indexOf('"', i + 1);
      if (end === -1) throw new BooleanQueryError('Unterminated quoted phrase.');
      const v = input.slice(i + 1, end).trim();
      if (v) toks.push({ t: 'phrase', v });
      i = end + 1;
      continue;
    }
    // bare run up to whitespace / paren / quote
    let j = i;
    while (j < input.length && !' \t\n\r()"'.includes(input[j])) j++;
    let word = input.slice(i, j);
    i = j;
    // leading '-' → NOT of the rest
    if (word.length > 1 && word[0] === '-') {
      toks.push({ t: 'not' });
      word = word.slice(1);
    } else if (word === '-') {
      continue; // stray dash — ignore
    }
    // Operator words are UPPERCASE-ONLY: a lowercase "not"/"or"/"and" is a
    // plain term, so natural phrases ("not sure", "cats or dogs") search
    // literally instead of silently turning into boolean expressions.
    if (word === 'AND') toks.push({ t: 'and' });
    else if (word === 'OR') toks.push({ t: 'or' });
    else if (word === 'NOT') toks.push({ t: 'not' });
    else toks.push({ t: 'term', v: word });
  }
  return toks;
}

/** Recursive-descent parser. Grammar: or := and (OR and)*; and := not (AND? not)*; not := (NOT|-)not | primary. */
function parse(toks: Tok[]): Node {
  let pos = 0;
  const peek = () => toks[pos];
  const eof = () => pos >= toks.length;

  function parseOr(): Node {
    let left = parseAnd();
    while (!eof() && peek().t === 'or') {
      pos++;
      if (eof()) throw new BooleanQueryError('Trailing OR with no right-hand operand.');
      left = { k: 'or', l: left, r: parseAnd() };
    }
    return left;
  }
  function parseAnd(): Node {
    let left = parseNot();
    while (!eof()) {
      const nx = peek().t;
      if (nx === 'or' || nx === 'rparen') break;
      if (nx === 'and') {
        pos++;
        if (eof()) throw new BooleanQueryError('Trailing AND with no right-hand operand.');
      }
      // explicit AND consumed above, or implicit AND between adjacent operands
      left = { k: 'and', l: left, r: parseNot() };
    }
    return left;
  }
  function parseNot(): Node {
    if (!eof() && peek().t === 'not') {
      pos++;
      if (eof()) throw new BooleanQueryError('NOT with no operand.');
      return { k: 'not', c: parseNot() };
    }
    return parsePrimary();
  }
  function parsePrimary(): Node {
    if (eof()) throw new BooleanQueryError('Unexpected end of query.');
    const tk = peek();
    if (tk.t === 'lparen') {
      pos++;
      const inner = parseOr();
      if (eof() || peek().t !== 'rparen') throw new BooleanQueryError('Unbalanced parentheses.');
      pos++;
      return inner;
    }
    if (tk.t === 'rparen') throw new BooleanQueryError('Unexpected ")".');
    if (tk.t === 'and' || tk.t === 'or') throw new BooleanQueryError(`Query cannot start with ${tk.t.toUpperCase()}.`);
    if (tk.t === 'term') { pos++; return { k: 'term', v: tk.v }; }
    if (tk.t === 'phrase') { pos++; return { k: 'phrase', v: tk.v }; }
    throw new BooleanQueryError('Unexpected token.');
  }

  const ast = parseOr();
  if (!eof()) throw new BooleanQueryError('Unexpected trailing tokens (check parentheses/operators).');
  return ast;
}

export interface CompiledTsquery {
  /** SQL expression of type tsquery, e.g. `(plainto_tsquery('english',$3) || plainto_tsquery('english',$4))`. */
  sql: string;
  /** Ordered leaf-term parameters to bind at $(<startIndex> + n). */
  params: string[];
}

/**
 * Parse `input` and compile it to a tsquery SQL expression whose leaf terms are
 * bound parameters starting at `$${startIndex}`. Throws BooleanQueryError on
 * malformed input or a query with no searchable terms.
 */
export function compileBooleanQuery(input: string, startIndex: number): CompiledTsquery {
  const toks = tokenize(input);
  if (toks.length === 0) throw new BooleanQueryError('Empty query.');
  const ast = parse(toks);
  const params: string[] = [];
  const emit = (n: Node): string => {
    switch (n.k) {
      case 'term': {
        params.push(n.v);
        return `plainto_tsquery('english', $${startIndex + params.length - 1})`;
      }
      case 'phrase': {
        params.push(n.v);
        return `phraseto_tsquery('english', $${startIndex + params.length - 1})`;
      }
      case 'and':
        return `(${emit(n.l)} && ${emit(n.r)})`;
      case 'or':
        return `(${emit(n.l)} || ${emit(n.r)})`;
      case 'not':
        return `(!! ${emit(n.c)})`;
    }
  };
  const sql = emit(ast);
  if (params.length === 0) throw new BooleanQueryError('Query has no searchable terms.');
  return { sql, params };
}

/**
 * Quote raw text as a single literal phrase leaf — the grammar's literal
 * form. Internal double quotes become spaces (the grammar has no quote
 * escape), so any input with searchable text tokenizes as exactly one
 * `phrase` and cannot hit a parse error. CAVEAT: input that is empty or
 * quotes/whitespace-only literalizes to an empty phrase, which tokenize()
 * drops — compile still throws 'Empty query.' Callers of the findNodes
 * literal fallback treat that as zero hits (see safeLiteralSearch), never
 * an error. Backs the findNodes literal fallback for malformed boolean
 * input.
 */
export function literalQuery(raw: string): string {
  return `"${raw.replace(/"/g, ' ')}"`;
}
