import type { Logger } from 'pino';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { Lifecycle } from './lifecycle.js';
import { loadConfig, defaultConfigPath } from './config.js';
import type { ApiConfig } from './config.js';
import { ensureDataDir } from './logger.js';
import { SecretStore } from './secret-store.js';
import { DatabaseManager } from '../db/database.js';
import { ProjectManager } from '../db/projects.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { TelegramReporter } from '../reporter/telegram.js';
import { WorkspaceManager } from '../workspace/workspace.js';
import { parseRoadmap } from '../workspace/roadmap-parser.js';
import { pickNextTask } from '../workspace/task-picker.js';
import { buildTaskContext } from '../workspace/context-builder.js';
import { createLLMClient } from '../llm/router.js';
import type { LLMExecutor } from '../llm/router.js';
import { applyFileChanges } from '../workspace/file-writer.js';
import { verify } from '../verifier/verifier.js';
import { BudgetTracker } from '../budget/tracker.js';
import { UsageOptimizer } from '../budget/optimizer.js';
import { loadPersona } from '../conversation/persona.js';
import { ConversationMemory } from '../conversation/memory.js';
import { ConversationHandler } from '../conversation/handler.js';
import { ToolRegistry } from '../tools/index.js';
import { registerBuiltinTools } from '../tools/builtin/index.js';
import { TaskLedger, BlockerMemory } from '../tasks/index.js';
import { CommitmentStore } from '../commitment/store.js';
import { CommitmentScheduler } from '../commitment/scheduler.js';
import { AgentOSManager } from '../agent-os/manager.js';
import { AgentOSApiServer } from '../api/server.js';
import { AutoPublisher } from '../deploy/auto-publisher.js';
import { generateNewsRoundup } from '../reporter/news-roundup.js';
import { getRuntimeVersionInfo, formatVersionLabel } from './version.js';
import type { DaemonModule, DaemonState } from './lifecycle.js';
import type { DaemonConfig } from './config.js';

export type { DaemonModule, DaemonState, DaemonConfig };

/**
 * Main Daemon class — orchestrates all daemon modules.
 *
 * Lifecycle: start() → running → stop()
 * Modules are registered in dependency order and started/stopped
 * in that order via the Lifecycle coordinator.
 */
export class Daemon {
  private lifecycle: Lifecycle;
  private paused = false;
  private sessionId = randomUUID();
  private tasksCompleted = 0;
  private startTime = Date.now();
  private releaseInstanceLock: (() => void) | null = null;
  config: DaemonConfig | null = null;

  constructor(
    readonly logger: Logger,
    private configPath?: string,
  ) {
    this.lifecycle = new Lifecycle(this.logger);
  }

  get state(): DaemonState {
    return this.lifecycle.state;
  }

  /** Register a module into the daemon lifecycle. */
  register(module: DaemonModule): void {
    this.lifecycle.register(module);
  }

