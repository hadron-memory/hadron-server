/**
 * #5225 item 7 (Belinda R3): the source guard's `console.*` exemption covers the log call's own argument, not the
 * whole line. Before, any line holding a `console.` call was skipped, so a refusal that echoed the caller's value
 * passed when it shared the line with a log.
 */
import { describe, expect, it } from 'vitest';
import { echoesOnLine, withoutConsoleArguments } from './refEchoGuard.js';

describe('#5225: the console exemption is the call argument only', () => {
  it('a log call alone is not a refusal', () => {
    expect(echoesOnLine('console.warn(`No more nodes after "${loc}".`);')).toBe(false);
  });
  it('a refusal on the same line as a log call is still caught', () => {
    expect(echoesOnLine('console.warn(`x`); return textResult(`No more nodes after "${loc}".`);')).toBe(true);
    expect(echoesOnLine('if (bad) { console.error(e); throw new Error(`Unknown scope "${scope}".`); }')).toBe(true);
  });
  it('nested parentheses inside the argument do not end the cut early', () => {
    expect(withoutConsoleArguments('console.log(f(a, (b)), `No more nodes after "${loc}"`); tail')).toBe('; tail');
  });
  it('an argument that continues on the next line is cut to the end of this one', () => {
    expect(withoutConsoleArguments('  console.warn(`Unknown scope "${scope}"`,')).toBe('  ');
  });
  it('the declared (memory, loc) relay stays exempt', () => {
    expect(echoesOnLine('`Node not found at loc "${input.loc}" in memory "${input.memoryId}"`')).toBe(false);
  });
});

describe("#5255 blind F1: a caller reference relayed in any typed code's extensions", () => {
  it('is caught for a non-NOT_FOUND code', () => {
    expect(echoesOnLine("{ extensions: { code: 'NODE_HAS_DESCENDANTS', count: descendantCount, ref: nodeRef } },")).toBe(true);
    expect(echoesOnLine("{ extensions: { code: 'SOME_CONFLICT', id: args.id } }")).toBe(true);
  });
  it("a resolved row's field is not caller text", () => {
    expect(echoesOnLine("{ extensions: { code: 'SOME_CONFLICT', id: task.id } }")).toBe(false);
    expect(echoesOnLine("{ extensions: { code: 'NODE_HAS_DESCENDANTS', count: descendantCount } },")).toBe(false);
  });
});
