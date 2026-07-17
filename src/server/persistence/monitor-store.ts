import type BetterSqlite3 from "better-sqlite3";

export type CheckIntentKind = "scheduled" | "overdue" | "manual" | "retry";
export type CheckStatus = "running" | "succeeded" | "failed";
export type CheckResult = "baseline" | "no_change" | "change" | "error";

export interface CreateMonitorRecord {
  name: string;
  url: string;
  targetSelectors: string[];
  exclusionSelectors: string[];
  intervalHours: 6 | 12 | 24 | 48 | 72;
}

export interface ClaimedCheck {
  checkId: number;
  intentId: number;
  kind: CheckIntentKind;
  monitorId: number;
  scopeRevision: number;
  intervalHours: 6 | 12 | 24 | 48 | 72;
  url: string;
  targetSelectors: string[];
  exclusionSelectors: string[];
}

export interface SnapshotRecord {
  formatVersion: number;
  sha256: string;
  canonicalJson: string;
}

export interface MonitorCheckRecord {
  id: number;
  kind: CheckIntentKind;
  status: CheckStatus;
  result: CheckResult | null;
  startedAt: string;
  completedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  snapshot: (SnapshotRecord & { id: number }) | null;
}

export interface MonitorRecord {
  id: number;
  name: string;
  url: string;
  targetSelectors: string[];
  exclusionSelectors: string[];
  intervalHours: 6 | 12 | 24 | 48 | 72;
  scopeRevision: number;
  nextCheckAt: string | null;
  history: MonitorCheckRecord[];
}

export interface MonitorSummaryRecord {
  id: number;
  name: string;
  url: string;
  intervalHours: 6 | 12 | 24 | 48 | 72;
  scopeRevision: number;
  nextCheckAt: string | null;
  latestCheckResult: CheckResult | null;
}

export interface MonitorStore {
  createMonitor(input: CreateMonitorRecord, now: string): number;
  claimNextCheck(now: string): ClaimedCheck | undefined;
  completeBaseline(
    claimed: ClaimedCheck,
    snapshot: SnapshotRecord,
    completedAt: string,
    nextCheckAt: string,
  ): void;
  failCheck(
    claimed: ClaimedCheck,
    error: { code: string; message: string },
    completedAt: string,
    nextCheckAt: string,
  ): void;
  listMonitors(): MonitorSummaryRecord[];
  getMonitor(id: number): MonitorRecord | undefined;
}

