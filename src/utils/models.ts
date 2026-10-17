export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface TeamSession {
  id: string;
  file: string;
  cwd: string;
  confirmed: boolean;
  agentDir?: string;
  trustArg?: "--approve" | "--no-approve";
}

export interface Member {
  agentId: string;
  name: string;
  agentType: string;
  model?: string;
  joinedAt: number;
  tmuxPaneId: string;
  windowId?: string;
  cwd: string;
  subscriptions: any[];
  prompt?: string;
  color?: string;
  thinking?: ThinkingLevel;
  defaultPlanRequired?: boolean;
  planModeRequired?: boolean;
  backendType?: string;
  isActive?: boolean;
  session?: TeamSession;
  recovery?: {
    token: string;
    ownerInstanceId: string;
    phase: "reserved" | "launched" | "attached" | "failed";
    error?: string;
  };
}

export interface TeamConfig {
  name: string;
  description: string;
  createdAt: number;
  leadAgentId: string;
  leadSessionId: string;
  members: Member[];
  defaultModel?: string;
  separateWindows?: boolean;
}

export interface TaskFile {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: "pending" | "planning" | "in_progress" | "completed" | "deleted";
  planRequired?: boolean;
  plan?: string;
  planFeedback?: string;
  blocks: string[];
  blockedBy: string[];
  owner?: string;
  metadata?: Record<string, any>;
}

export interface InboxMessage {
  id: string;
  from: string;
  text: string;
  timestamp: string;
  read: boolean;
  summary?: string;
  color?: string;
}
