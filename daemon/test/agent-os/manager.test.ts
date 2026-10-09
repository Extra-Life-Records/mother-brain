import test from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { DatabaseManager } from '../../src/db/database.ts';
import { TaskLedger } from '../../src/tasks/ledger.ts';
import { AgentOSManager } from '../../src/agent-os/manager.ts';

function createSilentLogger() {
  return pino({ level: 'silent' });
}

test('creates bootstrap agent when none exists', async () => {
  const logger = createSilentLogger();
  const db = new DatabaseManager(':memory:', logger);
  await db.start();

  const ledger = new TaskLedger(db.connection, logger);
  const manager = new AgentOSManager(db.connection, logger, ledger);

  const agent = manager.ensureBootstrapAgent();
  assert.equal(agent.name, 'generalist');
  assert.equal(manager.listAgents().length, 1);

  await db.stop();
});

test('creates objective and planned tasks assigned to an agent', async () => {
  const logger = createSilentLogger();
  const db = new DatabaseManager(':memory:', logger);
  await db.start();

  const ledger = new TaskLedger(db.connection, logger);
  const manager = new AgentOSManager(db.connection, logger, ledger);
  const agent = manager.createAgent({ name: 'writer', autonomyMode: 'autonomous' });

  const objective = manager.createObjective({
    requestedBy: 'test-user',
    title: 'Write and publish ebook',
    description: 'Research, write, and publish a practical ebook with a launch plan.',
    ownerAgentId: agent.id,
    priority: 7,
  });

  assert.equal(objective.status, 'queued');
  assert.equal(objective.ownerAgentId, agent.id);

  const tasks = manager.getObjectiveTasks(objective.id);
  assert.equal(tasks.length, 4);
  assert.ok(tasks.every((t) => t.objectiveId === objective.id));
  assert.ok(tasks.every((t) => t.assignedAgentId === agent.id));

  await db.stop();
});

test('delegation creates delegated task and resumes parent when answered', async () => {
  const logger = createSilentLogger();
  const db = new DatabaseManager(':memory:', logger);
  await db.start();

  const ledger = new TaskLedger(db.connection, logger);
  const manager = new AgentOSManager(db.connection, logger, ledger);
  const agentA = manager.createAgent({ name: 'planner', autonomyMode: 'autonomous' });
  const agentB = manager.createAgent({ name: 'researcher', autonomyMode: 'autonomous' });

  const objective = manager.createObjective({
    requestedBy: 'test-user',
    title: 'Ship delegated objective',
    description: 'Do work and delegate specific research pieces.',
    ownerAgentId: agentA.id,
    priority: 6,
  });
  const [parentTask] = manager.getObjectiveTasks(objective.id);
  assert.ok(parentTask);

  const delegation = manager.createDelegation({
    taskId: parentTask!.id,
    toAgentNameOrId: agentB.name,
    question: 'Find three competitors and summarize them',
  });
  assert.equal(delegation.status, 'requested');
  assert.ok(delegation.delegatedTaskId);

  const blockedParent = ledger.getById(parentTask!.id);
  assert.equal(blockedParent?.status, 'blocked');

  const delegatedTask = ledger.getById(delegation.delegatedTaskId!);
  assert.ok(delegatedTask);
  ledger.start(delegatedTask!.id);
  ledger.complete(delegatedTask!.id, [{ type: 'json', label: 'research', value: '{"ok":true}' }]);
  manager.refreshObjectiveStatusFromTask(delegatedTask!.id);

  const updatedDelegation = manager.getDelegationById(delegation.id);
  assert.equal(updatedDelegation?.status, 'answered');
  const resumedParent = ledger.getById(parentTask!.id);
  assert.equal(resumedParent?.status, 'queued');

  await db.stop();
});

