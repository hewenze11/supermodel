-- PostgreSQL schema (auto-applied on startup via initDatabase())
-- All timestamps stored as BIGINT (milliseconds since epoch)

CREATE TABLE IF NOT EXISTS flow_executions (
    id              TEXT PRIMARY KEY,
    instance_name   TEXT NOT NULL,
    flow_name       TEXT NOT NULL,
    status          TEXT NOT NULL,
    started_at      BIGINT NOT NULL,
    finished_at     BIGINT,
    total_rounds    INTEGER DEFAULT 0,
    finish_reason   TEXT,
    created_at      BIGINT NOT NULL DEFAULT ((EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT)
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
    created_at          BIGINT NOT NULL DEFAULT ((EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT)
);
