import { Bot } from 'grammy';
import type { Logger } from 'pino';
import type { DaemonModule } from '../core/lifecycle.js';
import type { TelegramConfig } from '../core/config.js';
import type { ProjectManager, Project } from '../db/projects.js';
import type { BudgetTracker, UsageReport } from '../budget/tracker.js';
import type { UsageOptimizer, OptimizationReport } from '../budget/optimizer.js';
import type { ConversationHandler } from '../conversation/handler.js';
import type { CommitmentStore, Commitment, CommitmentResult } from '../commitment/index.js';
import type { DetectedCommitment } from '../commitment/index.js';
import type { ToolRegistry } from '../tools/index.js';
import type { TaskLedger, Task, ProgressHeartbeat } from '../tasks/index.js';
import type { BlockerMemory } from '../tasks/index.js';
import type { AgentOSManager, Agent, ObjectiveSummary, Delegation, Approval } from '../agent-os/manager.js';
import { getRuntimeVersionInfo } from '../core/version.js';
import type { SecretStore } from '../core/secret-store.js';
import { generateNewsRoundup } from './news-roundup.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DaemonStatus {
  state: string;
  currentTask: string | null;
  tasksCompleted: number;
  budgetRemaining: string;
  activeHours: string;
  uptime: string;
}

export type StatusProvider = () => DaemonStatus;
export type PauseResumeHandler = (action: 'pause' | 'resume' | 'stop') => void;

// ---------------------------------------------------------------------------
// Intent Detection ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â classify messages as actionable vs conversational
// ---------------------------------------------------------------------------

/** Imperative verbs that signal the user wants the daemon to DO something. */
const ACTION_VERBS = /^(fetch|get|find|search|check|look up|compile|summarize|summarise|download|scrape|collect|gather|list|show me|tell me|give me|pull|grab|run|execute|build|deploy|install|create|write|generate|update|monitor|scan|analyze|analyse|compare|calculate|count|test|verify|read)\b/i;

/** Short conversational patterns that should NOT be treated as tasks. */
const CONVERSATIONAL = /^(hi|hello|hey|yo|thanks|thank you|ok|okay|sure|yes|no|what|who|why|when|where|how are|how's|good morning|good evening|good night)\b/i;

/** Questions should go to conversation, not pipeline. */
const QUESTION = /\?\s*$/;

function detectActionableIntent(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 10) return false;          // Too short to be a task
  if (CONVERSATIONAL.test(trimmed)) return false;  // Greeting/conversational
  if (QUESTION.test(trimmed)) return false;        // Questions -> conversation
  if (ACTION_VERBS.test(trimmed)) return true;     // Imperative verb -> task
  return false;
}

function isLongHorizonMission(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (normalized.length >= 140) return true;

  const missionSignals = [
    /\b(end[- ]to[- ]end|from scratch|full stack|entire project)\b/,
    /\b(research|plan|build|test|deploy|publish|market|launch)\b.*\b(and|then|after)\b/,
    /\b(write.*ebook|build.*website|start.*business|make.*money)\b/,
    /\bautonomous|independent|delegate|multi[- ]step|objective\b/,
  ];
  return missionSignals.some((pattern) => pattern.test(normalized));
}

function toIsoTodayOrTomorrow(hour24: number, minute: number): string {
  const at = new Date();
  at.setHours(hour24, minute, 0, 0);
  if (at.getTime() < Date.now()) at.setDate(at.getDate() + 1);
  return at.toISOString();
}

function stripSchedulingPhrases(text: string): string {
  return text
    .replace(/\band\s+deliver\s+to\s+me\b/ig, '')
    .replace(/\bdeliver\s+to\s+me\b/ig, '')
    .replace(/\band\s+send\s+it\s+to\s+me\b/ig, '')
    .replace(/\bsend\s+it\s+to\s+me\b/ig, '')
    .replace(/\bevery\s+day\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/ig, '')
    .replace(/\bdaily\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/ig, '')
    .replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/ig, '')
    .replace(/\bin\s+\d+\s+(?:minutes?|hours?)\b/ig, '')
    .replace(/\bfrom\s*$/ig, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/[,.\s]+$/, '');
}

function isNewsExpansionPrompt(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return /\b(where\s+is\s+the\s+rest|rest\s+of\s+it|more\s+news|more\s+headlines|continue|show\s+more)\b/.test(normalized);
}

function parseRescheduleIntent(text: string): { executeAt: string } | null {
  const normalized = text.trim();

  const toTime = normalized.match(/(?:change|move|reschedule|set)\s+(?:that|it|this|the time)?\s*(?:to|for)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i)
    ?? normalized.match(/\bto\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);

  if (!toTime) return null;

  let hour = parseInt(toTime[1], 10);
  const minute = toTime[2] ? parseInt(toTime[2], 10) : 0;
  const meridiem = toTime[3]?.toLowerCase();

  // If meridiem is present, convert 12h ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ 24h. If absent, treat as 24h clock.
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  return { executeAt: toIsoTodayOrTomorrow(hour, minute) };
}

export function parseScheduledIntent(text: string): DetectedCommitment | null {
  const normalized = text.trim();
  if (normalized.length < 10) return null;

  const recurringMatch = normalized.match(/(?:every\s+day|daily)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (recurringMatch) {
    let hour = parseInt(recurringMatch[1], 10);
    const minute = recurringMatch[2] ? parseInt(recurringMatch[2], 10) : 0;
    const meridiem = recurringMatch[3]?.toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;

    const action = stripSchedulingPhrases(normalized) || normalized;
    return {
      type: 'recurring',
      promiseText: recurringMatch[0],
      actionDescription: action,
      schedule: `${minute} ${hour} * * *`,
    };
  }

  const atMeridiem = normalized.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (atMeridiem) {
    let hour = parseInt(atMeridiem[1], 10);
    const minute = atMeridiem[2] ? parseInt(atMeridiem[2], 10) : 0;
    const meridiem = atMeridiem[3].toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;

    const action = stripSchedulingPhrases(normalized) || normalized;
    return {
      type: 'one_time',
      promiseText: atMeridiem[0],
      actionDescription: action,
      executeAt: toIsoTodayOrTomorrow(hour, minute),
    };
  }

  const at24h = normalized.match(/\bat\s+(\d{1,2}):(\d{2})(?!\s*(?:am|pm))\b/i);
  if (at24h) {
    const hour = parseInt(at24h[1], 10);
    const minute = parseInt(at24h[2], 10);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      const action = stripSchedulingPhrases(normalized) || normalized;
      return {
        type: 'one_time',
        promiseText: at24h[0],
        actionDescription: action,
        executeAt: toIsoTodayOrTomorrow(hour, minute),
      };
    }
  }

  const inMinutes = normalized.match(/\bin\s+(\d+)\s+minutes?\b/i);
  if (inMinutes) {
    const mins = parseInt(inMinutes[1], 10);
    const action = stripSchedulingPhrases(normalized) || normalized;
    return {
      type: 'one_time',
      promiseText: inMinutes[0],
      actionDescription: action,
      executeAt: new Date(Date.now() + mins * 60_000).toISOString(),
    };
  }

  const inHours = normalized.match(/\bin\s+(\d+)\s+hours?\b/i);
  if (inHours) {
    const hours = parseInt(inHours[1], 10);
    const action = stripSchedulingPhrases(normalized) || normalized;
    return {
      type: 'one_time',
      promiseText: inHours[0],
      actionDescription: action,
      executeAt: new Date(Date.now() + hours * 3_600_000).toISOString(),
    };
  }

  return null;
}

export function isObjectiveStatusQuery(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;

  const objectiveIdMention = /\b[0-9a-f]{8}\b/.test(normalized);
  const statusLanguage = /\b(status|progress\w*|blocked|stuck|unblock|failed|error|in progress|objective|task)\b/.test(normalized);
  const operationalQuestion = /\b(what are you blocked on|are you building|are you working|are you doing|how is it going|why .*blocked|why .*not progressing)\b/.test(normalized);

  return objectiveIdMention || statusLanguage || operationalQuestion;
}

function extractObjectiveIdFromText(text: string): string | null {
  const match = text.toLowerCase().match(/\b([0-9a-f]{8})\b/);
  return match?.[1] ?? null;
}

function buildObjectiveStatusReply(agentOS: AgentOSManager, text: string): string | null {
  if (!isObjectiveStatusQuery(text)) return null;

  const objectives = agentOS.listObjectives(20);
  if (objectives.length === 0) return null;

  const explicitId = extractObjectiveIdFromText(text);
  let objective = explicitId
    ? objectives.find((item) => item.id === explicitId) ?? null
    : null;

  if (!objective) {
    objective = objectives.find((item) =>
      item.status === 'running' ||
      item.status === 'waiting_approval' ||
      item.status === 'blocked' ||
      item.status === 'queued',
    ) ?? objectives[0]!;
  }

  const tasks = agentOS.getObjectiveTasks(objective.id);
  const runningTask = tasks.find((task) => task.status === 'running');
  const queuedTask = tasks.find((task) => task.status === 'queued');
  const blockerTask = [...tasks]
    .filter((task) => task.status === 'blocked' || task.status === 'failed')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];

  const lines: string[] = [
    '<b>Live Objective Status</b>',
    `Objective: <code>${objective.id}</code>`,
    `Title: ${escapeHtml(objective.title)}`,
    `Status: ${objective.status}`,
    `Progress: ${objective.taskDone}/${objective.taskTotal} done | ${objective.taskRunning} running | ${objective.taskQueued} queued | ${objective.taskFailed} failed`,
  ];

  if (runningTask) {
    lines.push(`Running now: <code>${runningTask.id}</code> ${escapeHtml(runningTask.title)}`);
  }

  if (objective.status === 'blocked' && blockerTask) {
    const reason = blockerTask.lastError ?? blockerTask.blockReason ?? 'No blocker reason captured.';
    lines.push(`Blocked on: <code>${blockerTask.id}</code> ${escapeHtml(blockerTask.title)}`);
    lines.push(`Reason: ${escapeHtml(reason.slice(0, 300))}`);
  } else if (queuedTask) {
    lines.push(`Next queued: <code>${queuedTask.id}</code> ${escapeHtml(queuedTask.title)}`);
  }

  lines.push(`Use /objective_tasks ${objective.id} to inspect full task state.`);
  return lines.join('\n');
}

