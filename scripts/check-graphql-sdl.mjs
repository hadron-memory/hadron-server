#!/usr/bin/env node
/**
 * Template-literal + SDL gate — three checks, in the order the last one needs.
 *
 * #1087 widened this past SDL. The hazard was never GraphQL: it is PROSE INSIDE
 * A TEMPLATE LITERAL, and the #1076 guard was scoped to where its author had
 * been bitten. One hour after that merged, the identical trap landed in a
 * `$queryRaw` SQL comment — a file this gate did not scan. Check 1b is that
 * widening.
 *
 * 1. THE LITERAL IS INTACT (#1076). `typeDefs.ts` is one `#graphql`-tagged
 *    template literal; a BARE backtick inside a GraphQL description or `#`
 *    comment terminates it, and everything after it is parsed as TypeScript.
 *    This half reads the file as TEXT and names the offending line.
 * 1b. THE TAGGED LITERALS ARE INTACT (#1087, #1110). Every `$queryRaw` /
 *    `$executeRaw` / `Prisma.sql` literal in `src/`. NOT the same scan as
 *    check 1 — it does not text-scan the file at all. `scanTaggedLiterals`
 *    asks the TypeScript parser where each literal ends, and then covers the
 *    two ways a stray backtick can end one:
 *      - it leaves the file UNPARSEABLE — reported against the nearest tagged
 *        literal, since `tsc` blames wherever the remainder stops making sense
 *        and never says "unterminated literal";
 *      - it RE-PAIRS into valid TypeScript, so the parser has no complaint at
 *        all and the truncated query still runs. Caught by
 *        `closesInsideSqlComment` (#1110), which asks one question about the
 *        literal itself: does its SQL END inside a `--` comment. Nothing about
 *        the surrounding expression is consulted. The shape is BANNED rather
 *        than diagnosed — a valid query whose comment simply runs to the close
 *        is refused too — because six attempts at telling those apart all
 *        failed; that function's header records the sequence and the ruling.
 * 2. THE SDL PARSES. Imports `typeDefs` from
 *    `src/api/graphql/schema/typeDefs.ts` (the single SDL source) and runs
 *    `graphql.parse()` on it.
 *
 *    Catches the class of bug from PR #136: a `"""docstring"""` block
 *    accidentally left adjacent to another `"""docstring"""` block on the same
 *    definition. `tsc` can't see this because the SDL lives inside a template
 *    literal (opaque to TypeScript); the vitest suite doesn't necessarily
 *    import `typeDefs` in a path that triggers parse-at-module-load; the
 *    runtime parse only fires on first `makeExecutableSchema` / Apollo init,
 *    which can be at process boot. Result: bad SDL can survive every existing
 *    gate and only surface in production as a boot loop.
 *
 * The ORDER is the whole design, and it is why check 1 lives here rather than
 * in a gate of its own: check 2 cannot run at all on a file check 1 rejects —
 * the module does not compile, so the import throws before this script's own
 * code executes. That is also why the import is DYNAMIC. A static one is
 * hoisted above everything, so the friendly message would never be reached and
 * the operator would get the same misleading TS1005 cascade the check exists to
 * translate.
 *
 * Run from CI on every PR that touches the SDL or anything that could ship a
 * new SDL fragment:
 *
 *   pnpm tsx scripts/check-graphql-sdl.mjs             # both checks
 *   node scripts/check-graphql-sdl.mjs --dir <path>    # check 1 only, elsewhere
 *
 * Exits 0 when both checks pass, 1 otherwise. The helpers are exported so
 * check-graphql-sdl.test.ts can prove this gate still FAILS on a planted
 * backtick — a gate that only ever passes is a line of setup.
 */
import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DEFAULT_SDL_DIR = join(ROOT, 'src', 'api', 'graphql', 'schema');

/** The marker that makes a template literal in this repo an SDL document. */
const SDL_MARKER = '#graphql';

/**
 * Every SDL document opening in one file: a template literal whose first
 * characters are `#graphql`, optionally preceded by its `const NAME =`.
 *
 * Keyed on the MARKER rather than on the declaration, because the marker is
 * what makes the literal SDL — an ordinary multi-line TS template literal
 * legitimately closes wherever its author put the backtick, and matching those
 * would make this check fire on prose.
 */
