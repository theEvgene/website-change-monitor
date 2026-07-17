import type BetterSqlite3 from "better-sqlite3";

export type CheckIntentKind = "scheduled" | "overdue" | "manual" | "retry";
export type CheckStatus = "running" | "succeeded" | "failed";
export type CheckResult = "baseline" | "no_change" | "change" | "error";
export type CheckIntentState = "queued" | "running" | "finished" | "cancelled";

export interface CheckIntentRecord {
  id: number;
  monitorId: number;
  monitorName: string;
  scopeRevision: number;
  kind: CheckIntentKind;
  state: CheckIntentState;
  dueAt: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

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
  currentSnapshot: (SnapshotRecord & { id: number }) | null;
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
  beforeSnapshotId: number | null;
  afterSnapshotId: number | null;
  isFinalError: boolean;
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
  paused: boolean;
  activeIntent: CheckIntentRecord | null;
  history: MonitorCheckRecord[];
}

export interface MonitorSummaryRecord {
  id: number;
  name: string;
  url: string;
  intervalHours: 6 | 12 | 24 | 48 | 72;
  scopeRevision: number;
  nextCheckAt: string | null;
  paused: boolean;
  latestCheckResult: CheckResult | null;
  activeIntent: CheckIntentRecord | null;
}

export interface JournalCheckRecord {
  id: number;
  monitorId: number;
  monitorName: string;
  kind: CheckIntentKind;
  status: CheckStatus;
  result: CheckResult | null;
  startedAt: string;
  completedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  beforeSnapshotId: number | null;
  afterSnapshotId: number | null;
  isFinalError: boolean;
}

export interface ComparisonSnapshotPair {
  checkId: number;
  monitorId: number;
  monitorName: string;
  beforeSnapshotId: number;
  afterSnapshotId: number;
  beforeCanonicalJson: string;
  afterCanonicalJson: string;
}

