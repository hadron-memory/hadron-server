/**
 * The 24-condition conformance fixture for the edge-condition spec.
 * Each entry transcribes a grounded use case from
 * `hadron-concept/brainstorming/2026-04-21-edge-condition-spec/005-cc.md`
 * (entries #1–#24) into a JSONLogic condition + a runtime context + an
 * expected boolean. Together they constitute the spec's SC-001
 * conformance set.
 *
 * The fixture is shared between unit tests (run all 24 standalone) and
 * the user-story integration tests (run a tagged subset).
 */

export type FixtureScope = 'memory' | 'chat' | 'agent' | 'message' | 'time';
export type FixtureUserStory = 'US1' | 'US2' | 'US3' | 'US4' | 'US5';

export interface FixtureContext {
  /** Layer-A (edge memory) values keyed by dotted path. */
  edgeMemory?: Record<string, unknown>;
  /** Layer-B (user memory) values keyed by dotted path. Empty for single-user agents. */
  userMemory?: Record<string, unknown>;
  /** chat.* bag. */
  chat?: Record<string, unknown>;
  /** agent.* bag. Always present. */
  agent?: Record<string, unknown>;
  /** message.data.* bag. */
  messageData?: Record<string, unknown>;
  /** ISO timestamp the clock should return when now()/today() is referenced. */
  clockIso?: string;
}

export interface FixtureEntry {
  id: number;
  agent: string;
  description: string;
  condition: unknown;
  context: FixtureContext;
  expected: boolean;
  scopes: ReadonlyArray<FixtureScope>;
  story: FixtureUserStory;
}

