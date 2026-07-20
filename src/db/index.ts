import { Pool, PoolClient } from 'pg';

// Initialize connection pool
// PG_POOL_MAX: tune per replica. Default 20 (was 10).
// connectionTimeoutMillis: fail fast if pool is exhausted, prevents silent hangs.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:PgTest12345@172.236.224.19:5433/supermodel_test',
  max: parseInt(process.env.PG_POOL_MAX || '20', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,  // fail if no connection available within 5s
});

// Log pool errors (e.g. idle client errors) so they don't go unnoticed
pool.on('error', (err) => {
  console.error('[pg-pool] Unexpected idle client error:', err.message);
});

// ============================================================
// Thin wrapper to match original synchronous-style call sites
// Usage: db.query(sql, params?) → Promise<{ rows: any[] }>
// ============================================================
export const db = {
  query: (sql: string, params?: any[]) => pool.query(sql, params),
  pool,
};

// ============================================================
// initDatabase: create tables + run startup compensation
// Must be called (awaited) before the server starts accepting requests
// ============================================================
export async function initDatabase(): Promise<void> {
  // ---------- Schema DDL (PostgreSQL syntax) ----------
  const schemaDDL = `
    CREATE TABLE IF NOT EXISTS flow_executions (
      id              TEXT PRIMARY KEY,
      instance_name   TEXT NOT NULL,
      flow_name       TEXT NOT NULL,
      status          TEXT NOT NULL,
      started_at      BIGINT NOT NULL,
      finished_at     BIGINT,
      total_rounds    INTEGER DEFAULT 0,
      finish_reason   TEXT,
      created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );

    CREATE TABLE IF NOT EXISTS node_executions (
      id                      TEXT PRIMARY KEY,
      flow_execution_id       TEXT NOT NULL REFERENCES flow_executions(id),
      node_id                 TEXT NOT NULL,
      role_id                 TEXT NOT NULL,
      round                   INTEGER NOT NULL,
      parallel_index          INTEGER,
      status                  TEXT NOT NULL,
      prompt_tokens           INTEGER DEFAULT 0,
      completion_tokens       INTEGER DEFAULT 0,
      input_messages_json     TEXT,
      actual_messages_count   INTEGER,
      output_text             TEXT,
      started_at              BIGINT NOT NULL,
      finished_at             BIGINT,
      error_message           TEXT
    );

    CREATE TABLE IF NOT EXISTS usage_records (
      id                  SERIAL PRIMARY KEY,
      flow_execution_id   TEXT NOT NULL REFERENCES flow_executions(id),
      node_execution_id   TEXT NOT NULL REFERENCES node_executions(id),
      role_id             TEXT NOT NULL,
      provider_model      TEXT NOT NULL,
      prompt_tokens       INTEGER,
      completion_tokens   INTEGER,
      total_tokens        INTEGER,
      created_at          BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );
  `;

  await pool.query(schemaDDL);

  // ---------- Startup compensation ----------
  // Mark any 'running' flow_executions as 'failed' (process may have crashed)
  const result = await pool.query(`
    UPDATE flow_executions
    SET status = 'failed',
        finished_at = $1,
        finish_reason = 'terminated_by_system_restart'
    WHERE status = 'running'
  `, [Date.now()]);

  console.log(`Compensated ${result.rowCount} running flow executions on startup`);
}
