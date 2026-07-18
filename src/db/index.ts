// eslint-disable-next-line @typescript-eslint/no-require-imports
const BetterSqlite3 = require('better-sqlite3');
import path from 'path';
import fs from 'fs';

const CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '', '.supermodel');
const DB_PATH = path.join(CONFIG_DIR, 'data.db');

// Ensure config directory exists
if (!fs.existsSync(CONFIG_DIR)) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

// Initialize database
const db = new BetterSqlite3(DB_PATH);

// Configure database
db.pragma('journal_mode = WAL');  // Enable WAL mode for better concurrency
db.pragma('busy_timeout = 5000'); // Set busy timeout to 5 seconds

// Read and execute schema
const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schemaSql);

// Function to initialize the database and perform startup compensation
export function initDatabase() {
  // Apply schema migrations: add missing columns if they don't exist
  const migrations = [
    "ALTER TABLE node_executions ADD COLUMN error_message TEXT",
    "ALTER TABLE node_executions ADD COLUMN input_messages_json TEXT",
    "ALTER TABLE node_executions ADD COLUMN actual_messages_count INTEGER",
    "ALTER TABLE node_executions ADD COLUMN output_text TEXT",
    "ALTER TABLE node_executions ADD COLUMN parallel_index INTEGER",
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists, ignore */ }
  }

  // Perform startup compensation: update any 'running' flow_executions to 'failed'
  const updateRunningFlows = db.prepare(`
    UPDATE flow_executions 
    SET status = 'failed', 
        finished_at = unixepoch('now') * 1000,
        finish_reason = 'terminated_by_system_restart'
    WHERE status = 'running'
  `);
  
  const result = updateRunningFlows.run();
  console.log(`Compensated ${result.changes} running flow executions on startup`);
  
  return db;
}

export { db };


