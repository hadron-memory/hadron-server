export interface HadronGraph {
  name: String;
  namespace: string;
  ownerRepo: string;
  nodes: Node[];
}

export interface Node {
  id: string;
  loc: string;
  name: string;
  alias: String;
  description: String;
  content: String;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  outgoingEdges: Edge[];
  incomingEdges: Edge[];
}

export interface Edge {
  id: string;
  source: Node;
  target: Node;
  label: String;
}

export interface Session {
  id: string;
  type: string;
  clientId: String;
  repo: String;
  branch: String;
  prNumber: Int;
  customerId: String;
  language: String;
  llmModel: String;
  inputTokens: Int;
  outputTokens: Int;
  turnCount: Int;
  errorCount: Int;
  parentSessionId: String;
  prevSessionId: String;
  summary: String;
  outcome: Float;
  outcomeRef: String;
  outcomeMeta: JSON;
  startedAt: string;
  endedAt: String;
  autoExpiredAt: String;
  events: UsageEvent[]
}

export interface UsageEvent {
  id: string;
  type: string;
  nodeLoc: String;
  actionArgs: JSON;
  clientId: String;
  sessionId: String;
  createdAt: string;
}

export interface Client {
  id: string;
  label: string;
  type: ClientType;
  description: String;
  role: Role;
  namespace: String;
  expiresAt: String;
  createdAt: string;
  lastUsedAt: String;
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
  name: String;
  avatarUrl: String;
  role: Role;
}
