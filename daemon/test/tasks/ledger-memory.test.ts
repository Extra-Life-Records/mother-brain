import test from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { DatabaseManager } from '../../src/db/database.ts';
import { TaskLedger } from '../../src/tasks/ledger.ts';

function createSilentLogger() {
  return pino({ level: 'silent' });
}

test('findRelevantCompleted ranks similar successful tasks first', async () => {
  const logger = createSilentLogger();
  const db = new DatabaseManager(':memory:', logger);
  await db.start();

  const ledger = new TaskLedger(db.connection, logger);

  const webTask = ledger.create({ title: 'Build and deploy marketing website', type: 'general' });
  ledger.start(webTask.id);
  ledger.complete(webTask.id, [{ type: 'file', label: 'site', value: '/tmp/index.html' }]);

  const ebookTask = ledger.create({ title: 'Write and publish ebook', type: 'general' });
  ledger.start(ebookTask.id);
  ledger.complete(ebookTask.id, [{ type: 'json', label: 'manuscript', value: '{"chapters":10}' }]);

  const newsTask = ledger.create({ title: 'Collect AI news feed', type: 'research' });
  ledger.start(newsTask.id);
  ledger.complete(newsTask.id, [{ type: 'link', label: 'feed', value: 'https://example.com/rss' }]);

  const memories = ledger.findRelevantCompleted('build website and deploy it', 2);
  assert.ok(memories.length >= 1);
  assert.equal(memories[0]?.id, webTask.id);

  await db.stop();
});
