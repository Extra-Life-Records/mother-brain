import test from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { DatabaseManager } from '../../src/db/database.ts';
import { TaskLedger } from '../../src/tasks/ledger.ts';
import { runPipeline } from '../../src/tasks/pipeline.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';

function createSilentLogger() {
  return pino({ level: 'silent' });
}

test('runPipeline blocks task when credentials are required', async () => {
  const logger = createSilentLogger();
  const db = new DatabaseManager(':memory:', logger);
  await db.start();

  const taskLedger = new TaskLedger(db.connection, logger);
  const toolRegistry = new ToolRegistry(logger);

  toolRegistry.register({
    name: 'credential_tool',
    description: 'Simulate a credential-gated action',
    inputSchema: { parameters: {} },
    riskLevel: 'low',
    builtin: true,
    async execute() {
      return {
        success: false,
        output: null,
        error: 'CREDENTIAL_REQUIRED:WEB_EXAMPLE_PASSWORD',
        durationMs: 1,
      };
    },
  });

  const task = taskLedger.create({
    title: 'Login and publish content',
    type: 'general',
    priority: 5,
  });

  const fakeClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  goal: 'Login and publish content',
                  steps: [
                    {
                      name: 'Authenticate',
                      tool: 'credential_tool',
                      args: {},
                      successCriteria: 'Credentials accepted',
                    },
                  ],
                  overallCriteria: 'Authenticated and published',
                }),
              },
            },
          ],
        }),
      },
    },
  } as any;

  const result = await runPipeline(task.id, {
    client: fakeClient,
    model: 'test-model',
    toolRegistry,
    taskLedger,
    logger,
  });

  assert.ok(result);
  assert.equal(result?.verification.verified, false);
  assert.equal(result?.task.status, 'blocked');
  assert.match(result?.task.blockReason ?? '', /WEB_EXAMPLE_PASSWORD/);

  await db.stop();
});

