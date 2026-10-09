import Database from 'better-sqlite3';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const dbPath = path.join(process.env.USERPROFILE ?? '', '.mother-brain-daemon', 'daemon.db');
const db = new Database(dbPath);

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function insertOneTimeCommitment(actionDescription, promiseText, dueInSeconds = 75) {
  const id = randomUUID();
  const due = new Date(Date.now() + dueInSeconds * 1000).toISOString();
  db.prepare(
    `INSERT INTO commitments (id, type, promise_text, action_description, schedule, execute_at, status, created_at, next_run_at, execution_count)
     VALUES (?, 'one_time', ?, ?, NULL, ?, 'active', ?, ?, 0)`
  ).run(id, promiseText, actionDescription, due, nowIso(), due);
  return { id, due, actionDescription };
}

function getCommitment(id) {
  return db.prepare(
    `SELECT id, status, execution_count, failure_reason, last_executed_at, action_description
     FROM commitments WHERE id = ?`
  ).get(id);
}

function findTaskByMarker(marker) {
  return db.prepare(
    `SELECT id, title, status, execution_count, last_error, completed_at
     FROM tasks
     WHERE title LIKE ?
     ORDER BY created_at DESC
     LIMIT 1`
  ).get(`%${marker}%`);
}

async function waitForTerminalStatus(id, timeoutMs = 210000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const row = getCommitment(id);
    if (row && (row.status === 'completed' || row.status === 'failed')) return row;
    await sleep(5000);
  }
  return getCommitment(id);
}

function assert(cond, message, failures) {
  if (!cond) failures.push(message);
}

async function main() {
  const runId = randomUUID().slice(0, 8);
  const newsMarker = `confidence-news-${runId}`;
  const pipelineMarker = `confidence-pipe-${runId}`;

  const news = insertOneTimeCommitment(
    `Get me a round up of music news ${newsMarker}`,
    'confidence check: news',
    75,
  );

  const pipeline = insertOneTimeCommitment(
    `Summarize this page briefly and list key points ${pipelineMarker} https://example.com`,
    'confidence check: pipeline',
    80,
  );

  console.log(JSON.stringify({
    runId,
    inserted: [news, pipeline],
    startedAt: nowIso(),
  }, null, 2));

  const [newsResult, pipelineResult] = await Promise.all([
    waitForTerminalStatus(news.id),
    waitForTerminalStatus(pipeline.id),
  ]);

  const pipelineTask = findTaskByMarker(pipelineMarker);
  const failures = [];

  assert(!!newsResult, 'News commitment row missing', failures);
  assert(newsResult?.status === 'completed', `News commitment not completed (status=${newsResult?.status})`, failures);
  assert(newsResult?.execution_count === 1, `News commitment executed ${newsResult?.execution_count ?? 0} times`, failures);
  assert(!newsResult?.failure_reason, `News commitment failure_reason present: ${newsResult?.failure_reason}`, failures);

  assert(!!pipelineResult, 'Pipeline commitment row missing', failures);
  assert(pipelineResult?.status === 'completed', `Pipeline commitment not completed (status=${pipelineResult?.status})`, failures);
  assert(pipelineResult?.execution_count === 1, `Pipeline commitment executed ${pipelineResult?.execution_count ?? 0} times`, failures);
  assert(!pipelineResult?.failure_reason, `Pipeline commitment failure_reason present: ${pipelineResult?.failure_reason}`, failures);

  assert(!!pipelineTask, 'Pipeline task row missing', failures);
  assert(pipelineTask?.status === 'done', `Pipeline task not done (status=${pipelineTask?.status})`, failures);
  assert(pipelineTask?.execution_count === 1, `Pipeline task executed ${pipelineTask?.execution_count ?? 0} times`, failures);
  assert(!pipelineTask?.last_error, `Pipeline task last_error present: ${pipelineTask?.last_error}`, failures);

  const output = {
    runId,
    passed: failures.length === 0,
    failures,
    results: {
      news: newsResult,
      pipeline: pipelineResult,
      pipelineTask,
    },
    finishedAt: nowIso(),
  };

  console.log(JSON.stringify(output, null, 2));
  process.exit(failures.length === 0 ? 0 : 2);
}

main().catch((error) => {
  console.error(JSON.stringify({ passed: false, error: String(error) }, null, 2));
  process.exit(1);
});
