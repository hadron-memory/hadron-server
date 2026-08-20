/**
 * #1034 — "session" is overloaded across every team surface.
 *
 * Three concepts, ratified by Holger:
 *
 *   - **session** (bare) — the general `Session` row: a unit of work with a
 *     `type` and an OPTIONAL `workerId`. The plain word is the supertype.
 *   - **worker session** — the subtype with `workerId` set: a Worker bound to a
 *     driver. What makes work attributable, and what a merged PR traces back
 *     through.
 *   - **chat session** — the human's own conversation (Desktop window, Claude
 *     Code session, IDE chat). Names no row in this schema.
 *
 *   ...and a fourth thing that is none of them: an **agent chat**, the saved
 *   `Chat` entity. Calling that a "chat session" is the specific wrong edit
 *   this vocabulary produced twice before it was written down (@Gil, team chat
 *   seq 73 and 78).
 *
 * WHY A TEST AT ALL, given prose tests are usually brittle. Prose is the one
 * part of a tool that rots with NOTHING GOING RED — which is precisely how the
 * collision reached seven surfaces before anyone filed it, and why a sweep
 * alone would not hold. So this pins the load-bearing SENTENCES rather than
 * whole strings: each assertion is a fact a reader must still be able to learn
 * here, not a spelling. Re-wording freely is fine; deleting the fact is not.
 * (Same shape as @Jonas's CLI guard on hadron-cli#467.)
 *
 * The fact every assertion below serves: ENDING ONE DOES NOT END THE OTHER.
 * The failure it is placed against is a driver archiving their chat session,
 * assuming the worker came free, and meeting a takeover refusal they cannot
 * read.
 */

import { describe, it, expect } from 'vitest';
import { createTestableMcpServer } from './server.js';
import { typeDefs } from '../api/graphql/schema/typeDefs.js';
import type { AuthContext } from '../middleware/auth.js';

/** Descriptions are static, so the weakest possible auth context will do. */
const anyAuth: AuthContext = { roles: [], clientId: 'anonymous' };
const srv = () => createTestableMcpServer(anyAuth);

/**
 * Collapse whitespace before matching. SDL block strings are hard-wrapped, so a
 * two-word term routinely straddles a newline — matching raw would fail on
 * re-flowed prose that still says exactly the same thing, which is the
 * brittleness that makes people delete tests like this one. (It caught this
 * file on its first run: `endSession` says "chat session" across a line break.)
 */
const flat = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();

/**
 * Does this text state the INDEPENDENCE — that ending a chat session does not
 * end a worker session — rather than merely mentioning both nouns?
 *
 * Third version of this helper, and the two it replaces are why it is written
 * as an explicit whitelist rather than a proximity match:
 *
 *  1. A bare `/does not|never/` was satisfied by an unrelated negative
 *     elsewhere in the same string — `hadron_end_session` contains "a
 *     restatement drifts while a pointer does not" (Copilot).
 *  2. Tying the negation to "chat session" by proximity was satisfied by "chat
 *     session ending ... NEVER REACHES THIS SERVER" — a true sentence that is
 *     not this claim, so deleting the real clause still passed (Codex).
 *
 *  3. Requiring only the negated OBJECT — `/(does not|never) end a worker
 *     session/` — was satisfied by "the reaper does not end a worker session",
 *     which is true, is IN these descriptions, and is a different claim
 *     entirely (Codex).
 *  4. Requiring subject/negation/action/object IN ORDER still accepted the
 *     REVERSED claim, "a chat session does not end when a worker session ends"
 *     — every token present, correct order, opposite direction (Codex).
 *
 * Four failures, one cause, and the fourth sharpens it: each version asserted
 * that some tokens were NEAR each other, never that they were ABOUT each other.
 * A claim has a subject, a negation, an action and an object — and (4) shows
 * that even all four in order is not enough, because it does not fix WHICH noun
 * is the thing being ended.
 *
 * So the chat session must be marked as the thing that ENDS: either "ending /
 * closing / archiving ... chat session" or "chat session ending". That is the
 * load-bearing direction — close your window and the worker stays held — and
 * the reverse reading, though also true, is not what a driver has to know.
 *
 * The descriptions were reworded to state the object outright rather than elide
 * it, which is what made a well-formed assertion possible at all: the regex was
 * hard to write because the prose was elliptical.
 *
 * Re-wording stays free: add an arm deliberately, and add its counterexample
 * below. What must not happen is an arm satisfiable by a sentence making a
 * different point.
 */
