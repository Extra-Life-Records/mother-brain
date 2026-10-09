import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { CommitmentType, DetectedCommitment } from './detector.js';

// ---------------------------------------------------------------------------
// Commitment Storage — SQLite CRUD for tracked commitments
// ---------------------------------------------------------------------------

export type CommitmentStatus = 'active' | 'executing' | 'completed' | 'failed' | 'cancelled';

export interface Commitment {
  id: string;
  type: CommitmentType;
  promiseText: string;
  actionDescription: string;
  schedule: string | null;     // Cron pattern for recurring
  executeAt: string | null;    // ISO timestamp for one-time
  status: CommitmentStatus;
  createdAt: string;
  lastExecutedAt: string | null;
  nextRunAt: string | null;
  executionCount: number;
  failureReason: string | null;
}

export class CommitmentStore {
  constructor(
    private db: Database.Database,
    private logger: Logger,
  ) {
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS commitments (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('one_time', 'recurring')),
        promise_text TEXT NOT NULL,
        action_description TEXT NOT NULL,
        schedule TEXT,
        execute_at TEXT,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active', 'executing', 'completed', 'failed', 'cancelled')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_executed_at TEXT,
        next_run_at TEXT,
        execution_count INTEGER NOT NULL DEFAULT 0,
        failure_reason TEXT
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_commitments_status ON commitments(status);
    `);
  }

  /** Create a new commitment from a detected intent. */
  create(detected: DetectedCommitment): Commitment {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO commitments (id, type, promise_text, action_description, schedule, execute_at, status, created_at, next_run_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      id,
      detected.type,
      detected.promiseText,
      detected.actionDescription,
      detected.schedule ?? null,
      detected.executeAt ?? null,
      now,
      detected.type === 'recurring' ? this.computeNextRun(detected.schedule!) : detected.executeAt ?? null,
    );

    this.logger.info({ id, type: detected.type, action: detected.actionDescription }, 'Commitment created');

    return this.getById(id)!;
  }

  /** Get a commitment by ID. */
  getById(id: string): Commitment | null {
    const row = this.db.prepare('SELECT * FROM commitments WHERE id = ?').get(id) as CommitmentRow | undefined;
    return row ? this.toCommitment(row) : null;
  }

  /** List all active commitments. */
  listActive(): Commitment[] {
    const rows = this.db.prepare(
      "SELECT * FROM commitments WHERE status IN ('active', 'executing') ORDER BY created_at ASC"
    ).all() as CommitmentRow[];
    return rows.map(r => this.toCommitment(r));
  }

  /** List all commitments (including completed/cancelled). */
  listAll(): Commitment[] {
    const rows = this.db.prepare(
      'SELECT * FROM commitments ORDER BY created_at DESC'
    ).all() as CommitmentRow[];
    return rows.map(r => this.toCommitment(r));
  }

  /** Mark a commitment as executing. */
  markExecuting(id: string): void {
    this.db.prepare(
      "UPDATE commitments SET status = 'executing' WHERE id = ?"
    ).run(id);
  }

  /** Mark a commitment execution as completed. */
  markCompleted(id: string): void {
    const commitment = this.getById(id);
    if (!commitment) return;

    if (commitment.type === 'recurring') {
      // Recurring: update execution count and next run, keep active
      const nextRun = this.computeNextRun(commitment.schedule!);
      this.db.prepare(`
        UPDATE commitments
        SET status = 'active', last_executed_at = datetime('now'),
            execution_count = execution_count + 1, next_run_at = ?
        WHERE id = ? AND status = 'executing'
      `).run(nextRun, id);
    } else {
      // One-time: mark fully completed
      this.db.prepare(`
        UPDATE commitments
        SET status = 'completed', last_executed_at = datetime('now'),
            execution_count = execution_count + 1
        WHERE id = ? AND status = 'executing'
      `).run(id);
    }
  }

  /** Mark a commitment as failed with a reason. */
  markFailed(id: string, reason: string): void {
    this.db.prepare(`
      UPDATE commitments
      SET status = 'failed', failure_reason = ?, last_executed_at = datetime('now')
      WHERE id = ? AND status = 'executing'
    `).run(reason, id);
  }

  /** Cancel a commitment. */
  cancel(id: string): boolean {
    const result = this.db.prepare(
      "UPDATE commitments SET status = 'cancelled' WHERE id = ? AND status IN ('active', 'failed')"
    ).run(id);
    if (result.changes > 0) {
      this.logger.info({ id }, 'Commitment cancelled');
      return true;
    }
    return false;
  }

  /** Cancel a commitment by matching its action description (fuzzy). */
  cancelByDescription(query: string): Commitment | null {
    const active = this.listActive();
    const lower = query.toLowerCase();
    const match = active.find(c =>
      c.actionDescription.toLowerCase().includes(lower) ||
      c.promiseText.toLowerCase().includes(lower)
    );
    if (match) {
      this.cancel(match.id);
      return match;
    }
    return null;
  }

  /** Reschedule an existing one-time commitment to a new execution timestamp. */
  rescheduleOneTime(id: string, executeAt: string): Commitment | null {
    const result = this.db.prepare(`
      UPDATE commitments
      SET execute_at = ?, next_run_at = ?, status = 'active', failure_reason = NULL
      WHERE id = ?
        AND type = 'one_time'
        AND status IN ('active', 'failed')
    `).run(executeAt, executeAt, id);

    if (result.changes === 0) return null;

    this.logger.info({ id, executeAt }, 'One-time commitment rescheduled');
    return this.getById(id);
  }

  /** Get commitments that are due for execution. */
  getDueCommitments(): Commitment[] {
    const now = new Date().toISOString();
    const rows = this.db.prepare(`
      SELECT * FROM commitments
      WHERE status = 'active'
        AND (
          (type = 'one_time' AND execute_at <= ?)
          OR (type = 'recurring' AND next_run_at <= ?)
        )
      ORDER BY COALESCE(execute_at, next_run_at) ASC
    `).all(now, now) as CommitmentRow[];
    return rows.map(r => this.toCommitment(r));
  }

  /**
   * Atomically claim due one-time commitments for execution.
   * This prevents duplicate runs if multiple daemon processes are polling.
   */
  claimDueOneTimeCommitments(limit: number = 20): Commitment[] {
    const now = new Date().toISOString();
    const selectStmt = this.db.prepare(`
      SELECT * FROM commitments
      WHERE status = 'active'
        AND type = 'one_time'
        AND execute_at <= ?
      ORDER BY execute_at ASC
      LIMIT ?
    `);
    const claimStmt = this.db.prepare(`
      UPDATE commitments
      SET status = 'executing'
      WHERE id = ? AND status = 'active'
    `);

    const tx = this.db.transaction((ts: string, lim: number) => {
      const candidates = selectStmt.all(ts, lim) as CommitmentRow[];
      const claimed: Commitment[] = [];

      for (const row of candidates) {
        const result = claimStmt.run(row.id);
        if (result.changes > 0) {
          claimed.push(this.toCommitment({ ...row, status: 'executing' }));
        }
      }

      return claimed;
    });

    try {
      return tx(now, limit);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === 'SQLITE_BUSY') {
        this.logger.warn('SQLite busy while claiming due commitments — will retry next poll cycle');
        return [];
      }
      throw error;
    }
  }

  /** Compute the next run time from a cron schedule (approximation). */
  private computeNextRun(cronPattern: string): string {
    // Parse simple cron patterns to estimate next run
    // Format: minute hour day-of-month month day-of-week
    const parts = cronPattern.split(/\s+/);
    if (parts.length !== 5) return new Date(Date.now() + 3_600_000).toISOString();

    const now = new Date();
    const [minPart, hourPart] = parts;

    let minute = now.getMinutes();
    let hour = now.getHours();

    // Parse minute
    if (minPart.startsWith('*/')) {
      const interval = parseInt(minPart.slice(2), 10);
      minute = Math.ceil((minute + 1) / interval) * interval;
      if (minute >= 60) { minute = 0; hour++; }
    } else if (minPart !== '*') {
      minute = parseInt(minPart, 10);
    }

    // Parse hour
    if (hourPart.startsWith('*/')) {
      const interval = parseInt(hourPart.slice(2), 10);
      if (hour % interval !== 0 || minute < now.getMinutes()) {
        hour = Math.ceil((hour + 1) / interval) * interval;
      }
    } else if (hourPart !== '*') {
      hour = parseInt(hourPart, 10);
    }

    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);

    // If the computed time is in the past, advance by one period
    if (next.getTime() <= now.getTime()) {
      if (hourPart === '*' || hourPart.startsWith('*/')) {
        // Advance by the appropriate interval
        if (minPart.startsWith('*/')) {
          next.setMinutes(next.getMinutes() + parseInt(minPart.slice(2), 10));
        } else {
          next.setHours(next.getHours() + 1);
        }
      } else {
        next.setDate(next.getDate() + 1);
      }
    }

    return next.toISOString();
  }

  // Row mapping
  private toCommitment(row: CommitmentRow): Commitment {
    return {
      id: row.id,
      type: row.type as CommitmentType,
      promiseText: row.promise_text,
      actionDescription: row.action_description,
      schedule: row.schedule,
      executeAt: row.execute_at,
      status: row.status as CommitmentStatus,
      createdAt: row.created_at,
      lastExecutedAt: row.last_executed_at,
      nextRunAt: row.next_run_at,
      executionCount: row.execution_count,
      failureReason: row.failure_reason,
    };
  }
}

interface CommitmentRow {
  id: string;
  type: string;
  promise_text: string;
  action_description: string;
  schedule: string | null;
  execute_at: string | null;
  status: string;
  created_at: string;
  last_executed_at: string | null;
  next_run_at: string | null;
  execution_count: number;
  failure_reason: string | null;
}
