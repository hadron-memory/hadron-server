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

describe('#1034 — MCP tool descriptions distinguish a worker session from a chat session', () => {
  it('hadron_start_session says both terms exist and that ending one does not end the other', () => {
    const d = srv().toolDescription('hadron_start_session');

    // Both terms present: naming only one leaves the reader to assume the
    // other is the same thing, which is the collision itself.
    expect(d.toLowerCase()).toContain('worker session');
    expect(d.toLowerCase()).toContain('chat session');
    // The independence fact, not merely the two nouns.
    expect(d.toLowerCase()).toMatch(/ending one does not end the other|never ends/);
    // The consequence a driver actually needs: the worker stays taken.
    expect(d.toLowerCase()).toMatch(/taken|still open|leaves the worker session open/);
  });

  it('hadron_end_session says THIS is what ends the worker session, and closing a window is not', () => {
    const d = srv().toolDescription('hadron_end_session');

    expect(d.toLowerCase()).toContain('worker session');
    expect(d.toLowerCase()).toContain('chat session');
    // The whole point of the tool, stated as an exclusive: this ends it, the
    // window closing does not. A description that dropped this would leave
    // `end_session` reading as optional bookkeeping.
    expect(d.toLowerCase()).toMatch(/does not|never/);
  });

  it('hadron_whoami — the recovery surface — explains that a listed binding may have outlived its chat session', () => {
    const d = srv().toolDescription('hadron_whoami');

    // whoami is where a compacted agent lands, so it is the one place the
    // distinction has to be learnable cold rather than assumed known.
    expect(d.toLowerCase()).toContain('worker session');
    expect(d.toLowerCase()).toContain('chat session');
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
    }
  });

  it('the sessions query does not present itself as a list of worker sessions', () => {
    const q = flat(
      typeDefs.slice(
        typeDefs.indexOf('Sessions recorded against the caller'),
        typeDefs.indexOf('sessions(type: String'),
      ),
    );

    // The claim that must survive: unfiltered, this is the general row.
    expect(q).toMatch(/general row/);
    // And NOT a frequency claim about how many rows are worker-bound — the
    // unverified-quantitative-claim defect (@Gil seq 78), which this very
    // description is the natural place to reintroduce.
    expect(q).not.toMatch(/most sessions|usually not|rarely/);
  });
});
