import test from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { DatabaseManager } from '../../src/db/database.ts';
import { SecretStore } from '../../src/core/secret-store.ts';

function createSilentLogger() {
  return pino({ level: 'silent' });
}

test('SecretStore resolves pending requests when a secret is provided', async () => {
  const logger = createSilentLogger();
  const db = new DatabaseManager(':memory:', logger);
  await db.start();

  const store = new SecretStore(db.connection, logger);
  store.request('web_example_password', 'Login password required for https://example.com');

  const pendingBefore = store.listPendingRequests();
  assert.equal(pendingBefore.length, 1);
  assert.equal(pendingBefore[0]?.secretKey, 'WEB_EXAMPLE_PASSWORD');

  store.set('web_example_password', 'super-secret');

  assert.equal(store.get('WEB_EXAMPLE_PASSWORD'), 'super-secret');
  assert.equal(store.listPendingRequests().length, 0);
  assert.ok(store.listKeys().includes('WEB_EXAMPLE_PASSWORD'));

  await db.stop();
});

