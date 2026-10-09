import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskType = 'commitment' | 'research' | 'coding' | 'general';
export type TaskStatus = 'queued' | 'running' | 'blocked' | 'done' | 'failed';

export interface Task {
  id: string;
  title: string;
  type: TaskType;
  status: TaskStatus;
  objectiveId: string | null;
  assignedAgentId: string | null;
  priority: number;
  parentTaskId: string | null;
  deadline: string | null;
  blockReason: string | null;
  checkpointData: Record<string, unknown>;
  artifacts: TaskArtifact[];
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  executionCount: number;
  lastError: string | null;
}

export interface TaskArtifact {
  type: 'file' | 'link' | 'text' | 'json';
  label: string;
  value: string;
}

export interface CreateTaskInput {
  title: string;
  type: TaskType;
  priority?: number;
  parentTaskId?: string;
  deadline?: string;
  objectiveId?: string;
  assignedAgentId?: string;
}

// ---------------------------------------------------------------------------
// TaskLedger — Durable task management with checkpoint/resume
// ---------------------------------------------------------------------------

export class TaskLedger {
  constructor(
    private db: Database.Database,
    private logger: Logger,
  ) {}

  /** Create a new task in queued status. */
  create(input: CreateTaskInput): Task {
    const id = randomUUID().slice(0, 8);
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO tasks (
        id, title, type, priority, parent_task_id, deadline, objective_id, assigned_agent_id, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.title,
      input.type,
      input.priority ?? 0,
      input.parentTaskId ?? null,
      input.deadline ?? null,
      input.objectiveId ?? null,
      input.assignedAgentId ?? null,
      now,
      now,
    );

    this.logger.info({ taskId: id, type: input.type, title: input.title }, 'Task created');
    return this.getById(id)!;
  }

  /** Start a queued task → running. */
  start(id: string): Task | null {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE tasks SET status = 'running', started_at = ?, updated_at = ?,
        execution_count = execution_count + 1
      WHERE id = ? AND status IN ('queued', 'blocked')
    `).run(now, now, id);

    if (result.changes === 0) {
      this.logger.warn({ taskId: id }, 'Cannot start task — not in queued/blocked status');
      return null;
    }
    this.logger.info({ taskId: id }, 'Task started');
    return this.getById(id);
  }

  /** Save a checkpoint — intermediate progress on a running task. */
  checkpoint(id: string, data: Record<string, unknown>): void {
    const now = new Date().toISOString();
    const existing = this.getById(id);
    if (!existing) return;

    const merged = { ...existing.checkpointData, ...data };
    this.db.prepare(`
      UPDATE tasks SET checkpoint_data = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(merged), now, id);

