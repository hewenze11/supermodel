CREATE TABLE IF NOT EXISTS flow_executions (
    id              TEXT PRIMARY KEY,
    instance_name   TEXT NOT NULL,
    flow_name       TEXT NOT NULL,
    status          TEXT NOT NULL,
    started_at      INTEGER NOT NULL,
    finished_at     INTEGER,
    total_rounds    INTEGER DEFAULT 0,
    finish_reason   TEXT,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
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
    started_at              INTEGER NOT NULL,
    finished_at             INTEGER,
    error_message           TEXT
);

CREATE TABLE IF NOT EXISTS usage_records (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    flow_execution_id   TEXT NOT NULL REFERENCES flow_executions(id),
    node_execution_id   TEXT NOT NULL REFERENCES node_executions(id),
    role_id             TEXT NOT NULL,
    provider_model      TEXT NOT NULL,
    prompt_tokens       INTEGER,
    completion_tokens   INTEGER,
    total_tokens        INTEGER,
    created_at          INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);