test('approval gate blocks risky task until approved', async () => {
  const logger = createSilentLogger();
  const db = new DatabaseManager(':memory:', logger);
  await db.start();

  const ledger = new TaskLedger(db.connection, logger);
  const manager = new AgentOSManager(db.connection, logger, ledger);
  const agent = manager.createAgent({ name: 'publisher', autonomyMode: 'autonomous' });
  const objective = manager.createObjective({
    requestedBy: 'test-user',
    title: 'Publish objective',
    description: 'Prepare and publish launch materials.',
    ownerAgentId: agent.id,
    priority: 8,
  });

  const riskyTask = ledger.create({
    title: 'Publish the ebook listing to marketplace',
    type: 'general',
    priority: 9,
    objectiveId: objective.id,
    assignedAgentId: agent.id,
  });

  const gate = manager.ensureTaskApproval(riskyTask, objective, agent);
  assert.equal(gate.state, 'pending');
  assert.equal(gate.created, true);
  assert.ok(gate.approval);

  const pending = manager.listApprovals('pending');
  assert.equal(pending.length, 1);

  const approved = manager.decideApproval(gate.approval!.id, 'approved', 'Looks good');
  assert.equal(approved?.status, 'approved');
  assert.equal(ledger.getById(riskyTask.id)?.status, 'queued');

  await db.stop();
});

test('objective requires DoD and creates remediation task if missing', async () => {
  const logger = createSilentLogger();
  const db = new DatabaseManager(':memory:', logger);
  await db.start();

  const ledger = new TaskLedger(db.connection, logger);
  const manager = new AgentOSManager(db.connection, logger, ledger);
  const agent = manager.createAgent({ name: 'maker', autonomyMode: 'autonomous' });
  const objective = manager.createObjective({
    requestedBy: 'test-user',
    title: 'DoD strict objective',
    description: 'Complete tasks with strict artifact requirements.',
    ownerAgentId: agent.id,
    definitionOfDone: {
      criteria: ['deliver final output artifact'],
      requiredArtifactKinds: ['file'],
    },
  });

  const tasks = manager.getObjectiveTasks(objective.id);
  for (const task of tasks) {
    ledger.start(task.id);
    ledger.complete(task.id, [{ type: 'json', label: 'note', value: '{"done":true}' }]);
    manager.refreshObjectiveStatusFromTask(task.id);
  }

  const refreshedObjective = manager.getObjectiveById(objective.id);
  assert.equal(refreshedObjective?.status, 'blocked');
  const updatedTasks = manager.getObjectiveTasks(objective.id);
  assert.ok(updatedTasks.some((task) => task.title.startsWith('Address Definition-of-Done gaps:')));

  await db.stop();
});

test('auto-retries recoverable planner failures and keeps objective runnable', async () => {
  const logger = createSilentLogger();
  const db = new DatabaseManager(':memory:', logger);
  await db.start();

  const ledger = new TaskLedger(db.connection, logger);
  const manager = new AgentOSManager(db.connection, logger, ledger);
  const agent = manager.createAgent({ name: 'operator', autonomyMode: 'autonomous' });
  const objective = manager.createObjective({
    requestedBy: 'test-user',
    title: 'Recover planner failures',
    description: 'Build me website',
    ownerAgentId: agent.id,
    priority: 7,
  });

  const tasks = manager.getObjectiveTasks(objective.id);
  const firstTask = tasks[0];
  assert.ok(firstTask);
  ledger.start(firstTask!.id);

  const refreshed = manager.recordExecutionFailure(firstTask!.id, 'Planner failed to generate a valid plan');
  assert.equal(ledger.getById(firstTask!.id)?.status, 'queued');
  assert.equal(refreshed?.status, 'running');

  const next = manager.pickNextRunnableTask();
  assert.ok(next);
  assert.equal(next?.objective.id, objective.id);

  await db.stop();
});

test('does not run downstream objective tasks when prerequisite failed and not recoverable', async () => {
  const logger = createSilentLogger();
  const db = new DatabaseManager(':memory:', logger);
  await db.start();

  const ledger = new TaskLedger(db.connection, logger);
  const manager = new AgentOSManager(db.connection, logger, ledger);
  const agent = manager.createAgent({ name: 'operator', autonomyMode: 'autonomous' });
  const objective = manager.createObjective({
    requestedBy: 'test-user',
    title: 'Block downstream',
    description: 'Build me website',
    ownerAgentId: agent.id,
    priority: 7,
  });

  const [researchTask] = manager.getObjectiveTasks(objective.id);
  assert.ok(researchTask);
  ledger.start(researchTask!.id);
  manager.recordExecutionFailure(researchTask!.id, 'Validation schema mismatch from planner');

  const next = manager.pickNextRunnableTask();
  assert.equal(next, null);
  assert.equal(manager.getObjectiveById(objective.id)?.status, 'blocked');

  const queued = manager.getObjectiveTasks(objective.id).filter((task) => task.status === 'queued');
  assert.equal(queued.length, 3);

  await db.stop();
});

