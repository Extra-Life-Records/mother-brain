import Database from 'better-sqlite3';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const dbPath = path.join(process.env.USERPROFILE ?? '', '.mother-brain-daemon', 'daemon.db');
const db = new Database(dbPath);

const marker = randomUUID().slice(0, 8);
const action = `Get gaming news test marker-${marker}`;
const id = randomUUID();
const now = new Date().toISOString();
const due = new Date(Date.now() + 3000).toISOString();

db.prepare(
  `INSERT INTO commitments (id, type, promise_text, action_description, schedule, execute_at, status, created_at, next_run_at)
   VALUES (?, 'one_time', ?, ?, NULL, ?, 'active', ?, ?)`
).run(id, 'manual test', action, due, now, due);

console.log(JSON.stringify({ insertedCommitmentId: id, action, dueAt: due }, null, 2));