  async start(): Promise<void> {
    this.logger.info('Mother Brain Daemon starting...');

    // Ensure data directory exists
    const dataDir = ensureDataDir();
    this.releaseInstanceLock = acquireInstanceLock(dataDir, this.logger);

    // Load config
    const cfgPath = this.configPath ?? defaultConfigPath();
    try {
      this.config = loadConfig(cfgPath, this.logger);
    } catch (error) {
      this.logger.warn({ error }, 'No config loaded — running in skeleton mode');
      await this.lifecycle.startAll();
      this.logger.info('Mother Brain Daemon started (skeleton mode)');
      return;
    }

    // Auto-refresh OpenAI OAuth token if present and near expiry
    if (this.config.llm.openaiOAuth) {
      const oauth = this.config.llm.openaiOAuth;
      const fiveMinutes = 5 * 60 * 1000;
      if (oauth.expires - Date.now() < fiveMinutes) {
        this.logger.info('OpenAI OAuth token expired or near expiry, refreshing...');
        try {
          const { refreshOpenAIToken } = await import('../llm/openai-oauth.js');
          const refreshed = await refreshOpenAIToken(oauth.refreshToken);
          if (refreshed) {
            this.config.llm.openaiOAuth = {
              apiKey: refreshed.apiKey,
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken,
              idToken: refreshed.idToken,
              expires: refreshed.expires,
              accountId: refreshed.accountId,
            };
            // Persist refreshed token to config file
            try {
              const { readFileSync, writeFileSync } = await import('node:fs');
              const raw = JSON.parse(readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>;
              const llm = (raw['llm'] ?? {}) as Record<string, unknown>;
              llm['openaiOAuth'] = this.config.llm.openaiOAuth;
              raw['llm'] = llm;
              writeFileSync(cfgPath, JSON.stringify(raw, null, 2), 'utf-8');
              this.logger.info('OpenAI OAuth token refreshed and saved');
            } catch (writeErr) {
              this.logger.warn({ err: writeErr }, 'Failed to persist refreshed OAuth token');
            }
          } else {
            this.logger.warn('OpenAI OAuth token refresh failed — token may be expired');
          }
        } catch (err) {
          this.logger.warn({ err }, 'OpenAI OAuth token refresh error');
        }
      } else {
        const minutesLeft = Math.round((oauth.expires - Date.now()) / 60000);
        this.logger.info({ minutesLeft }, 'OpenAI OAuth token valid');
      }
    }

    // Register and start database FIRST (other modules depend on it)
    const db = new DatabaseManager(join(dataDir, 'daemon.db'), this.logger);
    this.register(db);
    await db.start(); // Start immediately so connection is available

    // Project manager — handles multiple projects
    const projectManager = new ProjectManager(db.connection, this.logger);
    const secretStore = new SecretStore(db.connection, this.logger);

    // If config has a legacy workspace, auto-register it as a project
    if (this.config.workspace) {
      const existing = projectManager.listProjects();
      const alreadyAdded = existing.some(p => p.repoPath === this.config!.workspace!.repoPath);
      if (!alreadyAdded) {
        const project = projectManager.addProject(
          this.config.workspace.repoPath,
          this.config.workspace.branch,
        );
        if (project) {
          projectManager.setActiveProject(project.id);
        }
      }
    }

    // Scheduler
    const scheduler = new Scheduler(
      this.config.activeHours,
      this.config.timezone,
      this.config.heartbeatMinutes ?? 15,
      this.logger,
    );
    this.register(scheduler);

    // Telegram reporter (optional — start even if bot fails)
    let reporter: TelegramReporter | null = null;
    if (this.config.telegram.botToken) {
      reporter = new TelegramReporter(this.config.telegram, this.logger);
      reporter.setStartedAt(new Date(this.startTime).toISOString());
      this.register(reporter);
    }

    // Start remaining modules (scheduler, telegram — DB already started)
    await this.lifecycle.startAll();

    // Create session record
    db.connection.prepare(
      `INSERT INTO sessions (id, started_at, status) VALUES (?, datetime('now'), 'active')`,
    ).run(this.sessionId);

    // Set up budget tracker with session + global caps
    const budgetTracker = new BudgetTracker(
      db.connection,
      this.config.budget.perNight,
      this.config.budget.currency,
      this.logger,
      this.config.budget.globalCap,
    );

    // LLM clients — three-tier model routing
    const codingClient = createLLMClient(this.config, this.logger, 'coding');

    // Usage optimizer — analyzes spending patterns
    const usageOptimizer = new UsageOptimizer(db.connection, this.logger);

    // Wire up Telegram status provider
    reporter?.onStatus(() => ({
      state: this.paused ? 'paused' : 'running',
      currentTask: null,
      tasksCompleted: this.tasksCompleted,
      budgetRemaining: `${budgetTracker.getStatus(this.sessionId).remaining.toFixed(2)} ${this.config!.budget.currency}`,
      activeHours: `${this.config!.activeHours.start}:00 - ${this.config!.activeHours.end}:00`,
      uptime: formatUptime(Date.now() - this.startTime),
    }));

    // Wire up project management via Telegram
    reporter?.onProjects(projectManager);

    // Wire up usage tracking via Telegram
    reporter?.onBudget(budgetTracker);

    // Wire up usage optimizer via Telegram
    reporter?.onOptimizer(usageOptimizer);

    // Wire up conversational onboarding
    const persona = loadPersona(this.logger);
    const conversationMemory = new ConversationMemory(db.connection, this.logger);
    const conversationHandler = new ConversationHandler(
      this.config, persona, conversationMemory, projectManager, this.logger,
      budgetTracker, this.sessionId,
    );
    const autoPublisher = new AutoPublisher(this.logger);
    conversationHandler.setAutoPublish((input) => autoPublisher.publishIfNeeded(input));
    reporter?.onConversation(conversationHandler);
    reporter?.onSecrets(secretStore);

    // Tool registry — typed tool layer for function-calling
    const toolRegistry = new ToolRegistry(this.logger);
    registerBuiltinTools(toolRegistry, this.logger, {
      resolveSecret: (key: string) => secretStore.resolveValue(key),
      requestSecret: (key: string, context?: string) => {
        secretStore.request(key, context);
        reporter?.sendMessage(
          `<b>Credential Required</b>\n` +
          `Key: <code>${escapeHtml(key)}</code>\n` +
          `${context ? `Context: ${escapeHtml(context)}\n` : ''}` +
          `Set it: <code>/setsecret ${escapeHtml(key)} your-value</code>\n` +
          `Check all pending: <code>/secret_requests</code>`,
        ).catch((error) => {
          this.logger.warn({ error, key }, 'Failed to send credential request prompt');
        });
      },
    });
    conversationHandler.setToolRegistry(toolRegistry);
    reporter?.onTools(toolRegistry);

    // Task ledger — durable task management with checkpoint/resume
    const taskLedger = new TaskLedger(db.connection, this.logger);
    reporter?.onTaskLedger(taskLedger);
    conversationHandler.setTaskLedger(taskLedger);

    // Agent OS manager — persistent agents/objectives on top of task ledger
    const agentOS = new AgentOSManager(db.connection, this.logger, taskLedger);
    agentOS.ensureBootstrapAgent();
    reporter?.onAgentOS(agentOS);

    // Agent OS API server (optional via config or env)
    const apiConfig = resolveApiConfig(this.config);
    if (apiConfig?.enabled) {
      const apiServer = new AgentOSApiServer(apiConfig, this.logger, agentOS);
      await apiServer.start();
      this.register(apiServer);
      await reporter?.sendMessage(
        `🌐 <b>Agent OS API Online</b>\n` +
        `Host: <code>${escapeHtml(apiConfig.host)}</code>\n` +
        `Port: <code>${apiConfig.port}</code>\n` +
        `Auth: ${apiConfig.bearerToken ? 'Bearer token required' : 'No bearer token configured'}`,
      );
    }

    // Blocker memory — self-learning from resolved blockers
    const blockerMemory = new BlockerMemory(db.connection, this.logger);
    conversationHandler.setBlockerMemory(blockerMemory);
    reporter?.onBlockerMemory?.(blockerMemory);

    // Restart recovery — handle tasks that were running when daemon last stopped
    const interrupted = taskLedger.findInterrupted();
    if (interrupted.length > 0) {
      this.logger.warn({ count: interrupted.length }, 'Found interrupted tasks from previous run');
      for (const task of interrupted) {
        taskLedger.fail(task.id, 'Daemon restarted while task was running');
        this.logger.info({ taskId: task.id, title: task.title }, 'Interrupted task marked as failed');
      }
    }

    // Commitment engine — tracks and executes promises from conversation
    const commitmentStore = new CommitmentStore(db.connection, this.logger);
    const commitmentScheduler = new CommitmentScheduler(
      commitmentStore, this.logger, this.config.timezone,
    );
    // Start commitment scheduler directly (lifecycle.startAll() already ran)
    await commitmentScheduler.start();
    this.register(commitmentScheduler);

    // Commitment executor — run actionable commitments through the same pipeline
    commitmentScheduler.onExecute(async (commitment) => {
      const action = commitment.actionDescription.trim();
      if (!action) {
        return '⏰ Reminder: (empty action)';
      }

      // Deterministic path for news roundup asks: fetch headlines directly.
      const isNewsAsk = /\b(news|headlines|round\s*up|roundup|update|updates|latest)\b/i.test(action);
      if (isNewsAsk) {
        try {
          const roundup = await generateNewsRoundup(toolRegistry, action, 10);
          if (roundup) return roundup;
          return '📰 I checked, but couldn\'t extract fresh headlines from the feed right now.';
        } catch (error) {
          this.logger.warn({ error, action }, 'Deterministic news path failed; falling back to pipeline');
        }
      }

      const actionLooksExecutable = /^(fetch|get|find|search|check|look up|compile|summari[sz]e|download|scrape|collect|gather|list|show me|tell me|give me|make me|pull|grab|run|execute|build|deploy|install|create|write|generate|update|monitor|scan|analy[sz]e|compare|calculate|count|test|verify|read)\b/i
        .test(action);

      if (!actionLooksExecutable) {
        return `⏰ Reminder: ${action}`;
      }

      const task = taskLedger.create({
        title: action,
        type: 'commitment',
        priority: 6,
        deadline: commitment.executeAt ?? undefined,
      });

      const result = await conversationHandler.executeTask(task.id);
      if (!result) {
        throw new Error('Scheduled task pipeline failed to generate a plan');
      }

      const { verification, plan } = result;
      if (!verification.verified) {
        throw new Error(verification.failedCriteria ?? 'Scheduled task verification failed');
      }

      const doneSteps = plan.steps.filter(s => s.status === 'done').length;

      // Try to extract human-friendly headlines from web_fetch RSS output.
      const headlines = plan.steps
        .flatMap((s) => {
          const data = (s.output as { data?: { type?: string; items?: Array<{ title?: string; link?: string }> } } | undefined)?.data;
          if (!data || data.type !== 'rss' || !Array.isArray(data.items)) return [];
          return data.items
            .slice(0, 5)
            .map((item, idx) => {
              const title = item.title?.trim();
              const link = item.link?.trim();
              if (!title) return null;
              return `${idx + 1}. ${title}${link ? `\n${link}` : ''}`;
            })
            .filter((v): v is string => v !== null);
        });

      if (headlines.length > 0) {
        return `📰 Latest news roundup\n\n${headlines.join('\n\n')}`;
      }

      return `✅ Scheduled task complete (${doneSteps}/${plan.steps.length} steps). ${verification.evidence}`;
    });

    // Commitment notifier — sends results via Telegram
    commitmentScheduler.onNotify(async (commitment, result) => {
      await reporter?.notifyCommitmentResult(commitment, result);
    });

    // Wire commitment store + scheduler to Telegram for commands and conversation detection
    reporter?.onConversationCommitments(commitmentStore, commitmentScheduler);

    // Send greeting if new user
    if (conversationMemory.isNewUser() && reporter) {
      const greeting = conversationHandler.getGreeting();
      reporter.sendMessage(greeting).catch((err) => {
        this.logger.warn({ error: err }, 'Failed to send greeting');
      });
    }

    // Run startup usage optimization analysis (daily retrospective) — only send if significant
    if (reporter) {
      const optReport = usageOptimizer.analyze(7);
      if (optReport.totalRequests > 10 && optReport.insights.some(i => i.severity === 'high')) {
        reporter.sendOptimizationReport(optReport).catch((err) => {
          this.logger.warn({ error: err }, 'Failed to send optimization report');
        });
        this.logger.info(
          { insights: optReport.insights.length },
          'Startup optimization analysis sent',
        );
      }
    }

    // Wire up Telegram control commands
    reporter?.onControl((action) => {
      if (action === 'pause') this.paused = true;
      if (action === 'resume') this.paused = false;
      if (action === 'stop') void this.stop();
    });

    // Wire up the execution loop to the scheduler
    scheduler.onTask(async () => {
      const objectiveExecuted = await this.executeNextObjectiveTask(
        agentOS,
        conversationHandler,
        budgetTracker,
        reporter,
      );
      if (objectiveExecuted) {
        return;
      }

      const activeProject = projectManager.getActiveProject();
      if (!activeProject) {
        this.logger.info('No active project and no queued objectives — skipping task');
        return;
      }

      const workspace = new WorkspaceManager(
        activeProject.repoPath,
        activeProject.branch,
        this.logger,
      );
      await workspace.start();

      try {
        await this.executeNextTask(
          activeProject.repoPath, workspace, codingClient, budgetTracker, reporter, db,
        );
        projectManager.recordWork(activeProject.id);
      } finally {
        await workspace.stop();
      }
    });

    this.logger.info({ version: formatVersionLabel(new Date(this.startTime).toISOString()) }, 'Mother Brain Daemon started');

    if (reporter) {
      const info = getRuntimeVersionInfo(new Date(this.startTime).toISOString());
      await reporter.sendMessage(
        `🚀 <b>Mother Brain Daemon Online</b>
Version: <code>${info.buildVersion}</code> (${info.commit})
Env: <code>${info.environment}</code>
PID: <code>${info.pid}</code>
Use /version anytime to verify active runtime.`
      ).catch((err) => {
        this.logger.warn({ error: err }, 'Failed to send startup version banner');
      });
    }
  }

  async stop(): Promise<void> {
    this.logger.info('Mother Brain Daemon stopping...');
    await this.lifecycle.stopAll();
    try {
      this.releaseInstanceLock?.();
      this.releaseInstanceLock = null;
    } catch (error) {
      this.logger.warn({ error }, 'Failed to release daemon instance lock');
    }
    this.logger.info('Mother Brain Daemon stopped');
  }

  /**
   * Core execution loop — called on each scheduler heartbeat.
   */
  private async executeNextObjectiveTask(
    agentOS: AgentOSManager,
    conversationHandler: ConversationHandler,
    budgetTracker: BudgetTracker,
    reporter: TelegramReporter | null,
  ): Promise<boolean> {
    if (this.paused) {
      this.logger.debug('Daemon paused — skipping objective task');
      return false;
    }

    if (!budgetTracker.canProceed(this.sessionId)) {
      this.logger.info('Budget exceeded — objective execution paused');
      await reporter?.notifyBudgetWarning(
        budgetTracker.getStatus(this.sessionId).totalSpent.toFixed(2),
        '0.00',
        this.config!.budget.currency,
      );
      return false;
    }

    const picked = agentOS.pickNextRunnableTask();
    if (!picked) return false;

    const { objective, task, agent } = picked;
    agentOS.setAgentStatus(agent.id, 'running');

    const approval = agentOS.ensureTaskApproval(task, objective, agent);
    if (approval.state === 'pending') {
      agentOS.setAgentStatus(agent.id, 'idle');
      if (approval.created && approval.approval) {
        await reporter?.sendMessage(
          `✋ <b>Approval Required</b>\n` +
          `Objective: <code>${objective.id}</code>\n` +
          `Task: <code>${task.id}</code>\n` +
          `Type: ${approval.approval.approvalType}\n` +
          `Reason: ${escapeHtml(approval.approval.reason)}\n\n` +
          `Use /approve ${approval.approval.id} or /reject ${approval.approval.id} <reason>`,
        );
      }
      return true;
    }

    await reporter?.sendMessage(
      `🤖 <b>${agent.name}</b> started objective <code>${objective.id}</code>\n` +
      `🎯 ${escapeHtml(objective.title)}\n` +
      `📋 Task <code>${task.id}</code>: ${escapeHtml(task.title)}`,
    );

    let currentObjectiveStatus = objective.status;

    try {
      const result = await conversationHandler.executeTask(task.id);
      if (!result) {
        agentOS.recordExecutionFailure(task.id, 'Objective task pipeline failed to generate a plan');
      } else if (result.task.status === 'done') {
        this.tasksCompleted++;
      }

      const refreshed = agentOS.refreshObjectiveStatusFromTask(task.id);
      currentObjectiveStatus = refreshed?.status ?? currentObjectiveStatus;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error({ objectiveId: objective.id, taskId: task.id, error: errorMsg }, 'Objective task execution failed');
      agentOS.recordExecutionFailure(task.id, errorMsg);
      const refreshed = agentOS.refreshObjectiveStatusFromTask(task.id);
      currentObjectiveStatus = refreshed?.status ?? 'blocked';
    } finally {
      agentOS.setAgentStatus(agent.id, 'idle');
    }

    if (currentObjectiveStatus === 'completed') {
      await reporter?.sendMessage(
        `✅ Objective complete <code>${objective.id}</code>\n` +
        `🎯 ${escapeHtml(objective.title)}\n` +
        `Agent: <b>${agent.name}</b>`,
      );
    } else if (currentObjectiveStatus === 'blocked') {
      const objectiveTasks = agentOS.getObjectiveTasks(objective.id);
      const latestBlockedTask = objectiveTasks
        .filter((item) => item.status === 'failed' || item.status === 'blocked')
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      const blockerReason = latestBlockedTask?.lastError
        ?? latestBlockedTask?.blockReason
        ?? 'No blocker reason captured.';
      const looksCredentialRelated = /credential|required|missing secret|missing credentials|setsecret|CREDENTIAL_REQUIRED/i
        .test(blockerReason);
      const nextAction = looksCredentialRelated
        ? 'Likely needs credentials. Use /secret_requests and /setsecret KEY value.'
        : 'Use /objective_tasks <objective-id> to inspect failures and next runnable tasks.';

      await reporter?.sendMessage(
        `🚫 Objective blocked <code>${objective.id}</code>\n` +
        `🎯 ${escapeHtml(objective.title)}\n` +
        `Reason: ${escapeHtml(blockerReason.slice(0, 300))}\n` +
        `${escapeHtml(nextAction)}`,
      );
    }

    return true;
  }

  /**
   * Core execution loop — called on each scheduler heartbeat.
   */
  private async executeNextTask(
    repoPath: string,
    workspace: WorkspaceManager,
    llmClient: LLMExecutor,
    budgetTracker: BudgetTracker,
    reporter: TelegramReporter | null,
    db: DatabaseManager,
  ): Promise<void> {
    if (this.paused) {
      this.logger.debug('Daemon paused — skipping task');
      return;
    }

    // 1. Check budget
    if (!budgetTracker.canProceed(this.sessionId)) {
      this.logger.info('Budget exceeded — stopping');
      await reporter?.notifyBudgetWarning(
        budgetTracker.getStatus(this.sessionId).totalSpent.toFixed(2),
        '0.00',
        this.config!.budget.currency,
      );
      return;
    }

    // 2. Parse roadmap and pick next task
    const roadmapPath = join(repoPath, '.mother-brain', 'docs', 'roadmap.md');
    const roadmap = parseRoadmap(roadmapPath, this.logger);
    const picked = pickNextTask(roadmap, this.logger);

    if (!picked) {
      this.logger.info('All tasks complete — nothing to execute');
      return;
    }

    const { task, outcome } = picked;
    this.logger.info({ taskId: task.id, description: task.description }, 'Executing task');

    // Record task execution start
    const executionId = randomUUID();
    db.connection.prepare(`
      INSERT INTO task_executions (id, session_id, task_id, outcome_id, started_at, status)
      VALUES (?, ?, ?, ?, datetime('now'), 'running')
    `).run(executionId, this.sessionId, task.id, outcome.id);

    try {
      // 3. Build context
      const context = buildTaskContext(task, outcome, repoPath, this.logger);

      // 4. Call LLM
      const result = await llmClient.executeTask(context.systemPrompt, context.taskPrompt);

      // 5. Record budget
      budgetTracker.recordUsage(
        this.sessionId,
        'copilot',
        result.model,
        result.inputTokens,
        result.outputTokens,
      );

      // 6. Apply changes
      if (result.changes.length === 0) {
        this.logger.warn({ taskId: task.id }, 'LLM returned no file changes');
        db.connection.prepare(
          `UPDATE task_executions SET status = 'skipped', completed_at = datetime('now') WHERE id = ?`,
        ).run(executionId);
        return;
      }

      applyFileChanges(result.changes, repoPath, this.logger);

      // 7. Verify
      const verification = verify(repoPath, this.logger);

      if (verification.confidence === 'FAILED') {
        // Revert changes
        await workspace.revertChanges();
        db.connection.prepare(
          `UPDATE task_executions SET status = 'failed', completed_at = datetime('now'), verification_result = ? WHERE id = ?`,
        ).run(verification.summary, executionId);
        await reporter?.notifyError(task.id, verification.summary);
        return;
      }

      // 8. Commit
      const sha = await workspace.commitChanges(task.id, task.description);

      // 9. Record success
      db.connection.prepare(
        `UPDATE task_executions SET status = 'verified', completed_at = datetime('now'), verification_result = ?, commit_sha = ? WHERE id = ?`,
      ).run(verification.summary, sha, executionId);

      db.connection.prepare(
        `UPDATE sessions SET tasks_completed = tasks_completed + 1 WHERE id = ?`,
      ).run(this.sessionId);

      this.tasksCompleted++;

      // 10. Notify
      await reporter?.notifyTaskComplete(task.id, task.description, sha, verification.confidence);
      this.logger.info({ taskId: task.id, sha, confidence: verification.confidence }, 'Task complete');

    } catch (error) {
      this.logger.error({ taskId: task.id, error }, 'Task execution failed');
      db.connection.prepare(
        `UPDATE task_executions SET status = 'failed', completed_at = datetime('now') WHERE id = ?`,
      ).run(executionId);

      // Revert any partial changes
      try {
        await workspace.revertChanges();
      } catch {
        this.logger.error('Failed to revert changes after error');
      }

      await reporter?.notifyError(task.id, String(error));
    }
  }
}

function formatUptime(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours}h ${minutes}m`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function resolveApiConfig(config: DaemonConfig): ApiConfig | null {
  if (config.api) {
    if (!config.api.enabled) return null;
    return config.api;
  }

  const envPort = process.env['AGENT_OS_API_PORT'];
  if (!envPort) return null;

  const parsedPort = Number.parseInt(envPort, 10);
  if (!Number.isFinite(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    return null;
  }

  const envHost = process.env['AGENT_OS_API_HOST']?.trim();
  const envToken = process.env['AGENT_OS_API_TOKEN']?.trim();

  return {
    enabled: true,
    host: envHost && envHost.length > 0 ? envHost : '127.0.0.1',
    port: parsedPort,
    bearerToken: envToken && envToken.length > 0 ? envToken : undefined,
  };
}

function acquireInstanceLock(dataDir: string, logger: Logger): () => void {
  const lockPath = join(dataDir, 'daemon.lock');

  if (existsSync(lockPath)) {
    try {
      const raw = readFileSync(lockPath, 'utf-8').trim();
      const existingPid = Number.parseInt(raw, 10);
      if (Number.isFinite(existingPid)) {
        try {
          process.kill(existingPid, 0);
          throw new Error(`Another daemon instance is already running (pid=${existingPid})`);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ESRCH') {
            throw error;
          }
          // Stale lock: process no longer exists
          unlinkSync(lockPath);
        }
      } else {
        unlinkSync(lockPath);
      }
    } catch (error) {
      if (existsSync(lockPath)) {
        throw error;
      }
    }
  }

  writeFileSync(lockPath, String(process.pid), 'utf-8');
  logger.info({ lockPath, pid: process.pid }, 'Acquired daemon instance lock');

  return () => {
    if (!existsSync(lockPath)) return;
    const raw = readFileSync(lockPath, 'utf-8').trim();
    if (raw === String(process.pid)) {
      unlinkSync(lockPath);
      logger.info({ lockPath, pid: process.pid }, 'Released daemon instance lock');
    }
  };
}
