import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScheduledIntent, isObjectiveStatusQuery } from '../../src/reporter/telegram.ts';

test('parses one-time 12-hour time intent', () => {
  const intent = parseScheduledIntent('Get me the latest news and send it to me at 11am');
  assert.ok(intent);
  assert.equal(intent.type, 'one_time');
  assert.ok(intent.executeAt);
  assert.equal(intent.actionDescription.toLowerCase().includes('11am'), false);
});

test('parses one-time relative minute intent', () => {
  const before = Date.now();
  const intent = parseScheduledIntent('Fetch headlines in 30 minutes');
  assert.ok(intent);
  assert.equal(intent.type, 'one_time');
  assert.ok(intent.executeAt);
  const delta = new Date(intent.executeAt!).getTime() - before;
  assert.ok(delta > 25 * 60_000 && delta < 35 * 60_000);
});

test('parses recurring daily intent', () => {
  const intent = parseScheduledIntent('Get gaming news daily at 7am');
  assert.ok(intent);
  assert.equal(intent.type, 'recurring');
  assert.equal(intent.schedule, '0 7 * * *');
  assert.equal(intent.actionDescription.toLowerCase().includes('daily at 7am'), false);
});

test('returns null for non-scheduled message', () => {
  const intent = parseScheduledIntent('Get latest gaming news right now');
  assert.equal(intent, null);
});

test('detects objective status questions from natural language', () => {
  assert.equal(isObjectiveStatusQuery('what are you blocked on?'), true);
  assert.equal(isObjectiveStatusQuery('are you building it?'), true);
  assert.equal(isObjectiveStatusQuery('check objective 14e251e7 progress'), true);
});

test('does not classify normal action requests as status queries', () => {
  assert.equal(isObjectiveStatusQuery('Build me a website for AI news'), false);
});