test('enforces objective task dependency order before running report', async () => {
  const logger = createSilentLogger();
  const db = new DatabaseManager(':memory:', logger);
  await db.start();

  const ledger = new TaskLedger(db.connection, logger);
  const manager = new AgentOSManager(db.connection, logger, ledger);
  const agent = manager.createAgent({ name: 'operator', autonomyMode: 'autonomous' });
  const objective = manager.createObjective({
    requestedBy: 'test-user',
    title: 'Dependency order',
    description: 'Build me website',
    ownerAgentId: agent.id,
    priority: 7,
  });

  const tasks = manager.getObjectiveTasks(objective.id);
  const researchTask = tasks[0];
  const deliverableTask = tasks[1];
  const validateTask = tasks[2];
  const reportTask = tasks[3];
  assert.ok(researchTask && deliverableTask && validateTask && reportTask);

  ledger.start(researchTask!.id);
  ledger.complete(researchTask!.id, [{ type: 'json', label: 'research', value: '{"ok":true}' }]);
  manager.refreshObjectiveStatusFromTask(researchTask!.id);

  ledger.start(deliverableTask!.id);
  ledger.complete(deliverableTask!.id, [{ type: 'file', label: 'site', value: 'build-me-website.html' }]);
  manager.refreshObjectiveStatusFromTask(deliverableTask!.id);

  const nextBeforeValidate = manager.pickNextRunnableTask();
  assert.ok(nextBeforeValidate);
  assert.equal(nextBeforeValidate?.task.id, validateTask!.id);

  ledger.start(validateTask!.id);
  ledger.complete(validateTask!.id, [{ type: 'json', label: 'validation', value: '{"ok":true}' }]);
  manager.refreshObjectiveStatusFromTask(validateTask!.id);

  const nextAfterValidate = manager.pickNextRunnableTask();
  assert.ok(nextAfterValidate);
  assert.equal(nextAfterValidate?.task.id, reportTask!.id);

  await db.stop();
});

test('auto-resumes blocked objective when only recoverable failed tasks remain', async () => {
  const logger = createSilentLogger();
  const db = new DatabaseManager(':memory:', logger);
  await db.start();

  const ledger = new TaskLedger(db.connection, logger);
  const manager = new AgentOSManager(db.connection, logger, ledger);
  const agent = manager.createAgent({ name: 'operator', autonomyMode: 'autonomous' });
  const objective = manager.createObjective({
    requestedBy: 'test-user',
    title: 'Recover blocked objective',
    description: 'Build me website',
    ownerAgentId: agent.id,
    priority: 7,
  });

  const tasks = manager.getObjectiveTasks(objective.id);
  const researchTask = tasks[0];
  const deliverableTask = tasks[1];
  const validateTask = tasks[2];
  const reportTask = tasks[3];
  assert.ok(researchTask && deliverableTask && validateTask && reportTask);

  ledger.start(researchTask!.id);
  ledger.fail(researchTask!.id, 'Planner failed to generate a valid plan');
  manager.refreshObjectiveStatusFromTask(researchTask!.id);

  ledger.start(deliverableTask!.id);
  ledger.complete(deliverableTask!.id, [{ type: 'file', label: 'site', value: 'build-me-website.html' }]);
  manager.refreshObjectiveStatusFromTask(deliverableTask!.id);

  ledger.start(validateTask!.id);
  ledger.complete(validateTask!.id, [{ type: 'json', label: 'validation', value: '{"ok":true}' }]);
  manager.refreshObjectiveStatusFromTask(validateTask!.id);

  ledger.start(reportTask!.id);
  ledger.complete(reportTask!.id, [{ type: 'json', label: 'report', value: '{"ok":true}' }]);
  manager.refreshObjectiveStatusFromTask(reportTask!.id);

  assert.equal(manager.getObjectiveById(objective.id)?.status, 'blocked');

  const next = manager.pickNextRunnableTask();
  assert.ok(next);
  assert.equal(next?.task.id, researchTask!.id);
  assert.equal(manager.getObjectiveById(objective.id)?.status, 'running');

  await db.stop();
});
