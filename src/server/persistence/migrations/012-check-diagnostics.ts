export const checkDiagnosticsMigration = {
  version: 12,
  name: "012-check-diagnostics",
  sql: `
    CREATE TABLE check_diagnostics (
      check_id INTEGER PRIMARY KEY REFERENCES checks(id) ON DELETE CASCADE,
      recorded_at TEXT NOT NULL,
      stage TEXT NOT NULL CHECK (
        stage IN (
          'setup','validation','navigation','target','scroll',
          'stability','extraction','snapshot','application'
        )
      ),
      final_url TEXT CHECK (final_url IS NULL OR length(final_url) <= 2048),
      http_status INTEGER CHECK (
        http_status IS NULL OR http_status BETWEEN 100 AND 599
      ),
      total_ms INTEGER NOT NULL CHECK (total_ms BETWEEN 0 AND 86400000),
      navigation_ms INTEGER CHECK (
        navigation_ms IS NULL OR navigation_ms BETWEEN 0 AND 86400000
      ),
      target_ms INTEGER CHECK (
        target_ms IS NULL OR target_ms BETWEEN 0 AND 86400000
      ),
      scroll_ms INTEGER CHECK (
        scroll_ms IS NULL OR scroll_ms BETWEEN 0 AND 86400000
      ),
      stability_ms INTEGER CHECK (
        stability_ms IS NULL OR stability_ms BETWEEN 0 AND 86400000
      ),
      extraction_ms INTEGER CHECK (
        extraction_ms IS NULL OR extraction_ms BETWEEN 0 AND 86400000
      ),
      selector_field TEXT CHECK (
        selector_field IS NULL OR
        selector_field IN ('targetSelectors','exclusionSelectors')
      ),
      selector_index INTEGER CHECK (
        selector_index IS NULL OR selector_index >= 0
      ),
      CHECK (
        (selector_field IS NULL AND selector_index IS NULL) OR
        (selector_field IS NOT NULL AND selector_index IS NOT NULL)
      )
    ) STRICT;

    CREATE INDEX check_diagnostics_recorded_at
      ON check_diagnostics(recorded_at);
  `,
} as const;
