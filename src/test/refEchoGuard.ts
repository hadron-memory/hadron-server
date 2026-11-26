/**
 * The source guard of #5168, extended by #5225 (items 1-5 and 7): no refusal text in `src` quotes a value the caller typed.
 *
 * **This is a line-regex tripwire, not a proof** (#5225 item 7, Belinda N4). It reads one source line at a time, so a
 * refusal built across lines, through a helper, or from a variable with another name passes it. The proof for every
 * GraphQL field with a reference argument (top-level `ref`/`*Ref`/`urn`/`*Urn`/`id`/`*Id`, and the same names one
 * level inside an input object) is the door probe, `src/api/graphql/schema/resolvers.refEcho5168.test.ts`, which
 * calls each door and reads what comes back. This guard catches the shapes the probe cannot reach: MCP handlers, and
 * doors whose refusal sits behind an earlier gate the probe's caller does not pass.
 */

/** Each pattern is one refusal shape that interpolates a value as the thing refused. */
export const ECHO_CLASS: RegExp[] = [
  /`[A-Z][\w ]* "\$\{[^}`]+\}" not found/,
  /`[A-Z][\w ]* not found: \$\{[^}`]+\}`/,
  /`[A-Z][\w ]* \$\{[^}`]+\} not found\.?`/,
  /No match for [\w ]*"\$\{/,
  /No readable [\w ]*"\$\{/,
  // QA carry P2 (272a77fd): the single-quoted and "not found or invalid" shapes, and "No <noun> matching".
  /not found[^`]*['"]\$\{[^}`]+\}['"]/,
  /not found[^`]*: \$\{[^}`]+\}/,
  /No \w+ matching ['"]\$\{/,
  // #5225 items 1-5: "No more nodes after", "already soft-deleted", the moved/descendant conflicts, "Unknown <noun>",
  // a name quoted at the head of a refusal, and a ref relayed in parentheses.
  /No more \w+ after ['"]?\$\{/,
  /['"]\$\{[^}`]+\}['"] is already soft-deleted/,
  /`Node ['"]\$\{[^}`]+\}['"] (moved|has \$\{)/,
  /Unknown (?:scope|widget type)(?: ['"]\$\{|: \$\{)/,
  /`['"]\$\{[^}`]+\}['"] is owned by/,
  /scope ['"]\$\{[^}`]+\}['"] by name/,
  /\(ref ['"]\$\{[^}`]+\}['"]\)/,
  /Current URN's memory \(\$\{/,
  /`[Nn]ode ['"]\$\{[^}`]+\}['"]( and its| does not satisfy|`)/,
  /`['"]\$\{loc\}['"] and its /,
  // #5225 item 6: a not-found that relays the caller's reference in its extensions (`{ id }`, `id: ref`, …).
  // A value read from the caller's arguments (shorthand, `args.*`, `input.*`); a resolved row's id (`task.id`) is not one.
  /_NOT_FOUND['"], [^\n]*\{ ?(?:ref|id|eventId|hostId|taskId)(?:: (?:args|input)\.[\w.]+)? ?\}\)/,
  /code: ['"]\w+_NOT_FOUND['"], (?:ref|id|eventId|hostId|taskId):/,
];

/**
 * Named exceptions, each with its reason. The loc and memoryId of a node addressed by (memory, loc) are the declared
 * exception of #5168 (the NODE_NOT_FOUND `loc`/`memoryId` relay, QA F1; Holger's ruling on cor:api:140:01 is open).
 * The approval summary names a partial by its stored URN, server data rather than caller input.
 */
export const ECHO_EXEMPT: RegExp[] = [
  /Node not found at loc "\$\{input\.loc\}" in memory "\$\{input\.memoryId\}"/,
  /Instruction partial not found at approval: \$\{p\.urn\}/,
];

const CONSOLE_CALL = /\bconsole\.(?:warn|log|error|info|debug)\(/g;

/**
 * The line with every `console.*(…)` call's own argument removed (#5225 item 7, Belinda R3). A log line is not a
 * refusal, but before this only the call's argument was exempt in intent, while the whole LINE was in fact: a refusal
 * on the same line as a log call passed. The argument is cut by balanced parentheses; an argument that does not close
 * on this line is cut to the end of the line (the call continues below and its text is still a log).
 */
export function withoutConsoleArguments(line: string): string {
  let out = '';
  let from = 0;
  for (const m of line.matchAll(CONSOLE_CALL)) {
    const open = m.index! + m[0].length - 1;
    if (open < from) continue;
    out += line.slice(from, m.index);
    let depth = 0;
    let end = line.length;
    for (let i = open; i < line.length; i++) {
      if (line[i] === '(') depth++;
      else if (line[i] === ')' && --depth === 0) { end = i + 1; break; }
    }
    from = end;
  }
  return out + line.slice(from);
}

/** True when the line carries a refusal that echoes an interpolated value and no named exception covers it. */
export function echoesOnLine(line: string): boolean {
  const text = withoutConsoleArguments(line);
  return ECHO_CLASS.some((re) => re.test(text)) && !ECHO_EXEMPT.some((re) => re.test(text));
}
