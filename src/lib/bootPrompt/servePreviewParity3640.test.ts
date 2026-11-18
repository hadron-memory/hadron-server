/**
 * #3640 (follow-up of #3635): the SDL enum `BootPromptServeRefusal` and the refusals a PREVIEW can actually return
 * must be the same set. The set under test is observed, not re-declared: a db whose first read throws each code in
 * turn is handed to `previewServedBootPrompt`, which turns the codes it recognises into `{ refusal }` and rethrows
 * the rest. `BOOT_PROMPT_REFUSAL_CODES` is deliberately NOT the comparison set, because it also holds
 * `BOOT_PROMPT_RECORDED_REVISION_DELETED`, which belongs to an open session and is never a preview outcome.
 *
 * Assumption this harness rests on, and why it holds: the mapping from a thrown code to `{ refusal }` happens at ONE
 * place, the single try/catch in `previewServedBootPrompt` (src/lib/bootPrompt/serve.ts) around
 * `resolveServedBootPrompt`; no read position inside the resolver has its own mapping. So throwing at the first read
 * exercises the same `SERVE_REFUSALS` check that a throw at any later read would. If that mapping were ever split
 * per call site, this pin would need to throw at successive read positions instead.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { parse, Kind } from 'graphql';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';
import { BOOT_PROMPT_REFUSAL_CODES, bootPromptRefusal } from './refusal.js';
import { previewServedBootPrompt, type BootPromptServeRefusalCode } from './serve.js';

type Code = (typeof BOOT_PROMPT_REFUSAL_CODES)[number];
const RECORDED: Code = 'BOOT_PROMPT_RECORDED_REVISION_DELETED';

function sdlEnumValues(name: string): string[] {
  const doc = parse(typeDefs);
  const values: string[] = [];
  let found = false;
  for (const d of doc.definitions) {
    if ((d.kind === Kind.ENUM_TYPE_DEFINITION || d.kind === Kind.ENUM_TYPE_EXTENSION) && d.name.value === name) {
      found = true;
      values.push(...(d.values ?? []).map((v) => v.name.value));
    }
  }
  if (!found) throw new Error(`enum ${name} not found in the SDL`);
  return values;
}

/** Any read the serve makes throws this code, the way the real resolver does when it refuses. */
function dbRefusing(code: Code) {
  const fail = () => {
    throw bootPromptRefusal(code, { surface: 'bind', agentName: 'Parity' });
  };
  const model = new Proxy({}, { get: () => fail });
  return new Proxy({}, { get: () => model }) as unknown as Parameters<typeof previewServedBootPrompt>[0];
}

const target = { surface: 'bind' as const, appId: null, agent: { id: 'agent-parity', name: 'Parity' } };

/** The codes a preview hands back as a typed refusal. A code the preview rethrows is not in the list; any other failure fails loudly. */
async function previewProducible(): Promise<string[]> {
  const out: string[] = [];
  for (const code of BOOT_PROMPT_REFUSAL_CODES) {
    try {
      const outcome = await previewServedBootPrompt(dbRefusing(code), target);
      expect(outcome).toEqual({ served: null, refusal: code });
      out.push(code);
    } catch (err) {
      // Only the injected refusal may come back out, and only for a code the preview does not own.
      expect((err as { extensions?: { code?: unknown } }).extensions?.code).toBe(code);
      expect(code).toBe(RECORDED);
    }
  }
  return out;
}

describe('#3640 BootPromptServeRefusal parity with the preview-producible refusals', () => {
  let producible: string[];
  beforeAll(async () => {
    producible = await previewProducible();
  });

  it('a preview returns every code except the recorded-revision one, and rethrows that one', async () => {
    expect(producible).toEqual(BOOT_PROMPT_REFUSAL_CODES.filter((c) => c !== RECORDED));
    await expect(previewServedBootPrompt(dbRefusing(RECORDED), target)).rejects.toMatchObject({ extensions: { code: RECORDED } });
  });

  it('the SDL enum is exactly the preview-producible set (and never the recorded-revision code)', () => {
    const sdl = sdlEnumValues('BootPromptServeRefusal');
    expect([...sdl].sort()).toEqual([...producible].sort());
    expect(sdl).not.toContain(RECORDED);
    expect(new Set(sdl).size).toBe(sdl.length);
  });

  it('every SDL member is a known refusal code, and the serve-refusal type excludes the recorded-revision code', () => {
    for (const v of sdlEnumValues('BootPromptServeRefusal')) expect(BOOT_PROMPT_REFUSAL_CODES as readonly string[]).toContain(v);
    // Compile-time tripwire (test files are typechecked by `tsc --noEmit`): if the recorded-revision code became a
    // serve refusal this line would stop erroring, and the unused expectation would fail the build.
    // @ts-expect-error the recorded-revision code is not a BootPromptServeRefusalCode
    const _notServe: BootPromptServeRefusalCode = RECORDED;
    void _notServe;
  });
});
