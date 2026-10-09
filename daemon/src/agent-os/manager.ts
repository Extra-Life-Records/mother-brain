import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { TaskLedger, Task } from '../tasks/index.js';

export type AgentStatus = 'provisioning' | 'idle' | 'running' | 'paused' | 'offline' | 'error';
export type AgentAutonomyMode = 'manual' | 'supervised' | 'autonomous';
export type ObjectiveStatus =
  | 'draft'
  | 'queued'
  | 'planning'
  | 'running'
  | 'waiting_approval'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'canceled';

export type DelegationStatus = 'requested' | 'accepted' | 'running' | 'answered' | 'rejected' | 'expired';
export type ApprovalType = 'publish' | 'spend' | 'external_action' | 'destructive_action' | 'policy_override';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface Agent {
  id: string;
  name: string;
  rolePrompt: string;
  status: AgentStatus;
  autonomyMode: AgentAutonomyMode;
  createdAt: string;
  updatedAt: string;
}

export interface DefinitionOfDoneSpec {
  objective?: string;
  criteria?: string[];
  requiredArtifactKinds?: Array<'file' | 'link' | 'text' | 'json' | string>;
}

export interface Objective {
  id: string;
  projectId: string | null;
  ownerAgentId: string | null;
  requestedBy: string;
  title: string;
  description: string;
  definitionOfDone: DefinitionOfDoneSpec;
  priority: number;
  status: ObjectiveStatus;
  startedAt: string | null;
  completedAt: string | null;
  resultSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ObjectiveSummary extends Objective {
  taskTotal: number;
  taskDone: number;
  taskFailed: number;
  taskQueued: number;
  taskRunning: number;
}

export interface Delegation {
  id: string;
  objectiveId: string;
  taskId: string;
  delegatedTaskId: string | null;
  fromAgentId: string;
  toAgentId: string;
  status: DelegationStatus;
  question: string;
  context: Record<string, unknown>;
  response: Record<string, unknown>;
  deadline: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Approval {
  id: string;
  objectiveId: string;
  taskId: string;
  requestedByAgentId: string;
  requestedFrom: string;
  approvalType: ApprovalType;
  reason: string;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface ObjectiveEvent {
  id: number;
  objectiveId: string;
  eventType: string;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface DoDVerification {
  objectiveId: string;
  passed: boolean;
  doneTaskCount: number;
  criteriaCount: number;
  criteriaSatisfied: number;
  missingCriteria: string[];
  requiredArtifactKinds: string[];
  presentArtifactKinds: string[];
  missingArtifactKinds: string[];
  artifactCount: number;
  summary: string;
}

export interface CreateAgentInput {
  name: string;
  rolePrompt?: string;
  autonomyMode?: AgentAutonomyMode;
}

export interface CreateObjectiveInput {
  projectId?: string | null;
  ownerAgentId?: string | null;
  requestedBy: string;
  title: string;
  description: string;
  definitionOfDone?: DefinitionOfDoneSpec;
  priority?: number;
}

export interface RunnableObjectiveTask {
  objective: Objective;
  task: Task;
  agent: Agent;
}

export interface CreateDelegationInput {
  taskId: string;
  toAgentNameOrId: string;
  question: string;
  deadline?: string | null;
}

interface AgentRow {
  id: string;
  name: string;
  role_prompt: string;
  status: AgentStatus;
  autonomy_mode: AgentAutonomyMode;
  created_at: string;
  updated_at: string;
}

interface ObjectiveRow {
  id: string;
  project_id: string | null;
  owner_agent_id: string | null;
  requested_by: string;
  title: string;
  description: string;
  definition_of_done: string;
  priority: number;
  status: ObjectiveStatus;
  started_at: string | null;
  completed_at: string | null;
  result_summary: string | null;
  created_at: string;
  updated_at: string;
}

interface ObjectiveSummaryRow extends ObjectiveRow {
  task_total: number;
  task_done: number;
  task_failed: number;
  task_queued: number;
  task_running: number;
}

interface ObjectiveTaskCounts {
  total: number;
  done: number;
  failed: number;
  queued: number;
  running: number;
}

type ObjectiveTaskPhase = 'research' | 'deliverable' | 'validate' | 'report' | 'remediation' | 'other';

interface DependencyCheckResult {
  ready: boolean;
  prerequisiteTask?: Task;
  reason?: string;
}

interface DelegationRow {
  id: string;
  objective_id: string;
  task_id: string;
  delegated_task_id: string | null;
  from_agent_id: string;
  to_agent_id: string;
  status: DelegationStatus;
  question: string;
  context_json: string;
  response_json: string;
  deadline: string | null;
  created_at: string;
  updated_at: string;
}

interface ApprovalRow {
  id: string;
  objective_id: string;
  task_id: string;
  requested_by_agent_id: string;
  requested_from: string;
  approval_type: ApprovalType;
  reason: string;
  payload_json: string;
  status: ApprovalStatus;
  decision_note: string | null;
  created_at: string;
  decided_at: string | null;
}

interface ObjectiveEventRow {
  id: number;
  objective_id: string;
  event_type: string;
  message: string;
  payload_json: string;
  created_at: string;
}

export class AgentOSManager {
  constructor(
    private db: Database.Database,
    private logger: Logger,
    private taskLedger: TaskLedger,
  ) {}

  ensureBootstrapAgent(): Agent {
    const existing = this.listAgents();
    if (existing.length > 0) return existing[0]!;
    return this.createAgent({
      name: 'generalist',
      rolePrompt: 'General autonomous operator that can research, execute, verify, and report.',
      autonomyMode: 'autonomous',
    });
  }

  createAgent(input: CreateAgentInput): Agent {
    const id = randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    const rolePrompt = input.rolePrompt?.trim().length
      ? input.rolePrompt.trim()
      : 'General autonomous operator that can execute machine tasks end-to-end.';

    this.db.prepare(`
      INSERT INTO agents (id, name, role_prompt, status, autonomy_mode, created_at, updated_at)
      VALUES (?, ?, ?, 'idle', ?, ?, ?)
    `).run(id, input.name.trim(), rolePrompt, input.autonomyMode ?? 'supervised', now, now);

    const created = this.getAgentById(id);
    if (!created) throw new Error('Agent was created but could not be loaded');
    this.logger.info({ agentId: created.id, name: created.name }, 'Agent created');
    return created;
  }

  listAgents(): Agent[] {
    const rows = this.db.prepare('SELECT * FROM agents ORDER BY created_at ASC').all() as AgentRow[];
    return rows.map(rowToAgent);
  }

  getAgentByNameOrId(nameOrId: string): Agent | null {
    const row = this.db.prepare(
      'SELECT * FROM agents WHERE id = ? OR lower(name) = lower(?) LIMIT 1'
    ).get(nameOrId, nameOrId) as AgentRow | undefined;
    return row ? rowToAgent(row) : null;
  }

  getAgentById(id: string): Agent | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined;
    return row ? rowToAgent(row) : null;
  }

  setAgentStatus(agentId: string, status: AgentStatus): void {
    this.db.prepare('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), agentId);
  }

  createObjective(input: CreateObjectiveInput): Objective {
    const id = randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    const ownerAgent = input.ownerAgentId
      ? this.getAgentById(input.ownerAgentId)
      : (this.findFirstAvailableAgent() ?? this.ensureBootstrapAgent());

    this.db.prepare(`
      INSERT INTO objectives (
        id, project_id, owner_agent_id, requested_by, title, description,
        definition_of_done, priority, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
    `).run(
      id,
      input.projectId ?? null,
      ownerAgent?.id ?? null,
      input.requestedBy,
      input.title.trim(),
      input.description.trim(),
      JSON.stringify(input.definitionOfDone ?? defaultDefinitionOfDone(input.description)),
      input.priority ?? 5,
      now,
      now,
    );

    const objective = this.getObjectiveById(id);
    if (!objective) throw new Error('Objective was created but could not be loaded');

    const assignedAgentId = ownerAgent?.id ?? null;
    const plannedTasks = buildObjectiveTaskPlan(objective.description);
    for (const title of plannedTasks) {
      this.taskLedger.create({
        title,
        type: 'general',
        priority: objective.priority,
        objectiveId: objective.id,
        assignedAgentId: assignedAgentId ?? undefined,
      });
    }

    this.recordEvent(objective.id, 'objective.created', `Objective queued: ${objective.title}`, {
      plannedTasks: plannedTasks.length,
      ownerAgentId: assignedAgentId,
    });
    return objective;
  }

  listObjectives(limit = 20): ObjectiveSummary[] {
    const rows = this.db.prepare(`
      SELECT
        o.*,
        COUNT(t.id) as task_total,
        SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) as task_done,
        SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) as task_failed,
        SUM(CASE WHEN t.status = 'queued' THEN 1 ELSE 0 END) as task_queued,
        SUM(CASE WHEN t.status = 'running' THEN 1 ELSE 0 END) as task_running
      FROM objectives o
      LEFT JOIN tasks t ON t.objective_id = o.id
      GROUP BY o.id
      ORDER BY
        CASE o.status
          WHEN 'running' THEN 0
          WHEN 'waiting_approval' THEN 1
          WHEN 'queued' THEN 2
          WHEN 'blocked' THEN 3
          ELSE 4
        END,
        o.created_at DESC
      LIMIT ?
    `).all(limit) as ObjectiveSummaryRow[];

    return rows.map((row) => ({
      ...rowToObjective(row),
      taskTotal: row.task_total ?? 0,
      taskDone: row.task_done ?? 0,
      taskFailed: row.task_failed ?? 0,
      taskQueued: row.task_queued ?? 0,
      taskRunning: row.task_running ?? 0,
    }));
  }

  getObjectiveById(id: string): Objective | null {
    const row = this.db.prepare('SELECT * FROM objectives WHERE id = ?').get(id) as ObjectiveRow | undefined;
    return row ? rowToObjective(row) : null;
  }

  getObjectiveTasks(objectiveId: string): Task[] {
    const rows = this.db.prepare(`
      SELECT id FROM tasks
      WHERE objective_id = ?
      ORDER BY created_at ASC
    `).all(objectiveId) as Array<{ id: string }>;

    const tasks: Task[] = [];
    for (const row of rows) {
      const task = this.taskLedger.getById(row.id);
      if (task) tasks.push(task);
    }
    return tasks;
  }

  listObjectiveEvents(objectiveId: string, limit = 50, afterId = 0): ObjectiveEvent[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM objective_events
      WHERE objective_id = ?
        AND id > ?
      ORDER BY id ASC
      LIMIT ?
    `).all(objectiveId, afterId, limit) as ObjectiveEventRow[];
    return rows.map(rowToObjectiveEvent);
  }

  pickNextRunnableTask(): RunnableObjectiveTask | null {
    this.resumeRecoverableFailuresForBlockedObjectives();

    const rows = this.db.prepare(`
      SELECT
        t.id as task_id,
        o.id as objective_id,
        COALESCE(t.assigned_agent_id, o.owner_agent_id) as agent_id
      FROM tasks t
      JOIN objectives o ON o.id = t.objective_id
      WHERE t.status = 'queued'
        AND o.status IN ('queued', 'running', 'blocked')
      ORDER BY o.priority DESC, t.priority DESC, t.created_at ASC
      LIMIT 200
    `).all() as Array<{ task_id: string; objective_id: string; agent_id: string | null }>;

    if (rows.length === 0) return null;

    for (const row of rows) {
      const task = this.taskLedger.getById(row.task_id);
      const objective = this.getObjectiveById(row.objective_id);
      if (!task || !objective) continue;

      const dependency = this.checkTaskDependencies(task);
      if (!dependency.ready) {
        if (dependency.prerequisiteTask && this.tryAutoRetryPrerequisite(objective, task, dependency.prerequisiteTask)) {
          continue;
        }

        this.markObjectiveBlockedByDependency(objective, task, dependency);
        continue;
      }

      const agent = row.agent_id
        ? this.getAgentById(row.agent_id)
        : (this.findFirstAvailableAgent() ?? this.ensureBootstrapAgent());
      if (!agent) return null;

      this.db.prepare('UPDATE tasks SET assigned_agent_id = ? WHERE id = ?').run(agent.id, task.id);

      if (objective.status === 'queued' || objective.status === 'blocked') {
        const previous = objective.status;
        this.updateObjectiveStatus(objective.id, 'running');
        this.db.prepare('UPDATE objectives SET started_at = ? WHERE id = ? AND started_at IS NULL')
          .run(new Date().toISOString(), objective.id);
        if (previous === 'blocked') {
          this.recordEvent(
            objective.id,
            'objective.auto_resumed',
            'Objective resumed because queued tasks are still available',
            {
              previous,
              next: 'running',
              taskId: task.id,
            },
          );
        }
      }

      return { objective, task, agent };
    }

    return null;
  }

  ensureTaskApproval(
    task: Task,
    objective: Objective,
    agent: Agent,
  ): { state: 'approved' | 'pending'; approval?: Approval; created: boolean } {
    if (!requiresApprovalForTask(task.title)) {
      return { state: 'approved', created: false };
    }

    const approved = this.db.prepare(`
      SELECT * FROM approvals
      WHERE task_id = ? AND status = 'approved'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(task.id) as ApprovalRow | undefined;
    if (approved) {
      return { state: 'approved', approval: rowToApproval(approved), created: false };
    }

    const pending = this.db.prepare(`
      SELECT * FROM approvals
      WHERE task_id = ? AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(task.id) as ApprovalRow | undefined;
    if (pending) {
      return { state: 'pending', approval: rowToApproval(pending), created: false };
    }

    const approvalId = randomUUID().slice(0, 8);
    const reason = `Task requires approval before execution: ${task.title}`;
    const approvalType = inferApprovalType(task.title);

    this.db.prepare(`
      INSERT INTO approvals (
        id, objective_id, task_id, requested_by_agent_id, requested_from,
        approval_type, reason, payload_json, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      approvalId,
      objective.id,
      task.id,
      agent.id,
      objective.requestedBy,
      approvalType,
      reason,
      JSON.stringify({ taskTitle: task.title }),
    );

    this.db.prepare(`
      UPDATE tasks
      SET status = 'blocked', block_reason = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(`Waiting approval: ${approvalId}`, new Date().toISOString(), task.id);

    this.updateObjectiveStatus(objective.id, 'waiting_approval');
    this.recordEvent(objective.id, 'approval.requested', `Approval requested for task ${task.id}`, {
      approvalId,
      taskId: task.id,
      agentId: agent.id,
      approvalType,
    });

    const created = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as ApprovalRow;
    return { state: 'pending', approval: rowToApproval(created), created: true };
  }

  listApprovals(status: ApprovalStatus | 'all' = 'pending', limit = 25): Approval[] {
    const rows = status === 'all'
      ? this.db.prepare('SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?').all(limit) as ApprovalRow[]
      : this.db.prepare('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit) as ApprovalRow[];
    return rows.map(rowToApproval);
  }

  decideApproval(
    approvalId: string,
    decision: 'approved' | 'rejected',
    note?: string,
  ): Approval | null {
    const approval = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as ApprovalRow | undefined;
    if (!approval || approval.status !== 'pending') return null;

    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE approvals
      SET status = ?, decision_note = ?, decided_at = ?
      WHERE id = ?
    `).run(decision, note ?? null, now, approvalId);

    if (decision === 'approved') {
      this.db.prepare(`
        UPDATE tasks
        SET status = 'queued', block_reason = NULL, updated_at = ?
        WHERE id = ? AND status = 'blocked'
      `).run(now, approval.task_id);

      const remainingPending = this.countPendingApprovals(approval.objective_id);
      if (remainingPending === 0) {
        const objective = this.getObjectiveById(approval.objective_id);
        if (objective && objective.status === 'waiting_approval') {
          this.updateObjectiveStatus(approval.objective_id, 'running');
        }
      }
      this.recordEvent(approval.objective_id, 'approval.approved', `Approval ${approvalId} approved`, {
        taskId: approval.task_id,
      });
    } else {
      this.taskLedger.fail(approval.task_id, `Approval rejected: ${note ?? 'No reason provided'}`);
      this.updateObjectiveStatus(approval.objective_id, 'blocked');
      this.recordEvent(approval.objective_id, 'approval.rejected', `Approval ${approvalId} rejected`, {
        taskId: approval.task_id,
      });
    }

    const updated = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as ApprovalRow | undefined;
    return updated ? rowToApproval(updated) : null;
  }

  createDelegation(input: CreateDelegationInput): Delegation {
    const parentTask = this.taskLedger.getById(input.taskId);
    if (!parentTask) throw new Error(`Task not found: ${input.taskId}`);
    if (!parentTask.objectiveId) throw new Error('Task must belong to an objective to delegate');

    const objective = this.getObjectiveById(parentTask.objectiveId);
    if (!objective) throw new Error(`Objective not found for task: ${input.taskId}`);

    const toAgent = this.getAgentByNameOrId(input.toAgentNameOrId);
    if (!toAgent) throw new Error(`Agent not found: ${input.toAgentNameOrId}`);

    const fromAgentId = parentTask.assignedAgentId ?? objective.ownerAgentId ?? this.ensureBootstrapAgent().id;

    const delegatedTask = this.taskLedger.create({
      title: `Delegated work: ${input.question}`,
      type: 'general',
      priority: parentTask.priority,
      parentTaskId: parentTask.id,
      objectiveId: objective.id,
      assignedAgentId: toAgent.id,
    });

    const delegationId = randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO delegations (
        id, objective_id, task_id, delegated_task_id, from_agent_id, to_agent_id,
        status, question, context_json, response_json, deadline, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, '{}', '{}', ?, ?, ?)
    `).run(
      delegationId,
      objective.id,
      parentTask.id,
      delegatedTask.id,
      fromAgentId,
      toAgent.id,
      input.question.trim(),
      input.deadline ?? null,
      now,
      now,
    );

    this.db.prepare(`
      UPDATE tasks
      SET status = 'blocked', block_reason = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(`Delegated to ${toAgent.name}: ${delegationId}`, now, parentTask.id);

    this.recordEvent(objective.id, 'delegation.created', `Delegated task ${parentTask.id} to ${toAgent.name}`, {
      delegationId,
      parentTaskId: parentTask.id,
      delegatedTaskId: delegatedTask.id,
      fromAgentId,
      toAgentId: toAgent.id,
    });

    const row = this.db.prepare('SELECT * FROM delegations WHERE id = ?').get(delegationId) as DelegationRow | undefined;
    if (!row) throw new Error('Delegation created but could not be loaded');
    return rowToDelegation(row);
  }

  listDelegations(status: DelegationStatus | 'active' | 'all' = 'active', limit = 25): Delegation[] {
    let rows: DelegationRow[];
    if (status === 'all') {
      rows = this.db.prepare('SELECT * FROM delegations ORDER BY created_at DESC LIMIT ?').all(limit) as DelegationRow[];
    } else if (status === 'active') {
      rows = this.db.prepare(`
        SELECT * FROM delegations
        WHERE status IN ('requested', 'accepted', 'running')
        ORDER BY created_at DESC
        LIMIT ?
      `).all(limit) as DelegationRow[];
    } else {
      rows = this.db.prepare(`
        SELECT * FROM delegations
        WHERE status = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(status, limit) as DelegationRow[];
    }
    return rows.map(rowToDelegation);
  }

  getDelegationById(id: string): Delegation | null {
    const row = this.db.prepare('SELECT * FROM delegations WHERE id = ?').get(id) as DelegationRow | undefined;
    return row ? rowToDelegation(row) : null;
  }

  verifyObjectiveDefinitionOfDone(objectiveId: string): DoDVerification {
    const objective = this.getObjectiveById(objectiveId);
    if (!objective) {
      return {
        objectiveId,
        passed: false,
        doneTaskCount: 0,
        criteriaCount: 0,
        criteriaSatisfied: 0,
        missingCriteria: ['Objective not found'],
        requiredArtifactKinds: [],
        presentArtifactKinds: [],
        missingArtifactKinds: [],
        artifactCount: 0,
        summary: 'Objective not found',
      };
    }

    const tasks = this.getObjectiveTasks(objectiveId);
    const doneTasks = tasks.filter((task) => task.status === 'done');
    const criteria = Array.isArray(objective.definitionOfDone.criteria)
      ? objective.definitionOfDone.criteria.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const requiredArtifactKinds = Array.isArray(objective.definitionOfDone.requiredArtifactKinds)
      ? objective.definitionOfDone.requiredArtifactKinds
          .map((kind) => String(kind).toLowerCase().trim())
          .filter((kind) => kind.length > 0)
      : [];

    const allArtifacts = doneTasks.flatMap((task) => task.artifacts);
    const presentArtifactKinds = Array.from(new Set(allArtifacts.map((artifact) => artifact.type.toLowerCase())));
    const missingArtifactKinds = requiredArtifactKinds.filter((kind) => !presentArtifactKinds.includes(kind));

    const evidenceText = doneTasks
      .flatMap((task) => [
        task.title,
        ...task.artifacts.map((artifact) => `${artifact.label} ${String(artifact.value).slice(0, 200)}`),
      ])
      .join(' ')
      .toLowerCase();

    const criteriaResults = criteria.map((criterion) => ({
      criterion,
      satisfied: criterionSatisfied(criterion, evidenceText, doneTasks.length),
    }));
    const missingCriteria = criteriaResults.filter((item) => !item.satisfied).map((item) => item.criterion);

    const passed =
      doneTasks.length > 0 &&
      missingCriteria.length === 0 &&
      missingArtifactKinds.length === 0;

    return {
      objectiveId,
      passed,
      doneTaskCount: doneTasks.length,
      criteriaCount: criteria.length,
      criteriaSatisfied: criteriaResults.filter((item) => item.satisfied).length,
      missingCriteria,
      requiredArtifactKinds,
      presentArtifactKinds,
      missingArtifactKinds,
      artifactCount: allArtifacts.length,
      summary: passed
        ? 'Definition of done verified'
        : `Missing criteria: ${missingCriteria.length}, missing artifact kinds: ${missingArtifactKinds.length}`,
    };
  }

  refreshObjectiveStatusFromTask(taskId: string): Objective | null {
    const task = this.taskLedger.getById(taskId);
    if (!task?.objectiveId) return null;

    if (task.status === 'done' || task.status === 'failed') {
      this.reconcileDelegationOutcome(task);
    }

    const objective = this.getObjectiveById(task.objectiveId);
    if (!objective) return null;

    const counts = this.getTaskCounts(objective.id);
    const pendingApprovals = this.countPendingApprovals(objective.id);
    let nextStatus: ObjectiveStatus = objective.status;
    let verificationSummary: string | null = null;

    if (pendingApprovals > 0) {
      nextStatus = 'waiting_approval';
    } else if (counts.running > 0) {
      nextStatus = 'running';
    } else if (counts.queued > 0) {
      const queuedTasks = this.getObjectiveTasks(objective.id).filter((item) => item.status === 'queued');
      const hasRunnableQueuedTask = queuedTasks.some((item) => this.checkTaskDependencies(item).ready);
      nextStatus = hasRunnableQueuedTask ? 'running' : 'blocked';
    } else if (counts.failed > 0) {
      nextStatus = 'blocked';
    } else if (counts.total > 0 && counts.done === counts.total) {
      const verification = this.verifyObjectiveDefinitionOfDone(objective.id);
      verificationSummary = verification.summary;
      if (verification.passed) {
        nextStatus = 'completed';
      } else {
        nextStatus = 'blocked';
        this.ensureDefinitionOfDoneRemediationTask(objective, verification);
      }
    }

    if (nextStatus !== objective.status) {
      this.updateObjectiveStatus(objective.id, nextStatus);
      this.recordEvent(objective.id, 'objective.status_changed', `Objective status: ${nextStatus}`, {
        previous: objective.status,
        next: nextStatus,
        counts,
        pendingApprovals,
      });
    }

    if (nextStatus === 'completed') {
      this.db.prepare(`
        UPDATE objectives
        SET completed_at = COALESCE(completed_at, ?),
            result_summary = COALESCE(result_summary, ?),
            updated_at = ?
        WHERE id = ?
      `).run(
        new Date().toISOString(),
        verificationSummary ?? 'All planned objective tasks completed.',
        new Date().toISOString(),
        objective.id,
      );
    }

    return this.getObjectiveById(objective.id);
  }

  recordExecutionFailure(taskId: string, reason: string): Objective | null {
    const failedTask = this.taskLedger.fail(taskId, reason);
    if (!failedTask) return this.refreshObjectiveStatusFromTask(taskId);

    if (isAutoRecoverableFailure(reason) && failedTask.executionCount < 2) {
      const resumed = this.taskLedger.resume(taskId);
      if (resumed && failedTask.objectiveId) {
        this.recordEvent(
          failedTask.objectiveId,
          'task.auto_retry_queued',
          `Auto-retry queued for task ${failedTask.id} after recoverable failure`,
          {
            taskId: failedTask.id,
            reason,
            previousExecutionCount: failedTask.executionCount,
          },
        );
      }
    }

    return this.refreshObjectiveStatusFromTask(taskId);
  }

  private reconcileDelegationOutcome(task: Task): void {
    const delegation = this.db.prepare(`
      SELECT * FROM delegations
      WHERE delegated_task_id = ?
        AND status IN ('requested', 'accepted', 'running')
      LIMIT 1
    `).get(task.id) as DelegationRow | undefined;

    if (!delegation) return;
    const now = new Date().toISOString();

    if (task.status === 'done') {
      this.db.prepare(`
        UPDATE delegations
        SET status = 'answered', response_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        JSON.stringify({
          delegatedTaskId: task.id,
          taskTitle: task.title,
          artifactCount: task.artifacts.length,
          completedAt: task.completedAt,
        }),
        now,
        delegation.id,
      );

      if (task.artifacts.length > 0) {
        this.taskLedger.addArtifact(delegation.task_id, {
          type: 'json',
          label: `Delegation ${delegation.id} response`,
          value: JSON.stringify({
            fromAgentId: delegation.to_agent_id,
            delegatedTaskId: task.id,
            artifacts: task.artifacts,
          }),
        });
      }

      const parentTask = this.taskLedger.getById(delegation.task_id);
      if (parentTask && parentTask.status === 'blocked') {
        this.taskLedger.resume(parentTask.id);
      }

      this.recordEvent(delegation.objective_id, 'delegation.answered', `Delegation ${delegation.id} answered`, {
        taskId: delegation.task_id,
        delegatedTaskId: task.id,
      });
      return;
    }

    if (task.status === 'failed') {
      this.db.prepare(`
        UPDATE delegations
        SET status = 'rejected', response_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        JSON.stringify({
          delegatedTaskId: task.id,
          error: task.lastError,
          completedAt: task.completedAt,
        }),
        now,
        delegation.id,
      );
      this.recordEvent(delegation.objective_id, 'delegation.failed', `Delegation ${delegation.id} failed`, {
        taskId: delegation.task_id,
        delegatedTaskId: task.id,
        error: task.lastError,
      });
    }
  }

  private ensureDefinitionOfDoneRemediationTask(
    objective: Objective,
    verification: DoDVerification,
  ): void {
    const existing = this.db.prepare(`
      SELECT id FROM tasks
      WHERE objective_id = ?
        AND status IN ('queued', 'running', 'blocked')
        AND title LIKE 'Address Definition-of-Done gaps:%'
      LIMIT 1
    `).get(objective.id) as { id: string } | undefined;
    if (existing) return;

    const headline =
      verification.missingCriteria[0]
      ?? verification.missingArtifactKinds[0]
      ?? 'Complete remaining quality requirements';

    this.taskLedger.create({
      title: `Address Definition-of-Done gaps: ${headline}`,
      type: 'general',
      priority: Math.max(objective.priority, 7),
      objectiveId: objective.id,
      assignedAgentId: objective.ownerAgentId ?? undefined,
    });

    this.recordEvent(objective.id, 'objective.dod_failed', 'Definition of done not met; remediation task queued', {
      missingCriteria: verification.missingCriteria,
      missingArtifactKinds: verification.missingArtifactKinds,
    });
  }

  private checkTaskDependencies(task: Task): DependencyCheckResult {
    if (!task.objectiveId) return { ready: true };

    const phase = classifyObjectiveTaskPhase(task.title);
    const prerequisitePhase = prerequisitePhaseFor(phase);
    if (!prerequisitePhase) return { ready: true };

    const prerequisiteTask = this.findObjectiveTaskByPhase(task.objectiveId, prerequisitePhase);
    if (!prerequisiteTask) return { ready: true };

    if (prerequisiteTask.status === 'done') {
      return { ready: true };
    }

    const description = prerequisiteTask.lastError ?? prerequisiteTask.blockReason ?? prerequisiteTask.status;
    return {
      ready: false,
      prerequisiteTask,
      reason: `${phaseDisplayName(phase)} is waiting for ${phaseDisplayName(prerequisitePhase)} task ${prerequisiteTask.id} (${prerequisiteTask.status}): ${description}`,
    };
  }

  private findObjectiveTaskByPhase(objectiveId: string, phase: ObjectiveTaskPhase): Task | null {
    const tasks = this.getObjectiveTasks(objectiveId);
    return tasks.find((item) => classifyObjectiveTaskPhase(item.title) === phase) ?? null;
  }

  private tryAutoRetryPrerequisite(
    objective: Objective,
    blockedTask: Task,
    prerequisiteTask: Task,
  ): boolean {
    if (prerequisiteTask.status !== 'failed') return false;
    if (!prerequisiteTask.lastError || !isAutoRecoverableFailure(prerequisiteTask.lastError)) return false;
    if (prerequisiteTask.executionCount >= 2) return false;

    const resumed = this.taskLedger.resume(prerequisiteTask.id);
    if (!resumed) return false;

    if (objective.status === 'blocked') {
      this.updateObjectiveStatus(objective.id, 'running');
    }

    this.recordEvent(
      objective.id,
      'task.auto_retry_queued',
      `Auto-retry queued for prerequisite task ${prerequisiteTask.id} while unblocking ${blockedTask.id}`,
      {
        taskId: prerequisiteTask.id,
        dependentTaskId: blockedTask.id,
        reason: prerequisiteTask.lastError,
        previousExecutionCount: prerequisiteTask.executionCount,
      },
    );
    return true;
  }

  private markObjectiveBlockedByDependency(
    objective: Objective,
    blockedTask: Task,
    dependency: DependencyCheckResult,
  ): void {
    if (objective.status === 'waiting_approval' || objective.status === 'blocked') return;

    this.updateObjectiveStatus(objective.id, 'blocked');
    this.recordEvent(
      objective.id,
      'objective.blocked_dependency',
      `Objective blocked by task dependency for ${blockedTask.id}`,
      {
        taskId: blockedTask.id,
        reason: dependency.reason ?? 'Queued task is waiting on a prerequisite',
        prerequisiteTaskId: dependency.prerequisiteTask?.id ?? null,
      },
    );
  }

  private resumeRecoverableFailuresForBlockedObjectives(): void {
    const rows = this.db.prepare(`
      SELECT id
      FROM objectives
      WHERE status = 'blocked'
      ORDER BY priority DESC, updated_at ASC
      LIMIT 50
    `).all() as Array<{ id: string }>;

    for (const row of rows) {
      const failedTask = this.findRecoverableFailedTask(row.id);
      if (!failedTask || !failedTask.lastError) continue;

      const resumed = this.taskLedger.resume(failedTask.id);
      if (!resumed) continue;

      this.updateObjectiveStatus(row.id, 'running');
      this.recordEvent(
        row.id,
        'task.auto_retry_queued',
        `Auto-retry queued for recoverable failed task ${failedTask.id}`,
        {
          taskId: failedTask.id,
          reason: failedTask.lastError,
          previousExecutionCount: failedTask.executionCount,
          source: 'blocked-objective-recovery',
        },
      );
      this.recordEvent(
        row.id,
        'objective.auto_resumed',
        'Objective resumed after recoverable failure retry was queued',
        {
          taskId: failedTask.id,
          previous: 'blocked',
          next: 'running',
        },
      );
    }
  }

  private findRecoverableFailedTask(objectiveId: string): Task | null {
    const failed = this.getObjectiveTasks(objectiveId)
      .filter((task) =>
        task.status === 'failed' &&
        task.executionCount < 2 &&
        typeof task.lastError === 'string' &&
        isAutoRecoverableFailure(task.lastError),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    return failed[0] ?? null;
  }

  private updateObjectiveStatus(objectiveId: string, status: ObjectiveStatus): void {
    this.db.prepare('UPDATE objectives SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), objectiveId);
  }

  private findFirstAvailableAgent(): Agent | null {
    const row = this.db.prepare(`
      SELECT * FROM agents
      WHERE status IN ('idle', 'running')
      ORDER BY CASE status WHEN 'idle' THEN 0 ELSE 1 END, created_at ASC
      LIMIT 1
    `).get() as AgentRow | undefined;
    return row ? rowToAgent(row) : null;
  }

  private getTaskCounts(objectiveId: string): ObjectiveTaskCounts {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as queued,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running
      FROM tasks
      WHERE objective_id = ?
    `).get(objectiveId) as {
      total: number;
      done: number | null;
      failed: number | null;
      queued: number | null;
      running: number | null;
    };

    return {
      total: row.total ?? 0,
      done: row.done ?? 0,
      failed: row.failed ?? 0,
      queued: row.queued ?? 0,
      running: row.running ?? 0,
    };
  }

  private countPendingApprovals(objectiveId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM approvals
      WHERE objective_id = ?
        AND status = 'pending'
    `).get(objectiveId) as { count: number };
    return row.count ?? 0;
  }

  private recordEvent(
    objectiveId: string,
    eventType: string,
    message: string,
    payload: Record<string, unknown>,
  ): void {
    this.db.prepare(`
      INSERT INTO objective_events (objective_id, event_type, message, payload_json)
      VALUES (?, ?, ?, ?)
    `).run(objectiveId, eventType, message, JSON.stringify(payload));
  }
}

function rowToAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    rolePrompt: row.role_prompt,
    status: row.status,
    autonomyMode: row.autonomy_mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToObjective(row: ObjectiveRow): Objective {
  return {
    id: row.id,
    projectId: row.project_id,
    ownerAgentId: row.owner_agent_id,
    requestedBy: row.requested_by,
    title: row.title,
    description: row.description,
    definitionOfDone: safeParse(row.definition_of_done, {}),
    priority: row.priority,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    resultSummary: row.result_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToDelegation(row: DelegationRow): Delegation {
  return {
    id: row.id,
    objectiveId: row.objective_id,
    taskId: row.task_id,
    delegatedTaskId: row.delegated_task_id,
    fromAgentId: row.from_agent_id,
    toAgentId: row.to_agent_id,
    status: row.status,
    question: row.question,
    context: safeParse(row.context_json, {}),
    response: safeParse(row.response_json, {}),
    deadline: row.deadline,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    objectiveId: row.objective_id,
    taskId: row.task_id,
    requestedByAgentId: row.requested_by_agent_id,
    requestedFrom: row.requested_from,
    approvalType: row.approval_type,
    reason: row.reason,
    payload: safeParse(row.payload_json, {}),
    status: row.status,
    decisionNote: row.decision_note,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

function rowToObjectiveEvent(row: ObjectiveEventRow): ObjectiveEvent {
  return {
    id: row.id,
    objectiveId: row.objective_id,
    eventType: row.event_type,
    message: row.message,
    payload: safeParse(row.payload_json, {}),
    createdAt: row.created_at,
  };
}

function safeParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function defaultDefinitionOfDone(description: string): DefinitionOfDoneSpec {
  return {
    objective: description,
    criteria: [
      'Research completed and key findings documented',
      'Primary deliverable produced and saved as artifact',
      'Verification checks executed',
      'Progress and next actions reported to owner',
    ],
    requiredArtifactKinds: ['json'],
  };
}

function buildObjectiveTaskPlan(description: string): string[] {
  const normalized = description.trim();
  return [
    `Research and gather actionable context for: ${normalized}`,
    `Produce the primary deliverable for: ${normalized}`,
    `Validate quality and completeness for: ${normalized}`,
    `Create a progress report and next-step recommendations for: ${normalized}`,
  ];
}

function requiresApprovalForTask(taskTitle: string): boolean {
  return /\b(publish|deploy|post|launch|payment|buy|purchase|spend|invoice|wire|delete|destroy|drop\s+table|rm\s+-rf)\b/i
    .test(taskTitle);
}

function inferApprovalType(taskTitle: string): ApprovalType {
  if (/\b(publish|post|launch|deploy)\b/i.test(taskTitle)) return 'publish';
  if (/\b(payment|buy|purchase|spend|invoice|wire)\b/i.test(taskTitle)) return 'spend';
  if (/\b(delete|destroy|drop\s+table|rm\s+-rf)\b/i.test(taskTitle)) return 'destructive_action';
  return 'external_action';
}

function criterionSatisfied(criterion: string, evidenceText: string, doneTaskCount: number): boolean {
  if (doneTaskCount === 0) return false;
  const tokens = criterion
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 5 && !STOP_WORDS.has(token));

  if (tokens.length === 0) return doneTaskCount > 0;
  const matched = tokens.filter((token) => evidenceText.includes(token));
  return matched.length >= Math.min(1, tokens.length);
}

const STOP_WORDS = new Set([
  'about', 'above', 'after', 'again', 'before', 'being', 'between',
  'could', 'their', 'there', 'these', 'those', 'which', 'should', 'would',
  'reported', 'completed',
]);

function isAutoRecoverableFailure(reason: string): boolean {
  const lower = reason.toLowerCase();
  return (
    lower.includes('planner failed to generate a valid plan') ||
    lower.includes('pipeline failed to generate a plan') ||
    lower.includes('http 429') ||
    lower.includes('too many requests') ||
    lower.includes('rate limit') ||
    lower.includes('unknown model') ||
    lower.includes('model_not_found')
  );
}

function classifyObjectiveTaskPhase(title: string): ObjectiveTaskPhase {
  if (/^\s*research and gather actionable context for:/i.test(title)) return 'research';
  if (/^\s*produce the primary deliverable for:/i.test(title)) return 'deliverable';
  if (/^\s*validate quality and completeness for:/i.test(title)) return 'validate';
  if (/^\s*create a progress report and next-step recommendations for:/i.test(title)) return 'report';
  if (/^address definition-of-done gaps:/i.test(title)) return 'remediation';
  return 'other';
}

function prerequisitePhaseFor(phase: ObjectiveTaskPhase): ObjectiveTaskPhase | null {
  if (phase === 'deliverable') return 'research';
  if (phase === 'validate') return 'deliverable';
  if (phase === 'report') return 'validate';
  return null;
}

function phaseDisplayName(phase: ObjectiveTaskPhase): string {
  if (phase === 'research') return 'research';
  if (phase === 'deliverable') return 'deliverable';
  if (phase === 'validate') return 'validation';
  if (phase === 'report') return 'progress report';
  if (phase === 'remediation') return 'definition-of-done remediation';
  return 'task';
}
