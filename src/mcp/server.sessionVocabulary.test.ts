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
 *  5. A second arm accepting the symmetric phrasing "ending one does not end
 *     the other" was satisfied by "a session and its hold are independent;
 *     ending one does not end the other" — a sentence about two entirely
 *     different things (Codex).
 *
 * Five failures, one cause, and (5) is the one that ended the arms race.
 * "One" and "the other" are PRONOUNS: their antecedent lives in a neighbouring
 * clause, and no regex can verify an antecedent. That arm was unfixable in
 * principle, not merely underspecified — so it was removed, and the four
 * descriptions relying on it were reworded to name both kinds outright.
 *
 * Which leaves ONE arm, asserting the whole claim with no anaphora: the chat
 * session marked as the thing that ENDS ("ending / closing / archiving ... chat
 * session", or "chat session ending"), then the negation, then `end`, then the
 * worker session. Direction is load-bearing — close your window and the worker
 * stays held — and the reverse reading, though also true, is not what a driver
 * has to know.
 *
 * The through-line across all five: every version matched a larger SUBSET of
 * the sentence while still not matching its MEANING. What finally worked was
 * fixing the prose so the claim was stated outright, rather than growing the
 * regex to chase an elliptical one. A hard-to-write assertion is usually
 * evidence about the text, not about the assertion.
 *
 * Re-wording stays free: add an arm deliberately, and add its counterexample
 * below. What must not happen is an arm satisfiable by a sentence making a
 * different point — or one that depends on a pronoun.
 */
const statesIndependence = (s: string) =>
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
    ['the "never" voice', 'the two are independent, and ending a chat session never ends a worker session (#1034)'],
    [
      'closing rather than ending',
      'Closing your chat session does not end a worker session — the binding stays open.',
    ],
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
    [
      'the symmetric form with an unrelated antecedent — pronouns cannot be checked (Codex, round 5)',
      'A session and its hold are independent; ending one does not end the other. worker session, chat session.',
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

    // #3082: MCP no longer binds a worker, so start_session no longer carries the worker-taken consequence; it still
    // names both terms, says ending the chat does not end the session, and points at the refusal and the CLI.
    expect(d.toLowerCase()).toContain('worker session');
    expect(d.toLowerCase()).toContain('chat session');
    expect(d).toMatch(/ending the chat does not end it/);
    expect(d).toContain('MCP_WORKER_BINDING_UNSUPPORTED');
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

  it('#1246 — session tools distinguish a liveness block from a persistent hold', () => {
    const start = flat(srv().toolDescription('hadron_start_session'));
    const end = flat(srv().toolDescription('hadron_end_session'));

    // #3082: the start-side liveness/hold lines went with the worker bind (MCP binds no worker); the end side stays.
    expect(end).toMatch(/while open and recently active inside its idle window/);
    expect(end).toMatch(/session block falls away/);
    expect(end).toMatch(/human hold remains independent until explicit release/);
    expect(end).toMatch(/hadron_start_session does not set one.*remain open until this tool is called/);
    expect(start).not.toMatch(/worker taken,? until/);
    expect(end).not.toMatch(/worker taken until/);
    expect(end).not.toMatch(/leaves this binding open.*hard expiry passes/);
  });

  it('#1100 — the `summary` parameter says it is display-only and points at handoff', () => {
    // The schema is the ONLY thing guaranteed to be in front of the caller at
    // the moment of choosing: the end-worker-session skill is not always
    // loaded, and a worker recovering from a compaction has neither. It used to
    // read "Summary of what was accomplished", which is exactly what a
    // departing worker thinks it is writing.
    const desc = srv().toolParamDescription('hadron_end_session', 'summary');
    expect(desc).toMatch(/NOT the continuity record/i);
    expect(desc).toContain('handoff');
    expect(desc).not.toMatch(/^Summary of what was accomplished$/);
  });

  it('#1100 — the GraphQL endSession description carries the same warning', () => {
    // Same footgun, second surface. A description fixed on one surface only is
    // how the two come apart.
    // The needle is asserted BEFORE slicing (PR #1135 review, @copilot): a
    // missing `endSession` would make indexOf return -1, and `slice(-4001, -1)`
    // silently pulls unrelated text from the END of the SDL — which can fail
    // confusingly or, worse, pass.
    const at = typeDefs.indexOf('endSession(id: ID!');
    expect(at).toBeGreaterThan(0);
    const block = typeDefs.slice(Math.max(0, at - 4000), at);
    // The FACTS, not the phrasing — per this file's own rule that re-wording
    // stays free and deleting the fact does not: (a) the two fields are not
    // interchangeable, (b) no continuity path reads `summary`, (c) the mistake
    // is one-way.
    expect(block).toMatch(/summary.*is NOT a smaller/s);
    expect(block).toMatch(/worker-continuity path/);
    expect(block).toMatch(/not symmetric/);
  });

  it('hadron_whoami — the recovery surface — explains that a listed binding may have outlived its chat session', () => {
    const d = srv().toolDescription('hadron_whoami');

    // whoami is where a compacted agent lands, so it is the one place the
    // distinction has to be learnable cold rather than assumed known — which
    // means naming both terms is not enough here either.
    // #3082: MCP starts no worker session, so the chat-session independence wording left this description with the
    // bind; what stays pinned is that a bound row is the CLI's and that not every row is a worker session.
    expect(d.toLowerCase()).toContain('worker session');
    expect(d).toMatch(/MCP does not start worker sessions/);
    // The result set includes UNBOUND sessions, and this description must not
    // read as though every row is a worker session — an LLM recovering context
    // would otherwise treat a general session as a binding it does not have.
    //
    // Third surface in this one tool to need the same fact: the footer's naming
    // of the id, the footer's team-chat advice, and now the description itself
    // (PR #1056 review — Codex found each separately, over three rounds). One
    // fact, three places, so it is pinned in each rather than assumed to carry.
    expect(d.toLowerCase()).toMatch(/if it is bound|not every row|working as: nobody/);
    // BOTH properties, because they drifted apart once: the description was
    // corrected for boundness in one round and silently lost the OPEN half that
    // the footer already had, so a row could be bound, [ENDED] via
    // includeEnded, and recommended anyway — refused SESSION_ENDED. The two
    // surfaces state one rule and are asserted against the same pair.
    expect(d.toLowerCase()).toMatch(/\bopen\b/);
    expect(d.toLowerCase()).toMatch(/session_ended|\[ended\]/);
  });

  // #1141 removed the assertion that stood here. It read
  // `hadron_chatbot_start`'s description for the @Gil seq 73/78 property — that
  // `Chat` is a THIRD concept and an agent chat must not be called a "chat
  // session" — and that tool no longer exists, so the assertion has no subject
  // rather than a failing one.
  //
  // The RULE is not gone with it: no MCP tool starts an agent chat any more, so
  // the vocabulary is now carried by the GraphQL schema, which the next
  // describe block asserts against the same pair of terms. Deleted rather than
  // repointed at an arbitrary surviving tool, because a vocabulary test needs a
  // surface that actually talks about the entity.
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

  it('#1246 — idle worker sessions stop blocking binds without freeing held names', () => {
    const sessionType = flat(
      typeDefs.slice(
        typeDefs.indexOf('A unit of work recorded against a user or App'),
        typeDefs.indexOf('type Session {'),
      ),
    );
    const start = flat(
      typeDefs.slice(
        typeDefs.indexOf('Open a session — and, when'),
        typeDefs.indexOf('startSession(input: SessionInput!)'),
      ),
    );

    for (const [name, block] of [['Session', sessionType], ['startSession', start]] as const) {
      expect(block, `${name} must distinguish liveness from ownership`).toMatch(
        /stops? blocking another bind|lets another bind proceed/,
      );
      expect(block, `${name} must say idleness does not release the hold`).toMatch(
        /held until explicit release|hold stays in force until explicit release/,
      );
      expect(block, `${name} must not claim the name becomes free`).not.toMatch(
        /(?:free|frees) (?:itself|the name)|name (?:becomes|is) free/,
      );
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