export function createMonitorStore(
  database: BetterSqlite3.Database,
): MonitorStore {
  const insertMonitor = database.prepare(`
    INSERT INTO monitors (name, url, interval_hours, created_at, updated_at)
    VALUES (@name, @url, @intervalHours, @now, @now)
  `);
  const insertTargetSelector = database.prepare(`
    INSERT INTO monitor_target_selectors (monitor_id, position, selector)
    VALUES (?, ?, ?)
  `);
  const insertExclusionSelector = database.prepare(`
    INSERT INTO monitor_exclusion_selectors (monitor_id, position, selector)
    VALUES (?, ?, ?)
  `);
  const insertIntent = database.prepare(`
    INSERT INTO check_intents (
      monitor_id, scope_revision, kind, state, due_at, created_at
    ) VALUES (?, 1, 'scheduled', 'queued', ?, ?)
  `);

  const createMonitorTransaction = database.transaction(
    (input: CreateMonitorRecord, now: string) => {
      const result = insertMonitor.run({ ...input, now });
      const monitorId = Number(result.lastInsertRowid);
      for (const [position, selector] of input.targetSelectors.entries()) {
        insertTargetSelector.run(monitorId, position, selector);
      }
      for (const [position, selector] of input.exclusionSelectors.entries()) {
        insertExclusionSelector.run(monitorId, position, selector);
      }
      insertIntent.run(monitorId, now, now);
      return monitorId;
    },
  );

  const selectNextIntent = database.prepare(`
    SELECT id, monitor_id, scope_revision, kind
    FROM check_intents
    WHERE state = 'queued' AND due_at <= ?
    ORDER BY due_at, id
    LIMIT 1
  `);
  const markIntentRunning = database.prepare(`
    UPDATE check_intents
    SET state = 'running', started_at = ?
    WHERE id = ? AND state = 'queued'
  `);
  const insertCheck = database.prepare(`
    INSERT INTO checks (
      monitor_id, scope_revision, intent_id, kind, status, started_at
    ) VALUES (?, ?, ?, ?, 'running', ?)
  `);
  const selectMonitorForCheck = database.prepare(`
    SELECT id, url, scope_revision, interval_hours
    FROM monitors
    WHERE id = ?
  `);
  const selectTargets = database.prepare(`
    SELECT selector FROM monitor_target_selectors
    WHERE monitor_id = ? ORDER BY position
  `);
  const selectExclusions = database.prepare(`
    SELECT selector FROM monitor_exclusion_selectors
    WHERE monitor_id = ? ORDER BY position
  `);

  const claimTransaction = database.transaction((now: string) => {
    const intent = selectNextIntent.get(now) as
      | {
          id: number;
          monitor_id: number;
          scope_revision: number;
          kind: CheckIntentKind;
        }
      | undefined;
    if (intent === undefined) {
      return undefined;
    }
    if (markIntentRunning.run(now, intent.id).changes !== 1) {
      return undefined;
    }
    const check = insertCheck.run(
      intent.monitor_id,
      intent.scope_revision,
      intent.id,
      intent.kind,
      now,
    );
    const monitor = selectMonitorForCheck.get(intent.monitor_id) as {
      id: number;
      url: string;
      scope_revision: number;
      interval_hours: 6 | 12 | 24 | 48 | 72;
    };
    return {
      checkId: Number(check.lastInsertRowid),
      intentId: intent.id,
      kind: intent.kind,
      monitorId: monitor.id,
      scopeRevision: monitor.scope_revision,
      intervalHours: monitor.interval_hours,
      url: monitor.url,
      targetSelectors: selectorValues(selectTargets.all(monitor.id)),
      exclusionSelectors: selectorValues(selectExclusions.all(monitor.id)),
    } satisfies ClaimedCheck;
  });

  const insertSnapshot = database.prepare(`
    INSERT INTO snapshots (
      monitor_id, scope_revision, check_id, format_version,
      canonical_json, sha256, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const finishCheck = database.prepare(`
    UPDATE checks
    SET status = 'succeeded', result = 'baseline', completed_at = ?
    WHERE id = ? AND status = 'running'
  `);
  const failCheckStatement = database.prepare(`
    UPDATE checks
    SET status = 'failed', result = 'error', error_code = ?,
        error_message = ?, completed_at = ?
    WHERE id = ? AND status = 'running'
  `);
  const finishIntent = database.prepare(`
    UPDATE check_intents
    SET state = 'finished', finished_at = ?
    WHERE id = ? AND state = 'running'
  `);
  const scheduleMonitor = database.prepare(`
    UPDATE monitors
    SET next_check_at = ?, updated_at = ?
    WHERE id = ? AND scope_revision = ?
  `);

  const completeBaselineTransaction = database.transaction(
    (
      claimed: ClaimedCheck,
      snapshot: SnapshotRecord,
      completedAt: string,
      nextCheckAt: string,
    ) => {
      insertSnapshot.run(
        claimed.monitorId,
        claimed.scopeRevision,
        claimed.checkId,
        snapshot.formatVersion,
        Buffer.from(snapshot.canonicalJson, "utf8"),
        snapshot.sha256,
        completedAt,
      );
      assertChanged(finishCheck.run(completedAt, claimed.checkId).changes);
      assertChanged(finishIntent.run(completedAt, claimed.intentId).changes);
      assertChanged(
        scheduleMonitor.run(
          nextCheckAt,
          completedAt,
          claimed.monitorId,
          claimed.scopeRevision,
        ).changes,
      );
    },
  );

  const failCheckTransaction = database.transaction(
    (
      claimed: ClaimedCheck,
      error: { code: string; message: string },
      completedAt: string,
      nextCheckAt: string,
    ) => {
      assertChanged(
        failCheckStatement.run(
          error.code,
          error.message,
          completedAt,
          claimed.checkId,
        ).changes,
      );
      assertChanged(finishIntent.run(completedAt, claimed.intentId).changes);
      assertChanged(
        scheduleMonitor.run(
          nextCheckAt,
          completedAt,
          claimed.monitorId,
          claimed.scopeRevision,
        ).changes,
      );
    },
  );

  return {
    createMonitor: createMonitorTransaction,
    claimNextCheck: claimTransaction,
    completeBaseline: completeBaselineTransaction,
    failCheck: failCheckTransaction,
    listMonitors() {
      const rows = database
        .prepare(`
          SELECT m.id, m.name, m.url, m.interval_hours, m.scope_revision,
                 m.next_check_at,
                 (SELECT c.result FROM checks c
                  WHERE c.monitor_id = m.id ORDER BY c.id DESC LIMIT 1) latest_result
          FROM monitors m
          ORDER BY m.id
        `)
        .all() as Array<{
        id: number;
        name: string;
        url: string;
        interval_hours: 6 | 12 | 24 | 48 | 72;
        scope_revision: number;
        next_check_at: string | null;
        latest_result: CheckResult | null;
      }>;
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        url: row.url,
        intervalHours: row.interval_hours,
        scopeRevision: row.scope_revision,
        nextCheckAt: row.next_check_at,
        latestCheckResult: row.latest_result,
      }));
    },
    getMonitor(id) {
      const row = database
        .prepare(`
          SELECT id, name, url, interval_hours, scope_revision, next_check_at
          FROM monitors WHERE id = ?
        `)
        .get(id) as
        | {
            id: number;
            name: string;
            url: string;
            interval_hours: 6 | 12 | 24 | 48 | 72;
            scope_revision: number;
            next_check_at: string | null;
          }
        | undefined;
      if (row === undefined) {
        return undefined;
      }
      const checks = database
        .prepare(`
          SELECT c.id, c.kind, c.status, c.result, c.started_at,
                 c.completed_at, c.error_code, c.error_message,
                 s.id snapshot_id, s.format_version, s.sha256, s.canonical_json
          FROM checks c
          LEFT JOIN snapshots s ON s.check_id = c.id
          WHERE c.monitor_id = ?
          ORDER BY c.id DESC
        `)
        .all(id) as Array<{
        id: number;
        kind: CheckIntentKind;
        status: CheckStatus;
        result: CheckResult | null;
        started_at: string;
        completed_at: string | null;
        error_code: string | null;
        error_message: string | null;
        snapshot_id: number | null;
        format_version: number | null;
        sha256: string | null;
        canonical_json: Buffer | null;
      }>;
      return {
        id: row.id,
        name: row.name,
        url: row.url,
        targetSelectors: selectorValues(selectTargets.all(row.id)),
        exclusionSelectors: selectorValues(selectExclusions.all(row.id)),
        intervalHours: row.interval_hours,
        scopeRevision: row.scope_revision,
        nextCheckAt: row.next_check_at,
        history: checks.map((check) => ({
          id: check.id,
          kind: check.kind,
          status: check.status,
          result: check.result,
          startedAt: check.started_at,
          completedAt: check.completed_at,
          errorCode: check.error_code,
          errorMessage: check.error_message,
          snapshot:
            check.snapshot_id === null ||
            check.format_version === null ||
            check.sha256 === null ||
            check.canonical_json === null
              ? null
              : {
                  id: check.snapshot_id,
                  formatVersion: check.format_version,
                  sha256: check.sha256,
                  canonicalJson: check.canonical_json.toString("utf8"),
                },
        })),
      };
    },
  };
}

function selectorValues(rows: unknown[]): string[] {
  return (rows as Array<{ selector: string }>).map((row) => row.selector);
}

function assertChanged(changes: number): void {
  if (changes !== 1) {
    throw new Error("Concurrent Monitor state change prevented transaction commit");
  }
}
