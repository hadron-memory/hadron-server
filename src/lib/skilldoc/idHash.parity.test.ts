/**
 * #1235 §4a — the cross-repo hash vectors, pinned.
 *
 * `skilldoc.parity.test.ts` proves this port agrees with Go over a GENERATED
 * fixture set. This file is different and deliberately redundant with it: it
 * hard-codes the two digests @Jonas published in the body of hadron-cli#650,
 * as literal constants, so the two implementations can be compared BEFORE the
 * fixture-driven gate runs.
 *
 * ## Why a second, weaker-looking check earns its place
 *
 * The fixtures are regenerated FROM Go. That is their strength — they cannot
 * become a restatement of this side's own behaviour — and also their blind
 * spot: if the two halves disagree, every one of ~13 hash cases fails at once
 * and the diagnostic is "A2 is red", which localises nothing. These two
 * constants fail as `expected '3fc4…' to be '<something else>'` on a named
 * input, which is a sentence you can paste into a cross-repo conversation.
 *
 * @Jonas hit the mirror of this on his side: he published these digests as a
 * contract and pinned them with nothing, because every other test in his
 * package was self-referential — so moving the id later in the input would
 * have left them all green. @copilot caught it; `TestParityVectorIsPinned` is
 * the Go half of this file.
 *
 * ## If one of these fails
 *
 * Do NOT update the constant. It is a published cross-repo contract, not a
 * snapshot. A change here means the hash input shape moved, and the question
 * is whether hadron-cli moved with it.
 */

import { describe, it, expect } from 'vitest';
import { hash } from './hash.js';
import { render } from './render.js';

/** The exact inputs @Jonas computed against, from hadron-cli#650's PR body. */
const V = {
  id: '01a0099f949d76a9baf3a16527485475',
  source: 'hrn:node:hadronmemory.com:hadron-cli:tasks:example',
  name: 'hadron-example',
  description: 'Use when example.',
  content: '# Example\n\nBody text.\n',
} as const;

describe('#1235 §4a — the published cross-repo vectors', () => {
  it('reproduces hash(with id) = 3fc4ef3150dc27d5', () => {
    expect(hash(V.id, V.source, V.name, V.description, V.content)).toBe('3fc4ef3150dc27d5');
  });

  it('reproduces hash(empty id) = 283c6ac5b51c3cd7 — empty is HASHED, not skipped', () => {
    // The convention half, pinned because two implementers decide it
    // reasonably and differently. The rule is uniformity — one shape, no
    // branch, nothing for a second implementation to answer differently.
    //
    // It does NOT preserve pre-§4a digests; an earlier version of this comment
    // said it did. Prefixing `"" + NUL` moves the digest, so a legacy file
    // would classify `locally-edited` (@copilot / @codex, PR #1249). Ruled a
    // non-factor: already-exported skill files do not matter (@Holger), and
    // none carrying a `hash=` header exist anyway while hadron-cli#621 — the
    // only writer of one — is unshipped.
    expect(hash('', V.source, V.name, V.description, V.content)).toBe('283c6ac5b51c3cd7');
  });

  it('an id that differs changes the digest — the property the whole change exists for', () => {
    // Without this, editing ONLY the header id keeps hash(file) === headerHash,
    // so the file reads as untouched while pairing to a different node.
    const a = hash(V.id, V.source, V.name, V.description, V.content);
    const b = hash('01a0000000000000000000000000000f', V.source, V.name, V.description, V.content);
    expect(a).not.toBe(b);
  });

  it('writes the header byte-for-byte as Go does', () => {
    const out = render(V.id, V.name, V.source, V.description, V.content);
    expect(out).toContain(
      '<!-- hadron-skill id=01a0099f949d76a9baf3a16527485475 ' +
        'source=hrn:node:hadronmemory.com:hadron-cli:tasks:example hash=3fc4ef3150dc27d5 -->',
    );
  });

  it('OMITS id= entirely when the id is empty — never writes it blank', () => {
    // The header grammar is `\w+=\S+`, so `id= ` makes the line unparseable and
    // demotes a file we generated to "somebody else's skill" — which reports
    // `locally-edited` on a file nobody edited.
    const out = render('', V.name, V.source, V.description, V.content);
    expect(out).toContain(`<!-- hadron-skill source=${V.source} hash=283c6ac5b51c3cd7 -->`);
    expect(out).not.toContain('id=');
  });
});
