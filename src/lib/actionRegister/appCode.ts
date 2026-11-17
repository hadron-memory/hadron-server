/** #3449: App-defined action grammar (cor:agt:110:01); never a platform event code. */
import { GraphQLError } from 'graphql';
import { MAX_ATOM_LEN, parseUrnV2, validateAtomShape } from '../urn.js';
import { emitEntityUrnV2 } from '../urnEmit.js';

export const APP_ACTION_CODE = /^app\.[a-z0-9-]+(\.[a-z0-9][a-z0-9-]*)+$/;

/** Read the CURRENT slug, not an alias. Interim rename reading (a), #3449's gate. */
export function requireAppActionCode(appUrn: string, code: string): void {
  const invalid = () => new GraphQLError('The action code must name this App and satisfy the App action grammar.', {
    extensions: { code: 'APP_ACTION_CODE_INVALID', appUrn },
  });
  let slug: string;
  try {
    const parsed = parseUrnV2(emitEntityUrnV2('app', appUrn));
    slug = parsed.segments[parsed.segments.length - 1];
    if (!slug || !/^[a-z0-9-]+$/.test(slug)) throw invalid();
    validateAtomShape(code, code);
  } catch { throw invalid(); }
  if (code.length > MAX_ATOM_LEN || !APP_ACTION_CODE.test(code) || !code.startsWith(`app.${slug}.`)) throw invalid();
}
