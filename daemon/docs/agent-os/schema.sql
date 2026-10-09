-- Agent OS schema contract
-- Target: SQLite (compatible with current daemon runtime)

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mobile_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('telegram', 'web', 'mobile_app')),
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mobile_sessions_user ON mobile_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_mobile_sessions_expires ON mobile_sessions(expires_at);

CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  os TEXT NOT NULL,
  arch TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('online', 'offline', 'degraded', 'draining')),
  labels_json TEXT NOT NULL DEFAULT '{}',
  last_heartbeat_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS host_capabilities (
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  limits_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (host_id, capability)
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_owner_name ON projects(owner_user_id, name);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host_id TEXT REFERENCES hosts(id),
  name TEXT NOT NULL,
  role_prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('provisioning', 'idle', 'running', 'paused', 'offline', 'error')),
  autonomy_mode TEXT NOT NULL DEFAULT 'supervised' CHECK (autonomy_mode IN ('manual', 'supervised', 'autonomous')),
  max_concurrency INTEGER NOT NULL DEFAULT 1,
  memory_policy_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_owner_name ON agents(owner_user_id, name);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_host ON agents(host_id);

CREATE TABLE IF NOT EXISTS agent_capabilities (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  approval_level TEXT NOT NULL DEFAULT 'none' CHECK (approval_level IN ('none', 'high_risk', 'always')),
  PRIMARY KEY (agent_id, capability)
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  owner_agent_id TEXT REFERENCES agents(id),
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('execution', 'analysis', 'integration', 'meta')),
  status TEXT NOT NULL CHECK (status IN ('active', 'deprecated', 'disabled')),
  source_repo TEXT,
  path TEXT,
  checksum TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_name_version ON skills(name, version);

CREATE TABLE IF NOT EXISTS tools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('shell', 'browser', 'file', 'http', 'custom')),
  executor TEXT NOT NULL,
  version TEXT NOT NULL,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  enabled INTEGER NOT NULL DEFAULT 1,
  schema_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_tools (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'allow' CHECK (mode IN ('allow', 'deny', 'ask')),
  PRIMARY KEY (agent_id, tool_id)
);

CREATE TABLE IF NOT EXISTS objectives (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requested_by_user_id TEXT NOT NULL REFERENCES users(id),
  owner_agent_id TEXT REFERENCES agents(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL CHECK (status IN ('draft', 'queued', 'planning', 'running', 'waiting_approval', 'blocked', 'completed', 'failed', 'canceled')),
  definition_of_done_json TEXT NOT NULL,
  budget_limit_usd REAL,
  due_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  result_summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_objectives_project ON objectives(project_id);
CREATE INDEX IF NOT EXISTS idx_objectives_owner ON objectives(owner_agent_id);
CREATE INDEX IF NOT EXISTS idx_objectives_status ON objectives(status);

CREATE TABLE IF NOT EXISTS objective_dependencies (
  objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
  depends_on_objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
  PRIMARY KEY (objective_id, depends_on_objective_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
  parent_task_id TEXT REFERENCES tasks(id),
  assigned_agent_id TEXT REFERENCES agents(id),
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('research', 'coding', 'writing', 'marketing', 'ops', 'review', 'custom')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'retrying', 'delegated', 'waiting_input', 'blocked', 'done', 'failed', 'canceled')),
  input_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT NOT NULL DEFAULT '{}',
  definition_of_done_json TEXT NOT NULL DEFAULT '{}',
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 2,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_objective ON tasks(objective_id);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS delegations (
  id TEXT PRIMARY KEY,
  objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_agent_id TEXT NOT NULL REFERENCES agents(id),
  to_agent_id TEXT NOT NULL REFERENCES agents(id),
  status TEXT NOT NULL CHECK (status IN ('requested', 'accepted', 'running', 'answered', 'rejected', 'expired')),
  question TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  response_json TEXT NOT NULL DEFAULT '{}',
  deadline TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_delegations_task ON delegations(task_id);
CREATE INDEX IF NOT EXISTS idx_delegations_to_agent ON delegations(to_agent_id);
CREATE INDEX IF NOT EXISTS idx_delegations_status ON delegations(status);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  host_id TEXT REFERENCES hosts(id),
  status TEXT NOT NULL CHECK (status IN ('running', 'waiting_approval', 'blocked', 'completed', 'failed', 'canceled')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_objective ON runs(objective_id);
CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

CREATE TABLE IF NOT EXISTS run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id),
  step_index INTEGER NOT NULL,
  tool_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed', 'skipped')),
  input_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT NOT NULL DEFAULT '{}',
  error_text TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_run_steps_run ON run_steps(run_id);
CREATE INDEX IF NOT EXISTS idx_run_steps_task ON run_steps(task_id);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  objective_id TEXT REFERENCES objectives(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  requested_by_agent_id TEXT NOT NULL REFERENCES agents(id),
  requested_from_user_id TEXT NOT NULL REFERENCES users(id),
  approval_type TEXT NOT NULL CHECK (approval_type IN ('publish', 'spend', 'external_action', 'destructive_action', 'policy_override')),
  reason TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  decision_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_approvals_objective ON approvals(objective_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('telegram', 'web', 'mobile_app', 'internal')),
  from_type TEXT NOT NULL CHECK (from_type IN ('user', 'agent', 'system')),
  from_id TEXT NOT NULL,
  to_type TEXT NOT NULL CHECK (to_type IN ('user', 'agent', 'system')),
  to_id TEXT NOT NULL,
  objective_id TEXT REFERENCES objectives(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  requires_reply INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'read', 'replied')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT,
  replied_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_type, to_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_objective ON messages(objective_id);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  stream TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_stream_time ON events(stream, created_at);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_type, entity_id, created_at);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project', 'objective', 'task')),
  memory_key TEXT NOT NULL,
  content TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 1,
  embedding_ref TEXT,
  last_accessed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_agent_scope_key ON memories(agent_id, scope, memory_key);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  objective_id TEXT REFERENCES objectives(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('document', 'report', 'code', 'media', 'link', 'binary')),
  uri TEXT NOT NULL,
  summary TEXT,
  checksum TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_artifacts_objective ON artifacts(objective_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);

CREATE TABLE IF NOT EXISTS budget_ledger (
  id TEXT PRIMARY KEY,
  objective_id TEXT REFERENCES objectives(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_budget_objective ON budget_ledger(objective_id, created_at);
CREATE INDEX IF NOT EXISTS idx_budget_run ON budget_ledger(run_id);

