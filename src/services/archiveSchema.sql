-- DuckDB Archive Schema v1
-- Stores completed/archived plans for cross-machine historical research

CREATE TABLE IF NOT EXISTS plans (
    plan_id VARCHAR PRIMARY KEY,
    session_id VARCHAR NOT NULL,
    topic VARCHAR,
    plan_file VARCHAR,
    kanban_column VARCHAR,
    status VARCHAR,
    complexity VARCHAR,
    workspace_id VARCHAR NOT NULL,
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    last_action VARCHAR,
    source_type VARCHAR,
    tags VARCHAR,
    archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    days_to_completion INTEGER,
    revision_count INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_plans_workspace ON plans(workspace_id);
CREATE INDEX IF NOT EXISTS idx_plans_column ON plans(kanban_column);
CREATE INDEX IF NOT EXISTS idx_plans_complexity ON plans(complexity);
CREATE INDEX IF NOT EXISTS idx_plans_archived_at ON plans(archived_at);

CREATE TABLE IF NOT EXISTS archive_metadata (
    key VARCHAR PRIMARY KEY,
    value VARCHAR,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO archive_metadata (key, value)
VALUES ('schema_version', '1')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;

-- Conversations archive table (for /export command)
CREATE TABLE IF NOT EXISTS conversations (
    id VARCHAR PRIMARY KEY,
    exported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    conversation_date DATE,
    topic TEXT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT[],
    project TEXT,
    metadata JSON,
    file_path_original TEXT
);

CREATE INDEX IF NOT EXISTS idx_conversations_date ON conversations(conversation_date DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project);

-- Plan events archive table
CREATE TABLE IF NOT EXISTS plan_events (
    event_id BIGINT PRIMARY KEY,
    plan_id VARCHAR,
    event_type VARCHAR NOT NULL,
    workflow VARCHAR,
    action VARCHAR,
    timestamp TIMESTAMP NOT NULL,
    device_id VARCHAR,
    vector_clock VARCHAR,
    payload TEXT,
    workspace_id VARCHAR,
    archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_plan_events_plan_id ON plan_events(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_events_workspace ON plan_events(workspace_id);
CREATE INDEX IF NOT EXISTS idx_plan_events_timestamp ON plan_events(timestamp);

-- Activity log archive table
CREATE TABLE IF NOT EXISTS activity_log (
    id BIGINT PRIMARY KEY,
    timestamp TIMESTAMP NOT NULL,
    event_type VARCHAR NOT NULL,
    payload TEXT NOT NULL,
    correlation_id VARCHAR,
    session_id VARCHAR,
    workspace_id VARCHAR,
    archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_activity_log_workspace ON activity_log(workspace_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_timestamp ON activity_log(timestamp);

-- Job runs archive table
CREATE TABLE IF NOT EXISTS job_runs (
    id BIGINT PRIMARY KEY,
    timestamp TIMESTAMP NOT NULL,
    job VARCHAR NOT NULL,
    summary TEXT NOT NULL,
    source VARCHAR,
    workspace_id VARCHAR,
    archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Board move requests archive table
CREATE TABLE IF NOT EXISTS board_move_requests (
    id BIGINT PRIMARY KEY,
    file VARCHAR NOT NULL,
    plan_id VARCHAR NOT NULL,
    to_column VARCHAR NOT NULL,
    status VARCHAR NOT NULL,
    reason TEXT,
    timestamp TIMESTAMP NOT NULL,
    workspace_id VARCHAR,
    archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Dormant workspaces archive table
CREATE TABLE IF NOT EXISTS dormant_workspaces (
    workspace_id VARCHAR PRIMARY KEY,
    name VARCHAR,
    archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    export_path TEXT NOT NULL,
    last_activity_at TIMESTAMP,
    metadata JSON
);
