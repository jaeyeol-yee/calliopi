// Shared records for the registry, the Cursor Cloud Agents API, and the launch spec.
// JSON on disk is cast to these shapes at the read boundary; fields the code always
// writes are required, and fields only some paths set stay optional.

export interface UsageStats {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
}

export interface GitBranch {
  repoUrl?: string;
  branch?: string | null;
  prUrl?: string;
}

export interface GitSnapshot {
  branches?: GitBranch[];
}

export interface RunRecord {
  status?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  durationMs?: number | null;
  result?: string | null;
  finalized?: boolean;
  finalizedAt?: string;
  usage?: UsageStats | null;
  usageNote?: string | null;
  gitDelta?: GitBranch[];
  gitAttribution?: string;
}

export interface AgentError {
  at?: string;
  status?: number | null;
  code?: string | null;
  message?: string;
  requestId?: string | null;
}

export interface PaneInfo {
  blockId?: string;
  sessionId?: string | null;
  at?: string;
}

export interface ReviewRecord {
  state?: string;
  checkedAt?: number | null;
  lastError?: string | null;
  deferredUntil?: number | null;
  nextAt?: number | null;
  etag?: string | null;
  headSha?: string;
  mergedAt?: string | null;
  baseRef?: string | null;
  url?: string;
  attemptedAt?: number | null;
  leaseUntil?: number;
}

export interface HistoryEntry {
  at: string;
  runId?: string | null;
  from?: string | null;
  to?: string | null;
  via?: string;
}

/** What UI and review helpers read. Fixtures and partial registry rows are valid. */
export interface AgentView {
  agentId?: string | null;
  key?: string | null;
  label?: string | null;
  name?: string | null;
  source?: string;
  phase?: string | null;
  status?: string | null;
  runId?: string | null;
  missing?: boolean;
  finalized?: boolean;
  localApproval?: boolean;
  archived?: boolean;
  archivedAt?: string | number | null;
  archivedRunId?: string | null;
  reviewAckRunId?: string | null;
  git?: GitSnapshot | null;
  gitPrev?: GitSnapshot | null;
  reviews?: Record<string, ReviewRecord | undefined>;
  runs?: Record<string, RunRecord | undefined>;
  summary?: string | null;
  output?: string | null;
  url?: string | null;
  batch?: string | null;
  repo?: string | null;
  ref?: string | null;
  fanoutKey?: string | null;
  createError?: AgentError | null;
  lastError?: AgentError | null;
  pane?: PaneInfo | null;
  poll?: PollState;
  history?: HistoryEntry[];
  promptPreview?: string | null;
  promptSha?: string | null;
  statusChangedAt?: string | null;
  createdAt?: string;
  attempts?: number;
  requestId?: string | null;
  recovered?: string;
  pid?: number;
}

export interface PollState {
  nextAt: number;
  interval: number;
  unchanged: number;
  lastAt: string | null;
  lastAgentUpdatedAt: string | null;
}

/** A row written by newAgentRecord. Poll, runs, and history are always present. */
export interface AgentRecord extends AgentView {
  agentId: string | null;
  key: string | null;
  batch: string | null;
  label: string | null;
  source: string;
  phase: string;
  name: string | null;
  url: string | null;
  repo: string | null;
  ref: string | null;
  promptPreview: string | null;
  promptSha: string | null;
  runId: string | null;
  status: string | null;
  statusChangedAt: string | null;
  runs: Record<string, RunRecord>;
  history: HistoryEntry[];
  git: GitSnapshot | null;
  gitPrev: GitSnapshot | null;
  finalized: boolean;
  missing: boolean;
  poll: PollState;
  lastError: AgentError | null;
  pane: PaneInfo | null;
  createdAt: string;
}

export interface BudgetState {
  windowStart: number;
  count: number;
  cooldownUntil?: number;
  nextRequestAt?: number;
  failures?: number;
  remaining?: number | null;
  limit?: number | null;
  resetAt?: number;
  leaseUntil?: number;
}

export interface StatusEvent {
  at: string;
  agentId?: string | null;
  label?: string | null;
  runId?: string | null;
  from?: string | null;
  to?: string;
}

export interface ApprovalInfo {
  key?: string;
  label?: string | null;
  localApproval?: boolean;
  pid?: number;
}

export interface BatchInfo {
  createdAt?: string;
  specSha?: string;
  title?: string | null;
  via?: string;
}

export interface RegistryMeta {
  panes: Record<string, PaneInfo | undefined>;
  events?: StatusEvent[];
  usageUnavailable?: boolean;
  reviews?: Record<string, ReviewRecord>;
  budget?: BudgetState;
  reviewPaused?: boolean;
  approvals?: Record<string, ApprovalInfo>;
}