const statesIndependence = (s: string) =>
  /ending one (does not end|never ends) the other/.test(flat(s)) ||
  /(?:(?:ending|closing|archiving)[^.!?]{0,20}?chat session|chat session ending)[^.!?]{0,20}?(?:does not|never)[^.!?]{0,20}?\bends?\b[^.!?]{0,30}?worker session/.test(
    flat(s),
  );

describe('the statesIndependence helper itself', () => {
  // Three review rounds found three different ways this helper accepted text
  // that did not make the claim. Each is kept as a case, so a future
  // "simplification" of the regex cannot quietly reintroduce one — a guard
  // that has been wrong three times has earned a guard of its own.
  //
  // The general shape, worth more than the three instances: a claim has a
  // SUBJECT, a NEGATION, an ACTION and an OBJECT, and matching any subset of
  // those admits every sentence sharing the subset. All three near-misses below
  // are true sentences that appear in these very descriptions.
  const ACCEPTS: Array<[string, string]> = [
    ['the object stated outright', 'Ending your CHAT SESSION does not end a worker session (#1034).'],
    ['the subject as a gerund', "A client's chat session ending **does not end a worker session**, and never reaches this server."],
    ['the symmetric form', 'Two different things are called a session and ENDING ONE DOES NOT END THE OTHER.'],
    ['the symmetric form, "never" voice', 'the two are independent and ending one never ends the other (#1034)'],
  ];
  const REJECTS: Array<[string, string]> = [
    [
      'an unrelated negative sharing the words (Copilot, round 1)',
      'This ends a WORKER SESSION. Your CHAT SESSION is separate. A restatement drifts while a pointer does not.',
    ],
    [
      'a true chat-session sentence making a different point (Codex, round 2)',
      "This ends a worker session. A client's chat session ending never reaches this server. worker session.",
    ],
    [
      'the negated object with the wrong subject (Codex, round 3)',
      'The #930 reaper does not end a worker session on its own. Your chat session is a separate thing.',
    ],
    [
      'the REVERSED direction — every token, right order, opposite meaning (Codex, round 4)',
      'A chat session does not end when a worker session ends.',
    ],
  ];

  it.each(ACCEPTS)('accepts %s', (_label, text) => {
    expect(statesIndependence(text)).toBe(true);
  });

  it.each(REJECTS)('rejects %s', (_label, text) => {
    expect(statesIndependence(text)).toBe(false);
  });
});

describe('#1034 — MCP tool descriptions distinguish a worker session from a chat session', () => {
  it('hadron_start_session says both terms exist and that ending one does not end the other', () => {
    const d = srv().toolDescription('hadron_start_session');

    // Both terms present: naming only one leaves the reader to assume the
    // other is the same thing, which is the collision itself.
    expect(d.toLowerCase()).toContain('worker session');
    expect(d.toLowerCase()).toContain('chat session');
    // The independence fact, not merely the two nouns.
    expect(statesIndependence(d)).toBe(true);
    // The consequence a driver actually needs: the worker stays taken.
    expect(d.toLowerCase()).toMatch(/taken|still open|leaves the worker session open/);
  });

  it('hadron_end_session says THIS is what ends the worker session, and closing a window is not', () => {
    const d = srv().toolDescription('hadron_end_session');

    expect(d.toLowerCase()).toContain('worker session');
    expect(d.toLowerCase()).toContain('chat session');
    // The whole point of the tool: this ends the worker session, the window
    // closing does not. A description that dropped this would leave
    // `end_session` reading as optional bookkeeping.
    expect(statesIndependence(d)).toBe(true);
    // ...and that it is the CLIENT operation, not the only mechanism — the
    // #930 reaper ends worker sessions too, which the Session and startSession
    // descriptions both say. "ONLY" here made the contract self-contradictory
    // (PR #1056 review, Copilot).
    expect(d.toLowerCase()).not.toMatch(/only thing that ends/);
  });

  it('hadron_whoami — the recovery surface — explains that a listed binding may have outlived its chat session', () => {
    const d = srv().toolDescription('hadron_whoami');

    // whoami is where a compacted agent lands, so it is the one place the
    // distinction has to be learnable cold rather than assumed known — which
    // means naming both terms is not enough here either.
    expect(d.toLowerCase()).toContain('worker session');
    expect(d.toLowerCase()).toContain('chat session');
    expect(statesIndependence(d)).toBe(true);
  });

  it('the reserved term is NOT applied to the agent chat entity (@Gil seq 73/78)', () => {
    // The wrong edit this vocabulary invites: `Chat` is a THIRD concept, and
    // rule 1 ("never shorten chat session to chat") reads as forbidding its own
    // name until you know there are three things. It is an AGENT CHAT.
    const d = srv().toolDescription('hadron_chatbot_start').toLowerCase();

    expect(d).toContain('agent chat');
    // It may MENTION "chat session" — it now does, to say it is not one — but
    // never as the thing being started.
    expect(d).not.toMatch(/start (a |an )?(new )?chat session/);
  });
});

