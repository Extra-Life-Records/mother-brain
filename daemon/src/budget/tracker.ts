import type { Logger } from 'pino';
import type Database from 'better-sqlite3';
import type { LLMTier } from '../llm/router.js';

// ---------------------------------------------------------------------------
// Pricing Models (cost per million tokens)
// ---------------------------------------------------------------------------

interface ModelPricing {
  inputPerMillion: number;   // USD per million input tokens
  outputPerMillion: number;  // USD per million output tokens
}

const PRICING: Record<string, ModelPricing> = {
  // Claude (via GitHub Copilot / Models API)
  'claude-sonnet-4-20250514': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  'claude-opus-4-20250514': { inputPerMillion: 15.00, outputPerMillion: 75.00 },
  'claude-3-5-sonnet-20241022': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  'claude-3-5-haiku-20241022': { inputPerMillion: 0.80, outputPerMillion: 4.00 },
  'claude-3-haiku-20240307': { inputPerMillion: 0.25, outputPerMillion: 1.25 },
  // OpenAI GPT (via GitHub Copilot / Models API)
  'gpt-4.1': { inputPerMillion: 2.00, outputPerMillion: 8.00 },
  'gpt-4.1-mini': { inputPerMillion: 0.40, outputPerMillion: 1.60 },
  'gpt-4o': { inputPerMillion: 2.50, outputPerMillion: 10.00 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.60 },
  'gpt-5': { inputPerMillion: 2.00, outputPerMillion: 8.00 },
  'gpt-5-mini': { inputPerMillion: 0.40, outputPerMillion: 1.60 },
  'gpt-5-nano': { inputPerMillion: 0.15, outputPerMillion: 0.60 },
  'gpt-5.3-codex': { inputPerMillion: 2.00, outputPerMillion: 8.00 },
  // Local models
  'local': { inputPerMillion: 0, outputPerMillion: 0 },
};

/** Get pricing for a model. Strips provider prefix, falls back to mid-tier pricing. */
function getPricing(model: string): ModelPricing {
  // Strip provider prefix (e.g., "openai/gpt-4.1" → "gpt-4.1")
  const shortModel = model.includes('/') ? model.split('/').pop()! : model;
  return PRICING[shortModel] ?? { inputPerMillion: 3.00, outputPerMillion: 15.00 };
}

/** Calculate cost in USD for a given model and token counts. */
export function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = getPricing(model);
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion
  );
}

// ---------------------------------------------------------------------------
// Budget Tracker — comprehensive token and cost tracking
// ---------------------------------------------------------------------------

export interface BudgetStatus {
  sessionId: string;
  totalSpent: number;   // USD
  budgetCap: number;    // USD per session
  remaining: number;    // USD
  canProceed: boolean;
  taskBreakdown: Array<{ taskId: string; cost: number }>;
}

export interface UsageReport {
  allTime: { totalTokens: number; totalCost: number; requestCount: number };
  byTier: Record<string, { tokens: number; cost: number; requests: number }>;
  byModel: Record<string, { tokens: number; cost: number; requests: number }>;
  byProject: Record<string, { tokens: number; cost: number; requests: number }>;
  globalBudget: { cap: number; spent: number; remaining: number; percentUsed: number };
}

export class BudgetTracker {
  private alertThresholds = [50, 75, 90];
  private alertsSent = new Set<number>();

  constructor(
    private db: Database.Database,
    private sessionBudgetCap: number,
    private currency: string,
    private logger: Logger,
    private globalBudgetCap?: number,  // Absolute lifetime cap
  ) {
    this.ensureUsageTable();
  }

  /** Create the comprehensive usage tracking table if it doesn't exist. */
  private ensureUsageTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_tracking (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        session_id TEXT,
        project_id TEXT,
        tier TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_usage_tier ON usage_tracking(tier);
      CREATE INDEX IF NOT EXISTS idx_usage_project ON usage_tracking(project_id);
      CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_tracking(model);
    `);
  }

  /** Record an API call's token usage and cost. */
  recordUsage(
    sessionId: string,
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    tier?: LLMTier,
    projectId?: string,
  ): number {
    const cost = calculateCost(model, inputTokens, outputTokens);

    // Record in legacy budget_tracking table
    this.db.prepare(`
      INSERT INTO budget_tracking (session_id, timestamp, provider, model, input_tokens, output_tokens, cost_usd)
      VALUES (?, datetime('now'), ?, ?, ?, ?, ?)
    `).run(sessionId, provider, model, inputTokens, outputTokens, cost);

    // Record in comprehensive usage_tracking table
    this.db.prepare(`
      INSERT INTO usage_tracking (session_id, project_id, tier, provider, model, input_tokens, output_tokens, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, projectId ?? null, tier ?? null, provider, model, inputTokens, outputTokens, cost);

    // Update session totals
    this.db.prepare(`
      UPDATE sessions
      SET tokens_used = tokens_used + ? + ?,
          cost_usd = cost_usd + ?
      WHERE id = ?
    `).run(inputTokens, outputTokens, cost, sessionId);

    this.logger.info(
      { provider, model, tier, inputTokens, outputTokens, cost: cost.toFixed(4), currency: this.currency },
      'API usage recorded',
    );

    return cost;
  }