export interface Registry {
  version: number;
  updatedAt: string | null;
  meta: RegistryMeta;
  batches: Record<string, BatchInfo>;
  agents: Record<string, AgentRecord>;
}

export interface StoreConfig {
  dir: string;
  registryPath: string;
  lockPath: string;
}

export interface FanoutConfig extends StoreConfig {
  pidPath: string;
  dashboardPath: string;
  logPath: string;
  reportPath: string;
  apiBase: string;
  rpm: number;
  tickMs: number;
  intervals: Record<string, number>;
  runsPageLimit: number;
  indexThreshold: number;
  maxPerLaunch: number;
}

export interface Logger {
  info: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
  debug: (m: string) => void;
}

export interface AgentSummary {
  id: string;
  name?: string;
  url?: string;
  status?: string;
  updatedAt?: string;
  latestRunId?: string;
  createdAt?: string;
}

export interface ApiRun {
  id: string;
  agentId?: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  durationMs?: number | null;
  result?: string | null;
  git?: GitSnapshot | null;
}

export interface CreateAgentResponse {
  agent: AgentSummary;
  run?: ApiRun;
}

export interface ListAgentsResponse {
  items?: AgentSummary[];
  nextCursor?: string | null;
}

export interface ListRunsResponse {
  items?: ApiRun[];
  nextCursor?: string | null;
}

export interface UsageResponse {
  totalUsage?: UsageStats | null;
  runs?: { id?: string; usage?: UsageStats | null }[];
}

export interface ModelItem {
  id: string;
  displayName?: string;
  aliases?: string[];
}

export interface ModelsResponse {
  items?: ModelItem[];
}

export interface MeResponse {
  apiKeyName?: string;
  createdAt?: string;
  userEmail?: string;
  apiKey?: string;
  key?: string;
}

export interface CreateRunResponse {
  run?: ApiRun;
  runId?: string;
  delivery?: string;
}

export interface ModelRef {
  id?: string;
}

export interface LaunchItem {
  label?: string;
  prompt?: string;
  instruction?: string;
  summary?: string | null;
  output?: string | null;
  repo?: string | null;
  ref?: string | null;
  prUrl?: string | null;
  model?: ModelRef | null;
  mode?: string | null;
  autoCreatePR?: boolean | null;
  workOnCurrentBranch?: boolean | null;
  skipReviewerRequest?: boolean | null;
  request?: Record<string, unknown>;
}

export interface LaunchSpec {
  batch?: string;
  title?: string | null;
  defaults?: LaunchItem;
  agents?: LaunchItem[];
  matrix?: {
    prompts?: Array<string | LaunchItem>;
    repos?: Array<string | null>;
    refs?: Array<string | null>;
  };
}

export interface PlannedItem {
  key: string;
  label: string;
  prompt: string;
  summary: string | null;
  instruction: string | null;
  output: string | null;
  repo: string | null;
  ref: string | null;
  prUrl: string | null;
  model: ModelRef | null;
  mode: string | null;
  autoCreatePR: boolean | null;
  workOnCurrentBranch: boolean | null;
  skipReviewerRequest: boolean | null;
  request: Record<string, unknown>;
}

export interface FileChange {
  status: string;
  linesAdded?: number;
  linesRemoved?: number;
  confidence?: string;
}

export interface WorkspaceSource {
  kind: string;
  list: () => Promise<string[]>;
  readFile: (p: string) => Promise<string | null>;
  modified?: (ref?: string) => Promise<Map<string, { linesAdded?: number; linesRemoved?: number; confidence?: string; ghStatus?: string; patch?: string }>>;
}

export interface PrTarget {
  key: string;
  endpoint: string;
  url: string;
}

export interface GhResponse {
  status: number;
  headers: Record<string, string>;
  data?: {
    merged?: boolean;
    state?: string;
    merged_at?: string | null;
    head?: { sha?: string };
    base?: { ref?: string };
    message?: string;
  } | null;
  error?: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr?: string;
}

export type ExecFn = (command: string, args: string[], options?: { timeout?: number; maxBuffer?: number }) => Promise<ExecResult>;

export interface SidecarSession {
  sessionId?: string;
  token?: string;
  rexSession?: string;
  block?: string;
}

export interface SidecarOwner extends SidecarSession {
  pid: number;
  token: string;
}

export interface SidecarMessage {
  spec?: unknown;
  goal?: string;
  action?: string;
}

export interface ReplyMeta {
  fanoutKey: string | null;
  agentId: string | null;
  understood: string | null;
}