const SDL_OPEN = /(?:(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*)?`#graphql/g;

/**
 * Every TAGGED prose-carrying template literal (#1087). The hazard was never
 * SDL — it is PROSE INSIDE A TEMPLATE LITERAL, and #1076's guard was scoped to
 * where I had happened to be bitten. One hour after merging it I hit the
 * identical trap in a `$queryRaw` SQL comment, which that guard does not scan.
 *
 * Keyed on a TAG rather than on "any multi-line template literal", for the same
 * reason `SDL_OPEN` is keyed on its marker: an ordinary TS template literal
 * legitimately closes wherever its author put the backtick, so scanning
 * untagged ones would fire on prose. A tag is the author saying "this body is a
 * foreign language", which is exactly the population where a stray backtick is
 * a mistake rather than punctuation.
 *
 * The tag set is MEASURED, not guessed, and the issue's own suggestion (`gql`,
 * `sql`) would have been wrong: bare `` sql` `` matches `` `…/post-push.sql` ``
 * in a doc comment and bare `` graphql` `` matches every `` `${base}/graphql` ``
 * URL in the repo. Only two families survive contact with the codebase:
 *
 *   - `$queryRaw` / `$executeRaw` (+`Unsafe`), optionally generic-annotated —
 *     `$queryRaw<{ c: bigint }[]>` — which is 100+ call sites and the one that
 *     bit;
 *   - `Prisma.sql`, the fragment builder.
 *
 * The generic may span LINES — `$queryRaw<\n  { … }[]\n>` is real in this repo
 * (resolvers.worker.ts) — so it is bounded by "no backtick" rather than by "no
 * newline". Forbidding newlines skipped four literals entirely, and a skipped
 * literal is a SILENT false negative while the anti-phantom count stays healthy
 * on the other 101 (PR #1109 review, @codex P2).
 *
 * The `(?<!\`)` is load-bearing and was found by running this, not by reading
 * it. Prose in this repo MENTIONS these tags inside markdown code spans —
 * ``stay \`$executeRawUnsafe\```— and the span's own closing backtick then looks
 * exactly like the literal's opening one. Eight of the first reports were
 * comments talking ABOUT raw SQL. A tag preceded by a backtick is a mention; a
 * tag preceded by `.` or whitespace is a call.
 */
const TAGGED_OPEN =
  /(?:(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*)?(?<!`)(?:\$(?:query|execute)Raw(?:Unsafe)?|Prisma\.sql)(?:<[^`]*>)?`/g;

/**
 * Does `prefix` open a line comment that is still in effect at its end?
 *
 * The naive `.includes('--')` reports a legitimate query as broken when the
 * dashes sit inside a SQL string — `` $queryRaw`SELECT '--'`; `` (PR #1109,
 * @codex). Quote parity is enough to tell them apart: a marker inside an odd
 * number of preceding quotes is inside a string literal, not opening a comment.
 *
 * Known limit, stated rather than silently handled: SQL escapes a quote by
 * doubling it (`''`), which this counts as two and therefore as balanced —
 * correct for `'it''s'`, and it degrades to a LOUD false positive rather than a
 * silent miss in any case it gets wrong, which is the right way round here.
 */
function hasLineComment(prefix, marker) {
  let quoted = false;
  for (let k = 0; k < prefix.length; k += 1) {
    if (prefix[k] === "'") quoted = !quoted;
    else if (!quoted && prefix.startsWith(marker, k)) return true;
  }
  return false;
}

/** 1-indexed line number of `index` in `text`, so the report is clickable. */
function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/**
 * Find SDL literals that ended somewhere other than their own terminator
 * (#1076) — i.e. that contain a bare backtick.
 *
 * A bare backtick in a GraphQL description or `#` comment, where it looks like
 * ordinary prose formatting, ENDS the template literal. What follows is parsed
 * as TypeScript, so the compiler reports TS1005 / TS1443 wherever that stops
 * making sense as a statement. How far away that is depends on where the
 * remainder happens to re-pair: the two backticks I planted while writing this
 * both landed on the same line, and the cascade on #1076 landed on 2129. What
 * is constant is the DIAGNOSIS — "',' expected" on a schema description, with
 * nothing anywhere saying "unterminated template literal". Holger hit it twice in one
 * session (#1050, #1024); @Gil hit it twice in hadron-portal, the second time
 * after reading the finding that documents it (hadron-portal#751, PR #757).
 * Documentation cannot fix it because it fails at AUTHORING time, and a review
 * node fires at review time — after the bad diagnosis has already been made.
 *
 * Detected by WHERE the literal ended AND what follows it, which is the
 * precondition itself rather than one symptom of breaking it. A legitimate
 * terminator satisfies both:
 *
 *   - POSITION: first on its line (`` `; ``), or on the opening line for a
 *     single-line document
 *   - SHAPE: followed by `;` `,` or `)` — a template literal is an expression,
 *     so a real terminator is always followed by whatever consumed it
 *
 * Anything else means the literal ended in the MIDDLE of a body, which is a
 * nested backtick by definition — wherever it sits. The `#` need not start the
 * line: a GraphQL comment runs to end-of-line, so `id # the `urn` field`
 * terminates just as early.
 *
 * POSITION alone is not enough, and the version of this check ported from
 * hadron-portal had that hole (Codex P2 on PR #1085). A description line may
 * legitimately BEGIN with a backtick — a markdown code span, or a fenced
 * ```graphql block — and a position-only rule reads that leading backtick as
 * the document's own terminator, announces the literal intact, and hands the
 * developer the exact TS cascade the gate exists to translate. Requiring the
 * closing SHAPE as well is what tells a terminator from a line that merely
 * starts like one.
 *
 * An ESCAPED backtick (`` \` ``) terminates nothing and is this file's actual
 * idiom — 71 of them, and they render as backticks in the published
 * description. The scan skips them, and a test pins that.
 *
 * Known limit, stated rather than silently handled: a `${…}` interpolation
 * containing a nested template literal would be read as a terminator and
 * reported. There are none in the SDL today; if one is ever added, this fails
 * loudly and wrongly rather than passing quietly and wrongly, which is the
 * right way round for a gate.
 */
export function findBrokenLiterals(file, text, opts = {}) {
  const pattern = opts.pattern ?? SDL_OPEN;
  // The noun in every message. #1087 widened this walker past SDL, and a guard
  // that reports "SDL template literal" over a SQL comment sends the reader to
  // the wrong file.
  const kind = opts.kind ?? 'SDL';
  // Whether a legitimate terminator must also be FIRST ON ITS LINE.
  //
  // True for SDL, where `typeDefs.ts` closes with a `\`;` line by convention.
  // FALSE for raw SQL, and #1087 claimed the rule "ports without change" —
  // measured, it does not. SQL closes on the last content line
  // (`… lower(c.name)\`;`) far more often than on its own, and requiring the
  // position reported 41 offenders across a repo that compiles cleanly.
  //
  // The SHAPE half is the part that actually generalises: a template literal is
  // an expression, so its real terminator is followed by whatever consumed it
  // and nothing else. That alone catches the incident this widening is for — a
  // backtick in `-- \`auto_expired_at\` is set …` is followed by prose, not by
  // a close.
  const requireFirstOnLine = opts.requireFirstOnLine ?? true;
  // The comment marker of the embedded language, so the message can say WHERE
  // the stray backtick is. GraphQL comments open with `#`, SQL with `--`; the
  // first version of the #1087 widening dropped this distinction and told a SQL
  // author about a "# comment", which is the wrong language.
  const commentMarker = opts.commentMarker ?? '#';
  // A backtick with the comment marker EARLIER ON ITS LINE is never a real
  // terminator, whatever its shape or position.
  //
  // This is the precise statement of the hazard rather than a proxy for it, and
  // it took two wrong proxies to get here (PR #1109 review, @codex P2). With
  // POSITION relaxed for SQL, an EMPTY remainder satisfies the shape check — so
  // a stray backtick ending a `-- comment` line was accepted as the terminator
  // and the real closer below was never examined. Demanding a non-empty closer
  // instead then rejected three legitimate literals whose `;` or `)` sits on
  // the NEXT line (`Prisma.sql\`…\`` as a ternary branch, and a query closing
  // on its own line).
  //
  // The comment marker is what actually separates them: a comment runs to
  // end-of-line in both languages, so a closer can never legitimately follow one
  // — while in JS that same backtick ends the literal. No legitimate terminator
  // has `--` (or `#`) before it on its line, and every instance of this bug
  // does.
  const offenders = [];
  // Counted by the SAME walk that finds the offenders. Counting openings with a
  // second, separately-written matcher is how the anti-phantom count and the
  // thing it certifies drift apart (PR #1085 review).
  let documents = 0;
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const openIndex = match.index + match[0].lastIndexOf('`');
    const name = match[1] ?? file;
    documents += 1;

    let i = openIndex + 1;
    while (i < text.length) {
      if (text[i] === '\\') i += 2;
      else if (text[i] === '`') break;
      else i += 1;
    }

    if (i >= text.length) {
      offenders.push({
        name,
        file,
        line: lineOf(text, openIndex),
        errors: [
          `this ${kind} template literal is never terminated — no backtick below it`,
          'closes it, so the rest of the file is inside the literal. Most likely',
          'the closing `; line was deleted.',
        ],
      });
      break;
    }

    const openLineStart = text.lastIndexOf('\n', openIndex) + 1;
    const closeLineStart = text.lastIndexOf('\n', i) + 1;
    const lineEnd = text.indexOf('\n', i);
    const line = text.slice(closeLineStart, lineEnd === -1 ? text.length : lineEnd);
    const sameLineAsOpening = openLineStart === closeLineStart;
    const firstOnItsLine = text.slice(closeLineStart, i).trim() === '';
    // A template literal is an EXPRESSION, so its closer is followed by whatever
    // consumed it and NOTHING ELSE on that line: `;` here, or `,` / `)` / `]` /
    // `}` if the SDL is ever passed inline, plus an optional trailing comment.
    //
    // A TypeScript continuation — `` `.trim() `` or `` ` as const `` — is
    // therefore refused too, which is DELIBERATE (Codex, third pass on #1085).
    // None exists in the SDL, and recognizing them means modelling expression
    // syntax in a text scanner: every form it learns is a shape prose can then
    // imitate, and the failure that buys is a SILENT false negative, which is
    // the one this gate exists to prevent. A false positive is loud, and the
    // message says outright that a real continuation means widening this rule
    // rather than escaping anything — so nobody is sent to the wrong fix.
    //
    // Asserting only a PREFIX is not enough, and that was the second round on
    // this same predicate (Codex, PR #1085): a description line reading
    // `` `;` ends a statement. `` starts with a backtick AND is followed by a
    // semicolon, so a prefix test called it a terminator. Being told "narrower"
    // twice means the SHAPE is wrong rather than the width — a prefix cannot
    // separate syntax from prose that begins like it, however many characters
    // it inspects, so the whole line is the unit (findings, #1032).
    const afterClose = text.slice(i + 1, lineEnd === -1 ? text.length : lineEnd);
    const closesAnExpression = /^[\s;,)\]}]*(\/\/.*)?$/.test(afterClose);
    // Computed before the verdict because it IS part of the verdict now, not
    // only part of the message.
    //
    // Measured over the literal's BODY on this line, not the whole line, and
    // that distinction took a third review round to get right (PR #1109,
    // @codex). Scanning the whole line flags every single-line SDL document,
    // because SDL's own opening marker IS a `#`. Suppressing the opening line
    // instead — the fix I reached for first — then hid a SQL comment that
    // starts immediately after the tag (`$queryRaw\`-- accidental \``), which is
    // a false NEGATIVE and therefore the worse trade.
    //
    // Starting from the body skips the SDL tag by construction and leaves an
    // opening-line SQL comment fully visible.
    const bodyStart = openIndex + 1 + (text.startsWith(SDL_MARKER, openIndex + 1) ? SDL_MARKER.length : 0);
    const prefix = text.slice(Math.max(closeLineStart, bodyStart), i);
    const inComment = hasLineComment(prefix, commentMarker);

    const positionOk = !requireFirstOnLine || sameLineAsOpening || firstOnItsLine;
    if (!positionOk || !closesAnExpression || inComment) {
      // Position-legal but shape-illegal: a line that STARTS with a backtick,
      // i.e. prose — a code span or a fenced block — that looks like a closer.
      const looksLikeATerminator =
        !inComment && requireFirstOnLine && firstOnItsLine && !sameLineAsOpening;
      const why = looksLikeATerminator
        ? [
            'this backtick starts the line like a terminator, but the rest of the',
            'line is not a plain close (`;` `,` `)`) — so this gate reads it as',
            `prose, a code span or a fenced block, that ended the ${kind} template`,
            'literal here. Escape it (\\`).',
            'If instead this IS the terminator and the line is a valid expression',
            'continuation (`.trim()`, `as const`), this gate does not model those:',
            'widen closesAnExpression in scripts/check-graphql-sdl.mjs.',
          ]
        : [
            inComment
              ? `a backtick in this ${commentMarker} comment ends the ${kind} template literal early —`
              : `a backtick here ends the ${kind} template literal early —`,
            'everything below it is then parsed as TypeScript, which reports',
            'TS1005 / TS1443 wherever it stops making sense — sometimes here,',
            'sometimes hundreds of lines away, and never as "unterminated',
            'literal". Escape it (\\`), use single quotes, or spell the symbol out.',
          ];
      offenders.push({ name, file, line: lineOf(text, i), errors: [...why, `    ${line.trim()}`] });
    }
    pattern.lastIndex = i + 1;
  }
  return { offenders, documents };
}