    this.logger.debug({ taskId: id }, 'Task checkpoint saved');
  }

  /** Block a task with a reason. */
  block(id: string, reason: string): Task | null {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE tasks SET status = 'blocked', block_reason = ?, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(reason, now, id);

    if (result.changes === 0) return null;
    this.logger.info({ taskId: id, reason }, 'Task blocked');
    return this.getById(id);
  }

  /** Complete a task with optional artifacts. */
  complete(id: string, artifacts?: TaskArtifact[]): Task | null {
    const now = new Date().toISOString();
    const existing = this.getById(id);
    if (!existing) return null;

    const allArtifacts = [...existing.artifacts, ...(artifacts ?? [])];
    const result = this.db.prepare(`
      UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ?,
        artifacts = ?, block_reason = NULL
      WHERE id = ? AND status IN ('running', 'blocked')
    `).run(now, now, JSON.stringify(allArtifacts), id);

    if (result.changes === 0) return null;
    this.logger.info({ taskId: id, artifactCount: allArtifacts.length }, 'Task completed');
    return this.getById(id);
  }

  /** Fail a task with an error message. */
  fail(id: string, error: string): Task | null {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE tasks SET status = 'failed', last_error = ?, updated_at = ?, completed_at = ?
      WHERE id = ? AND status IN ('running', 'blocked', 'queued')
    `).run(error, now, now, id);

    if (result.changes === 0) return null;
    this.logger.warn({ taskId: id, error }, 'Task failed');
    return this.getById(id);
  }

  /** Resume a blocked or failed task → re-queue it. */
  resume(id: string): Task | null {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE tasks SET status = 'queued', block_reason = NULL, last_error = NULL, updated_at = ?
      WHERE id = ? AND status IN ('blocked', 'failed')
    `).run(now, id);

    if (result.changes === 0) return null;
    this.logger.info({ taskId: id }, 'Task resumed → queued');
    return this.getById(id);
  }

  /** Add an artifact to an existing task. */
  addArtifact(id: string, artifact: TaskArtifact): void {
    const existing = this.getById(id);
    if (!existing) return;

    const artifacts = [...existing.artifacts, artifact];
    this.db.prepare(`
      UPDATE tasks SET artifacts = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(artifacts), new Date().toISOString(), id);
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  getById(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  /** List tasks by status. */
  listByStatus(...statuses: TaskStatus[]): Task[] {
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = this.db.prepare(
      `SELECT * FROM tasks WHERE status IN (${placeholders}) ORDER BY priority DESC, created_at ASC`
    ).all(...statuses) as TaskRow[];
    return rows.map(rowToTask);
  }

  /** List all active tasks (queued + running + blocked). */
  listActive(): Task[] {
    return this.listByStatus('queued', 'running', 'blocked');
  }

  /**
   * Find completed tasks most relevant to a new query.
   * Used as lightweight long-term memory for planning.
   */
  findRelevantCompleted(query: string, limit = 3): Task[] {
    const rows = this.db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'done'
      ORDER BY completed_at DESC
      LIMIT 100
    `).all() as TaskRow[];

    const doneTasks = rows.map(rowToTask);
    if (doneTasks.length === 0) return [];

    const queryTokens = tokenize(query);
    if (queryTokens.size === 0) {
      return doneTasks.slice(0, Math.max(1, limit));
    }

    const scored = doneTasks
      .map((task) => {
        const taskText = [
          task.title,
          ...task.artifacts.map((artifact) => `${artifact.label} ${artifact.value}`),
        ].join(' ');
        const taskTokens = tokenize(taskText);
        if (taskTokens.size === 0) return { task, score: 0 };

        let overlap = 0;
        for (const token of queryTokens) {
          if (taskTokens.has(token)) overlap++;
        }

        const score = overlap / queryTokens.size;
        return { task, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.task.updatedAt.localeCompare(a.task.updatedAt);
      });

    if (scored.length === 0) {
      return doneTasks.slice(0, Math.max(1, limit));
    }

    return scored.slice(0, Math.max(1, limit)).map((entry) => entry.task);
  }

  /** List subtasks of a parent. */
  listSubtasks(parentId: string): Task[] {
    const rows = this.db.prepare(
      'SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC'
    ).all(parentId) as TaskRow[];
    return rows.map(rowToTask);
  }

  /** Count tasks by status. */
  counts(): Record<TaskStatus, number> {
    const rows = this.db.prepare(
      'SELECT status, COUNT(*) as count FROM tasks GROUP BY status'
    ).all() as { status: TaskStatus; count: number }[];

    const result: Record<TaskStatus, number> = { queued: 0, running: 0, blocked: 0, done: 0, failed: 0 };
    for (const row of rows) result[row.status] = row.count;
    return result;
  }

  /** Find tasks that were running when the daemon last stopped (interrupted). */
  findInterrupted(): Task[] {
    return this.listByStatus('running');
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface TaskRow {
  id: string;
  title: string;
  type: string;
  status: string;
  objective_id: string | null;
  assigned_agent_id: string | null;
  priority: number;
  parent_task_id: string | null;
  deadline: string | null;
  block_reason: string | null;
  checkpoint_data: string;
  artifacts: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  execution_count: number;
  last_error: string | null;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    type: row.type as TaskType,
    status: row.status as TaskStatus,
    objectiveId: row.objective_id,
    assignedAgentId: row.assigned_agent_id,
    priority: row.priority,
    parentTaskId: row.parent_task_id,
    deadline: row.deadline,
    blockReason: row.block_reason,
    checkpointData: safeParse(row.checkpoint_data, {}),
    artifacts: safeParse(row.artifacts, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    executionCount: row.execution_count,
    lastError: row.last_error,
  };
}

function safeParse<T>(json: string, fallback: T): T {
  try { return JSON.parse(json); } catch { return fallback; }
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4 && !TASK_TOKEN_STOP_WORDS.has(token)),
  );
}

const TASK_TOKEN_STOP_WORDS = new Set([
  'that', 'this', 'with', 'from', 'have', 'will', 'your', 'into', 'task',
  'make', 'build', 'create', 'write', 'done', 'step', 'steps',
]);