export interface MonitorStore {
  createMonitor(input: CreateMonitorRecord, now: string): number;
  enqueueManualCheck(monitorId: number, now: string): boolean | undefined;
  reconcileSchedule(now: string, recoverOverdue: boolean): void;
  recoverInterrupted(now: string): void;
  claimNextCheck(now: string, preferAutomatic?: boolean): ClaimedCheck | undefined;
  completeBaseline(
    claimed: ClaimedCheck,
    snapshot: SnapshotRecord,
    completedAt: string,
    nextCheckAt: string,
  ): void;
  completeNoChange(
    claimed: ClaimedCheck,
    completedAt: string,
    nextCheckAt: string,
  ): void;
  completeChange(
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
  setPaused(monitorId: number, paused: boolean, now: string): boolean | undefined;
  listMonitors(): MonitorSummaryRecord[];
  listJournal(): JournalCheckRecord[];
  listActiveIntents(): CheckIntentRecord[];
  getComparison(checkId: number): ComparisonSnapshotPair | undefined;
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

  const selectMonitorRevision = database.prepare(`
    SELECT scope_revision FROM monitors WHERE id = ?
  `);
  const selectActiveManualIntent = database.prepare(`
    SELECT id FROM check_intents
    WHERE monitor_id = ? AND state IN ('queued', 'running')
      AND (kind = 'manual' OR state = 'running')
    LIMIT 1
  `);
  const insertManualIntent = database.prepare(`
    INSERT INTO check_intents (
      monitor_id, scope_revision, kind, state, due_at, created_at
    ) VALUES (?, ?, 'manual', 'queued', ?, ?)
  `);
  const enqueueManualTransaction = database.transaction(
    (monitorId: number, now: string): boolean | undefined => {
      const monitor = selectMonitorRevision.get(monitorId) as
        | { scope_revision: number }
        | undefined;
      if (monitor === undefined) {
        return undefined;
      }
      if (selectActiveManualIntent.get(monitorId) !== undefined) {
        return false;
      }
      insertManualIntent.run(monitorId, monitor.scope_revision, now, now);
      return true;
    },
  );

  const selectNextIntent = database.prepare(`
    SELECT i.id, i.monitor_id, i.scope_revision, i.kind
    FROM check_intents i
    JOIN monitors m ON m.id = i.monitor_id
    WHERE i.state = 'queued' AND i.due_at <= ?
      AND (m.paused = 0 OR i.kind = 'manual')
    ORDER BY CASE i.kind
      WHEN 'manual' THEN 0
      WHEN 'retry' THEN 1
      WHEN 'overdue' THEN 2
      ELSE 3
    END, i.due_at, i.id
    LIMIT 1
  `);
  const selectNextAutomaticIntent = database.prepare(`
    SELECT i.id, i.monitor_id, i.scope_revision, i.kind
    FROM check_intents i
    JOIN monitors m ON m.id = i.monitor_id
    WHERE i.state = 'queued' AND i.due_at <= ? AND i.kind <> 'manual'
      AND m.paused = 0
    ORDER BY CASE i.kind
      WHEN 'retry' THEN 0
      WHEN 'overdue' THEN 1
      ELSE 2
    END, i.due_at, i.id
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
    SELECT id, url, scope_revision, interval_hours, current_snapshot_id
    FROM monitors
    WHERE id = ?
  `);
  const selectSnapshot = database.prepare(`
    SELECT id, format_version, sha256, canonical_json
    FROM snapshots WHERE id = ?
  `);
  const selectTargets = database.prepare(`
    SELECT selector FROM monitor_target_selectors
    WHERE monitor_id = ? ORDER BY position
  `);
  const selectExclusions = database.prepare(`
    SELECT selector FROM monitor_exclusion_selectors
    WHERE monitor_id = ? ORDER BY position
  `);

  const claimTransaction = database.transaction((now: string, preferAutomatic = false) => {
    const intent = (
      preferAutomatic
        ? (selectNextAutomaticIntent.get(now) ?? selectNextIntent.get(now))
        : selectNextIntent.get(now)
    ) as
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
      current_snapshot_id: number | null;
    };
    const snapshot =
      monitor.current_snapshot_id === null
        ? undefined
        : (selectSnapshot.get(monitor.current_snapshot_id) as
            | {
                id: number;
                format_version: number;
                sha256: string;
                canonical_json: Buffer;
              }
            | undefined);
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
      currentSnapshot:
        snapshot === undefined
          ? null
          : {
              id: snapshot.id,
              formatVersion: snapshot.format_version,
              sha256: snapshot.sha256,
              canonicalJson: snapshot.canonical_json.toString("utf8"),
            },
    } satisfies ClaimedCheck;
  });

  const insertSnapshot = database.prepare(`
    INSERT INTO snapshots (
      monitor_id, scope_revision, check_id, format_version,
      canonical_json, sha256, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const succeedCheck = database.prepare(`
    UPDATE checks
    SET status = 'succeeded', result = ?, before_snapshot_id = ?,
        after_snapshot_id = ?, completed_at = ?
    WHERE id = ? AND status = 'running'
  `);
  const failCheckStatement = database.prepare(`
    UPDATE checks
    SET status = 'failed', result = 'error', error_code = ?,
        error_message = ?, completed_at = ?, is_final_error = ?
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
  const cancelQueuedAutomatic = database.prepare(`
    UPDATE check_intents
    SET state = 'cancelled', finished_at = ?
    WHERE monitor_id = ? AND state = 'queued'
      AND kind IN ('scheduled', 'overdue')
  `);
  const insertScheduledIntent = database.prepare(`
    INSERT INTO check_intents (
      monitor_id, scope_revision, kind, state, due_at, created_at
    ) VALUES (?, ?, 'scheduled', 'queued', ?, ?)
  `);
  const insertRetryIntent = database.prepare(`
    INSERT INTO check_intents (
      monitor_id, scope_revision, kind, state, due_at, created_at, retry_of_check_id
    ) VALUES (?, ?, 'retry', 'queued', ?, ?, ?)
  `);
  const selectQueuedRetryDue = database.prepare(`
    SELECT due_at FROM check_intents
    WHERE monitor_id = ? AND state = 'queued' AND kind = 'retry'
    ORDER BY due_at, id LIMIT 1
  `);

  function replaceOrdinarySchedule(
    claimed: ClaimedCheck,
    completedAt: string,
    nextCheckAt: string,
  ): void {
    cancelQueuedAutomatic.run(completedAt, claimed.monitorId);
    insertScheduledIntent.run(
      claimed.monitorId,
      claimed.scopeRevision,
      nextCheckAt,
      completedAt,
    );
    const pendingRetry = selectQueuedRetryDue.get(claimed.monitorId) as
      | { due_at: string }
      | undefined;
    assertChanged(
      scheduleMonitor.run(
        pendingRetry?.due_at ?? nextCheckAt,
        completedAt,
        claimed.monitorId,
        claimed.scopeRevision,
      ).changes,
    );
  }
  const setCurrentSnapshot = database.prepare(`
    UPDATE monitors SET current_snapshot_id = ?
    WHERE id = ? AND scope_revision = ?
  `);

  const completeBaselineTransaction = database.transaction(
    (
      claimed: ClaimedCheck,
      snapshot: SnapshotRecord,
      completedAt: string,
      nextCheckAt: string,
    ) => {
      const inserted = insertSnapshot.run(
        claimed.monitorId,
        claimed.scopeRevision,
        claimed.checkId,
        snapshot.formatVersion,
        Buffer.from(snapshot.canonicalJson, "utf8"),
        snapshot.sha256,
        completedAt,
      );
      const snapshotId = Number(inserted.lastInsertRowid);
      assertChanged(
        succeedCheck.run(
          "baseline",
          null,
          snapshotId,
          completedAt,
          claimed.checkId,
        ).changes,
      );
      assertChanged(
        setCurrentSnapshot.run(
          snapshotId,
          claimed.monitorId,
          claimed.scopeRevision,
        ).changes,
      );
      assertChanged(finishIntent.run(completedAt, claimed.intentId).changes);
      replaceOrdinarySchedule(claimed, completedAt, nextCheckAt);
    },
  );

  const completeNoChangeTransaction = database.transaction(
    (claimed: ClaimedCheck, completedAt: string, nextCheckAt: string) => {
      if (claimed.currentSnapshot === null) {
        throw new Error("No current Snapshot for no-change result");
      }
      assertChanged(
        succeedCheck.run(
          "no_change",
          claimed.currentSnapshot.id,
          claimed.currentSnapshot.id,
          completedAt,
          claimed.checkId,
        ).changes,
      );
      assertChanged(finishIntent.run(completedAt, claimed.intentId).changes);
      replaceOrdinarySchedule(claimed, completedAt, nextCheckAt);
    },
  );

  const completeChangeTransaction = database.transaction(
    (
      claimed: ClaimedCheck,
      snapshot: SnapshotRecord,
      completedAt: string,
      nextCheckAt: string,
    ) => {
      if (claimed.currentSnapshot === null) {
        throw new Error("No current Snapshot for Change result");
      }
      const inserted = insertSnapshot.run(
        claimed.monitorId,
        claimed.scopeRevision,
        claimed.checkId,
        snapshot.formatVersion,
        Buffer.from(snapshot.canonicalJson, "utf8"),
        snapshot.sha256,
        completedAt,
      );
      const snapshotId = Number(inserted.lastInsertRowid);
      assertChanged(
        succeedCheck.run(
          "change",
          claimed.currentSnapshot.id,
          snapshotId,
          completedAt,
          claimed.checkId,
        ).changes,
      );
      assertChanged(
        setCurrentSnapshot.run(
          snapshotId,
          claimed.monitorId,
          claimed.scopeRevision,
        ).changes,
      );
      assertChanged(finishIntent.run(completedAt, claimed.intentId).changes);
      replaceOrdinarySchedule(claimed, completedAt, nextCheckAt);
    },
  );

  function recordFailureTransition(
    identity: Pick<ClaimedCheck,
      "checkId" | "intentId" | "kind" | "monitorId" | "scopeRevision">,
    error: { code: string; message: string },
    completedAt: string,
    nextCheckAt: string,
  ): void {
    const finalError = identity.kind === "retry";
    assertChanged(failCheckStatement.run(
      error.code, error.message, completedAt, finalError ? 1 : 0,
      identity.checkId,
    ).changes);
    assertChanged(finishIntent.run(completedAt, identity.intentId).changes);
    if (finalError) {
      cancelQueuedAutomatic.run(completedAt, identity.monitorId);
      insertScheduledIntent.run(
        identity.monitorId, identity.scopeRevision, nextCheckAt, completedAt,
      );
      assertChanged(scheduleMonitor.run(
        nextCheckAt, completedAt, identity.monitorId, identity.scopeRevision,
      ).changes);
      return;
    }
    const retryAt = new Date(new Date(completedAt).getTime() + 60_000).toISOString();
    cancelQueuedAutomatic.run(completedAt, identity.monitorId);
    const existingRetry = selectQueuedRetryDue.get(identity.monitorId) as
      | { due_at: string }
      | undefined;
    if (existingRetry === undefined) {
      insertRetryIntent.run(
        identity.monitorId, identity.scopeRevision, retryAt, completedAt,
        identity.checkId,
      );
    }
    assertChanged(scheduleMonitor.run(
      existingRetry?.due_at ?? retryAt,
      completedAt,
      identity.monitorId,
      identity.scopeRevision,
    ).changes);
  }

  const failCheckTransaction = database.transaction(recordFailureTransition);

  const selectPauseState = database.prepare(`
    SELECT id, scope_revision, current_snapshot_id, next_check_at
    FROM monitors WHERE id = ?
  `);
  const updatePaused = database.prepare(`
    UPDATE monitors SET paused = ?, updated_at = ? WHERE id = ?
  `);
  const setPausedTransaction = database.transaction(
    (monitorId: number, paused: boolean, now: string): boolean | undefined => {
      const monitor = selectPauseState.get(monitorId) as
        | { id: number; scope_revision: number; current_snapshot_id: number | null; next_check_at: string | null }
        | undefined;
      if (monitor === undefined) return undefined;
      updatePaused.run(paused ? 1 : 0, now, monitorId);
      if (!paused) {
        const retry = database.prepare(`
          SELECT 1 FROM check_intents
          WHERE monitor_id = ? AND state IN ('queued', 'running') AND kind = 'retry'
        `).get(monitorId);
        if (retry === undefined) {
          database.prepare(`
            UPDATE check_intents SET kind = 'overdue'
            WHERE monitor_id = ? AND state = 'queued' AND kind = 'scheduled'
              AND due_at <= ? AND ? IS NOT NULL
          `).run(monitorId, now, monitor.current_snapshot_id);
          const activeAutomatic = database.prepare(`
            SELECT 1 FROM check_intents
            WHERE monitor_id = ? AND state IN ('queued', 'running')
              AND kind IN ('scheduled', 'overdue')
          `).get(monitorId);
          if (activeAutomatic === undefined && monitor.next_check_at !== null) {
            const kind = monitor.next_check_at <= now && monitor.current_snapshot_id !== null
              ? "overdue" : "scheduled";
            database.prepare(`
              INSERT INTO check_intents (
                monitor_id, scope_revision, kind, state, due_at, created_at
              ) VALUES (?, ?, ?, 'queued', ?, ?)
            `).run(monitorId, monitor.scope_revision, kind, monitor.next_check_at, now);
          }
        }
      }
      return true;
    },
  );

  const recoverInterruptedTransaction = database.transaction((now: string) => {
    const rows = database.prepare(`
      SELECT i.id intent_id, i.kind, i.monitor_id, i.scope_revision,
             c.id check_id, m.interval_hours
      FROM check_intents i
      JOIN checks c ON c.intent_id = i.id AND c.status = 'running'
      JOIN monitors m ON m.id = i.monitor_id
      WHERE i.state = 'running'
      ORDER BY i.id
    `).all() as Array<{
      intent_id: number; kind: CheckIntentKind; monitor_id: number;
      scope_revision: number; check_id: number;
      interval_hours: 6 | 12 | 24 | 48 | 72;
    }>;
    for (const row of rows) {
      const nextAt = new Date(
        new Date(now).getTime() + row.interval_hours * 60 * 60 * 1_000,
      ).toISOString();
      recordFailureTransition(
        {
          checkId: row.check_id,
          intentId: row.intent_id,
          kind: row.kind,
          monitorId: row.monitor_id,
          scopeRevision: row.scope_revision,
        },
        {
          code: "application_shutdown",
          message: "Проверка была прервана завершением приложения.",
        },
        now,
        nextAt,
      );
    }
  });

  return {
    createMonitor: createMonitorTransaction,
    enqueueManualCheck: enqueueManualTransaction,
    reconcileSchedule(now, recoverOverdue) {
      database.transaction(() => {
        if (recoverOverdue) {
          database.prepare(`
            UPDATE check_intents AS i
            SET kind = 'overdue'
            WHERE i.state = 'queued' AND i.kind = 'scheduled' AND i.due_at <= ?
              AND EXISTS (
                SELECT 1 FROM monitors m
                WHERE m.id = i.monitor_id AND m.current_snapshot_id IS NOT NULL
              )
          `).run(now);
        }
        database.prepare(`
          INSERT INTO check_intents (
            monitor_id, scope_revision, kind, state, due_at, created_at
          )
          SELECT m.id, m.scope_revision,
                 CASE WHEN m.next_check_at < @now AND @recover = 1
                      THEN 'overdue' ELSE 'scheduled' END,
                 'queued', m.next_check_at, @now
          FROM monitors m
          WHERE m.next_check_at IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM check_intents i
              WHERE i.monitor_id = m.id AND i.state IN ('queued', 'running')
                AND i.kind IN ('scheduled', 'overdue', 'retry')
            )
        `).run({ now, recover: recoverOverdue ? 1 : 0 });
      })();
    },
    recoverInterrupted: recoverInterruptedTransaction,
    claimNextCheck: claimTransaction,
    completeBaseline: completeBaselineTransaction,
    completeNoChange: completeNoChangeTransaction,
    completeChange: completeChangeTransaction,
    failCheck: failCheckTransaction,
    setPaused: setPausedTransaction,
    listMonitors() {
      const rows = database
        .prepare(`
          SELECT m.id, m.name, m.url, m.interval_hours, m.scope_revision,
                 m.next_check_at, m.paused,
                 (SELECT c.result FROM checks c
                  WHERE c.monitor_id = m.id ORDER BY c.id DESC LIMIT 1) latest_result,
                 i.id intent_id, i.kind intent_kind, i.state intent_state,
                 i.scope_revision intent_scope_revision, i.due_at intent_due_at,
                 i.created_at intent_created_at, i.started_at intent_started_at,
                 i.finished_at intent_finished_at
          FROM monitors m
          LEFT JOIN check_intents i ON i.id = (
            SELECT ai.id FROM check_intents ai
            WHERE ai.monitor_id = m.id AND ai.state IN ('queued', 'running')
            ORDER BY CASE ai.state WHEN 'running' THEN 0 ELSE 1 END,
                     ai.due_at, ai.id LIMIT 1
          )
          ORDER BY m.id
        `)
        .all() as Array<{
        id: number;
        name: string;
        url: string;
        interval_hours: 6 | 12 | 24 | 48 | 72;
        scope_revision: number;
        next_check_at: string | null;
        paused: 0 | 1;
        latest_result: CheckResult | null;
        intent_id: number | null;
        intent_kind: CheckIntentKind | null;
        intent_state: CheckIntentState | null;
        intent_scope_revision: number | null;
        intent_due_at: string | null;
        intent_created_at: string | null;
        intent_started_at: string | null;
        intent_finished_at: string | null;
      }>;
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        url: row.url,
        intervalHours: row.interval_hours,
        scopeRevision: row.scope_revision,
        nextCheckAt: row.next_check_at,
        paused: row.paused === 1,
        latestCheckResult: row.latest_result,
        activeIntent: intentFromJoinedRow(row, row.name),
      }));
    },
    listActiveIntents() {
      const rows = database.prepare(`
        SELECT i.id, i.monitor_id, m.name monitor_name, i.scope_revision,
               i.kind, i.state, i.due_at, i.created_at, i.started_at, i.finished_at
        FROM check_intents i
        JOIN monitors m ON m.id = i.monitor_id
        WHERE i.state IN ('queued', 'running')
        ORDER BY CASE i.state WHEN 'running' THEN 0 ELSE 1 END,
                 CASE i.kind WHEN 'manual' THEN 0 WHEN 'retry' THEN 1
                   WHEN 'overdue' THEN 2 ELSE 3 END,
                 i.due_at, i.id
      `).all() as Array<{
        id: number; monitor_id: number; monitor_name: string;
        scope_revision: number; kind: CheckIntentKind; state: CheckIntentState;
        due_at: string; created_at: string; started_at: string | null;
        finished_at: string | null;
      }>;
      return rows.map(intentFromRow);
    },
    listJournal() {
      const rows = database
        .prepare(`
          SELECT c.id, c.monitor_id, m.name monitor_name, c.kind, c.status,
                 c.result, c.started_at, c.completed_at, c.error_code,
                 c.error_message, c.before_snapshot_id, c.after_snapshot_id,
                 c.is_final_error
          FROM checks c
          JOIN monitors m ON m.id = c.monitor_id
          ORDER BY c.id DESC
        `)
        .all() as Array<{
        id: number;
        monitor_id: number;
        monitor_name: string;
        kind: CheckIntentKind;
        status: CheckStatus;
        result: CheckResult | null;
        started_at: string;
        completed_at: string | null;
        error_code: string | null;
        error_message: string | null;
        before_snapshot_id: number | null;
        after_snapshot_id: number | null;
        is_final_error: 0 | 1;
      }>;
      return rows.map((row) => ({
        id: row.id,
        monitorId: row.monitor_id,
        monitorName: row.monitor_name,
        kind: row.kind,
        status: row.status,
        result: row.result,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        beforeSnapshotId: row.before_snapshot_id,
        afterSnapshotId: row.after_snapshot_id,
        isFinalError: row.is_final_error === 1,
      }));
    },
    getComparison(checkId) {
      const row = database
        .prepare(`
          SELECT c.id check_id, c.monitor_id, m.name monitor_name,
                 before_snapshot.id before_snapshot_id,
                 after_snapshot.id after_snapshot_id,
                 before_snapshot.canonical_json before_json,
                 after_snapshot.canonical_json after_json
          FROM checks c
          JOIN monitors m ON m.id = c.monitor_id
          JOIN snapshots before_snapshot ON before_snapshot.id = c.before_snapshot_id
          JOIN snapshots after_snapshot ON after_snapshot.id = c.after_snapshot_id
          WHERE c.id = ?
        `)
        .get(checkId) as
        | {
            check_id: number;
            monitor_id: number;
            monitor_name: string;
            before_snapshot_id: number;
            after_snapshot_id: number;
            before_json: Buffer;
            after_json: Buffer;
          }
        | undefined;
      return row === undefined
        ? undefined
        : {
            checkId: row.check_id,
            monitorId: row.monitor_id,
            monitorName: row.monitor_name,
            beforeSnapshotId: row.before_snapshot_id,
            afterSnapshotId: row.after_snapshot_id,
            beforeCanonicalJson: row.before_json.toString("utf8"),
            afterCanonicalJson: row.after_json.toString("utf8"),
          };
    },
    getMonitor(id) {
      const row = database
        .prepare(`
          SELECT id, name, url, interval_hours, scope_revision, next_check_at, paused
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
            paused: 0 | 1;
          }
        | undefined;
      if (row === undefined) {
        return undefined;
      }
      const checks = database
        .prepare(`
          SELECT c.id, c.kind, c.status, c.result, c.started_at,
                 c.completed_at, c.error_code, c.error_message,
                 c.before_snapshot_id, c.after_snapshot_id, c.is_final_error,
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
        before_snapshot_id: number | null;
        after_snapshot_id: number | null;
        is_final_error: 0 | 1;
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
        paused: row.paused === 1,
        activeIntent: this.listActiveIntents().find((intent) => intent.monitorId === id) ?? null,
        history: checks.map((check) => ({
          id: check.id,
          kind: check.kind,
          status: check.status,
          result: check.result,
          startedAt: check.started_at,
          completedAt: check.completed_at,
          errorCode: check.error_code,
          errorMessage: check.error_message,
          beforeSnapshotId: check.before_snapshot_id,
          afterSnapshotId: check.after_snapshot_id,
          isFinalError: check.is_final_error === 1,
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

function intentFromRow(row: {
  id: number; monitor_id: number; monitor_name: string; scope_revision: number;
  kind: CheckIntentKind; state: CheckIntentState; due_at: string;
  created_at: string; started_at: string | null; finished_at: string | null;
}): CheckIntentRecord {
  return {
    id: row.id, monitorId: row.monitor_id, monitorName: row.monitor_name,
    scopeRevision: row.scope_revision, kind: row.kind, state: row.state,
    dueAt: row.due_at, createdAt: row.created_at,
    startedAt: row.started_at, finishedAt: row.finished_at,
  };
}

function intentFromJoinedRow(row: {
  id: number; intent_id: number | null; intent_kind: CheckIntentKind | null;
  intent_state: CheckIntentState | null; intent_scope_revision: number | null;
  intent_due_at: string | null; intent_created_at: string | null;
  intent_started_at: string | null; intent_finished_at: string | null;
}, monitorName: string): CheckIntentRecord | null {
  if (row.intent_id === null || row.intent_kind === null || row.intent_state === null ||
      row.intent_scope_revision === null || row.intent_due_at === null ||
      row.intent_created_at === null) return null;
  return {
    id: row.intent_id, monitorId: row.id, monitorName,
    scopeRevision: row.intent_scope_revision, kind: row.intent_kind,
    state: row.intent_state, dueAt: row.intent_due_at,
    createdAt: row.intent_created_at, startedAt: row.intent_started_at,
    finishedAt: row.intent_finished_at,
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