/** Back-compat wrapper: the SDL scan, which is what the existing tests call. */
export function findBrokenSdlLiterals(file, text) {
  return findBrokenLiterals(file, text, { pattern: SDL_OPEN, kind: 'SDL' });
}

/**
 * Scan every `.ts` file directly under `dir` for SDL documents.
 *
 * Returns the offenders AND the number of documents examined: a scan that found
 * nothing to check must not read as a clean one. If the SDL ever moves, or the
 * `#graphql` marker is dropped, `documents === 0` fails the gate instead of
 * passing it.
 */
export function scanSdlDir(dir = DEFAULT_SDL_DIR) {
  const offenders = [];
  let documents = 0;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    const path = join(dir, entry);
    const text = readFileSync(path, 'utf8');
    if (!text.includes(SDL_MARKER)) continue;
    // Repo-relative when the file is in the repo; otherwise (a --dir elsewhere)
    // relative to that dir, rather than a ../../.. climb out of ROOT.
    const fromRoot = relative(ROOT, path);
    const file = fromRoot.startsWith('..') ? relative(dir, path) : fromRoot;
    const found = findBrokenSdlLiterals(file, text);
    documents += found.documents;
    offenders.push(...found.offenders);
  }
  return { offenders, documents };
}

/** Directories under `src/` that carry no hand-written source. */
const SKIP_DIRS = new Set(['generated', 'node_modules']);

