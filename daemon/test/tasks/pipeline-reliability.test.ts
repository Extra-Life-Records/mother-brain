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

test('pipeline skips downstream steps when dependency step fails', async () => {
  const logger = createSilentLogger();
  const db = new DatabaseManager(':memory:', logger);
  await db.start();

  const taskLedger = new TaskLedger(db.connection, logger);
  const toolRegistry = new ToolRegistry(logger);
  let writeExecuted = 0;

  toolRegistry.register({
    name: 'always_fail',
    description: 'Always fails',
    inputSchema: { parameters: {} },
    riskLevel: 'low',
    builtin: true,
    async execute() {
      return {
        success: false,
        output: { status: 500, statusText: 'Internal Server Error' },
        error: 'HTTP 500: Internal Server Error',
        durationMs: 1,
      };
    },
  });

  toolRegistry.register({
    name: 'should_not_run',
    description: 'Would run if dependency gating failed',
    inputSchema: {
      parameters: {
        path: { type: 'string', description: 'path', required: true },
        content: { type: 'string', description: 'content', required: true },
      },
    },
    riskLevel: 'low',
    builtin: true,
    async execute() {
      writeExecuted += 1;
      return {
        success: true,
        output: { path: '/tmp/out.html' },
        durationMs: 1,
      };
    },
  });

  const task = taskLedger.create({
    title: 'Build a website from data',
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
                  goal: 'Build a website from data',
                  steps: [
                    { name: 'Get data', tool: 'always_fail', args: {}, successCriteria: 'Data fetched' },
                    {
                      name: 'Write HTML',
                      tool: 'should_not_run',
                      args: { path: '/tmp/out.html', content: '<html></html>' },
                      successCriteria: 'HTML file exists',
                    },
                  ],
                  overallCriteria: 'Website is complete',
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
  assert.equal(writeExecuted, 0);
  assert.equal(result?.plan.steps[0]?.status, 'failed');
  assert.equal(result?.plan.steps[1]?.status, 'skipped');
  assert.equal(result?.task.status, 'failed');

  await db.stop();
});

test('pipeline auto-discovers alternate RSS source after 404', async () => {
  const logger = createSilentLogger();
  const db = new DatabaseManager(':memory:', logger);
  await db.start();

  const taskLedger = new TaskLedger(db.connection, logger);
  const toolRegistry = new ToolRegistry(logger);

  toolRegistry.register({
    name: 'web_fetch',
    description: 'Mock web fetch',
    inputSchema: {
      parameters: {
        url: { type: 'string', description: 'url', required: true },
        method: { type: 'string', description: 'method', required: false, enum: ['GET', 'POST'] },
      },
    },
    riskLevel: 'low',
    builtin: true,
    async execute(params: Record<string, unknown>) {
      const url = String(params['url'] ?? '');
      if (url.includes('bad-feed')) {
        return {
          success: false,
          output: { status: 404, statusText: 'Not Found' },
          error: 'HTTP 404: Not Found',
          durationMs: 1,
        };
      }

      if (url.includes('news.google.com/rss/search')) {
        return {
          success: true,
          output: {
            status: 200,
            url,
            contentType: 'application/rss+xml',
            data: {
              type: 'rss',
              items: [
                { title: 'Item 1', link: 'https://example.com/1' },
                { title: 'Item 2', link: 'https://example.com/2' },
                { title: 'Item 3', link: 'https://example.com/3' },
              ],
            },
          },
          durationMs: 1,
        };
      }

      return {
        success: false,
        output: { status: 500 },
        error: 'Unexpected URL',
        durationMs: 1,
      };
    },
  });

  const task = taskLedger.create({
    title: 'Fetch AI news feed',
    type: 'research',
    priority: 5,
  });

  let calls = 0;
  const fakeClient = {
    chat: {
      completions: {
        create: async () => {
          calls += 1;
          if (calls === 1) {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      goal: 'Fetch AI news feed',
                      steps: [
                        {
                          name: 'Fetch AI news feed',
                          tool: 'web_fetch',
                          args: { url: 'https://example.com/bad-feed', method: 'GET' },
                          successCriteria: 'RSS items fetched',
                        },
                      ],
                      overallCriteria: 'At least 3 AI news items were fetched',
                    }),
                  },
                },
              ],
            };
          }

          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    verified: true,
                    evidence: 'RSS items fetched successfully',
                  }),
                },
              },
            ],
          };
        },
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
  assert.equal(result?.task.status, 'done');
  assert.equal(result?.verification.verified, true);
  assert.equal(result?.plan.steps[0]?.status, 'done');
  assert.match(String(result?.plan.steps[0]?.args?.url ?? ''), /news\.google\.com\/rss\/search/);

  await db.stop();
});

