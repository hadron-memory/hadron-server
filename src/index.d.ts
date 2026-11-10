export interface Node {
  id: string;
  memoryId: string;
  loc: string;
  isLink: boolean;
  nodeType: string;
  data: import('./generated/prisma/index.js').Prisma.JsonValue;
  name: string;
  alias: string | null;
  description: string | null;
  /** Paragraph-length summary. Spec 031. */
  abstract: string | null;
  /** Spec 032 — fingerprint of `content` at the time `abstract` was authored.
   *  Read-tools compare against `computeContentHash(content)` to detect stale
   *  abstracts. System-managed; never accepted from caller input. */
  abstractOriginHash: string | null;
  content: string | null;
  contentHash: string | null;
  tokens: number | null;
  tags: string[];
  ownerRepo: string | null;
  isRunnable: boolean | null;
  isPlaceholder: boolean;
  objectType: string | null;
  createdAt: string;
  updatedAt: string;
  outgoingEdges: Edge[];
  incomingEdges: Edge[];
}

export interface Edge {
  id: string;
  source: Node;
  target: Node;
  label: string;
}

export interface Session {
  id: string;
  type: string;
  appId: string | null;
  repo: string | null;
  branch: string | null;
  prNumber: number | null;
  customerId: string | null;
  language: string | null;
  plan: string | null;
  llmModel: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  turnCount: number | null;
  errorCount: number | null;
  parentSessionId: string | null;
  prevSessionId: string | null;
  summary: string | null;
  outcome: number | null;
  outcomeRef: string | null;
  outcomeMeta: Record<string, unknown> | null;
  startedAt: string;
  endedAt: string | null;
  autoExpiredAt: string | null;
  events: UsageEvent[];
}

export interface UsageEvent {
  id: string;
  type: string;
  nodeLoc: string | null;
  nodeId: string | null;
  actionArgs: Record<string, unknown> | null;
  /** Caller identity — the App that authored this event. */
  appId: string | null;
  sessionId: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  createdAt: string;
}

export interface App {
  id: string;
  urn: string;
  name: string;
  appType: AppType;
  description: string | null;
  role: AppMembershipRole;
  organizationId: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface AppCreated {
  app: App;
  rawKey: string;
}

export interface User {
  id: string;
  handle: string | null;
  githubId: number;
  githubUsername: string;
  identityProvider: IdentityProvider | null;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  roles: Role[];
  maxReferrals: number | null;
}

export type Role = 'OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER';
export type AppMembershipRole = 'OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER';
export type AppType = 'WORKSTATION' | 'CHATBOT' | 'AGENT' | 'AUTOMATION' | 'CLOUD' | 'IOT';
export type IdentityProvider = 'GITHUB';