/** Every `.ts` file under `dir`, recursively. */
function* tsFilesUnder(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* tsFilesUnder(join(dir, entry.name));
    } else if (entry.name.endsWith('.ts')) {
      yield join(dir, entry.name);
    }
  }
}

/** Tag names whose template literal carries a foreign language, not JS prose. */
const RAW_SQL_TAGS = /\$(?:query|execute)Raw(?:Unsafe)?$|^sql$/;



/** The tag identifier of a tagged template, or null if this is not one. */
function tagNameOf(node) {
  if (!ts.isTaggedTemplateExpression(node)) return null;
  const tag = node.tag;
  return ts.isPropertyAccessExpression(tag)
    ? tag.name.text
    : ts.isIdentifier(tag)
      ? tag.text
      : '';
}

/** Is this AST node a tagged template whose tag is one of ours? */
function isRawSqlTag(node) {
  const name = tagNameOf(node);
  return name !== null && RAW_SQL_TAGS.test(name);
}

/**
 * Does this raw-SQL literal CLOSE inside one of its own `--` comments? (#1110)
 *
 * The re-pair case, and the arm that five earlier attempts could not build. A
 * stray backtick whose remainder happens to re-pair leaves the file PARSEABLE,
 * so the diagnostic arm above is blind to it:
 *
 *   db.$executeRaw`UPDATE u SET a = false -- use `&&` for overlap
 *   WHERE id = ${id}`;
 *
 * is `taggedTemplate && templateExpression` — valid TypeScript, `WHERE` gone,
 * and the truncated UPDATE still runs.
 *
 * WHY THE EARLIER ATTEMPTS FAILED, since the difference is the whole point.
 * Each asked where the EXECUTOR sat: an operand of `&&`, a branch of a
 * conditional, an unowned tail, a parent shape, "no literal beside its own".
 * Every one of those names the SHAPES a re-pair can take, so every one was
 * shown a shape it lacked — a conditional, then the conditional's TEST, then a
 * tail owned by a tag the comment named, then an array element — until the
 * fifth finally flagged ordinary code and had to come out:
 *
 *   await Promise.all([db.$queryRaw`SELECT 1`, db.$queryRaw`SELECT 2`])
 *
 * A gate that blocks valid code gets switched off, which costs more than the
 * gap it closes. Enumerating shapes was the error, not the width of any
 * particular enumeration.
 *
 * WHAT THIS ASKS INSTEAD is one property of the literal alone, with no
 * reference to what encloses it: **does it close on a line whose SQL contains a
 * `--` comment.** Where the executor sits, what consumed it, and what the
 * remainder re-paired into are all irrelevant — which is why no construction
 * defeats it.
 *
 * THE RULE IS DELIBERATELY A BAN, NOT A DIAGNOSIS, and that was @Holger's call
 * (2026-09-03) after a first version tried to be clever. That version added a
 * second condition — the query must also continue past the close — so that the
 * legitimate `` `SELECT 1 -- explanation` `` kept working. @codex broke it from
 * BOTH sides within one review: a stray backtick at end-of-line left an empty
 * tail and passed (false negative), while a valid query ending in a comment and
 * followed by `.then(…)` or `as T` was flagged (false positive on valid code).
 * Repairing that means modelling TypeScript continuations in a text scanner —
 * the exact trap this file's SDL half already documents, and the one that
 * killed five attempts.
 *
 * So the shape is banned outright: **do not end a raw-SQL literal on a comment
 * line.** It costs one valid idiom, which is worth stating plainly rather than
 * pretending away — but that idiom is one keystroke from the bug, the fix is to
 * move the comment up a line or close on the next one, and it appears **0
 * times in 105 raw-SQL literals** here. Making the hazardous shape
 * unrepresentable is cheaper and more honest than telling its safe instances
 * from its unsafe ones, which is what nobody managed six times running.
 *
 * Against the constructions #1110 recorded: the `&&` head case, the tag-owned
 * tail, the array element, and the backtick pair enclosing a semicolon (which
 * no previous version reached at all) are caught; the two conditional shapes
 * leave the file unparseable and belong to the arm above. `Promise.all` with
 * two real queries, a nested `Prisma.sql` fragment, `SELECT '--'`, an escaped
 * backtick in a comment, and a comment on a line the literal does not close on
 * all stay silent.
 *
 * `endsInsideLineComment` is quote-aware, so `SELECT '--'` is a string and not
 * a comment — the distinction that keeps this a ban on one shape rather than on
 * every line containing two dashes. (`hasLineComment` is the SDL half's
 * simpler cousin and is NOT what runs here; PR #1131 review, @copilot.)
 *
 * NOT a SQL parser and NOT an ESLint rule, the two options #1110 proposed and
 * flagged as technology decisions. Neither is needed: the invariant is lexical,
 * and the helper for it was already in this file.
 */