test('pipeline uses heuristic fallback for objective research task when planner model fails', async () => {
  const logger = createSilentLogger();
  const db = new DatabaseManager(':memory:', logger);
  await db.start();

  const taskLedger = new TaskLedger(db.connection, logger);
  const toolRegistry = new ToolRegistry(logger);

  let writtenPath = '';
  toolRegistry.register({
    name: 'file_write',
    description: 'Mock file write',
    inputSchema: {
      parameters: {
        path: { type: 'string', description: 'path', required: true },
        content: { type: 'string', description: 'content', required: true },
      },
    },
    riskLevel: 'low',
    builtin: true,
    async execute(params: Record<string, unknown>) {
      writtenPath = String(params['path'] ?? '');
      return {
        success: true,
        output: { path: writtenPath, bytesWritten: 100 },
        durationMs: 1,
      };
    },
  });

  const task = taskLedger.create({
    title: 'Research and gather actionable context for: Build me website',
    type: 'general',
    priority: 5,
  });

  const failingClient = {
    chat: {
      completions: {
        create: async () => {
          throw new Error('HTTP 429: Too many requests');
        },
      },
    },
  } as any;

  const result = await runPipeline(task.id, {
    client: failingClient,
    model: 'openai/gpt-5',
    toolRegistry,
    taskLedger,
    logger,
  });

  assert.ok(result);
  assert.equal(result?.task.status, 'done');
  assert.equal(result?.plan.steps[0]?.tool, 'file_write');
  assert.match(writtenPath, /-research\.md$/);

  await db.stop();
});

test('pipeline uses heuristic fallback to create html deliverable when planner fails', async () => {
  const logger = createSilentLogger();
  const db = new DatabaseManager(':memory:', logger);
  await db.start();

  const taskLedger = new TaskLedger(db.connection, logger);
  const toolRegistry = new ToolRegistry(logger);

  let writtenPath = '';
  toolRegistry.register({
    name: 'file_write',
    description: 'Mock file write',
    inputSchema: {
      parameters: {
        path: { type: 'string', description: 'path', required: true },
        content: { type: 'string', description: 'content', required: true },
      },
    },
    riskLevel: 'low',
    builtin: true,
    async execute(params: Record<string, unknown>) {
      writtenPath = String(params['path'] ?? '');
      return {
        success: true,
        output: { path: writtenPath, bytesWritten: 200 },
        durationMs: 1,
      };
    },
  });

  const task = taskLedger.create({
    title: 'Produce the primary deliverable for: Build me website',
    type: 'general',
    priority: 5,
  });

  const failingClient = {
    chat: {
      completions: {
        create: async () => {
          throw new Error('HTTP 404: Unknown model');
        },
      },
    },
  } as any;

  const result = await runPipeline(task.id, {
    client: failingClient,
    model: 'openai/gpt-5',
    toolRegistry,
    taskLedger,
    logger,
  });

  assert.ok(result);
  assert.equal(result?.task.status, 'done');
  assert.equal(result?.verification.verified, true);
  assert.match(writtenPath, /\.html$/);

  await db.stop();
});