function normalizeSecretKeyInput(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

function extractCredentialKeysFromText(text: string | null | undefined): string[] {
  if (!text) return [];

  const keys = new Set<string>();
  const regex = /CREDENTIAL_REQUIRED:([A-Z0-9_]+)/gi;
  for (const match of text.matchAll(regex)) {
    const key = match[1]?.trim();
    if (key) keys.add(key);
  }

  const genericMatch = text.match(/Missing credentials required:\s*([A-Z0-9_,\s]+)/i);
  if (genericMatch?.[1]) {
    for (const token of genericMatch[1].split(/[,\s]+/)) {
      const normalized = normalizeSecretKeyInput(token);
      if (normalized.length > 0) keys.add(normalized);
    }
  }

  return Array.from(keys);
}

function extractCredentialKeysFromTask(task: Task): string[] {
  const keys = new Set<string>();

  for (const key of extractCredentialKeysFromText(task.blockReason)) {
    keys.add(key);
  }

  for (const key of extractCredentialKeysFromText(task.lastError)) {
    keys.add(key);
  }

  return Array.from(keys);
}

function buildCredentialPrompt(task: Task): string {
  const keys = extractCredentialKeysFromTask(task);
  if (keys.length === 0) return '';

  const keyList = keys.map((key) => `<code>${escapeHtml(key)}</code>`).join(', ');
  const firstKey = keys[0]!;
  return [
    '<b>Credentials Required</b>',
    `Needed: ${keyList}`,
    `Set one now: <code>/setsecret ${escapeHtml(firstKey)} your-value</code>`,
    'Then rerun the task or wait for auto-resume.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Telegram Reporter
// ---------------------------------------------------------------------------

/**
 * Telegram bot for daemon communication.
 *
 * Commands:
 * - /status ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â Show current daemon state
 * - /pause ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â Pause task execution
 * - /resume ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â Resume task execution
 * - /stop ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â Emergency stop
 *
 * Outbound notifications:
 * - Task completion
 * - Errors
 * - Budget warnings
 * - Morning report
 */
export class TelegramReporter implements DaemonModule {
  readonly name = 'telegram';
  private bot: Bot | null = null;
  private statusProvider: StatusProvider | null = null;
  private controlHandler: PauseResumeHandler | null = null;
  private projectManager: ProjectManager | null = null;
  private budgetTracker: BudgetTracker | null = null;
  private usageOptimizer: UsageOptimizer | null = null;
  private conversationHandler: ConversationHandler | null = null;
  private commitmentStore: CommitmentStore | null = null;
  private commitmentScheduler: import('../commitment/scheduler.js').CommitmentScheduler | null = null;
  private toolRegistry: ToolRegistry | null = null;
  private taskLedger: TaskLedger | null = null;
  private blockerMemory: BlockerMemory | null = null;
  private agentOSManager: AgentOSManager | null = null;
  private secretStore: SecretStore | null = null;
  private startedAtIso = new Date().toISOString();

  constructor(
    private config: TelegramConfig,
    private logger: Logger,
  ) {}

  /** Register a callback that provides current daemon status. */
  onStatus(provider: StatusProvider): void {
    this.statusProvider = provider;
  }

  /** Register a callback for pause/resume/stop commands. */
  onControl(handler: PauseResumeHandler): void {
    this.controlHandler = handler;
  }

  /** Register the project manager for project commands. */
  onProjects(manager: ProjectManager): void {
    this.projectManager = manager;
  }

  /** Register the budget tracker for usage commands. */
  onBudget(tracker: BudgetTracker): void {
    this.budgetTracker = tracker;
  }

  /** Register the usage optimizer for optimization analysis. */
  onOptimizer(optimizer: UsageOptimizer): void {
    this.usageOptimizer = optimizer;
  }

  /** Register the conversation handler for natural language messages. */
  onConversation(handler: ConversationHandler): void {
    this.conversationHandler = handler;
  }

  /** Register the tool registry for tool commands. */
  onTools(registry: ToolRegistry): void {
    this.toolRegistry = registry;
  }

  /** Register the task ledger for task commands. */
  onTaskLedger(ledger: TaskLedger): void {
    this.taskLedger = ledger;
  }

  /** Register blocker memory for self-learning commands. */
  onBlockerMemory(memory: BlockerMemory): void {
    this.blockerMemory = memory;
  }

  /** Register the Agent OS manager for agent/objective commands. */
  onAgentOS(manager: AgentOSManager): void {
    this.agentOSManager = manager;
  }

  /** Register the secret store for credential command flow. */
  onSecrets(store: SecretStore): void {
    this.secretStore = store;
  }

  /** Register the commitment store for commitment commands. */
  onCommitments(store: CommitmentStore): void {
    this.commitmentStore = store;
  }

  /** Register commitment detection for conversation flow. */
  onConversationCommitments(store: CommitmentStore, scheduler: import('../commitment/scheduler.js').CommitmentScheduler): void {
    this.commitmentStore = store;
    this.commitmentScheduler = scheduler;
  }

  /** Register daemon start timestamp for runtime version reporting. */
  setStartedAt(startedAtIso: string): void {
    this.startedAtIso = startedAtIso;
  }

  private buildRuntimeVersionMessage(): string {
    const info = getRuntimeVersionInfo(this.startedAtIso);
    return `ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â·ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â <b>Runtime Version</b>
Version: <code>${escapeHtml(info.buildVersion)}</code>
Commit: <code>${escapeHtml(info.commit)}</code>
Env: <code>${escapeHtml(info.environment)}</code>
PID: <code>${info.pid}</code>
Started: <code>${escapeHtml(info.startedAt)}</code>`;
  }

  private parseSetSecretInput(raw: string): { key: string; value: string } | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    const firstSpace = trimmed.search(/\s/);
    if (firstSpace <= 0) return null;

    const key = trimmed.slice(0, firstSpace).trim();
    const value = trimmed.slice(firstSpace + 1).trim();
    if (!key || !value) return null;

    return { key, value };
  }

  private async resumeBlockedTasksForSecret(secretKey: string): Promise<{
    found: number;
    resumed: number;
    done: number;
    blocked: number;
    failed: number;
  }> {
    if (!this.taskLedger) {
      return { found: 0, resumed: 0, done: 0, blocked: 0, failed: 0 };
    }

    const normalizedKey = normalizeSecretKeyInput(secretKey);
    const candidates = this.taskLedger
      .listByStatus('blocked')
      .filter((task) => extractCredentialKeysFromTask(task).includes(normalizedKey))
      .slice(0, 5);

    if (candidates.length === 0) {
      return { found: 0, resumed: 0, done: 0, blocked: 0, failed: 0 };
    }

    let resumed = 0;
    let done = 0;
    let blocked = 0;
    let failed = 0;

    for (const task of candidates) {
      const requeued = this.taskLedger.resume(task.id);
      if (!requeued) continue;
      resumed++;

      if (!this.conversationHandler) continue;

      try {
        const result = await this.conversationHandler.executeTask(task.id);
        if (!result) {
          failed++;
          continue;
        }

        if (result.task.status === 'done') {
          done++;
          continue;
        }

        if (result.task.status === 'blocked') {
          blocked++;
          continue;
        }

        failed++;
      } catch (error) {
        failed++;
        this.logger.warn(
          {
            taskId: task.id,
            error: error instanceof Error ? error.message : String(error),
            secretKey: normalizedKey,
          },
          'Auto-resume after secret set failed',
        );
      }
    }

    return { found: candidates.length, resumed, done, blocked, failed };
  }

  private async handleSetSecret(raw: string): Promise<string> {
    if (!this.secretStore) {
      return 'Secret store not available.';
    }

    const parsed = this.parseSetSecretInput(raw);
    if (!parsed) {
      return 'Usage: <code>/setsecret KEY value</code>';
    }

    const normalizedKey = normalizeSecretKeyInput(parsed.key);
    this.secretStore.set(parsed.key, parsed.value);

    const resume = await this.resumeBlockedTasksForSecret(normalizedKey);
    const lines = [`Stored secret: <code>${escapeHtml(normalizedKey)}</code>`];

    if (resume.found > 0) {
      lines.push(
        `Auto-resume scanned ${resume.found} blocked task(s): ` +
        `${resume.done} done, ${resume.blocked} still blocked, ${resume.failed} failed.`,
      );
    }

    return lines.join('\n');
  }

  private handleSecretsList(): string {
    if (!this.secretStore) {
      return 'Secret store not available.';
    }

    const keys = this.secretStore.listKeys(30);
    if (keys.length === 0) {
      return 'No stored secrets yet.';
    }

    const lines = [`<b>Stored Secrets (${keys.length})</b>`, ''];
    for (const key of keys) {
      lines.push(`- <code>${escapeHtml(key)}</code>`);
    }
    lines.push('', 'Set/update: <code>/setsecret KEY value</code>');
    lines.push('Delete: <code>/delsecret KEY</code>');
    return lines.join('\n');
  }

  private handleDeleteSecret(raw: string): string {
    if (!this.secretStore) {
      return 'Secret store not available.';
    }

    const key = raw.trim();
    if (!key) {
      return 'Usage: <code>/delsecret KEY</code>';
    }

    const normalizedKey = normalizeSecretKeyInput(key);
    const deleted = this.secretStore.delete(normalizedKey);
    return deleted
      ? `Deleted secret: <code>${escapeHtml(normalizedKey)}</code>`
      : `No stored secret found for <code>${escapeHtml(normalizedKey)}</code>`;
  }

  private handleSecretRequests(): string {
    if (!this.secretStore) {
      return 'Secret store not available.';
    }

    const requests = this.secretStore.listPendingRequests(20);
    if (requests.length === 0) {
      return 'No pending credential requests.';
    }

    const lines = [`<b>Pending Credential Requests (${requests.length})</b>`, ''];
    for (const request of requests) {
      lines.push(
        `- <code>${escapeHtml(request.secretKey)}</code> ` +
        `(id=${request.id})${request.context ? `\n  ${escapeHtml(request.context)}` : ''}`,
      );
    }
    lines.push('', 'Provide one: <code>/setsecret KEY value</code>');
    return lines.join('\n');
  }

  async start(): Promise<void> {
    this.bot = new Bot(this.config.botToken);
    const authorizedChat = this.config.chatId;

    // Auth middleware ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â only respond to the configured chat
    this.bot.use(async (ctx, next) => {
      if (ctx.chat?.id.toString() !== authorizedChat) {
        this.logger.warn({ chatId: ctx.chat?.id }, 'Unauthorized chat ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ignoring');
        return;
      }
      await next();
    });

    // /status command
    this.bot.command('status', async (ctx) => {
      const status = this.statusProvider?.() ?? {
        state: 'unknown', currentTask: null, tasksCompleted: 0,
        budgetRemaining: 'N/A', activeHours: 'N/A', uptime: 'N/A',
      };
      await ctx.reply(formatStatusMessage(status), { parse_mode: 'HTML' });
    });

    // /version ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â show runtime build/version metadata from the active process
    this.bot.command('version', async (ctx) => {
      await ctx.reply(this.buildRuntimeVersionMessage(), { parse_mode: 'HTML' });
    });

    // /pause command
    this.bot.command('pause', async (ctx) => {
      this.controlHandler?.('pause');
      await ctx.reply('ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ Daemon paused. Use /resume to continue.');
    });

    // /resume command
    this.bot.command('resume', async (ctx) => {
      this.controlHandler?.('resume');
      await ctx.reply('ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¶ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â Daemon resumed.');
    });

    // /stop command
    this.bot.command('stop', async (ctx) => {
      await ctx.reply('ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂºÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¹Ã…â€œ Emergency stop initiated. Daemon shutting down...');
      this.controlHandler?.('stop');
    });

    // /projects ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â list all projects
    this.bot.command('projects', async (ctx) => {
      if (!this.projectManager) {
        await ctx.reply('Project manager not available.');
        return;
      }
      const projects = this.projectManager.listProjects();
      if (projects.length === 0) {
        await ctx.reply('ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ No projects. Use /addproject &lt;path&gt; to add one.');
        return;
      }
      await ctx.reply(formatProjectsList(projects), { parse_mode: 'HTML' });
    });

    // /addproject <path> [name] ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â add a new project
    this.bot.command('addproject', async (ctx) => {
      if (!this.projectManager) {
        await ctx.reply('Project manager not available.');
        return;
      }
      const args = ctx.match?.toString().trim().split(/\s+/) ?? [];
      if (args.length === 0 || !args[0]) {
        await ctx.reply('Usage: /addproject &lt;path&gt; [name]');
        return;
      }
      const project = this.projectManager.addProject(args[0], 'daemon/work', args[1]);
      if (!project) {
        await ctx.reply(`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ Path not found: ${args[0]}`);
        return;
      }
      await ctx.reply(`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ Added project: <b>${escapeHtml(project.name)}</b>\nPath: <code>${escapeHtml(project.repoPath)}</code>`, { parse_mode: 'HTML' });
    });

    // /work <name> ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â set active project
    this.bot.command('work', async (ctx) => {
      if (!this.projectManager) {
        await ctx.reply('Project manager not available.');
        return;
      }
      const name = ctx.match?.toString().trim();
      if (!name) {
        await ctx.reply('Usage: /work &lt;project-name&gt;');
        return;
      }
      const project = this.projectManager.setActiveProject(name);
      if (!project) {
        await ctx.reply(`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ Project not found: ${name}`);
        return;
      }
      await ctx.reply(`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â½ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¯ Now working on: <b>${escapeHtml(project.name)}</b>`, { parse_mode: 'HTML' });
    });

    // /rmproject <name> ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â remove a project
    this.bot.command('rmproject', async (ctx) => {
      if (!this.projectManager) {
        await ctx.reply('Project manager not available.');
        return;
      }
      const name = ctx.match?.toString().trim();
      if (!name) {
        await ctx.reply('Usage: /rmproject &lt;project-name&gt;');
        return;
      }
      const removed = this.projectManager.removeProject(name);
      if (removed) {
        await ctx.reply(`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¹Ã…â€œ Project removed: ${name}`);
      } else {
        await ctx.reply(`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ Project not found: ${name}`);
      }
    });

    // /agents ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â list all autonomous agents
    this.bot.command('agents', async (ctx) => {
      if (!this.agentOSManager) {
        await ctx.reply('Agent OS manager not available.');
        return;
      }
      const agents = this.agentOSManager.listAgents();
      if (agents.length === 0) {
        await ctx.reply('ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¤ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œ No agents yet. Use /addagent <name> [role]');
        return;
      }
      await ctx.reply(formatAgentsList(agents), { parse_mode: 'HTML' });
    });

    // /addagent <name> [role prompt] ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â create an autonomous agent
    this.bot.command('addagent', async (ctx) => {
      if (!this.agentOSManager) {
        await ctx.reply('Agent OS manager not available.');
        return;
      }
      const raw = ctx.match?.toString().trim() ?? '';
      if (!raw) {
        await ctx.reply('Usage: /addagent <name> [role prompt]');
        return;
      }

      const parts = raw.split(/\s+/);
      const name = parts[0]?.trim();
      if (!name) {
        await ctx.reply('Usage: /addagent <name> [role prompt]');
        return;
      }

      const rolePrompt = parts.slice(1).join(' ').trim();
      try {
        const agent = this.agentOSManager.createAgent({
          name,
          rolePrompt: rolePrompt.length > 0 ? rolePrompt : undefined,
          autonomyMode: 'autonomous',
        });
        await ctx.reply(
          `ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ Agent created: <b>${escapeHtml(agent.name)}</b>\nID: <code>${agent.id}</code>\nStatus: ${agent.status}`,
          { parse_mode: 'HTML' },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await ctx.reply(`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ Could not create agent: ${escapeHtml(message)}`, { parse_mode: 'HTML' });
      }
    });

    // /objective <description> OR /objective <agent> :: <description>
    this.bot.command('objective', async (ctx) => {
      if (!this.agentOSManager) {
        await ctx.reply('Agent OS manager not available.');
        return;
      }

      const raw = ctx.match?.toString().trim() ?? '';
      if (!raw) {
        await ctx.reply('Usage: /objective <description>\nor: /objective <agent> :: <description>');
        return;
      }

      let description = raw;
      let ownerAgentId: string | null = null;
      const split = raw.split('::');
      if (split.length >= 2) {
        const requestedAgent = split[0]?.trim() ?? '';
        description = split.slice(1).join('::').trim();
        if (!description) {
          await ctx.reply('Usage: /objective <agent> :: <description>');
          return;
        }
        if (requestedAgent) {
          const agent = this.agentOSManager.getAgentByNameOrId(requestedAgent);
          if (!agent) {
            await ctx.reply(`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ Agent not found: ${escapeHtml(requestedAgent)}`, { parse_mode: 'HTML' });
            return;
          }
          ownerAgentId = agent.id;
        }
      }

      const activeProject = this.projectManager?.getActiveProject();
      const title = description.length > 80 ? `${description.slice(0, 77)}...` : description;

      try {
        const objective = this.agentOSManager.createObjective({
          projectId: activeProject?.id ?? null,
          ownerAgentId,
          requestedBy: 'telegram-user',
          title,
          description,
          priority: 6,
        });
        const ownerAgent = objective.ownerAgentId
          ? this.agentOSManager.getAgentByNameOrId(objective.ownerAgentId)
          : null;

        await ctx.reply(
          `ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â½ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¯ Objective created\nID: <code>${objective.id}</code>\nStatus: ${objective.status}\nOwner: ${escapeHtml(ownerAgent?.name ?? 'auto')}\n\n${escapeHtml(objective.description)}`,
          { parse_mode: 'HTML' },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await ctx.reply(`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ Could not create objective: ${escapeHtml(message)}`, { parse_mode: 'HTML' });
      }
    });

    // /objectives ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â list objective queue and progress
    this.bot.command('objectives', async (ctx) => {
      if (!this.agentOSManager) {
        await ctx.reply('Agent OS manager not available.');
        return;
      }
      const objectives = this.agentOSManager.listObjectives(20);
      if (objectives.length === 0) {
        await ctx.reply('ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â½ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¯ No objectives yet. Use /objective <description> to create one.');
        return;
      }
      await ctx.reply(formatObjectivesList(objectives), { parse_mode: 'HTML' });
    });

    // /objective_tasks <objectiveId> ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â list tasks under an objective
    this.bot.command('objective_tasks', async (ctx) => {
      if (!this.agentOSManager) {
        await ctx.reply('Agent OS manager not available.');
        return;
      }
      let objectiveId = ctx.match?.toString().trim() ?? '';
      if (!objectiveId) {
        const latest = this.agentOSManager.listObjectives(1)[0];
        if (!latest) {
          await ctx.reply('No objectives yet. Use /objective <description> to create one.');
          return;
        }
        objectiveId = latest.id;
      }
      const objective = this.agentOSManager.getObjectiveById(objectiveId);
      if (!objective) {
        await ctx.reply(`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ Objective not found: ${escapeHtml(objectiveId)}`, { parse_mode: 'HTML' });
        return;
      }
      const tasks = this.agentOSManager.getObjectiveTasks(objectiveId);
      if (tasks.length === 0) {
        await ctx.reply(`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¹ No tasks found for objective ${escapeHtml(objectiveId)}.`);
        return;
      }
      const lines = tasks.map((task) => {
        const emoji = task.status === 'done'
          ? 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦'
          : task.status === 'running'
            ? 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾'
            : task.status === 'failed'
              ? 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢'
              : task.status === 'blocked'
                ? 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â«'
                : 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³';
        return `${emoji} <code>${task.id}</code> ${escapeHtml(task.title)}`;
      });
      await ctx.reply(
        `ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¹ <b>Objective ${escapeHtml(objective.id)}</b>\n${escapeHtml(objective.title)}\n\n${lines.join('\n')}`,
        { parse_mode: 'HTML' },
      );
    });

    // /delegate <taskId> <agent> :: <question>
    this.bot.command('delegate', async (ctx) => {
      if (!this.agentOSManager) {
        await ctx.reply('Agent OS manager not available.');
        return;
      }
      const raw = ctx.match?.toString().trim() ?? '';
      const parsed = raw.match(/^(\S+)\s+([A-Za-z0-9_-]+)\s*::\s+(.+)$/);
      if (!parsed) {
        await ctx.reply('Usage: /delegate <task-id> <agent-name> :: <question>');
        return;
      }

      const taskId = parsed[1]!;
      const toAgent = parsed[2]!;
      const question = parsed[3]!;

      try {
        const delegation = this.agentOSManager.createDelegation({
          taskId,
          toAgentNameOrId: toAgent,
          question,
        });
        await ctx.reply(
          `ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¤ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â Delegation created\n` +
          `Delegation: <code>${delegation.id}</code>\n` +
          `Parent Task: <code>${delegation.taskId}</code>\n` +
          `Delegated Task: <code>${escapeHtml(delegation.delegatedTaskId ?? '(none)')}</code>\n` +
          `To Agent: <code>${escapeHtml(delegation.toAgentId)}</code>`,
          { parse_mode: 'HTML' },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await ctx.reply(`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ Delegation failed: ${escapeHtml(message)}`, { parse_mode: 'HTML' });
      }
    });

    // /delegations ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â list delegation queue
    this.bot.command('delegations', async (ctx) => {
      if (!this.agentOSManager) {
        await ctx.reply('Agent OS manager not available.');
        return;
      }
      const delegations = this.agentOSManager.listDelegations('all', 25);
      if (delegations.length === 0) {
        await ctx.reply('ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¤ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â No delegations found.');
        return;
      }
      await ctx.reply(formatDelegationsList(delegations), { parse_mode: 'HTML' });
    });

    // /approvals ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â list pending approvals
    this.bot.command('approvals', async (ctx) => {
      if (!this.agentOSManager) {
        await ctx.reply('Agent OS manager not available.');
        return;
      }
      const approvals = this.agentOSManager.listApprovals('pending', 25);
      if (approvals.length === 0) {
        await ctx.reply('ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ No pending approvals.');
        return;
      }
      await ctx.reply(formatApprovalsList(approvals), { parse_mode: 'HTML' });
    });

    // /approve <approvalId> [note]
    this.bot.command('approve', async (ctx) => {
      if (!this.agentOSManager) {
        await ctx.reply('Agent OS manager not available.');
        return;
      }
      const raw = ctx.match?.toString().trim() ?? '';
      const [approvalId, ...rest] = raw.split(/\s+/);
      if (!approvalId) {
        await ctx.reply('Usage: /approve <approval-id> [note]');
        return;
      }

      const note = rest.join(' ').trim();
      const updated = this.agentOSManager.decideApproval(approvalId, 'approved', note.length > 0 ? note : undefined);
      if (!updated) {
        await ctx.reply(`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ Approval not found or already decided: ${escapeHtml(approvalId)}`, { parse_mode: 'HTML' });
        return;
      }
      await ctx.reply(`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ Approved <code>${updated.id}</code> for task <code>${updated.taskId}</code>`, { parse_mode: 'HTML' });
    });

    // /reject <approvalId> [reason]
    this.bot.command('reject', async (ctx) => {
      if (!this.agentOSManager) {
        await ctx.reply('Agent OS manager not available.');
        return;
      }
      const raw = ctx.match?.toString().trim() ?? '';
      const [approvalId, ...rest] = raw.split(/\s+/);
      if (!approvalId) {
        await ctx.reply('Usage: /reject <approval-id> [reason]');
        return;
      }

      const note = rest.join(' ').trim();
      const updated = this.agentOSManager.decideApproval(approvalId, 'rejected', note.length > 0 ? note : 'Rejected by operator');
      if (!updated) {
        await ctx.reply(`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ Approval not found or already decided: ${escapeHtml(approvalId)}`, { parse_mode: 'HTML' });
        return;
      }
      await ctx.reply(`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â« Rejected <code>${updated.id}</code> for task <code>${updated.taskId}</code>`, { parse_mode: 'HTML' });
    });

    // /usage ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â comprehensive token usage report
    this.bot.command('usage', async (ctx) => {
      if (!this.budgetTracker) {
        await ctx.reply('Budget tracker not available.');
        return;
      }
      const report = this.budgetTracker.getUsageReport();
      await ctx.reply(formatUsageReport(report), { parse_mode: 'HTML' });
    });

    // /optimize ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â run usage optimization analysis
    this.bot.command('optimize', async (ctx) => {
      if (!this.usageOptimizer) {
        await ctx.reply('Usage optimizer not available.');
        return;
      }
      const days = parseInt(ctx.match?.toString().trim() || '7', 10) || 7;
      const report = this.usageOptimizer.analyze(days);
      await ctx.reply(formatOptimizationReport(report), { parse_mode: 'HTML' });
    });

    // /commitments ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â list active commitments
    this.bot.command('commitments', async (ctx) => {
      if (!this.commitmentStore) {
        await ctx.reply('Commitment engine not available.');
        return;
      }
      const active = this.commitmentStore.listActive();
      if (active.length === 0) {
        await ctx.reply("ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¹ No active commitments. I haven't promised anything yet!");
        return;
      }
      await ctx.reply(formatCommitmentsList(active), { parse_mode: 'HTML' });
    });

    // /cancel <query> ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â cancel a commitment by description
    this.bot.command('cancel', async (ctx) => {
      if (!this.commitmentStore) {
        await ctx.reply('Commitment engine not available.');
        return;
      }
      const query = ctx.match?.toString().trim();
      if (!query) {
        await ctx.reply('Usage: /cancel &lt;description&gt;\nExample: /cancel daily news');
        return;
      }
      const cancelled = this.commitmentStore.cancelByDescription(query);
      if (cancelled) {
        await ctx.reply(`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ Cancelled: "${escapeHtml(cancelled.actionDescription)}"`);
      } else {
        await ctx.reply(`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ No active commitment matching "${escapeHtml(query)}". Use /commitments to see active ones.`);
      }
    });

    // /reset ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â reset conversation state to start fresh
    this.bot.command('reset', async (ctx) => {
      if (!this.conversationHandler) {
        await ctx.reply('Conversation handler not available.');
        return;
      }
      this.conversationHandler.resetConversation();
      await ctx.reply("ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ Conversation reset. Let's start fresh! What are you working on?");
    });

    // /tasks ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â list active tasks from the task ledger
    // /setsecret <KEY> <VALUE> - store secret and retry blocked tasks waiting on it
    this.bot.command('setsecret', async (ctx) => {
      const raw = ctx.message?.text?.replace(/^\/setsecret\s*/i, '').trim() ?? '';
      const message = await this.handleSetSecret(raw);
      await ctx.reply(message, { parse_mode: 'HTML' });
    });

    // /secrets - list stored secret keys (values are never shown)
    this.bot.command('secrets', async (ctx) => {
      await ctx.reply(this.handleSecretsList(), { parse_mode: 'HTML' });
    });

    // /delsecret <KEY> - delete a stored secret
    this.bot.command('delsecret', async (ctx) => {
      const raw = ctx.match?.toString().trim() ?? '';
      await ctx.reply(this.handleDeleteSecret(raw), { parse_mode: 'HTML' });
    });

    // /secret_requests - list pending credential requests raised by tools
    this.bot.command('secret_requests', async (ctx) => {
      await ctx.reply(this.handleSecretRequests(), { parse_mode: 'HTML' });
    });

    this.bot.command('tasks', async (ctx) => {
      if (!this.taskLedger) {
        await ctx.reply('Task ledger not available.');
        return;
      }
      const active = this.taskLedger.listActive();
      if (active.length === 0) {
        await ctx.reply('ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¹ No active tasks right now.');
        return;
      }
      const statusEmoji: Record<string, string> = { queued: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³', running: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾', blocked: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â«' };
      const lines = active.map(t => {
        const emoji = statusEmoji[t.status] ?? 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¹';
        const deadline = t.deadline ? ` (due ${t.deadline})` : '';
        const blocked = t.blockReason ? ` ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ${escapeHtml(t.blockReason)}` : '';
        return `${emoji} <b>${escapeHtml(t.id)}</b>: ${escapeHtml(t.title)}${deadline}${blocked}`;
      });
      await ctx.reply(`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¹ <b>Active Tasks (${active.length})</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
    });

    // /task <id> ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â show task detail
    this.bot.command('task', async (ctx) => {
      if (!this.taskLedger) {
        await ctx.reply('Task ledger not available.');
        return;
      }
      const taskId = ctx.message?.text?.split(/\s+/)[1];
      if (!taskId) {
        await ctx.reply('Usage: /task &lt;id&gt;');
        return;
      }
      const task = this.taskLedger.getById(taskId);
      if (!task) {
        await ctx.reply(`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ No task found with ID "${escapeHtml(taskId)}"`);
        return;
      }
      const statusEmoji: Record<string, string> = { queued: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³', running: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾', blocked: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â«', done: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦', failed: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢' };
      const parts = [
        `${statusEmoji[task.status] ?? 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¹'} <b>${escapeHtml(task.title)}</b>`,
        `Type: ${task.type} | Priority: ${task.priority}`,
        `Status: ${task.status}`,
      ];
      if (task.deadline) parts.push(`Deadline: ${task.deadline}`);
      if (task.blockReason) parts.push(`Blocked: ${escapeHtml(task.blockReason)}`);
      if (task.lastError) parts.push(`Error: ${escapeHtml(task.lastError)}`);
      const credentialPrompt = buildCredentialPrompt(task);
      if (credentialPrompt) parts.push(credentialPrompt);
      if (task.artifacts.length > 0) {
        parts.push(`Artifacts: ${task.artifacts.map(a => escapeHtml(a.label)).join(', ')}`);
        const artifactSummary = formatTaskArtifactSummary(task);
        if (artifactSummary) {
          parts.push(artifactSummary.replace(/^\n\n/, ''));
        }
      }
      parts.push(`Created: ${task.createdAt}`);
      if (task.startedAt) parts.push(`Started: ${task.startedAt}`);
      if (task.completedAt) parts.push(`Completed: ${task.completedAt}`);
      parts.push(`Executions: ${task.executionCount}`);

      await ctx.reply(parts.join('\n'), { parse_mode: 'HTML' });
    });

    // /tools ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â list available tools and their risk levels
    this.bot.command('tools', async (ctx) => {
      if (!this.toolRegistry || this.toolRegistry.size === 0) {
        await ctx.reply('No tools registered.');
        return;
      }
      const tools = this.toolRegistry.list();
      const riskEmoji = { low: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢', medium: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡', high: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â´' } as const;
      const lines = tools.map(t =>
        `${riskEmoji[t.riskLevel]} <b>${escapeHtml(t.name)}</b> ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ${escapeHtml(t.description)}`
      );
      await ctx.reply(`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂºÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â <b>Available Tools (${tools.length})</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
    });

    // /run <description> ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â create a task and run it through the pipeline
    this.bot.command('run', async (ctx) => {
      if (!this.taskLedger || !this.conversationHandler) {
        await ctx.reply('Pipeline not available.');
        return;
      }
      const description = ctx.message?.text?.replace(/^\/run\s*/i, '').trim();
      if (!description) {
        await ctx.reply('Usage: /run &lt;task description&gt;');
        return;
      }

      const scheduledIntentFromRun = parseScheduledIntent(description);
      if (scheduledIntentFromRun) {
        if (!this.commitmentStore || !this.commitmentScheduler) {
          this.logger.warn({ description }, 'Timed /run request received before commitment engine was ready');
          await ctx.reply('ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³ Scheduling engine is still initializing. Please try again in a few seconds.');
          return;
        }

        this.logger.info(
          {
            source: '/run',
            type: scheduledIntentFromRun.type,
            executeAt: scheduledIntentFromRun.executeAt,
            schedule: scheduledIntentFromRun.schedule,
            action: scheduledIntentFromRun.actionDescription,
          },
          'Timed intent detected and routed to commitment scheduler',
        );

        const commitment = this.commitmentStore.create(scheduledIntentFromRun);
        this.commitmentScheduler.scheduleCommitment(commitment);
        await this.notifyCommitmentCreated(commitment);
        return;
      }

      const task = this.taskLedger.create({ title: description, type: 'general', priority: 5 });
      await ctx.reply(`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¹ Task <b>${escapeHtml(task.id)}</b> created. Running pipeline...`, { parse_mode: 'HTML' });

      // Keep typing indicator active during pipeline execution
      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction('typing').catch(() => {});
      }, 4000);

      try {
        // Heartbeat: send live progress updates as the pipeline runs
        const phaseEmoji: Record<string, string> = {
          planning: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ', executing: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡', verifying: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â', complete: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦', failed: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢',
        };
        let lastHeartbeatMsg = '';

        const onHeartbeat = async (hb: ProgressHeartbeat) => {
          const emoji = phaseEmoji[hb.phase] ?? 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢';
          const stepInfo = hb.stepIndex && hb.totalSteps ? ` [${hb.stepIndex}/${hb.totalSteps}]` : '';
          const blockerInfo = hb.blockers?.length ? `\nÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ ${hb.blockers.join(', ')}` : '';
          const msg = `${emoji}${stepInfo} ${hb.action}${blockerInfo}`;

          // Avoid sending duplicate messages
          if (msg === lastHeartbeatMsg) return;
          lastHeartbeatMsg = msg;

          try { await ctx.reply(msg); } catch { /* Telegram send errors shouldn't break pipeline */ }
        };

        const result = await this.conversationHandler.executeTask(task.id, onHeartbeat);
        clearInterval(typingInterval);
        if (!result) {
          await ctx.reply(`Pipeline failed for task ${escapeHtml(task.id)}. Use /task ${escapeHtml(task.id)} for details.`);
          return;
        }

        const { verification, plan } = result;
        const stepSummary = plan.steps.map(s => {
          const emoji = s.status === 'done' ? 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦' : s.status === 'failed' ? 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢' : 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â';
          return `${emoji} ${escapeHtml(s.name)}`;
        }).join('\n');

        const artifactSummary = formatTaskArtifactSummary(result.task);
        const credentialPrompt = buildCredentialPrompt(result.task);

        if (verification.verified) {
          await ctx.reply(
            `<b>Task Complete</b>\n\n${stepSummary}${artifactSummary}\n\nEvidence: ${escapeHtml(verification.evidence)}`,
            { parse_mode: 'HTML' },
          );
        } else if (result.task.status === 'blocked' && credentialPrompt) {
          await ctx.reply(
            `<b>Task Blocked</b>\n\n${stepSummary}${artifactSummary}\n\n${credentialPrompt}`,
            { parse_mode: 'HTML' },
          );
        } else {
          await ctx.reply(
            `<b>Task Failed</b>\n\n${stepSummary}${artifactSummary}\n\nReason: ${escapeHtml(verification.failedCriteria ?? 'Unknown failure')}`,
            { parse_mode: 'HTML' },
          );
        }
      } catch (error) {
        clearInterval(typingInterval);
        this.logger.error({ taskId: task.id, error }, 'Pipeline error');
        await ctx.reply(`Error: ${escapeHtml(error instanceof Error ? error.message : String(error))}`);
      }
    });

    // /blockers ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â show self-learning blocker memory
    this.bot.command('blockers', async (ctx) => {
      if (!this.blockerMemory) {
        await ctx.reply('Blocker memory not available.');
        return;
      }

      const stats = this.blockerMemory.stats();
      if (stats.total === 0) {
        await ctx.reply('ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â  No blocker resolutions recorded yet. The daemon learns from failures during /run tasks.');
        return;
      }

      const recent = this.blockerMemory.recent(5);
      const recentLines = recent.map(r =>
        `ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ <b>${escapeHtml(r.originalTool)}</b> ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ <b>${escapeHtml(r.resolutionTool)}</b> (${escapeHtml(r.blockerType)})`
      ).join('\n');

      const topBlockers = stats.topBlockers.map(b => `${escapeHtml(b.type)}: ${b.count}`).join(', ');

      await ctx.reply(
        `ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â  <b>Blocker Memory</b>\n\n` +
        `ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â  ${stats.total} resolutions, ${Math.round(stats.successRate * 100)}% success rate\n` +
        `ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â Top blockers: ${topBlockers}\n\n` +
        `<b>Recent Resolutions:</b>\n${recentLines}`,
        { parse_mode: 'HTML' },
      );
    });

    // Catch-all: natural language messages ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ intent classification ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ route
    this.bot.on('message:text', async (ctx) => {
      if (!this.conversationHandler) {
        await ctx.reply("I'm running but conversation mode isn't set up yet. Use /status for daemon info.");
        return;
      }

      let text = ctx.message.text;

      // Compatibility fallback: some chat runtimes do not dispatch slash commands.
      // Handle key commands in the generic text stream.
      const commandMatch = text.trim().match(/^\/(\w+)(?:\s+([\s\S]+))?$/i);
      if (commandMatch) {
        const cmd = (commandMatch[1] ?? '').toLowerCase();
        const arg = (commandMatch[2] ?? '').trim();

        if (cmd === 'version') {
          await ctx.reply(this.buildRuntimeVersionMessage(), { parse_mode: 'HTML' });
          return;
        }

        if (cmd === 'status') {
          const status = this.statusProvider?.() ?? {
            state: 'unknown', currentTask: null, tasksCompleted: 0,
            budgetRemaining: 'N/A', activeHours: 'N/A', uptime: 'N/A',
          };
          await ctx.reply(formatStatusMessage(status), { parse_mode: 'HTML' });
          return;
        }

        if (cmd === 'setsecret') {
          await ctx.reply(await this.handleSetSecret(arg), { parse_mode: 'HTML' });
          return;
        }

        if (cmd === 'secrets') {
          await ctx.reply(this.handleSecretsList(), { parse_mode: 'HTML' });
          return;
        }

        if (cmd === 'delsecret') {
          await ctx.reply(this.handleDeleteSecret(arg), { parse_mode: 'HTML' });
          return;
        }

        if (cmd === 'secret_requests') {
          await ctx.reply(this.handleSecretRequests(), { parse_mode: 'HTML' });
          return;
        }

        if (cmd === 'tasks') {
          if (!this.taskLedger) {
            await ctx.reply('Task ledger not available.');
            return;
          }
          const active = this.taskLedger.listActive();
          if (active.length === 0) {
            await ctx.reply('ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¹ No active tasks right now.');
            return;
          }
          const statusEmoji: Record<string, string> = { queued: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³', running: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾', blocked: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â«' };
          const lines = active.map(t => {
            const emoji = statusEmoji[t.status] ?? 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¹';
            const deadline = t.deadline ? ` (due ${t.deadline})` : '';
            const blocked = t.blockReason ? ` ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ${escapeHtml(t.blockReason)}` : '';
            return `${emoji} <b>${escapeHtml(t.id)}</b>: ${escapeHtml(t.title)}${deadline}${blocked}`;
          });
          await ctx.reply(`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¹ <b>Active Tasks (${active.length})</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
          return;
        }

        if (cmd === 'commitments') {
          if (!this.commitmentStore) {
            await ctx.reply('Commitment engine not available.');
            return;
          }
          const active = this.commitmentStore.listActive();
          if (active.length === 0) {
            await ctx.reply("ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¹ No active commitments. I haven't promised anything yet!");
            return;
          }
          await ctx.reply(formatCommitmentsList(active), { parse_mode: 'HTML' });
          return;
        }

        // /run fallback: if command endpoint isn't available, forward description
        // into the normal actionable/timed routing below.
        if (cmd === 'run' && arg) {
          text = arg;
        }
      }

      // Additional compatibility fallback: allow plain "version" text.
      if (/^\/?version\b/i.test(text.trim())) {
        await ctx.reply(this.buildRuntimeVersionMessage(), { parse_mode: 'HTML' });
        return;
      }

      // Natural-language reschedule: "change that to 12:34"
      const reschedule = parseRescheduleIntent(text);
      if (reschedule) {
        if (!this.commitmentStore) {
          await ctx.reply('Commitment engine not available.');
          return;
        }

        const latestOneTime = this.commitmentStore
          .listActive()
          .filter(c => c.type === 'one_time')
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

        if (!latestOneTime) {
          await ctx.reply('I could not find an active one-time scheduled task to update.');
          return;
        }

        const updated = this.commitmentStore.rescheduleOneTime(latestOneTime.id, reschedule.executeAt);
        if (!updated) {
          await ctx.reply('I found a schedule to update, but could not apply the new time.');
          return;
        }

        await ctx.reply(
          `ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ Updated schedule.
Action: ${escapeHtml(updated.actionDescription)}
When: ${escapeHtml(updated.executeAt ?? reschedule.executeAt)}`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      const scheduledIntent = parseScheduledIntent(text);

      if (scheduledIntent) {
        if (!this.commitmentStore || !this.commitmentScheduler) {
          this.logger.warn({ text }, 'Timed message received before commitment engine was ready');
          await ctx.reply('ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³ Scheduling engine is still initializing. Please retry in a few seconds.');
          return;
        }

        this.logger.info(
          {
            source: 'message:text',
            type: scheduledIntent.type,
            executeAt: scheduledIntent.executeAt,
            schedule: scheduledIntent.schedule,
            action: scheduledIntent.actionDescription,
          },
          'Timed intent detected and routed to commitment scheduler',
        );

        const commitment = this.commitmentStore.create(scheduledIntent);
        this.commitmentScheduler.scheduleCommitment(commitment);

        const when = commitment.type === 'recurring'
          ? `every ${commitment.schedule}`
          : (commitment.executeAt ?? 'scheduled');

        await ctx.reply(
          `ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ Scheduled.
Action: ${escapeHtml(commitment.actionDescription)}
When: ${escapeHtml(when)}`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      if (isNewsExpansionPrompt(text) && this.toolRegistry) {
        const latestNewsSeed = this.commitmentStore
          ?.listAll()
          .filter((c) => /\b(news|headlines|round\s*up|roundup|latest|update|updates)\b/i.test(c.actionDescription))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
          ?.actionDescription;

        if (latestNewsSeed) {
          const expanded = await generateNewsRoundup(this.toolRegistry, latestNewsSeed, 12);
          if (expanded) {
            await ctx.reply(markdownToTelegramHtml(expanded), { parse_mode: 'HTML' }).catch(() =>
              ctx.reply(expanded),
            );
            return;
          }
        }
      }

      if (this.agentOSManager) {
        const statusReply = buildObjectiveStatusReply(this.agentOSManager, text);
        if (statusReply) {
          await ctx.reply(statusReply, { parse_mode: 'HTML' });
          return;
        }
      }

      // Agent-direct objective message shortcuts:
      //   @agentName: do X
      //   agent agentName do X
      if (this.agentOSManager) {
        const directTarget =
          text.match(/^(?:@)?([A-Za-z0-9_-]+)\s*:\s+(.+)$/)
          ?? text.match(/^agent\s+([A-Za-z0-9_-]+)\s+(.+)$/i);

        if (directTarget) {
          const requestedAgent = directTarget[1]?.trim();
          const objectiveText = directTarget[2]?.trim();
          if (requestedAgent && objectiveText) {
            const agent = this.agentOSManager.getAgentByNameOrId(requestedAgent);
            if (agent) {
              const activeProject = this.projectManager?.getActiveProject();
              const title = objectiveText.length > 80 ? `${objectiveText.slice(0, 77)}...` : objectiveText;

              const objective = this.agentOSManager.createObjective({
                projectId: activeProject?.id ?? null,
                ownerAgentId: agent.id,
                requestedBy: 'telegram-user',
                title,
                description: objectiveText,
                priority: 6,
              });

              await ctx.reply(
                `ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â½ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¯ Routed to <b>${escapeHtml(agent.name)}</b>\nObjective: <code>${objective.id}</code>\n${escapeHtml(objectiveText)}`,
                { parse_mode: 'HTML' },
              );
              return;
            }
          }
        }
      }

      // Detect actionable intent: imperative verb = task, not conversation
      const isActionable = this.taskLedger && detectActionableIntent(text);

      if (isActionable && this.taskLedger) {
        if (this.agentOSManager && isLongHorizonMission(text)) {
          const activeProject = this.projectManager?.getActiveProject();
          const title = text.length > 80 ? `${text.slice(0, 77)}...` : text;
          const objective = this.agentOSManager.createObjective({
            projectId: activeProject?.id ?? null,
            ownerAgentId: null,
            requestedBy: 'telegram-user',
            title,
            description: text,
            priority: 7,
          });

          await ctx.reply(
            `<b>Objective queued</b>\nID: <code>${objective.id}</code>\n` +
            `Mode: autonomous multi-step mission\n` +
            `Use /objective_tasks ${objective.id} to inspect progress.`,
            { parse_mode: 'HTML' },
          );
          return;
        }
        // Route through pipeline: create task ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ plan ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ execute ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ verify ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ report
        const task = this.taskLedger.create({ title: text, type: 'general', priority: 5 });
        await ctx.reply(`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¹ Task created. Working on it...`);

        const typingInterval = setInterval(() => {
          ctx.replyWithChatAction('typing').catch(() => {});
        }, 4000);

        try {
          const phaseEmoji: Record<string, string> = {
            planning: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ', executing: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡', verifying: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â', complete: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦', failed: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢',
          };
          let lastMsg = '';

          const onHeartbeat = async (hb: ProgressHeartbeat) => {
            const emoji = phaseEmoji[hb.phase] ?? 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢';
            const stepInfo = hb.stepIndex && hb.totalSteps ? ` [${hb.stepIndex}/${hb.totalSteps}]` : '';
            const blockerInfo = hb.blockers?.length ? `\nÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ ${hb.blockers.join(', ')}` : '';
            const msg = `${emoji}${stepInfo} ${hb.action}${blockerInfo}`;
            if (msg === lastMsg) return;
            lastMsg = msg;
            try { await ctx.reply(msg); } catch { /* ignore */ }
          };

          const result = await this.conversationHandler.executeTask(task.id, onHeartbeat);
          clearInterval(typingInterval);

          if (!result) {
            await ctx.reply(`Pipeline could not generate a plan. Try a more specific request, or use /run <description>.`);
            return;
          }

          const { verification, plan } = result;
          const stepSummary = plan.steps.map(s => {
            const emoji = s.status === 'done' ? 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦' : s.status === 'failed' ? 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢' : 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â';
            return `${emoji} ${escapeHtml(s.name)}`;
          }).join('\n');

          const artifactSummary = formatTaskArtifactSummary(result.task);
          const credentialPrompt = buildCredentialPrompt(result.task);

          if (verification.verified) {
            await ctx.reply(
              `<b>Done</b>\n\n${stepSummary}${artifactSummary}\n\nEvidence: ${escapeHtml(verification.evidence)}`,
              { parse_mode: 'HTML' },
            );
          } else if (result.task.status === 'blocked' && credentialPrompt) {
            await ctx.reply(
              `<b>Blocked Waiting For Credentials</b>\n\n${stepSummary}${artifactSummary}\n\n${credentialPrompt}`,
              { parse_mode: 'HTML' },
            );
          } else {
            await ctx.reply(
              `<b>Partial Result</b>\n\n${stepSummary}${artifactSummary}\n\nReason: ${escapeHtml(verification.failedCriteria ?? 'Some steps failed')}`,
              { parse_mode: 'HTML' },
            );
          }
        } catch (error) {
          clearInterval(typingInterval);
          this.logger.error({ taskId: task.id, error }, 'Pipeline error from natural language');
          await ctx.reply(`Error running task: ${escapeHtml(error instanceof Error ? error.message : String(error))}`);
        }
        return;
      }

      // Not actionable ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ normal conversation flow
      try {
        await ctx.replyWithChatAction('typing');
        const typingInterval = setInterval(() => {
          ctx.replyWithChatAction('typing').catch(() => {});
        }, 4000);

        try {
          const response = await this.conversationHandler.handleMessage(text);
          clearInterval(typingInterval);
          await ctx.reply(markdownToTelegramHtml(response.text), { parse_mode: 'HTML' }).catch(() =>
            ctx.reply(response.text),
          );

          if (response.detectedCommitments?.length && this.commitmentStore && this.commitmentScheduler) {
            for (const detected of response.detectedCommitments) {
              const commitment = this.commitmentStore.create(detected);
              this.commitmentScheduler.scheduleCommitment(commitment);
              await this.notifyCommitmentCreated(commitment);
            }
          }
        } catch (error) {
          clearInterval(typingInterval);
          throw error;
        }
      } catch (error) {
        this.logger.error({ error }, 'Conversation handler error');
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (errorMsg.includes('tokens_limit') || errorMsg.includes('too large')) {
          await ctx.reply('The data fetched was too large to process. Try a more specific request.');
        } else if (errorMsg.includes('content_filter')) {
          await ctx.reply('Content filter triggered. Please rephrase your request.');
        } else {
          await ctx.reply(`Error: ${escapeHtml(errorMsg.slice(0, 200))}\n\nTry /status to check daemon health.`);
        }
      }
    });

    // Start polling (long polling ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â no webhooks needed for Pi)
    this.bot.start({
      onStart: () => {
        this.logger.info('Telegram bot started (long polling)');
      },
    });
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
      this.bot = null;
      this.logger.info('Telegram bot stopped');
    }
  }

  // ---------------------------------------------------------------------------
  // Outbound Notifications
  // ---------------------------------------------------------------------------

  /** Send a notification about task completion. */
  async notifyTaskComplete(taskId: string, description: string, commitSha: string, confidence: string): Promise<void> {
    const emoji = confidence === 'HIGH' ? 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦' : confidence === 'MEDIUM' ? 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â' : 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢';
    const message = [
      `${emoji} <b>Task ${taskId} Complete</b>`,
      `<i>${description}</i>`,
      ``,
      `Confidence: ${confidence}`,
      `Commit: <code>${commitSha.slice(0, 7)}</code>`,
    ].join('\n');
    await this.sendMessage(message);
  }

  /** Send a notification about an error. */
  async notifyError(taskId: string, error: string): Promise<void> {
    const message = [
      `ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â´ <b>Task ${taskId} Failed</b>`,
      `<code>${escapeHtml(error.slice(0, 500))}</code>`,
    ].join('\n');
    await this.sendMessage(message);
  }

  /** Send a budget warning. */
  async notifyBudgetWarning(spent: string, remaining: string, currency: string): Promise<void> {
    await this.sendMessage(
      `ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â° <b>Budget Warning</b>\nSpent: ${spent} ${currency}\nRemaining: ${remaining} ${currency}`,
    );
  }

  /** Send the morning report. */
  async sendMorningReport(report: MorningReport): Promise<void> {
    const message = formatMorningReport(report);
    await this.sendMessage(message);
  }

  /** Send an optimization analysis report. */
  async sendOptimizationReport(report: OptimizationReport): Promise<void> {
    await this.sendMessage(formatOptimizationReport(report));
  }

  /** Notify about a commitment result (success or failure). */
  async notifyCommitmentResult(commitment: Commitment, result: CommitmentResult): Promise<void> {
    if (result.success) {
      const lines = [
        `ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ <b>Commitment Fulfilled</b>`,
        `<i>${escapeHtml(commitment.actionDescription)}</i>`,
        '',
        result.output ? escapeHtml(result.output.slice(0, 500)) : 'Done!',
      ];
      if (commitment.type === 'recurring') {
        lines.push('', `ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â Recurring ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â next run scheduled`);
      }
      await this.sendMessage(lines.join('\n'));
    } else {
      const lines = [
        `ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â <b>Commitment Failed</b>`,
        `<i>${escapeHtml(commitment.actionDescription)}</i>`,
        '',
        `Error: <code>${escapeHtml(result.error?.slice(0, 300) ?? 'Unknown error')}</code>`,
        '',
        `Use /commitments to see status or /cancel to remove it.`,
      ];
      await this.sendMessage(lines.join('\n'));
    }
  }

  /** Notify that a new commitment was detected and scheduled. */
  async notifyCommitmentCreated(commitment: Commitment): Promise<void> {
    const typeLabel = commitment.type === 'recurring'
      ? `ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â Recurring (${commitment.schedule})`
      : `ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â° One-time`;
    await this.sendMessage(
      `ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ <b>Commitment Tracked</b>\n${typeLabel}\n<i>${escapeHtml(commitment.actionDescription)}</i>\n\nUse /commitments to see all, /cancel to remove.`,
    );
  }

  /** Send a message to the configured Telegram chat. */
  async sendMessage(text: string): Promise<void> {
    if (!this.bot) {
      this.logger.warn('Bot not started ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â cannot send message');
      return;
    }
    try {
      await this.bot.api.sendMessage(this.config.chatId, text, { parse_mode: 'HTML' });
    } catch (error) {
      this.logger.error({ error }, 'Failed to send Telegram message');
    }
  }
}

// ---------------------------------------------------------------------------
// Message Formatting
// ---------------------------------------------------------------------------

export interface MorningReport {
  sessionDuration: string;
  tasksCompleted: number;
  tasksFailed: number;
  totalSpent: string;
  currency: string;
  completedTasks: Array<{ id: string; description: string; confidence: string }>;
  failedTasks: Array<{ id: string; description: string; error: string }>;
}

function formatStatusMessage(status: DaemonStatus): string {
  const stateEmoji = status.state === 'running' ? 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢' : status.state === 'paused' ? 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡' : 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â´';
  return [
    `${stateEmoji} <b>Mother Brain Daemon</b>`,
    ``,
    `State: ${status.state}`,
    status.currentTask ? `Current Task: ${status.currentTask}` : 'Current Task: idle',
    `Tasks Completed: ${status.tasksCompleted}`,
    `Budget Remaining: ${status.budgetRemaining}`,
    `Active Hours: ${status.activeHours}`,
    `Uptime: ${status.uptime}`,
  ].join('\n');
}

function formatMorningReport(report: MorningReport): string {
  const lines = [
    `ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¹Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â <b>Morning Report</b>`,
    ``,
    `ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â± Duration: ${report.sessionDuration}`,
    `ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ Completed: ${report.tasksCompleted}`,
    `ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ Failed: ${report.tasksFailed}`,
    `ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â° Spent: ${report.totalSpent} ${report.currency}`,
  ];

  if (report.completedTasks.length > 0) {
    lines.push('', '<b>Completed:</b>');
    for (const task of report.completedTasks) {
      const emoji = task.confidence === 'HIGH' ? 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦' : 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â';
      lines.push(`  ${emoji} Task ${task.id}: ${task.description}`);
    }
  }

  if (report.failedTasks.length > 0) {
    lines.push('', '<b>Failed:</b>');
    for (const task of report.failedTasks) {
      lines.push(`  ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ Task ${task.id}: ${task.description}`);
      lines.push(`     <code>${escapeHtml(task.error.slice(0, 100))}</code>`);
    }
  }

  return lines.join('\n');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatTaskArtifactSummary(task: Task): string {
  if (task.artifacts.length === 0) return '';

  const files = new Set<string>();
  const links = new Set<string>();
  const notes = new Set<string>();

  for (const artifact of task.artifacts) {
    if (artifact.type === 'file' && artifact.value.trim().length > 0) {
      files.add(artifact.value.trim());
      continue;
    }

    if (artifact.type === 'link' && /^https?:\/\//i.test(artifact.value)) {
      links.add(artifact.value);
      continue;
    }

    if (artifact.type === 'text' && artifact.label.startsWith('publish_') && artifact.value.trim().length > 0) {
      notes.add(artifact.value.trim());
      continue;
    }

    if (artifact.type !== 'json') continue;
    try {
      const parsed = JSON.parse(artifact.value) as Record<string, unknown>;
      const path = parsed['path'];
      if (typeof path === 'string' && path.trim().length > 0) {
        files.add(path.trim());
      }
      const url = parsed['url'];
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
        links.add(url);
      }
      const publishBlocked = parsed['publish_blocked'];
      if (typeof publishBlocked === 'string' && publishBlocked.trim().length > 0) {
        notes.add(publishBlocked.trim());
      }
    } catch {
      // Ignore non-JSON artifact payloads.
    }
  }

  const fileList = Array.from(files).slice(0, 4);
  const linkList = Array.from(links).slice(0, 3);
  const noteList = Array.from(notes).slice(0, 2);
  if (fileList.length === 0 && linkList.length === 0 && noteList.length === 0) return '';

  const lines: string[] = [];
  if (fileList.length > 0) {
    lines.push('<b>Output Files</b>');
    for (const filePath of fileList) {
      lines.push(`- <code>${escapeHtml(filePath)}</code>`);
    }
    if (files.size > fileList.length) {
      lines.push(`- ...and ${files.size - fileList.length} more`);
    }
  }

  if (linkList.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('<b>Output Links</b>');
    for (const link of linkList) {
      lines.push(`- <code>${escapeHtml(link)}</code>`);
    }
    if (links.size > linkList.length) {
      lines.push(`- ...and ${links.size - linkList.length} more`);
    }
  }

  if (noteList.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('<b>Output Notes</b>');
    for (const note of noteList) {
      lines.push(`- ${escapeHtml(note.slice(0, 300))}`);
    }
    if (notes.size > noteList.length) {
      lines.push(`- ...and ${notes.size - noteList.length} more`);
    }
  }

  return `\n\n${lines.join('\n')}`;
}

/**
 * Convert LLM Markdown output to Telegram-compatible HTML.
 * Handles: headings ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ bold, **bold**, *italic*, `code`, ```blocks```, ---
 */
function markdownToTelegramHtml(md: string): string {
  // First escape HTML entities in the raw text
  let html = escapeHtml(md);

  // Code blocks (``` ... ```) ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ <pre>
  html = html.replace(/```(?:\w*)\n?([\s\S]*?)```/g, '<pre>$1</pre>');

  // Inline code (`text`) ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ <code>
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Headings (##+ text) ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ bold line
  html = html.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // Bold (**text**) ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ <b>
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

  // Italic (*text*) ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â but not bullet points (* item)
  html = html.replace(/(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, '<i>$1</i>');

  // Horizontal rules (--- or ***) ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ empty line
  html = html.replace(/^[-*]{3,}$/gm, '');

  return html.trim();
}

function formatProjectsList(projects: Project[]): string {
  const lines = [`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ <b>Projects</b> (${projects.length})\n`];
  for (const p of projects) {
    const active = p.active ? ' ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â½ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¯' : '';
    const tasks = p.tasksCompleted > 0 ? ` (${p.tasksCompleted} tasks done)` : '';
    lines.push(`${active} <b>${escapeHtml(p.name)}</b>${tasks}`);
    lines.push(`  <code>${escapeHtml(p.repoPath)}</code>`);
  }
  lines.push('', 'Use /work &lt;name&gt; to switch projects');
  return lines.join('\n');
}

function formatAgentsList(agents: Agent[]): string {
  const statusEmoji: Record<Agent['status'], string> = {
    provisioning: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂºÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â',
    idle: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦',
    running: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾',
    paused: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â',
    offline: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â«',
    error: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢',
  };

  const lines = [`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¤ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œ <b>Agents</b> (${agents.length})`, ''];
  for (const agent of agents) {
    const emoji = statusEmoji[agent.status] ?? 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¤ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œ';
    lines.push(`${emoji} <b>${escapeHtml(agent.name)}</b>`);
    lines.push(`  ID: <code>${agent.id}</code>`);
    lines.push(`  Mode: ${agent.autonomyMode}`);
    lines.push(`  Status: ${agent.status}`);
  }
  return lines.join('\n');
}

function formatObjectivesList(objectives: ObjectiveSummary[]): string {
  const statusEmoji: Record<ObjectiveSummary['status'], string> = {
    draft: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â',
    queued: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³',
    planning: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ',
    running: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾',
    waiting_approval: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¹',
    blocked: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â«',
    completed: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦',
    failed: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢',
    canceled: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂºÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¹Ã…â€œ',
  };

  const lines = [`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â½ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¯ <b>Objectives</b> (${objectives.length})`, ''];
  for (const objective of objectives) {
    const emoji = statusEmoji[objective.status] ?? 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â½ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¯';
    lines.push(`${emoji} <b>${escapeHtml(objective.title)}</b>`);
    lines.push(`  ID: <code>${objective.id}</code>`);
    lines.push(`  Status: ${objective.status}`);
    lines.push(`  Progress: ${objective.taskDone}/${objective.taskTotal} done | ${objective.taskQueued} queued | ${objective.taskFailed} failed`);
  }
  return lines.join('\n');
}

function formatDelegationsList(delegations: Delegation[]): string {
  const statusEmoji: Record<Delegation['status'], string> = {
    requested: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¨',
    accepted: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦',
    running: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾',
    answered: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬',
    rejected: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢',
    expired: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Âº',
  };

  const lines = [`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¤ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â <b>Delegations</b> (${delegations.length})`, ''];
  for (const delegation of delegations) {
    lines.push(`${statusEmoji[delegation.status] ?? 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¤ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â'} <code>${delegation.id}</code> ${delegation.status}`);
    lines.push(`  Parent Task: <code>${delegation.taskId}</code>`);
    lines.push(`  Delegated Task: <code>${escapeHtml(delegation.delegatedTaskId ?? '(none)')}</code>`);
    lines.push(`  From: <code>${escapeHtml(delegation.fromAgentId)}</code> ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ To: <code>${escapeHtml(delegation.toAgentId)}</code>`);
    lines.push(`  Q: ${escapeHtml(delegation.question)}`);
  }
  return lines.join('\n');
}

function formatApprovalsList(approvals: Approval[]): string {
  const statusEmoji: Record<Approval['status'], string> = {
    pending: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¹',
    approved: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦',
    rejected: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â«',
    expired: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Âº',
  };

  const lines = [`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¹ <b>Approvals</b> (${approvals.length})`, ''];
  for (const approval of approvals) {
    lines.push(`${statusEmoji[approval.status] ?? 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¹'} <code>${approval.id}</code> ${approval.approvalType}`);
    lines.push(`  Objective: <code>${approval.objectiveId}</code>`);
    lines.push(`  Task: <code>${approval.taskId}</code>`);
    lines.push(`  Reason: ${escapeHtml(approval.reason)}`);
  }
  lines.push('', 'Use /approve <id> or /reject <id> [reason]');
  return lines.join('\n');
}

function formatUsageReport(report: UsageReport): string {
  const lines = [
    `ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â  <b>Token Usage Report</b>`,
    ``,
    `<b>All-Time:</b>`,
    `  Tokens: ${report.allTime.totalTokens.toLocaleString()}`,
    `  Cost: $${report.allTime.totalCost.toFixed(4)}`,
    `  Requests: ${report.allTime.requestCount}`,
  ];

  // Global budget
  if (report.globalBudget.cap !== Infinity) {
    const bar = makeProgressBar(report.globalBudget.percentUsed);
    lines.push(
      ``,
      `<b>Global Budget:</b>`,
      `  ${bar} ${report.globalBudget.percentUsed.toFixed(1)}%`,
      `  $${report.globalBudget.spent.toFixed(4)} / $${report.globalBudget.cap.toFixed(2)}`,
    );
  }

  // By tier
  const tiers = Object.entries(report.byTier);
  if (tiers.length > 0) {
    lines.push('', '<b>By Tier:</b>');
    const tierEmoji: Record<string, string> = {
      background: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§', chat: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬', planning: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¹', coding: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â', review: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â',
    };
    for (const [tier, data] of tiers) {
      const emoji = tierEmoji[tier] ?? 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢';
      lines.push(`  ${emoji} ${tier}: ${data.tokens.toLocaleString()} tokens ($${data.cost.toFixed(4)}) [${data.requests} req]`);
    }
  }

  // By model
  const models = Object.entries(report.byModel);
  if (models.length > 0) {
    lines.push('', '<b>By Model:</b>');
    for (const [model, data] of models) {
      lines.push(`  ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ ${model}: $${data.cost.toFixed(4)} [${data.requests} req]`);
    }
  }

  // By project
  const projects = Object.entries(report.byProject);
  if (projects.length > 0) {
    lines.push('', '<b>By Project:</b>');
    for (const [project, data] of projects) {
      lines.push(`  ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ ${project}: $${data.cost.toFixed(4)} (${data.tokens.toLocaleString()} tokens)`);
    }
  }

  return lines.join('\n');
}

function formatOptimizationReport(report: OptimizationReport): string {
  const lines = [
    `ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â <b>Usage Optimization Report</b>`,
    `<i>Last ${report.periodDays} days ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ${report.totalRequests} requests, $${report.totalCost.toFixed(4)} spent</i>`,
    ``,
  ];

  if (report.insights.length === 0) {
    lines.push('ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ No optimization opportunities found ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â usage looks efficient.');
  } else {
    const severityEmoji: Record<string, string> = {
      critical: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â´', warning: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡', info: 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Âµ',
    };

    for (const insight of report.insights) {
      const emoji = severityEmoji[insight.severity] ?? 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢';
      lines.push(`${emoji} <b>${escapeHtml(insight.title)}</b>`);
      lines.push(`   ${escapeHtml(insight.detail)}`);
      lines.push(`   ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ ${escapeHtml(insight.suggestion)}`);
      lines.push('');
    }
  }

  lines.push(`<i>${escapeHtml(report.summary)}</i>`);
  return lines.join('\n');
}

function makeProgressBar(percent: number): string {
  const filled = Math.round(percent / 10);
  const empty = 10 - filled;
  return 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“'.repeat(filled) + 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¹Ã…â€œ'.repeat(empty);
}

function formatCommitmentsList(commitments: Commitment[]): string {
  const lines = [`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¹ <b>Active Commitments</b> (${commitments.length})\n`];
  for (const c of commitments) {
    const typeEmoji = c.type === 'recurring' ? 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â' : 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°';
    const statusEmoji = c.status === 'executing' ? 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³' : c.status === 'failed' ? 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢' : 'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦';
    lines.push(`${typeEmoji}${statusEmoji} <b>${escapeHtml(c.actionDescription)}</b>`);
    if (c.type === 'recurring' && c.schedule) {
      lines.push(`  Schedule: <code>${c.schedule}</code>`);
    }
    if (c.executionCount > 0) {
      lines.push(`  Executed: ${c.executionCount} time${c.executionCount > 1 ? 's' : ''}`);
    }
    if (c.failureReason) {
      lines.push(`  ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â Last error: ${escapeHtml(c.failureReason.slice(0, 100))}`);
    }
    lines.push('');
  }
  lines.push('Use /cancel &lt;description&gt; to remove a commitment.');
  return lines.join('\n');
}