function closesInsideSqlComment(node, text) {
  // The template's last character is its closing backtick — true for both a
  // NoSubstitutionTemplateLiteral and a TemplateExpression with `${}` spans.
  const closeIndex = node.template.end - 1;
  if (text[closeIndex] !== '`') return null;
  return endsInsideLineComment(cookedSql(node.template)) ? closeIndex : null;
}

/**
 * A template's SQL as the DATABASE would see it: cooked text, with every
 * `${…}` span replaced by `?`.
 *
 * Reading the raw source instead was wrong in a way worth recording, because it
 * looked equivalent (PR #1131 review, @codex P2). The scan tracks `'` to tell a
 * SQL string from a comment, and raw source drags the embedded TypeScript of
 * every interpolation through it — so `${"'"}` toggles the quote state and
 * HIDES a real `--` behind it, turning a truncated query into a silent pass.
 * Interpolations become bound parameters, never literal SQL, so they have no
 * business being lexed as SQL at all; `?` is what actually arrives, and it
 * carries no quote or dash.
 *
 * Cooked text also disposes of escapes for free: `` \` `` arrives as a plain
 * backtick that terminated nothing, which is this repo's idiom for naming a
 * column inside a comment.
 */
function cookedSql(template) {
  return ts.isNoSubstitutionTemplateLiteral(template)
    ? template.text
    : template.head.text +
        template.templateSpans.map((span) => `?${span.literal.text}`).join('');
}

/**
 * Does this SQL END inside a `--` line comment?
 *
 * Scanned from the START of the literal rather than from its last line, and
 * that is the whole point (PR #1131 review, @codex P2). A SQL string may SPAN
 * lines:
 *
 *   UPDATE t SET a = 'hello
 *   world' -- use `…`
 *
 * Starting at the final line meets that closing `'` first, reads it as an
 * OPENING quote, and then treats the real `--` as quoted — hiding a truncated
 * UPDATE. Quote state is only meaningful from where the string actually began,
 * so the scan has to carry it across newlines.
 *
 * A comment ends at the newline, so the walk resets there; the answer is simply
 * whether it finishes inside one.
 *
 * QUOTED CONTEXTS ARE SKIPPED WHOLE rather than toggled on `'` alone, and that
 * distinction is load-bearing (PR #1131 review, @codex P2). A toggle treats
 * every apostrophe as SQL string syntax, so an apostrophe inside a
 * `"`-quoted IDENTIFIER — `SET "owner's" = 1 -- use …` — flips the state and
 * then hides the real comment behind it: a truncated UPDATE, passed silently.
 * 11 of this repo's 105 literals contain `"`.
 *
 * My earlier note here claimed the only `"` risk was a `--` INSIDE an
 * identifier being falsely refused — loud, and therefore acceptable. That was
 * half the story: the same gap runs the other way and fails SILENTLY, which is
 * the direction a gate must never fail. Documented limitations deserve the same
 * "which way does it fail" check as code.
 *
 * EVERY Postgres context that can carry a quote or a dash is skipped, not just
 * the ones that had bitten yet. Rounds three, four and five of this review were
 * each "you missed another context" (`"…"` identifiers, then `/* … *\/` blocks,
 * then dollar-quoting), and answering them one at a time was inviting a sixth.
 * So: `'…'` (with `''`), `E'…'` (backslash escapes), `"…"` (with `""`),
 * `/* … *\/` — which NESTS in Postgres, unlike C — and `$tag$ … $tag$`.
 *
 * The remaining limit, stated in BOTH directions because the last version of
 * this note only gave the flattering one: an UNTERMINATED quote or block runs
 * to the end of the literal and reports nothing. That is a silent pass, but
 * only on SQL that is already malformed — and such a literal cannot have closed
 * where its author intended either, so the parse arm or `tsc` gets it first.
 */