describe('#1034 — the GraphQL schema carries the distinction for every client', () => {
  it('the Session type defines the bare word as the general row, not the worker binding', () => {
    // Gil hit this gap on the org Sessions page: the supertype had no
    // description at all, so a client author had nothing to be correct from.
    const sessionType = flat(
      typeDefs.slice(
        typeDefs.indexOf('type Session {') - 1600,
        typeDefs.indexOf('type Session {'),
      ),
    );

    expect(sessionType).toContain('worker session');
    expect(sessionType).toContain('chat session');
    // The structural fact that makes the supertype a supertype.
    expect(sessionType).toMatch(/optional|not worker/);
    // And that a chat session is NOT one of these rows — the point a reader
    // most easily gets backwards, since the other two terms both name rows.
    expect(sessionType).toMatch(/no row|not one of these/);
  });

  it('startSession and endSession both state the independence, not just one of them', () => {
    // Stating it on only one is worse than neither: it reads as a property of
    // that mutation rather than of the model.
    const start = flat(
      typeDefs.slice(
        typeDefs.indexOf('startSession(input: SessionInput!)') - 900,
        typeDefs.indexOf('startSession(input: SessionInput!)'),
      ),
    );
    const end = flat(
      typeDefs.slice(
        typeDefs.indexOf('End a session, and — for a worker-bound one'),
        typeDefs.indexOf('endSession(id: ID!'),
      ),
    );

    for (const [name, block] of [['startSession', start], ['endSession', end]] as const) {
      expect(block, `${name} must name the worker session`).toContain('worker session');
      expect(block, `${name} must name the chat session`).toContain('chat session');
      // Naming both nouns is not stating the fact — this test's own title
      // claimed the independence while asserting only the vocabulary
      // (PR #1056 review, Copilot).
      expect(statesIndependence(block), `${name} must state the independence`).toBe(true);
    }
  });

  it('the sessions query does not present itself as a list of worker sessions', () => {
    const q = flat(
      typeDefs.slice(
        typeDefs.indexOf('Sessions VISIBLE to the caller'),
        typeDefs.indexOf('sessions(type: String'),
      ),
    );

    // The claim that must survive: unfiltered, this is the general row.
    expect(q).toMatch(/general row/);
    // And NOT a frequency claim about how many rows are worker-bound — the
    // unverified-quantitative-claim defect (@Gil seq 78), which this very
    // description is the natural place to reintroduce.
    expect(q).not.toMatch(/most sessions|usually not|rarely/);
    // Nor "the caller's own", which is an AUTHORIZATION misstatement rather
    // than a vocabulary one: sessionScopeFilter admits every session of every
    // App in any org the caller belongs to, and everything for a platform
    // ADMIN/OWNER. A generated client doc saying "your activity" would
    // understate the scope (PR #1056 review, Codex + Copilot).
    expect(q).toMatch(/visible to the caller/);
    expect(q).toMatch(/not only the caller's own|other users or apps/);
  });
});
