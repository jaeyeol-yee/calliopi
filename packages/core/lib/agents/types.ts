// Subagents: a parent Pi delegates a task to a child Pi that runs in a pseudo-terminal of the parent,
// and gets a result back. Everything a child needs or reports goes through its own directory in a registry,
// so the parent, the child and any viewer agree on one record without talking to each other.

/** What the child reports with its finish tool: its own verdict. */
export type FinishStatus = 'done' | 'blocked' | 'partial';
/** How a child ended. Beyond its own verdict, the harness decides when it ended without one. */
export type EndStatus = FinishStatus | 'unanswered' | 'budget_exceeded' | 'idle' | 'stopped' | 'error' | 'drifted';
export type AgentState = 'starting' | 'running' | EndStatus;

/** What the child gets of its parent's conversation besides the contract. */
export type ContextMode = 'none' | 'summary' | 'fork';
/** When the user confirms a delegation to a role. */
export type Approval = 'none' | 'once' | 'always';
/** Where a child's model came from. */
export type ModelSource = 'pin' | 'caller' | 'default' | 'inherit';

/** Limits of one agent. Every dimension is optional; budgetFor() fills them in. */
export interface Budget {
  turns?: number;
  minutes?: number;
  tokens?: number;
  /** Minutes without any event before the harness stops the child. Not inherited. */
  idleMinutes?: number;
}
export type FullBudget = Required<Budget>;

export interface BudgetUsage {
  turns: number;
  ms: number;
  tokens: number;
  idleMs: number;
}

/** A role from the catalog (agents/*.md). */
export interface AgentRole {
  name: string;
  description: string;
  /** When a model should delegate to this role, and when not: they become prompt guidelines. */
  when?: string;
  notWhen?: string;
  /** Tools the child may use, from those the parent has; undefined: the parent's tools; empty: none. */
  tools?: string[];
  disallowedTools: string[];
  model?: string;
  /** The role's model wins over the caller's. */
  modelLocked: boolean;
  thinking?: string;
  /** Roles this role may delegate to in turn ('*' for any); empty: it delegates to none. */
  allowedSubagents: string[];
  approval: Approval;
  budget: Budget;
  context: ContextMode;
  /** The body of the role file: appended to the child's system prompt. */
  instructions: string;
  /** The file it came from. */
  source: string;
}

/** What the parent asked for. */
export interface AgentCall {
  task: string;
  /** When the task is done: part of the contract the child is held to. */
  done?: string;
  budget: FullBudget;
  context: ContextMode;
  background: boolean;
  /** The parent's tool call that started this child. */
  parentToolCallId?: string;
}

export interface PaneLocation {
  multiplexer: string;
  session: string;
  pane: string;
}

/** meta.json: written once by the parent before the child starts. */
export interface AgentMeta {
  id: string;
  /** Session id of the top Pi: every agent of one tree shares it. */
  root: string;
  /** Agent id of the parent; null when the top Pi itself delegated. */
  parent: string | null;
  /** The goal it works for (the top Pi's open goal when it was started, inherited below); null: none. */
  goal?: string | null;
  /** The user's request it was started for (its session entry and first line), to group a goal's agents. */
  request?: { id: string; text: string };
  depth: number;
  role: string;
  model: string;
  modelSource: ModelSource;
  thinking?: string;
  tools: string[];
  cwd: string;
  createdAt: number;
  call: AgentCall;
  /** The child's Pi session file. */
  session: string;
  /** Unused since children run in the parent's pseudo-terminals (always null); kept for old records. */
  pane: PaneLocation | null;
}

/** status.json: rewritten by the child as it works. */
export interface AgentStatus {
  state: 'starting' | 'running';
  /** What it does now, e.g. "thinking" or a tool name. */
  activity?: string;
  turns: number;
  tokens: number;
  startedAt: number;
  updatedAt: number;
  /** When the briefing (the parent's summary) reached it, and how. */
  briefing?: { at: number; how: 'first' | 'steer' | 'missed' | 'failed' };
  /** Process id of the child Pi. */
  pid?: number;
}

/** result.json: written once, when the child ends. */
export interface AgentResult {
  status: EndStatus;
  summary: string;
  evidence?: string;
  artifacts?: string[];
  /** Why the harness ended it (budget dimension, idle, error message). */
  reason?: string;
  usage: { turns: number; tokens: number; ms: number };
  endedAt: number;
}

/** One message from the parent to a child, delivered in seq order. */
export interface InboxMessage {
  seq: number;
  id: string;
  kind: 'briefing' | 'steer' | 'stop';
  text: string;
  at: number;
}

/** Everything the registry knows about one agent. */
export interface AgentRecord {
  dir: string;
  meta: AgentMeta;
  status?: AgentStatus;
  result?: AgentResult;
}