function endsInsideLineComment(sql) {
  let inComment = false;
  let k = 0;
  /** Advance past a delimited run, honouring a doubled delimiter as an escape. */
  const skipQuoted = (delim, backslashEscapes) => {
    k += 1;
    while (k < sql.length) {
      if (backslashEscapes && sql[k] === '\\') k += 2;
      else if (sql[k] !== delim) k += 1;
      else if (sql[k + 1] === delim) k += 2;
      else return void (k += 1);
    }
  };
  while (k < sql.length) {
    const ch = sql[k];
    if (ch === '\n' || ch === '\r') {
      // CR ends a line comment in Postgres too, and a cooked `\r` really can
      // appear in one of these literals (@codex P2, #1131). Missing it left a
      // valid query marked as ending inside a comment and REFUSED — the loud
      // direction, but a gate that rejects correct code is the one that gets
      // switched off.
      inComment = false;
      k += 1;
    } else if (inComment) {
      k += 1;
    } else if (ch === "'") {
      // `E'…'` / `e'…'` gives backslash its C-style meaning; a plain string
      // does not. The preceding character must be a standalone E, not the tail
      // of an identifier like `TABLE'…'`.
      skipQuoted("'", /[Ee]/.test(sql[k - 1] ?? '') && !/[\w$]/.test(sql[k - 2] ?? ' '));
    } else if (ch === '"') {
      skipQuoted('"', false);
    } else if (sql.startsWith('/*', k)) {
      // Postgres block comments NEST, so a depth counter is required rather
      // than a scan to the first `*/`.
      let depth = 1;
      k += 2;
      while (k < sql.length && depth > 0) {
        if (sql.startsWith('/*', k)) { depth += 1; k += 2; }
        else if (sql.startsWith('*/', k)) { depth -= 1; k += 2; }
        else k += 1;
      }
    } else if (isDollarQuoteAt(sql, k)) {
      const tag = sql.slice(k).match(DOLLAR_TAG)[0];
      const close = sql.indexOf(tag, k + tag.length);
      k = close === -1 ? sql.length : close + tag.length;
    } else if (sql.startsWith('--', k)) {
      inComment = true;
      k += 2;
    } else {
      k += 1;
    }
  }
  return inComment;
}

/**
 * A dollar-quote delimiter: `$$` or `$tag$`, anchored at the scan position.
 *
 * The tag follows Postgres identifier rules — a letter or underscore, then
 * letters, DIGITS or underscores. The digits matter: `$tag1$` is legal, and
 * omitting them left its body unskipped (PR #1131 review, @copilot).
 *
 * NON-ASCII is admitted wholesale, which is Postgres's ACTUAL rule rather than
 * an approximation of it: its identifier lexer accepts "letters with diacritical
 * marks and non-Latin letters" — implemented as any character outside ASCII.
 *
 * Two review rounds arrived here (@codex P2, twice). The first was `$é$` and I
 * answered it with `\p{L}`; the second pointed out that `\p{L}`/`\p{N}` omit
 * combining MARKS, so a decomposed `$á$` still failed. Rather than add `\p{M}`
 * and wait to be told about `\p{Pc}`, this now matches what Postgres documents.
 * Guessing a category at a time is the same mistake as guessing a SQL context
 * at a time, which this file already made five times over.
 */
const NON_ASCII = '[^\\x00-\\x7F]';
const DOLLAR_TAG = new RegExp(`^\\$(?:(?:[A-Za-z_]|${NON_ASCII})(?:[A-Za-z0-9_]|${NON_ASCII})*)?\\$`, 'u');

/** Any character Postgres allows INSIDE an unquoted identifier, `$` included. */
const IDENT_CHAR = new RegExp(`[A-Za-z0-9_$]|${NON_ASCII}`, 'u');

/**
 * Is position `k` the START of a dollar-quoted string?
 *
 * The delimiter alone is not enough, because Postgres permits `$` INSIDE an
 * unquoted identifier — so a legal column like `owner$tag$` contains a perfect
 * `$tag$` that opens nothing (PR #1131 review, @codex P2). Treating it as a
 * delimiter enters a body with no close, runs the scan to the end of the
 * literal, and swallows a later real `--` — a silent pass on a truncated query.
 *
 * A real dollar-quote therefore cannot directly follow an identifier character.
 * Both bots landed on this one line from opposite sides in the same round —
 * @copilot that the tag was too NARROW, @codex that the boundary was too WIDE —
 * and it needed both to be right.
 */
