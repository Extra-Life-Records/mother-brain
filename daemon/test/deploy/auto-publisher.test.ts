import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Logger } from 'pino';
import { AutoPublisher } from '../../src/deploy/auto-publisher.js';
import type { AutoPublishInput } from '../../src/tasks/index.js';

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

const HOSTING_ENV_KEYS = [
  'MB_HOSTING_MODE',
  'MB_HOSTING_AUTO_PUBLISH',
  'MB_HOSTING_DEFAULT_PROVIDER',
  'MB_HOSTING_VERCEL_CMD',
  'MB_HOSTING_NETLIFY_CMD',
  'MB_HOSTING_CLOUDFLARE_CMD',
  'VERCEL_TOKEN',
  'VERCEL_SCOPE',
  'VERCEL_TEAM_ID',
  'VERCEL_PROJECT_NAME',
  'NETLIFY_AUTH_TOKEN',
  'NETLIFY_SITE_ID',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_PAGES_PROJECT',
  'CLOUDFLARE_PAGES_PROJECT_NAME',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_PAGES_BRANCH',
] as const;

function withCleanHostingEnv<T>(fn: () => Promise<T>): Promise<T> {
  const snapshot = new Map<string, string | undefined>();
  for (const key of HOSTING_ENV_KEYS) {
    snapshot.set(key, process.env[key]);
    delete process.env[key];
  }

  return fn().finally(() => {
    for (const key of HOSTING_ENV_KEYS) {
      const value = snapshot.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

function buildInput(taskTitle: string, artifacts: AutoPublishInput['artifacts']): AutoPublishInput {
  const now = new Date().toISOString();
  return {
    task: {
      id: 'task-1',
      title: taskTitle,
      type: 'general',
      status: 'running',
      objectiveId: null,
      assignedAgentId: null,
      priority: 5,
      parentTaskId: null,
      deadline: null,
      blockReason: null,
      checkpointData: {},
      artifacts: [],
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      completedAt: null,
      executionCount: 1,
      lastError: null,
    },
    plan: {
      goal: taskTitle,
      steps: [],
      overallCriteria: 'Deliver result',
      createdAt: now,
      status: 'verified',
    },
    verification: {
      verified: true,
      evidence: 'All steps done',
    },
    artifacts,
  };
}

test('auto publisher skips non-website tasks', async () => {
  await withCleanHostingEnv(async () => {
    const publisher = new AutoPublisher(logger);
    const input = buildInput('summarize quarterly expenses', [
      { type: 'text', label: 'summary', value: 'Done' },
    ]);

    const result = await publisher.publishIfNeeded(input);
    assert.equal(result, null);
  });
});

test('auto publisher reports blocked when website output exists but no provider is configured', async () => {
  await withCleanHostingEnv(async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'mb-autopublish-test-'));
    const htmlPath = join(tempDir, 'landing.html');
    await writeFile(htmlPath, '<!doctype html><html><body>hello</body></html>', 'utf-8');

    const publisher = new AutoPublisher(logger);
    const input = buildInput('build me a website', [
      { type: 'file', label: 'website html', value: htmlPath },
    ]);

    const result = await publisher.publishIfNeeded(input);
    assert.ok(result);
    assert.match(result.evidenceNote ?? '', /Publish blocked/i);
    assert.ok(result.artifacts.some((item) => item.label === 'publish_blocked'));
  });
});

test('auto publisher can be disabled with MB_HOSTING_MODE=off', async () => {
  await withCleanHostingEnv(async () => {
    process.env['MB_HOSTING_MODE'] = 'off';

    const tempDir = await mkdtemp(join(tmpdir(), 'mb-autopublish-test-'));
    const htmlPath = join(tempDir, 'index.html');
    await writeFile(htmlPath, '<!doctype html><html><body>hello</body></html>', 'utf-8');

    const publisher = new AutoPublisher(logger);
    const input = buildInput('build website', [
      { type: 'file', label: 'index', value: htmlPath },
    ]);

    const result = await publisher.publishIfNeeded(input);
    assert.equal(result, null);
  });
});

