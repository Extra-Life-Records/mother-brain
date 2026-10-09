import { Cron } from 'croner';
import type { Logger } from 'pino';
import type { DaemonModule } from '../core/lifecycle.js';
import type { ActiveHoursConfig } from '../core/config.js';

// ---------------------------------------------------------------------------
// Active Hours
// ---------------------------------------------------------------------------

/** Check if the current time is within the active hours window. */
export function isWithinActiveHours(config: ActiveHoursConfig, timezone: string): boolean {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone: timezone,
  });
  const currentHour = parseInt(formatter.format(now), 10);

  // start == end means "always on" (24/7).
  if (config.start === config.end) {
    return true;
  }

  // Handle overnight windows (e.g., 23:00 - 07:00)
  if (config.start > config.end) {
    return currentHour >= config.start || currentHour < config.end;
  }

  // Handle same-day windows (e.g., 09:00 - 17:00)
  return currentHour >= config.start && currentHour < config.end;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export type TaskCallback = () => Promise<void>;

/**
 * Scheduler module — runs the daemon's execution loop on a heartbeat.
 *
 * Behavior:
 * - Heartbeat fires every N minutes (configurable, default 15)
 * - On each heartbeat, checks if we're within active hours
 * - If active: calls the task callback to execute the next task
 * - If inactive: skips silently (zero cost)
 * - Protects against overlapping executions (if task runs > heartbeat interval)
 */
export class Scheduler implements DaemonModule {
  readonly name = 'scheduler';
  private job: Cron | null = null;
  private executing = false;
  private taskCallback: TaskCallback | null = null;

  constructor(
    private activeHours: ActiveHoursConfig,
    private timezone: string,
    private heartbeatMinutes: number,
    private logger: Logger,
  ) {}

  /** Set the callback that runs on each heartbeat during active hours. */
  onTask(callback: TaskCallback): void {
    this.taskCallback = callback;
    // Kick off one immediate heartbeat when the callback is attached.
    void this.heartbeat();
  }

  async start(): Promise<void> {
    const pattern = `*/${this.heartbeatMinutes} * * * *`;

    this.job = new Cron(pattern, {
      timezone: this.timezone,
    }, async () => {
      await this.heartbeat();
    });

    this.logger.info(
      {
        pattern,
        timezone: this.timezone,
        activeHours: `${this.activeHours.start}:00 - ${this.activeHours.end}:00`,
      },
      'Scheduler started',
    );
  }

  async stop(): Promise<void> {
    if (this.job) {
      this.job.stop();
      this.job = null;
    }
    this.logger.info('Scheduler stopped');
  }

  private async heartbeat(): Promise<void> {
    // Check active hours
    if (!isWithinActiveHours(this.activeHours, this.timezone)) {
      this.logger.debug('Outside active hours — skipping');
      return;
    }

    // Prevent overlapping executions
    if (this.executing) {
      this.logger.debug('Previous task still executing — skipping heartbeat');
      return;
    }

    if (!this.taskCallback) {
      this.logger.debug('No task callback registered — skipping');
      return;
    }

    this.executing = true;
    try {
      await this.taskCallback();
    } catch (error) {
      this.logger.error({ error }, 'Task execution failed during heartbeat');
    } finally {
      this.executing = false;
    }
  }
}
