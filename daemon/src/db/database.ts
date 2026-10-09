import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { DaemonModule } from '../core/lifecycle.js';

/**
 * SQLite database manager.
 * Uses better-sqlite3 for synchronous, reliable operations on Pi.
 * Handles schema migrations on startup.
 */
export class DatabaseManager implements DaemonModule {
  readonly name = 'database';
  private db: Database.Database | null = null;

  constructor(
    private dbPath: string,
    private logger: Logger,
  ) {}

  /** Get the underlying database instance. Throws if not started. */
  get connection(): Database.Database {
    if (!this.db) {
      throw new Error('Database not started');
    }
    return this.db;
  }

  async start(): Promise<void> {
    if (this.db) return; // Already started — idempotent
    this.db = new Database(this.dbPath);

    // WAL mode for better concurrent read performance
    this.db.pragma('journal_mode = WAL');
    // Enforce foreign keys
    this.db.pragma('foreign_keys = ON');

    this.runMigrations();
    this.logger.info({ path: this.dbPath }, 'Database ready');
  }

  async stop(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.logger.info('Database closed');
    }
  }

  private runMigrations(): void {
    if (!this.db) return;

    // Migration tracking table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    const applied = new Set(
      this.db
        .prepare('SELECT name FROM migrations')
        .all()
        .map((row) => (row as { name: string }).name)
    );

    for (const migration of MIGRATIONS) {
      if (!applied.has(migration.name)) {
        this.logger.info({ migration: migration.name }, 'Applying migration');
        this.db.exec(migration.sql);
        this.db
          .prepare('INSERT INTO migrations (name) VALUES (?)')
          .run(migration.name);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Migrations — append-only, never modify existing migrations
// ---------------------------------------------------------------------------

interface Migration {
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    name: '001_initial_schema',
    sql: `
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT CHECK(status IN ('active', 'completed', 'failed', 'budget_exceeded')),
        tasks_completed INTEGER DEFAULT 0,
        tokens_used INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0.0
      );

      CREATE TABLE task_executions (
        id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES sessions(id),
        task_id TEXT NOT NULL,
        outcome_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT CHECK(status IN ('running', 'verified', 'failed', 'skipped')),
        tokens_used INTEGER DEFAULT 0,
        verification_result TEXT,
        commit_sha TEXT
      );

      CREATE TABLE budget_tracking (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT REFERENCES sessions(id),
        timestamp TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL
      );

      CREATE TABLE project_context (
        repo_path TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repo_path, key)
      );
    `,
  },
  {
    name: '002_projects_table',
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        repo_path TEXT NOT NULL,
        branch TEXT NOT NULL DEFAULT 'daemon/work',
        active INTEGER NOT NULL DEFAULT 0,
        added_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_worked_at TEXT,
        tasks_completed INTEGER DEFAULT 0
      );

      CREATE INDEX idx_projects_active ON projects(active);
    `,
  },
  {
    name: '003_task_ledger',
    sql: `
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('commitment', 'research', 'coding', 'general')),
        status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'running', 'blocked', 'done', 'failed')),
        priority INTEGER NOT NULL DEFAULT 0,
        parent_task_id TEXT REFERENCES tasks(id),
        deadline TEXT,
        block_reason TEXT,
        checkpoint_data TEXT DEFAULT '{}',
        artifacts TEXT DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT,
        execution_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );

      CREATE INDEX idx_tasks_status ON tasks(status);
      CREATE INDEX idx_tasks_type ON tasks(type);
      CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);
    `,
  },
  {
    name: '004_blocker_resolutions',
    sql: `
      CREATE TABLE blocker_resolutions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symptom TEXT NOT NULL,
        blocker_type TEXT NOT NULL,
        original_tool TEXT NOT NULL,
        original_error TEXT NOT NULL,
        resolution_tool TEXT NOT NULL,
        resolution_args TEXT DEFAULT '{}',
        success INTEGER NOT NULL DEFAULT 1,
        task_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_blocker_symptom ON blocker_resolutions(symptom);
      CREATE INDEX idx_blocker_type ON blocker_resolutions(blocker_type);
    `,
  },
  {
    name: '005_agent_os_core',
    sql: `
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        role_prompt TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('provisioning', 'idle', 'running', 'paused', 'offline', 'error')),
        autonomy_mode TEXT NOT NULL CHECK(autonomy_mode IN ('manual', 'supervised', 'autonomous')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE objectives (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id),
        owner_agent_id TEXT REFERENCES agents(id),
        requested_by TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        definition_of_done TEXT NOT NULL DEFAULT '{}',
        priority INTEGER NOT NULL DEFAULT 5,
        status TEXT NOT NULL CHECK(status IN ('draft', 'queued', 'planning', 'running', 'waiting_approval', 'blocked', 'completed', 'failed', 'canceled')),
        started_at TEXT,
        completed_at TEXT,
        result_summary TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE delegations (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        from_agent_id TEXT NOT NULL REFERENCES agents(id),
        to_agent_id TEXT NOT NULL REFERENCES agents(id),
        status TEXT NOT NULL CHECK(status IN ('requested', 'accepted', 'running', 'answered', 'rejected', 'expired')),
        question TEXT NOT NULL,
        context_json TEXT NOT NULL DEFAULT '{}',
        response_json TEXT NOT NULL DEFAULT '{}',
        deadline TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE objective_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      ALTER TABLE tasks ADD COLUMN objective_id TEXT REFERENCES objectives(id);
      ALTER TABLE tasks ADD COLUMN assigned_agent_id TEXT REFERENCES agents(id);

      CREATE INDEX idx_agents_status ON agents(status);
      CREATE INDEX idx_objectives_status ON objectives(status);
      CREATE INDEX idx_objectives_owner ON objectives(owner_agent_id);
      CREATE INDEX idx_tasks_objective_id ON tasks(objective_id);
      CREATE INDEX idx_tasks_assigned_agent_id ON tasks(assigned_agent_id);
      CREATE INDEX idx_delegations_status ON delegations(status);
      CREATE INDEX idx_delegations_to_agent ON delegations(to_agent_id);
      CREATE INDEX idx_objective_events_objective ON objective_events(objective_id, created_at);
    `,
  },
  {
    name: '006_agent_os_approvals_and_delegation_link',
    sql: `
      ALTER TABLE delegations ADD COLUMN delegated_task_id TEXT REFERENCES tasks(id);

      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        requested_by_agent_id TEXT NOT NULL REFERENCES agents(id),
        requested_from TEXT NOT NULL,
        approval_type TEXT NOT NULL CHECK(approval_type IN ('publish', 'spend', 'external_action', 'destructive_action', 'policy_override')),
        reason TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'expired')),
        decision_note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        decided_at TEXT
      );

      CREATE INDEX idx_approvals_status ON approvals(status);
      CREATE INDEX idx_approvals_objective ON approvals(objective_id);
      CREATE INDEX idx_approvals_task ON approvals(task_id);
      CREATE INDEX idx_delegations_delegated_task ON delegations(delegated_task_id);
    `,
  },
  {
    name: '007_secret_store',
    sql: `
      CREATE TABLE secrets (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE secret_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        secret_key TEXT NOT NULL,
        context TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending', 'resolved', 'dismissed')) DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
      );

      CREATE INDEX idx_secret_requests_status ON secret_requests(status);
      CREATE INDEX idx_secret_requests_key ON secret_requests(secret_key);
    `,
  },
];
