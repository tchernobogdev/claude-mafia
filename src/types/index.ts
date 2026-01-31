export type AgentRole = "underboss" | "capo" | "soldier";
export type RelationshipAction = "summarize" | "ask" | "review" | "delegate";
export type Cardinality = "1:1" | "1:many" | "many:1";
export type ConversationStatus = "active" | "completed" | "paused";
export type EscalationStatus = "pending" | "answered";

export interface AgentData {
  id: string;
  name: string;
  role: AgentRole;
  specialty: string | null;
  systemPrompt: string;
  model: string;
  parentId: string | null;
  orderIndex: number;
  children?: AgentData[];
}

export interface RelationshipData {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  action: RelationshipAction;
  cardinality: Cardinality;
  fromAgent?: AgentData;
  toAgent?: AgentData;
}

export interface ConversationData {
  id: string;
  title: string;
  status: ConversationStatus;
  createdAt: string;
}

export interface MessageData {
  id: string;
  conversationId: string;
  agentId: string | null;
  role: string;
  content: string;
  metadata: string | null;
  createdAt: string;
  agent?: { name: string; role: string } | null;
}

export interface EscalationData {
  id: string;
  conversationId: string;
  fromAgentId: string;
  question: string;
  answer: string | null;
  status: EscalationStatus;
}

export const ACTION_CARDINALITY: Record<RelationshipAction, Cardinality> = {
  delegate: "1:many",
  review: "1:1",
  ask: "1:1",
  summarize: "1:1",
};
