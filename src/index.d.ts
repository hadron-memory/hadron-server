export interface Node {
  id: string;
  graphId: string;
  loc: string;
  isLink: boolean;
  name: string;
  title: string;
  alias: string | null;
  description: string | null;
  content: string | null;
  contentHash: string | null;
  tokens: number | null;
  tags: string[];
  namespace: string;
  ownerRepo: string | null;
  isRunnable: boolean | null;
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
  clientId: string | null;
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
  clientId: string | null;
  sessionId: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  createdAt: string;
}

export interface Client {
  id: string;
  label: string;
  clientType: ClientType;
  description: string | null;
  role: Role;
  apiKeyShown: boolean;
  namespace: string | null;
  userId: string | null;
  organizationId: string | null;
  expiresAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ClientCreated {
  client: Client;
  rawKey: string;
}

export interface User {
  id: string;
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
export type ClientType = 'WORKSTATION' | 'AGENT' | 'AUTOMATION' | 'CLOUD' | 'IOT';
export type IdentityProvider = 'GITHUB';
