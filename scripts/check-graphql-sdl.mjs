#!/usr/bin/env node
/**
 * GraphQL SDL gate — two checks, in the order the second one needs.
 *
 * 1. THE LITERAL IS INTACT (#1076). `typeDefs.ts` is one `#graphql`-tagged
 *    template literal; a BARE backtick inside a GraphQL description or `#`
 *    comment terminates it, and everything after it is parsed as TypeScript.
 *    This half reads the file as TEXT and names the offending line.
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
export function findBrokenSdlLiterals(file, text) {
  const offenders = [];
  // Counted by the SAME walk that finds the offenders. Counting openings with a
  // second, separately-written matcher is how the anti-phantom count and the
  // thing it certifies drift apart (PR #1085 review).
  let documents = 0;
  SDL_OPEN.lastIndex = 0;
  let match;
  while ((match = SDL_OPEN.exec(text)) !== null) {
    const openIndex = match.index + match[0].indexOf('`');
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
          'this SDL template literal is never terminated — no backtick below it',
          'closes it, so the rest of the file is inside the literal. Most likely',
          'the closing `; line was deleted.',
        ],
      });
      break;
    }

    const openLineStart = text.lastIndexOf('\n', openIndex) + 1;
    const closeLineStart = text.lastIndexOf('\n', i) + 1;
    const sameLineAsOpening = openLineStart === closeLineStart;
    const firstOnItsLine = text.slice(closeLineStart, i).trim() === '';
    // A template literal is an EXPRESSION: whatever consumed it follows the
    // closing backtick. `;` here, `,` or `)` if the SDL is ever passed inline.
    const closesAnExpression = /^\s*[;,)]/.test(text.slice(i + 1));

    if ((!sameLineAsOpening && !firstOnItsLine) || !closesAnExpression) {
      const lineEnd = text.indexOf('\n', i);
      const line = text.slice(closeLineStart, lineEnd === -1 ? text.length : lineEnd);
      const inComment = line.slice(0, i - closeLineStart).includes('#');
      // Position-legal but shape-illegal: a line that STARTS with a backtick,
      // i.e. prose — a code span or a fenced block — that looks like a closer.
      const looksLikeATerminator = firstOnItsLine && !sameLineAsOpening;
      const why = looksLikeATerminator
        ? [
            'this backtick starts the line like a terminator, but no `;` follows',
            'it — so it is prose (a code span or a fenced block), and it ends the',
            'SDL template literal here. Escape it (\\`).',
          ]
        : [
            inComment
              ? 'a backtick in this # comment ends the SDL template literal early —'
              : 'a backtick here ends the SDL template literal early —',
            'everything below it is then parsed as TypeScript, which reports',
            'TS1005 / TS1443 wherever it stops making sense — sometimes here,',
            'sometimes hundreds of lines away, and never as "unterminated',
            'literal". Escape it (\\`), use single quotes, or spell the symbol out.',
          ];
      offenders.push({ name, file, line: lineOf(text, i), errors: [...why, `    ${line.trim()}`] });
    }
    SDL_OPEN.lastIndex = i + 1;
  }
  return { offenders, documents };
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
    return 0;
  }

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
