/**
 * #3640 (follow-up of #3635): the SDL enum `BootPromptServeRefusal` and the refusals a PREVIEW can actually return
 * must be the same set. The set under test is observed, not re-declared: a db whose first read throws each code in
 * turn is handed to `previewServedBootPrompt`, which turns the codes it recognises into `{ refusal }` and rethrows
 * the rest. `BOOT_PROMPT_REFUSAL_CODES` is deliberately NOT the comparison set, because it also holds
 * `BOOT_PROMPT_RECORDED_REVISION_DELETED`, which belongs to an open session and is never a preview outcome.
 */
import { describe, it, expect } from 'vitest';
import { parse, Kind } from 'graphql';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';
import { BOOT_PROMPT_REFUSAL_CODES, bootPromptRefusal } from './refusal.js';
import { previewServedBootPrompt, type BootPromptServeRefusalCode } from './serve.js';

function sdlEnumValues(name: string): string[] {
  const doc = parse(typeDefs.replace('#graphql', ''));
  for (const d of doc.definitions) {
    if (d.kind === Kind.ENUM_TYPE_DEFINITION && d.name.value === name) return (d.values ?? []).map((v) => v.name.value);
  }
  throw new Error(`enum ${name} not found in the SDL`);
}

/** Any read the serve makes throws this code, the way the real resolver does when it refuses. */
function dbRefusing(code: (typeof BOOT_PROMPT_REFUSAL_CODES)[number]) {
  const fail = () => {
    throw bootPromptRefusal(code, { surface: 'bind', agentName: 'Parity' });
  };
  const model = new Proxy({}, { get: () => fail });
  return new Proxy({}, { get: () => model }) as unknown as Parameters<typeof previewServedBootPrompt>[0];
}

const target = { surface: 'bind' as const, appId: null, agent: { id: 'agent-parity', name: 'Parity' } };

async function previewProducible(): Promise<string[]> {
  const out: string[] = [];
  for (const code of BOOT_PROMPT_REFUSAL_CODES) {
    const r = await previewServedBootPrompt(dbRefusing(code), target).then(
      (o) => o,
      () => null,
    );
    if (r && r.refusal === code) out.push(code);
  }
  return out;
}

describe('#3640 BootPromptServeRefusal parity with the preview-producible refusals', () => {
  it('a preview returns every code except the recorded-revision one, and rethrows that one', async () => {
    const producible = await previewProducible();
    expect(producible).toEqual(BOOT_PROMPT_REFUSAL_CODES.filter((c) => c !== 'BOOT_PROMPT_RECORDED_REVISION_DELETED'));
    await expect(previewServedBootPrompt(dbRefusing('BOOT_PROMPT_RECORDED_REVISION_DELETED'), target)).rejects.toMatchObject({
      extensions: { code: 'BOOT_PROMPT_RECORDED_REVISION_DELETED' },
    });
  });

  it('the SDL enum is exactly the preview-producible set (and never the recorded-revision code)', async () => {
    const sdl = sdlEnumValues('BootPromptServeRefusal');
    expect([...sdl].sort()).toEqual([...(await previewProducible())].sort());
    expect(sdl).not.toContain('BOOT_PROMPT_RECORDED_REVISION_DELETED');
    expect(new Set(sdl).size).toBe(sdl.length);
  });

  it('the exported serve-refusal type covers the SDL members (compile-time)', () => {
    const members: BootPromptServeRefusalCode[] = sdlEnumValues('BootPromptServeRefusal') as BootPromptServeRefusalCode[];
    expect(members.length).toBeGreaterThan(0);
    // @ts-expect-error the recorded-revision code is not a serve refusal
    const notServe: BootPromptServeRefusalCode = 'BOOT_PROMPT_RECORDED_REVISION_DELETED';
    expect(notServe).toBeDefined();
  });
});
