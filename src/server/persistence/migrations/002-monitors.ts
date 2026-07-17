export const monitorsMigration = {
  version: 2,
  name: "002-monitors",
  sql: `
    CREATE TABLE monitors (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      interval_hours INTEGER NOT NULL CHECK (interval_hours IN (6, 12, 24, 48, 72)),
      scope_revision INTEGER NOT NULL DEFAULT 1 CHECK (scope_revision > 0),
      next_check_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE monitor_target_selectors (
      monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      selector TEXT NOT NULL,
      PRIMARY KEY (monitor_id, position),
      UNIQUE (monitor_id, selector)
    ) STRICT;

    CREATE TABLE monitor_exclusion_selectors (
      monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      selector TEXT NOT NULL,
      PRIMARY KEY (monitor_id, position),
      UNIQUE (monitor_id, selector)
    ) STRICT;

    CREATE TABLE check_intents (
      id INTEGER PRIMARY KEY,
      monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      scope_revision INTEGER NOT NULL CHECK (scope_revision > 0),
      kind TEXT NOT NULL CHECK (kind IN ('scheduled', 'overdue', 'manual', 'retry')),
      state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'finished', 'cancelled')),
      due_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    ) STRICT;

    CREATE INDEX check_intents_queue
      ON check_intents(state, due_at, id);

    CREATE TABLE checks (
      id INTEGER PRIMARY KEY,
      monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      scope_revision INTEGER NOT NULL CHECK (scope_revision > 0),
      intent_id INTEGER NOT NULL UNIQUE REFERENCES check_intents(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('scheduled', 'overdue', 'manual', 'retry')),
      status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
      result TEXT CHECK (result IN ('baseline', 'no_change', 'change', 'error')),
      error_code TEXT,
      error_message TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT
    ) STRICT;

    CREATE INDEX checks_monitor_history
      ON checks(monitor_id, id DESC);

    CREATE TABLE snapshots (
      id INTEGER PRIMARY KEY,
      monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      scope_revision INTEGER NOT NULL CHECK (scope_revision > 0),
      check_id INTEGER NOT NULL UNIQUE REFERENCES checks(id) ON DELETE CASCADE,
      format_version INTEGER NOT NULL,
      canonical_json BLOB NOT NULL,
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX snapshots_monitor_revision
      ON snapshots(monitor_id, scope_revision, id DESC);
  `,
} as const;