function isDollarQuoteAt(sql, k) {
  // The same charset as the tag, for the same reason: `café$t$` is ONE
  // identifier, so an ASCII-only boundary test would read the `$t$` inside it
  // as a delimiter and skip past the real comment.
  if (IDENT_CHAR.test(sql[k - 1] ?? ' ')) return false;
  return DOLLAR_TAG.test(sql.slice(k));
}



/**
 * Scan every `.ts` file under `dir` for BROKEN prose-carrying literals (#1087).
 *
 * **This asks the TypeScript parser where a template literal ends rather than
 * deciding for itself, and that is the whole design — arrived at the hard way.**
 * The first version ported check 1's text heuristics to raw SQL and took FIVE
 * review rounds, each trading one edge for another:
 *
 *   - position + shape (the SDL rule) — 41 false positives: SQL closes on its
 *     last content line, not on a line of its own;
 *   - shape only — a backtick ENDING a `--` comment read as the terminator;
 *   - require a non-empty closer — rejected literals whose `;` sits on the NEXT
 *     line (`Prisma.sql` as a ternary branch);
 *   - comment context over the line — flagged every single-line SDL document,
 *     because SDL's own marker IS a `#`;
 *   - comment context over the literal body — false positive on the ordinary
 *     `` `SELECT 1 -- explanation` ``, and blind to block comments.
 *
 * Being told "narrower" five times means the SHAPE is wrong, not the width —
 * which this file already says one function up, about a prefix test. Each fix
 * was another clause of a SQL lexer (line comments, strings, quote parity,
 * block comments) hand-rolled inside a gate whose value is being simple.
 *
 * The parser has no such problem: it DEFINES where a template literal ends. A
 * bare backtick in SQL ends the literal, the rest of the file stops being valid
 * TypeScript, and `parseDiagnostics` is non-empty — precisely the condition
 * this gate exists to detect. All six cases above classify correctly with zero
 * SQL knowledge.
 *
 * What this still adds over `tsc`, and why it is not redundant: `tsc` reports
 * TS1005 wherever the remainder stops making sense — sometimes hundreds of
 * lines from the cause, never as "unterminated literal". This names the TAGGED
 * LITERAL the error falls inside, and says what to do about it.
 *
 * `.test.ts` is included: 15 test files use raw SQL, and a broken literal in any
 * of them breaks `tsc` repo-wide, so the blast radius is identical.
 */
