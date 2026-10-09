import test from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { detectCommitments } from '../../src/commitment/detector.ts';

const logger = pino({ level: 'silent' });

test('ignores recurring phrases in exploratory schedule questions', async () => {
  const text = 'How often should the news feed update (for example: real-time, every hour, daily), or is it enough to update whenever a visitor loads the page?';
  const commitments = await detectCommitments(text, logger);
  assert.equal(commitments.length, 0);
});

test('detects recurring commitments only when explicit commitment cue exists', async () => {
  const text = "I'll send you an AI news roundup every hour.";
  const commitments = await detectCommitments(text, logger);
  assert.equal(commitments.length, 1);
  assert.equal(commitments[0]?.type, 'recurring');
  assert.equal(commitments[0]?.schedule, '0 * * * *');
});