  /** Check if we can proceed (session budget + global budget). */
  canProceed(sessionId: string): boolean {
    // Check session budget
    const sessionSpent = this.getSessionSpent(sessionId);
    if (sessionSpent >= this.sessionBudgetCap) {
      this.logger.warn({ sessionSpent, sessionBudgetCap: this.sessionBudgetCap }, 'Session budget exceeded');
      return false;
    }

    // Check global budget
    if (this.globalBudgetCap) {
      const globalSpent = this.getGlobalSpent();
      if (globalSpent >= this.globalBudgetCap) {
        this.logger.warn({ globalSpent, globalBudgetCap: this.globalBudgetCap }, 'Global budget exceeded');
        return false;
      }
    }

    return true;
  }

  /** Get budget status for current session. */
  getStatus(sessionId: string): BudgetStatus {
    const totalSpent = this.getSessionSpent(sessionId);

    const tasks = this.db.prepare(`
      SELECT te.task_id, COALESCE(SUM(bt.cost_usd), 0) as cost
      FROM task_executions te
      LEFT JOIN budget_tracking bt ON bt.session_id = te.session_id
      WHERE te.session_id = ?
      GROUP BY te.task_id
    `).all(sessionId) as Array<{ task_id: string; cost: number }>;

    return {
      sessionId,
      totalSpent,
      budgetCap: this.sessionBudgetCap,
      remaining: this.sessionBudgetCap - totalSpent,
      canProceed: totalSpent < this.sessionBudgetCap,
      taskBreakdown: tasks.map((t) => ({ taskId: t.task_id, cost: t.cost })),
    };
  }

  /** Get comprehensive usage report — all-time, by tier, by model, by project. */
  getUsageReport(): UsageReport {
    // All-time totals
    const allTime = this.db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens + output_tokens), 0) as totalTokens,
        COALESCE(SUM(cost_usd), 0) as totalCost,
        COUNT(*) as requestCount
      FROM usage_tracking
    `).get() as { totalTokens: number; totalCost: number; requestCount: number };

    // By tier
    const tierRows = this.db.prepare(`
      SELECT tier,
        SUM(input_tokens + output_tokens) as tokens,
        SUM(cost_usd) as cost,
        COUNT(*) as requests
      FROM usage_tracking
      WHERE tier IS NOT NULL
      GROUP BY tier
    `).all() as Array<{ tier: string; tokens: number; cost: number; requests: number }>;

    const byTier: Record<string, { tokens: number; cost: number; requests: number }> = {};
    for (const r of tierRows) {
      byTier[r.tier] = { tokens: r.tokens, cost: r.cost, requests: r.requests };
    }

    // By model
    const modelRows = this.db.prepare(`
      SELECT model,
        SUM(input_tokens + output_tokens) as tokens,
        SUM(cost_usd) as cost,
        COUNT(*) as requests
      FROM usage_tracking
      GROUP BY model
    `).all() as Array<{ model: string; tokens: number; cost: number; requests: number }>;

    const byModel: Record<string, { tokens: number; cost: number; requests: number }> = {};
    for (const r of modelRows) {
      byModel[r.model] = { tokens: r.tokens, cost: r.cost, requests: r.requests };
    }

    // By project
    const projectRows = this.db.prepare(`
      SELECT
        COALESCE(ut.project_id, 'unknown') as project_id,
        COALESCE(p.name, ut.project_id, 'unknown') as project_name,
        SUM(ut.input_tokens + ut.output_tokens) as tokens,
        SUM(ut.cost_usd) as cost,
        COUNT(*) as requests
      FROM usage_tracking ut
      LEFT JOIN projects p ON ut.project_id = p.id
      GROUP BY ut.project_id
    `).all() as Array<{ project_name: string; tokens: number; cost: number; requests: number }>;

    const byProject: Record<string, { tokens: number; cost: number; requests: number }> = {};
    for (const r of projectRows) {
      byProject[r.project_name] = { tokens: r.tokens, cost: r.cost, requests: r.requests };
    }

    // Global budget
    const globalSpent = allTime.totalCost;
    const globalCap = this.globalBudgetCap ?? Infinity;

    return {
      allTime,
      byTier,
      byModel,
      byProject,
      globalBudget: {
        cap: globalCap,
        spent: globalSpent,
        remaining: globalCap - globalSpent,
        percentUsed: globalCap === Infinity ? 0 : (globalSpent / globalCap) * 100,
      },
    };
  }

  /** Check and return any unnotified threshold alerts. */
  checkThresholdAlerts(): number[] {
    if (!this.globalBudgetCap) return [];

    const globalSpent = this.getGlobalSpent();
    const percentUsed = (globalSpent / this.globalBudgetCap) * 100;

    const newAlerts: number[] = [];
    for (const threshold of this.alertThresholds) {
      if (percentUsed >= threshold && !this.alertsSent.has(threshold)) {
        this.alertsSent.add(threshold);
        newAlerts.push(threshold);
      }
    }
    return newAlerts;
  }

  private getSessionSpent(sessionId: string): number {
    const row = this.db.prepare(
      'SELECT COALESCE(SUM(cost_usd), 0) as total FROM budget_tracking WHERE session_id = ?',
    ).get(sessionId) as { total: number } | undefined;
    return row?.total ?? 0;
  }

  private getGlobalSpent(): number {
    const row = this.db.prepare(
      'SELECT COALESCE(SUM(cost_usd), 0) as total FROM usage_tracking',
    ).get() as { total: number } | undefined;
    return row?.total ?? 0;
  }
}