export function scanTaggedLiterals(dir = join(ROOT, 'src')) {
  const offenders = [];
  let documents = 0;
  for (const path of tsFilesUnder(dir)) {
    const text = readFileSync(path, 'utf8');
    // Cheap pre-filter: the walk is over ~700 files and most carry no tag.
    if (!/\$(?:query|execute)Raw|Prisma\.sql/.test(text)) continue;
    const fromRoot = relative(ROOT, path);
    const file = fromRoot.startsWith('..') ? relative(dir, path) : fromRoot;

    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    // Not in the public typings, but stable and what `tsc` itself reports from.
    const diagnostics = source.parseDiagnostics ?? [];

    if (diagnostics.length > 0) {
      const at = diagnostics[0].start ?? 0;
      // The tagged literal the error falls inside or after — what the author has
      // to look at, as opposed to where TypeScript gave up.
      // Also the count for this file: `documents` means "literals EXAMINED",
      // and a broken one was examined — it is the whole reason there is a
      // report. The AST cannot supply it (a broken file has no usable AST), so
      // it comes from the same TAGGED_OPEN walk that locates the literal rather
      // than from a second, separately-written matcher.
      let opensAt = -1;
      TAGGED_OPEN.lastIndex = 0;
      let m;
      while ((m = TAGGED_OPEN.exec(text)) !== null) {
        const openIndex = m.index + m[0].lastIndexOf('`');
        documents += 1;
        if (openIndex <= at) opensAt = openIndex;
      }
      // Report where the PARSER stopped, not where the literal opened: that is
      // at or next to the stray backtick in every case measured, and it is the
      // line the author has to edit. The literal's own opening line is named in
      // the message, because that is the context the bare TS error omits.
      const openLine = opensAt === -1 ? null : lineOf(text, opensAt);
      // Say only what the diagnostic ESTABLISHES (PR #1109 review, @copilot).
      // This branch fires on ANY parse error in a file that happens to contain
      // raw-SQL tags — so asserting "a backtick ended the literal early" would
      // misdiagnose an unrelated missing brace, and send the reader hunting for
      // a backtick that is not there. Which of the two it is turns on whether a
      // raw-SQL literal actually OPENS before the error: if none does, the
      // error cannot be a broken one of ours.
      //
      // The same over-assertion this session kept producing in refusal
      // messages (#1101, four wordings): a remedy is only as good as the claim
      // under it, and a confident wrong cause is worse than an honest vague one.
      offenders.push({
        name: file,
        file,
        line: lineOf(text, at),
        errors:
          // ALWAYS cause-neutral here (PR #1109 review, @copilot then @codex).
          // A literal opening BEFORE the diagnostic does not establish that the
          // diagnostic belongs to it — a completed query followed by a
          // malformed function has exactly that shape, and my first fix only
          // handled the opposite ordering because that is the ordering I wrote
          // a test for. When a literal really did break, the AST rule above
          // fires and says so with evidence; this branch has none, so it names
          // a suspect rather than a cause.
          openLine === null
            ? [
                'this file does not parse, and it contains raw-SQL template literals.',
                'No such literal opens before the error, so this is probably an',
                'ordinary syntax error rather than a backtick that ended a literal',
                'early — but the two are indistinguishable from here, which is why',
                'this gate reports it instead of staying silent.',
              ]
            : [
                'this file does not parse. It contains raw-SQL template literals, the',
                `nearest opening on line ${openLine} — and a bare backtick inside one (a`,
                '`--` comment, a quoted identifier) ends it early, which TypeScript',
                'then reports as TS1005 / TS1443 somewhere below rather than as an',
                'unterminated literal. That is worth checking FIRST, but this gate',
                'cannot tell it from an ordinary syntax error, and does not claim to.',
              ],
      });
      continue;
    }

    // Parsed clean. Count the tagged literals so an empty scan cannot read as
    // a clean one — and check each for the RE-PAIR case (#1110), which by
    // definition only occurs in files that parse.
    const visit = (node) => {
      if (isRawSqlTag(node)) {
        documents += 1;
        const closeIndex = closesInsideSqlComment(node, text);
        if (closeIndex !== null) {
          const lineEnd = text.indexOf('\n', closeIndex);
          const line = text.slice(
            text.lastIndexOf('\n', closeIndex) + 1,
            lineEnd === -1 ? text.length : lineEnd,
          );
          offenders.push({
            name: file,
            file,
            line: lineOf(text, closeIndex),
            errors: [
              'this raw-SQL template literal CLOSES on a line carrying a -- comment.',
              'A SQL comment runs to end-of-line, so a bare backtick anywhere in it',
              'ends the literal early — and the remainder can re-pair into valid',
              'TypeScript, in which case nothing fails to compile and the TRUNCATED',
              'query still runs.',
              'Fix: move the comment up a line, or close the literal on the next',
              'line. If the backtick is the problem, escape it (\\`) or spell the',
              'symbol out. This shape is refused even when it happens to be safe —',
              'telling the safe instances from the broken ones is what six attempts',
              'could not do (#1110).',
              `    ${line.trim()}`,
            ],
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { offenders, documents };
}

async function main(argv) {
  const dirFlag = argv.indexOf('--dir');
  if (dirFlag !== -1) {
    const value = argv[dirFlag + 1];
    if (value === undefined || value.startsWith('-')) {
      console.error('✗ --dir needs a path, e.g. --dir src/api/graphql/schema');
      return 1;
    }
  }
  const dir = dirFlag === -1 ? DEFAULT_SDL_DIR : resolve(argv[dirFlag + 1]);

  let scan;
  try {
    scan = scanSdlDir(dir);
  } catch (e) {
    console.error(`✗ could not read the SDL directory ${dir}: ${e.message}`);
    return 1;
  }

  if (scan.documents === 0) {
    const shown = relative(ROOT, dir);
    console.error(
      `✗ no ${SDL_MARKER} template literal found under ${shown && !shown.startsWith('..') ? shown : dir}.`,
    );
    console.error('  The SDL moved or lost its marker, and this gate was checking nothing.');
    return 1;
  }

  if (scan.offenders.length > 0) {
    for (const offender of scan.offenders) {
      console.error(`✗ ${offender.file}:${offender.line}  ${offender.name}`);
      for (const message of offender.errors) console.error(`    ${message}`);
    }
    console.error(`\n✗ ${scan.offenders.length} broken SDL template literal(s).`);
    return 1;
  }
  console.log(`✓ ${scan.documents} SDL template literal(s) intact.`);

  // Only now is importing the module safe: check 1 just proved it compiles as
  // far as the literal is concerned. Dynamic, so that stays true — see header.
  if (dirFlag !== -1) {
    console.log("… SDL parse skipped: --dir only checks the literal, not this repo's typeDefs.");
    console.log('… raw-SQL scan skipped: --dir checks one directory for SDL only.');
    return 0;
  }

  // Check 1b (#1087) — the same hazard in the OTHER prose-carrying literals.
  // Runs over all of src/, because a `$queryRaw` lives wherever its query does.
  let tagged;
  try {
    tagged = scanTaggedLiterals();
  } catch (e) {
    console.error(`✗ could not scan src/ for tagged template literals: ${e.message}`);
    return 1;
  }
  if (tagged.documents === 0) {
    console.error('✗ no tagged ($queryRaw / $executeRaw / Prisma.sql) template literal found under src/.');
    console.error('  Either they were all removed or the tag set is stale — either way this half');
    console.error('  of the gate was checking nothing. Update TAGGED_OPEN.');
    return 1;
  }
  if (tagged.offenders.length > 0) {
    for (const offender of tagged.offenders) {
      console.error(`✗ ${offender.file}:${offender.line}  ${offender.name}`);
      for (const message of offender.errors) console.error(`    ${message}`);
    }
    console.error(`\n✗ ${tagged.offenders.length} broken raw-SQL template literal(s).`);
    return 1;
  }
  console.log(`✓ ${tagged.documents} tagged (raw-SQL) template literal(s) intact.`);

  try {
    const { typeDefs } = await import('../src/api/graphql/schema/typeDefs.js');
    const { parse } = await import('graphql');
    parse(typeDefs);
    console.log('✓ GraphQL SDL parses cleanly.');
  } catch (e) {
    console.error('✗ GraphQL SDL failed to parse:');
    console.error(e.message);
    return 1;
  }
  return 0;
}

// Only act as a CLI when executed directly, so the test can import the helpers.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
