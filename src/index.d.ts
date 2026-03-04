export interface HadronGraph {
  name: string;
  namespace: string;
  ownerRepo: string;
  nodes: Node[];
}

export interface Node {
  id: string;
  loc: string;
  name: string;
  alias: string | null;
  description: string | null;
  content: string | null;
  contentHash: string | null;
  tags: string[];
  namespace: string;
  ownerRepo: string;
  createdAt: string;
  updatedAt: string;
  outgoingEdges: Edge[];
  incomingEdges: Edge[];
}

export interface Edge {
  id: string;
  source: Node;
  target: Node;
  label: string | null;
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
  createdAt: string;
}

export interface Client {
  id: string;
  label: string;
  type: ClientType;
  description: string | null;
  roles: Role[];
  namespace: string | null;
  expiresAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

// Returned once at creation — the raw key is never stored
export interface ClientCreated {
  client: Client;
  rawKey: string;
}

export interface User {
  id: string;
  githubId: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  roles: Role[];
}

export type Role = 'ADMIN' | 'CONTRIBUTOR' | 'READER';
export type ClientType = 'WORKSTATION' | 'CLOUD' | 'IOT' | 'AGENT';
