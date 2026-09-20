/**
 * #1177 — the skill name's grammar and the host's caps.
 *
 * **D12 retired derivation.** A skill's name is STORED whole at
 * `properties.exports.<host>.name`, prefix included; there is no
 * `Organization.skillPrefix`, no `--prefix`, and nothing to derive from. What
 * survives from the derivation era is the VALIDATION, now applied to the value
 * the author wrote rather than to one this code composed.
 *
 * Note what can no longer be checked, because it is the cost D12 accepts: with
 * no prefix source, a name's PREFIX is unverifiable — `hadon-foo` is a valid
 * skill name. Shape is checkable here; correctness is a human convention.
 */

import { runeCount } from './normalize.js';

/** The host's skill-name grammar: kebab-case, lowercase letters and digits. */
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The host's caps, counted in CODE POINTS (A6) — not UTF-16 units, which is
 *  what `String.length` would give and is wrong for any astral character. */
export const MAX_NAME_LEN = 64;
export const MAX_DESCRIPTION_LEN = 1024;

/**
 * Whether a stored skill name satisfies the host's grammar and length.
 *
 * Length is `runeCount`, not `.length`: the Go side counts code points, so an
 * emoji in a name must measure the same on both sides or the parity fixtures
 * diverge on a value a human can see is identical.
 */
export function validName(name: string): boolean {
  return runeCount(name) <= MAX_NAME_LEN && NAME_RE.test(name);
}