export const FIXTURE_24: ReadonlyArray<FixtureEntry> = [
  {
    id: 1,
    agent: 'Juno',
    description: 'business_type missing AND team_size missing → profile',
    condition: {
      and: [
        { missing: ['memory.business_type'] },
        { missing: ['memory.team_size'] },
      ],
    },
    context: { edgeMemory: {} },
    expected: true,
    scopes: ['memory'],
    story: 'US1',
  },
  {
    id: 2,
    agent: 'Juno',
    description: "revenue_status == 'struggling' OR runway_months < 3 → urgent",
    condition: {
      or: [
        { '==': [{ var: 'memory.revenue_status' }, 'struggling'] },
        { '<': [{ var: 'memory.runway_months' }, 3] },
      ],
    },
    context: { edgeMemory: { 'runway_months': 2 } },
    expected: true,
    scopes: ['memory'],
    story: 'US1',
  },
  {
    id: 3,
    agent: 'Juno',
    description: 'industry in [tech, healthcare, retail] → vertical',
    condition: { in: [{ var: 'memory.industry' }, ['tech', 'healthcare', 'retail']] },
    context: { edgeMemory: { industry: 'healthcare' } },
    expected: true,
    scopes: ['memory'],
    story: 'US1',
  },
  {
    id: 4,
    agent: 'Juno',
    description: 'chat.message_count > 20 AND business_type missing → force-profile',
    condition: {
      and: [
        { '>': [{ var: 'chat.message_count' }, 20] },
        { missing: ['memory.business_type'] },
      ],
    },
    context: { edgeMemory: {}, chat: { message_count: 23 } },
    expected: true,
    scopes: ['memory', 'chat'],
    story: 'US1',
  },
  {
    id: 5,
    agent: 'Juno',
    description: 'chat started > 7d ago AND no recent message → re-engage',
    // No JSONLogic date arithmetic in v1; agent precomputes the cutoff,
    // condition compares against chat.started_at.
    condition: {
      and: [
        { '<': [{ var: 'chat.started_at' }, { var: 'agent.config.reengage_cutoff' }] },
        { '!': { var: 'chat.has_recent_message' } },
      ],
    },
    context: {
      chat: { started_at: '2026-04-15T10:00:00Z', has_recent_message: false },
      agent: { config: { reengage_cutoff: '2026-04-19T00:00:00Z' } },
    },
    expected: true,
    scopes: ['chat', 'agent'],
    story: 'US1',
  },
  {
    id: 6,
    agent: 'Pong',
    description: 'received_at outside business hours → after-hours auto-reply',
    // Approximated via agent-provided business-hours boundaries; demonstrates
    // time + agent + per-message scope mixing.
    condition: {
      or: [
        { '<': [{ var: 'message.data.received_at' }, { var: 'agent.config.business_hours_start' }] },
        { '>': [{ var: 'message.data.received_at' }, { var: 'agent.config.business_hours_end' }] },
      ],
    },
    context: {
      messageData: { received_at: '2026-04-26T21:00:00Z' },
      agent: {
        config: {
          business_hours_start: '2026-04-26T08:00:00Z',
          business_hours_end: '2026-04-26T18:00:00Z',
        },
      },
    },
    expected: true,
    scopes: ['time', 'message'],
    story: 'US2',
  },
  {
    id: 7,
    agent: 'Pong',
    description: 'sender in memory.approved_vip → priority (skip auto-reply)',
    condition: { in: [{ var: 'message.data.sender' }, { var: 'memory.approved_vip' }] },
    context: {
      edgeMemory: { approved_vip: ['ceo@acme.com', 'investor@vc.com'] },
      messageData: { sender: 'ceo@acme.com' },
    },
    expected: true,
    scopes: ['memory', 'message'],
    story: 'US2',
  },
  {
    id: 8,
    agent: 'Pong',
    description: 'thread.auto_reply_count >= 3 → escalate to human',
    condition: { '>=': [{ var: 'chat.auto_reply_count' }, 3] },
    context: { chat: { auto_reply_count: 3 } },
    expected: true,
    scopes: ['chat'],
    story: 'US2',
  },
  {
    id: 9,
    agent: 'Pong',
    description: 'message.data.confidence < agent.config.confidence_threshold → skip',
    condition: {
      '<': [
        { var: 'message.data.confidence' },
        { var: 'agent.config.confidence_threshold' },
      ],
    },
    context: {
      messageData: { confidence: 0.7 },
      agent: { config: { confidence_threshold: 0.85 } },
    },
    expected: true,
    scopes: ['message', 'agent'],
    story: 'US2',
  },
  {
    id: 10,
    agent: 'Pong',
    description: 'confidence >= 0.95 AND agent.config.auto_send → send',
    condition: {
      and: [
        { '>=': [{ var: 'message.data.confidence' }, 0.95] },
        { '==': [{ var: 'agent.config.auto_send' }, true] },
      ],
    },
    context: {
      messageData: { confidence: 0.97 },
      agent: { config: { auto_send: true } },
    },
    expected: true,
    scopes: ['message', 'agent'],
    story: 'US2',
  },
  {
    id: 11,
    agent: 'Pong',
    description: 'sender unknown AND attachment present → quarantine',
    condition: {
      and: [
        { '!': { in: [{ var: 'message.data.sender' }, { var: 'memory.known_senders' }] } },
        { '==': [{ var: 'message.data.has_attachment' }, true] },
      ],
    },
    context: {
      edgeMemory: { known_senders: ['boss@acme.com', 'team@acme.com'] },
      messageData: { sender: 'spam@elsewhere.com', has_attachment: true },
    },
    expected: true,
    scopes: ['memory', 'message'],
    story: 'US2',
  },
  {
    id: 12,
    agent: 'Tickfinder',
    description: 'agent.integrations.photos.tagged_count > 0 → process-photos',
    condition: { '>': [{ var: 'agent.integrations.photos.tagged_count' }, 0] },
    context: { agent: { integrations: { photos: { tagged_count: 2 } } } },
    expected: true,
    scopes: ['agent'],
    story: 'US2',
  },
  {
    id: 13,
    agent: 'Tickfinder',
    description: 'tick_detected AND confidence < 0.6 → request more photo',
    condition: {
      and: [
        { '==': [{ var: 'message.data.tick_detected' }, true] },
        { '<': [{ var: 'message.data.confidence' }, 0.6] },
      ],
    },
    context: { messageData: { tick_detected: true, confidence: 0.45 } },
    expected: true,
    scopes: ['message'],
    story: 'US2',
  },
  {
    id: 14,
    agent: 'Tickfinder',
    description: 'bite confirmed within last 30d → schedule follow-up',
    // Time arithmetic deferred; agent pre-computes the cutoff.
    condition: {
      '>': [
        { var: 'memory.bite.confirmed_at' },
        { var: 'agent.config.thirty_day_cutoff' },
      ],
    },
    context: {
      edgeMemory: { bite: { confirmed_at: '2026-04-10T00:00:00Z' } },
      agent: { config: { thirty_day_cutoff: '2026-03-27T00:00:00Z' } },
    },
    expected: true,
    scopes: ['memory', 'agent'],
    story: 'US3',
  },
  {
    id: 15,
    agent: 'Mealplan',
    description: '"nuts" in memory.family.allergies → exclude-nuts',
    condition: { in: ['nuts', { var: 'memory.family.allergies' }] },
    context: { edgeMemory: { family: { allergies: ['nuts', 'shellfish'] } } },
    expected: true,
    scopes: ['memory'],
    story: 'US1',
  },
  {
    id: 16,
    agent: 'Mealplan',
    description: 'planning.current_week.has_meat (cached predicate) → alert',
    condition: { '==': [{ var: 'memory.planning.current_week.has_meat' }, true] },
    context: {
      edgeMemory: { planning: { current_week: { has_meat: true } } },
    },
    expected: true,
    scopes: ['memory'],
    story: 'US1',
  },
  {
    id: 17,
    agent: 'Mealplan',
    description: 'cumulative.protein < targets.protein * 0.8 → boost-protein',
    condition: {
      '<': [
        { var: 'memory.cumulative.protein' },
        { '*': [{ var: 'memory.targets.protein' }, 0.8] },
      ],
    },
    context: {
      edgeMemory: {
        cumulative: { protein: 50 },
        targets: { protein: 100 },
      },
    },
    expected: true,
    scopes: ['memory'],
    story: 'US1',
  },
  {
    id: 18,
    agent: 'Know Yourself',
    description: 'relationships.has_partner (cached) → partner-emotions edge',
    condition: { '==': [{ var: 'memory.relationships.has_partner' }, true] },
    context: { edgeMemory: { relationships: { has_partner: true } } },
    expected: true,
    scopes: ['memory'],
    story: 'US1',
  },
  {
    id: 19,
    agent: 'Know Yourself',
    description: 'chat duration > config.max_chat_duration → suggest-end',
    condition: {
      '>': [
        { var: 'chat.duration_seconds' },
        { var: 'agent.config.max_chat_duration_seconds' },
      ],
    },
    context: {
      chat: { duration_seconds: 4200 },
      agent: { config: { max_chat_duration_seconds: 3600 } },
    },
    expected: true,
    scopes: ['chat', 'agent'],
    story: 'US1',
  },
  {
    id: 20,
    agent: 'Know Yourself',
    description: 'patterns.shutdown.recurrence_count >= 3 → surface-pattern',
    condition: { '>=': [{ var: 'memory.patterns.shutdown.recurrence_count' }, 3] },
    context: { edgeMemory: { patterns: { shutdown: { recurrence_count: 4 } } } },
    expected: true,
    scopes: ['memory'],
    story: 'US1',
  },
  {
    id: 21,
    agent: 'Know Yourself',
    description: 'message.data.crisis_signal → crisis-redirect',
    condition: { '==': [{ var: 'message.data.crisis_signal' }, true] },
    context: { messageData: { crisis_signal: true } },
    expected: true,
    scopes: ['message'],
    story: 'US2',
  },
  {
    id: 22,
    agent: 'Research Assistant',
    description: 'chat.message_count > 50 AND ≥30 messages since last summary → summarize',
    condition: {
      and: [
        { '>': [{ var: 'chat.message_count' }, 50] },
        {
          '>': [
            { '-': [{ var: 'chat.message_count' }, { var: 'chat.last_summary.message_count' }] },
            30,
          ],
        },
      ],
    },
    context: {
      chat: { message_count: 90, last_summary: { message_count: 50 } },
    },
    expected: true,
    scopes: ['chat'],
    story: 'US1',
  },
  {
    id: 23,
    agent: 'Research Assistant',
    description: 'chat.title == null AND chat.message_count >= 3 → name the chat',
    condition: {
      and: [
        { '==': [{ var: 'chat.title' }, null] },
        { '>=': [{ var: 'chat.message_count' }, 3] },
      ],
    },
    context: { chat: { title: null, message_count: 4 } },
    expected: true,
    scopes: ['chat'],
    story: 'US1',
  },
  {
    id: 24,
    agent: 'Cross-cutting',
    description: 'subscription.expiresAt approaching → renewal-nudge',
    // Pre-computed window; demonstrates agent + time scope mixing.
    condition: {
      '<': [{ var: 'agent.subscription.expiresAt' }, { var: 'agent.config.renewal_nudge_threshold' }],
    },
    context: {
      agent: {
        subscription: { expiresAt: '2026-05-01T00:00:00Z' },
        config: { renewal_nudge_threshold: '2026-05-03T00:00:00Z' },
      },
    },
    expected: true,
    scopes: ['agent', 'time'],
    story: 'US1',
  },
];
