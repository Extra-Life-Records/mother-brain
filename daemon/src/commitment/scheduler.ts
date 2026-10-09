import { Cron } from 'croner';
import type { Logger } from 'pino';
import type { DaemonModule } from '../core/lifecycle.js';
import type { CommitmentStore, Commitment } from './store.js';

// ---------------------------------------------------------------------------
// Commitment Scheduler
// ---------------------------------------------------------------------------
// Polls for due commitments and executes them. For recurring commitments,
// creates croner jobs. Reports successes and failures via a callback.
// ---------------------------------------------------------------------------

export type CommitmentExecutor = (commitment: Commitment) => Promise<string>;
export type CommitmentNotifier = (commitment: Commitment, result: CommitmentResult) => Promise<void>;

export interface CommitmentResult {
  success: boolean;
  output?: string;
  error?: string;
}

/**
 * Manages execution of commitments on schedule.
 *
 * - On start, loads all active recurring commitments and creates cron jobs
 * - Polls for due one-time commitments every minute
 * - Executes via the registered executor callback
 * - Notifies via the registered notifier callback
 * - Handles failures: marks failed, notifies user, allows retry
 */
export class CommitmentScheduler implements DaemonModule {
  readonly name = 'commitment-scheduler';
  private cronJobs = new Map<string, Cron>();
  private pollJob: Cron | null = null;
  private executor: CommitmentExecutor | null = null;
  private notifier: CommitmentNotifier | null = null;

  constructor(
    private store: CommitmentStore,
    private logger: Logger,
    private timezone: string,
  ) {}

  /** Register the function that executes a commitment's action. */
  onExecute(executor: CommitmentExecutor): void {
    this.executor = executor;
  }

  /** Register the function that notifies the user about commitment results. */
  onNotify(notifier: CommitmentNotifier): void {
    this.notifier = notifier;
  }

  async start(): Promise<void> {
    // Load all active recurring commitments and create cron jobs
    const active = this.store.listActive();
    for (const commitment of active) {
      if (commitment.type === 'recurring' && commitment.schedule) {
        this.registerCronJob(commitment);
      }
    }

    // Poll for due one-time commitments every minute
    this.pollJob = new Cron('* * * * *', { timezone: this.timezone }, async () => {
      try {
        await this.pollDueCommitments();
      } catch (error) {
        this.logger.error({ error: String(error) }, 'Error polling due commitments');
      }
    });

    this.logger.info(
      { recurringJobs: this.cronJobs.size },
      'Commitment scheduler started',
    );
  }

  async stop(): Promise<void> {
    // Stop all cron jobs
    for (const [id, job] of this.cronJobs) {
      job.stop();
      this.logger.debug({ id }, 'Stopped commitment cron job');
    }
    this.cronJobs.clear();

    if (this.pollJob) {
      this.pollJob.stop();
      this.pollJob = null;
    }

    this.logger.info('Commitment scheduler stopped');
  }

  /** Schedule a newly created commitment. Call after store.create(). */
  scheduleCommitment(commitment: Commitment): void {
    if (commitment.type === 'recurring' && commitment.schedule) {
      this.registerCronJob(commitment);
    } else if (commitment.type === 'one_time' && commitment.executeAt === 'now') {
      // Execute immediately
      void this.executeCommitment(commitment);
    }
    // Other one-time commitments are picked up by the poll job
  }

  /** Remove a commitment's cron job (e.g., after cancellation). */
  unscheduleCommitment(commitmentId: string): void {
    const job = this.cronJobs.get(commitmentId);
    if (job) {
      job.stop();
      this.cronJobs.delete(commitmentId);
      this.logger.info({ id: commitmentId }, 'Unscheduled commitment');
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private registerCronJob(commitment: Commitment): void {
    if (this.cronJobs.has(commitment.id)) return;

    try {
      const job = new Cron(commitment.schedule!, { timezone: this.timezone }, async () => {
        await this.executeCommitment(commitment);
      });

      this.cronJobs.set(commitment.id, job);
      this.logger.info(
        { id: commitment.id, schedule: commitment.schedule, action: commitment.actionDescription },
        'Registered recurring commitment',
      );
    } catch (error) {
      this.logger.error(
        { id: commitment.id, schedule: commitment.schedule, error: String(error) },
        'Failed to create cron job for commitment',
      );
      this.store.markFailed(commitment.id, `Invalid schedule: ${String(error)}`);
    }
  }

  private async pollDueCommitments(): Promise<void> {
    const due = this.store.claimDueOneTimeCommitments();
    for (const commitment of due) {
      // Skip recurring — they have their own cron jobs
      if (commitment.type === 'recurring') continue;
      await this.executeCommitment(commitment);
    }
  }

  private async executeCommitment(commitment: Commitment): Promise<void> {
    if (!this.executor) {
      this.logger.warn({ id: commitment.id }, 'No executor registered — skipping commitment');
      return;
    }

    this.logger.info(
      { id: commitment.id, type: commitment.type, action: commitment.actionDescription },
      'Executing commitment',
    );

    this.store.markExecuting(commitment.id);

    try {
      const output = await this.executor(commitment);
      this.store.markCompleted(commitment.id);

      const result: CommitmentResult = { success: true, output };
      await this.notifier?.(commitment, result);

      this.logger.info(
        { id: commitment.id, action: commitment.actionDescription },
        'Commitment executed successfully',
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.store.markFailed(commitment.id, errorMessage);

      const result: CommitmentResult = { success: false, error: errorMessage };
      await this.notifier?.(commitment, result);

      this.logger.error(
        { id: commitment.id, action: commitment.actionDescription, error: errorMessage },
        'Commitment execution failed',
      );
    }
  }
}
