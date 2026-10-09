import type Database from 'better-sqlite3';
import type { Logger } from 'pino';

export interface SecretRequest {
  id: number;
  secretKey: string;
  context: string | null;
  status: 'pending' | 'resolved' | 'dismissed';
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

interface SecretRequestRow {
  id: number;
  secret_key: string;
  context: string | null;
  status: 'pending' | 'resolved' | 'dismissed';
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export class SecretStore {
  constructor(
    private db: Database.Database,
    private logger: Logger,
  ) {}

  set(key: string, value: string): void {
    const normalized = normalizeSecretKey(key);
    this.db.prepare(`
      INSERT INTO secrets (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(normalized, value, new Date().toISOString());
    this.resolveRequests(normalized);
    this.logger.info({ key: normalized }, 'Secret stored');
  }

  get(key: string): string | null {
    const normalized = normalizeSecretKey(key);
    const row = this.db.prepare('SELECT value FROM secrets WHERE key = ?').get(normalized) as { value: string } | undefined;
    return row?.value ?? null;
  }

  delete(key: string): boolean {
    const normalized = normalizeSecretKey(key);
    const result = this.db.prepare('DELETE FROM secrets WHERE key = ?').run(normalized);
    return result.changes > 0;
  }

  listKeys(limit = 50): string[] {
    const rows = this.db.prepare(`
      SELECT key
      FROM secrets
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit) as Array<{ key: string }>;
    return rows.map((row) => row.key);
  }

  request(secretKey: string, context?: string): SecretRequest {
    const normalized = normalizeSecretKey(secretKey);
    const now = new Date().toISOString();

    const existing = this.db.prepare(`
      SELECT *
      FROM secret_requests
      WHERE secret_key = ?
        AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(normalized) as SecretRequestRow | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE secret_requests
        SET context = COALESCE(?, context),
            updated_at = ?
        WHERE id = ?
      `).run(context ?? null, now, existing.id);
      const refreshed = this.db.prepare('SELECT * FROM secret_requests WHERE id = ?').get(existing.id) as SecretRequestRow;
      return rowToSecretRequest(refreshed);
    }

    const result = this.db.prepare(`
      INSERT INTO secret_requests (secret_key, context, status, created_at, updated_at)
      VALUES (?, ?, 'pending', ?, ?)
    `).run(normalized, context ?? null, now, now);

    const created = this.db.prepare('SELECT * FROM secret_requests WHERE id = ?').get(result.lastInsertRowid) as SecretRequestRow;
    this.logger.info({ secretKey: normalized }, 'Secret request created');
    return rowToSecretRequest(created);
  }

  listPendingRequests(limit = 25): SecretRequest[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM secret_requests
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as SecretRequestRow[];
    return rows.map(rowToSecretRequest);
  }

  resolveRequests(secretKey: string): number {
    const normalized = normalizeSecretKey(secretKey);
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE secret_requests
      SET status = 'resolved',
          resolved_at = ?,
          updated_at = ?
      WHERE secret_key = ?
        AND status = 'pending'
    `).run(now, now, normalized);
    return result.changes;
  }

  resolveValue(secretKey: string): string | null {
    return this.get(secretKey) ?? process.env[secretKey] ?? null;
  }
}

function normalizeSecretKey(key: string): string {
  return key.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

function rowToSecretRequest(row: SecretRequestRow): SecretRequest {
  return {
    id: row.id,
    secretKey: row.secret_key,
    context: row.context,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

