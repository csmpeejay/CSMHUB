-- CSM Hub initial schema. All timestamps are unix seconds (UTC). Money is stored in cents.

CREATE TABLE clients (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  email              TEXT,
  status             TEXT NOT NULL DEFAULT 'active',      -- active | paused | ended
  stripe_customer_id TEXT UNIQUE,
  clickup_folder_id  TEXT,                                -- optional: ClickUp folder that holds this client's lists
  slack_channel_id   TEXT,                                -- optional: client-specific Slack channel for updates
  notes              TEXT,
  created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at         INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_clients_status ON clients(status);

CREATE TABLE projects (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id        INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active',        -- planning | active | on_hold | done
  clickup_list_id  TEXT UNIQUE,
  budget_cents     INTEGER,
  start_date       TEXT,                                  -- YYYY-MM-DD
  due_date         TEXT,                                  -- YYYY-MM-DD
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_projects_client ON projects(client_id);

-- Mirror of ClickUp tasks (ClickUp stays the source of truth).
CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,                          -- ClickUp task id
  list_id      TEXT NOT NULL,
  list_name    TEXT,
  folder_id    TEXT,
  project_id   INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  client_id    INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  status       TEXT,
  is_closed    INTEGER NOT NULL DEFAULT 0,
  assignees    TEXT,                                      -- comma-separated names
  priority     TEXT,
  due_at       INTEGER,
  url          TEXT,
  updated_at   INTEGER,
  closed_at    INTEGER,
  deleted      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_client ON tasks(client_id);
CREATE INDEX idx_tasks_list ON tasks(list_id);
CREATE INDEX idx_tasks_open_due ON tasks(is_closed, due_at);

-- Mirror of Stripe invoices.
CREATE TABLE invoices (
  id                 TEXT PRIMARY KEY,                    -- Stripe invoice id
  client_id          INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  stripe_customer_id TEXT,
  number             TEXT,
  status             TEXT,                                -- draft | open | paid | void | uncollectible
  currency           TEXT,
  total              INTEGER NOT NULL DEFAULT 0,
  amount_paid        INTEGER NOT NULL DEFAULT 0,
  amount_remaining   INTEGER NOT NULL DEFAULT 0,
  description        TEXT,
  subscription_id    TEXT,
  hosted_url         TEXT,
  created_at         INTEGER,
  due_at             INTEGER,
  paid_at            INTEGER
);
CREATE INDEX idx_invoices_client ON invoices(client_id);
CREATE INDEX idx_invoices_status ON invoices(status, due_at);
CREATE INDEX idx_invoices_customer ON invoices(stripe_customer_id);

-- Mirror of Stripe subscriptions (used for monthly recurring revenue).
CREATE TABLE subscriptions (
  id                 TEXT PRIMARY KEY,
  client_id          INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  stripe_customer_id TEXT,
  status             TEXT,
  currency           TEXT,
  mrr_cents          INTEGER NOT NULL DEFAULT 0,
  description        TEXT,
  current_period_end INTEGER,
  canceled_at        INTEGER,
  created_at         INTEGER
);
CREATE INDEX idx_subs_client ON subscriptions(client_id);

CREATE TABLE activity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL DEFAULT (unixepoch()),
  kind       TEXT NOT NULL,                               -- invoice_paid | invoice_failed | task_done | client_created | note ...
  client_id  INTEGER,
  project_id INTEGER,
  message    TEXT NOT NULL,
  link       TEXT
);
CREATE INDEX idx_activity_ts ON activity(ts DESC);
CREATE INDEX idx_activity_client ON activity(client_id, ts DESC);

CREATE TABLE sync_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,                              -- stripe | clickup
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  ok          INTEGER,
  summary     TEXT
);
CREATE INDEX idx_sync_runs_source ON sync_runs(source, started_at DESC);

-- Prevents the same alert (e.g. "invoice X overdue") being sent more than once.
CREATE TABLE alerts_sent (
  key     TEXT PRIMARY KEY,
  sent_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Prevents processing the same webhook twice.
CREATE TABLE webhook_events (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  received_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
