# Current failure-diagnostics path

## Scope

This note traces diagnostics for a failed persisted monitoring check through the current repository implementation. It does not diagnose any particular website incident and does not propose the final target contract.

## Executive finding

The browser probe already produces a useful structured diagnostic envelope: failure code and message, execution stage, effective final URL, HTTP status when available, per-stage timings, and optional selector field/index. That envelope survives in `PageProbeResult` but is narrowed by `MonitorService` to `{ code, message }` before SQLite persistence. Consequently, SQLite, the check/history HTTP responses, UI, final-error notification, and Telegram retain only the generic code/message plus ordinary check identity and timing metadata. The NDJSON application logger is not called for monitoring-check failures at all.

The main reusable mechanisms are:

- the existing `PageProbeDiagnostics` and `PageProbeFailure` types;
- the existing check identity/retry-chain model and transactional `failCheck` boundary;
- the existing SQLite-backed journal and final-error notification linkage;
- the existing NDJSON writer with recursive redaction and bounded rotation;
- the Telegram detailed-change failure logger pattern, which is explicitly best-effort.

## End-to-end trace

### 1. Playwright/PageProbe creates structured diagnostics

`PageProbeFailure` includes:

- `code` and `message`;
- `stage`;
- optional `finalUrl` and `httpStatus`;
- `timings` (`totalMs`, `navigationMs`, `targetMs`, `scrollMs`, `stabilityMs`, `extractionMs`);
- optional selector `field` and `index`.

These fields are defined in [`src/server/application/page-probe.ts:L29-L52`](../../../src/server/application/page-probe.ts#L29-L52) and [`src/server/application/page-probe.ts:L90-L103`](../../../src/server/application/page-probe.ts#L90-L103). `PageProbeError`, used by interactive preview routes, also carries the same diagnostic properties [`src/server/application/page-probe.ts:L109-L125`](../../../src/server/application/page-probe.ts#L109-L125).

The Playwright implementation measures each stage, remembers the current stage and HTTP status, obtains the effective browser URL, and attaches all of them when an error exits the probe [`src/server/browser-playwright/playwright-page-probe.ts:L139-L157`](../../../src/server/browser-playwright/playwright-page-probe.ts#L139-L157), [`src/server/browser-playwright/playwright-page-probe.ts:L194-L236`](../../../src/server/browser-playwright/playwright-page-probe.ts#L194-L236), [`src/server/browser-playwright/playwright-page-probe.ts:L274-L294`](../../../src/server/browser-playwright/playwright-page-probe.ts#L274-L294). The failure is converted into a structured unsuccessful `PageProbeResult`, not thrown past the probe boundary [`src/server/browser-playwright/playwright-page-probe.ts:L79-L115`](../../../src/server/browser-playwright/playwright-page-probe.ts#L79-L115).

For an HTTP response of 400 or higher, the probe therefore knows the concrete status before producing the generic `http_error` message [`src/server/browser-playwright/playwright-page-probe.ts:L228-L236`](../../../src/server/browser-playwright/playwright-page-probe.ts#L228-L236). It does not collect response bodies, response headers as an artifact, screenshots, HAR files, or Playwright traces in this path.

There is one synthetic failure source outside Playwright: `MonitorService` applies a 75-second orchestration deadline and fabricates `check_deadline_exceeded` with `stage: "setup"` and only `totalMs`; all individual timings are zero and no final URL or HTTP status is available [`src/server/application/monitor-service.ts:L124-L141`](../../../src/server/application/monitor-service.ts#L124-L141), [`src/server/application/monitor-service.ts:L341-L368`](../../../src/server/application/monitor-service.ts#L341-L368).

### 2. MonitorService discards the extended envelope

The scheduled/manual worker calls `pageProbe.preview` with the claimed monitor URL and selector arrays [`src/server/application/monitor-service.ts:L147-L170`](../../../src/server/application/monitor-service.ts#L147-L170). On an unsuccessful result, it passes only:

```ts
{ code: result.code, message: result.message }
```

to `failCheck`; `stage`, `finalUrl`, `httpStatus`, all timings, and selector `field/index` are discarded at this exact boundary [`src/server/application/monitor-service.ts:L171-L186`](../../../src/server/application/monitor-service.ts#L171-L186).

Snapshot-construction failures use the same `failCheck` boundary and likewise retain only a code and message [`src/server/application/monitor-service.ts:L217-L232`](../../../src/server/application/monitor-service.ts#L217-L232).

### 3. SQLite retains code/message and retry identity, but no probe diagnostics

The `checks` table has `error_code` and `error_message`, along with monitor/intent/kind/status/result and start/completion timestamps; it has no columns or related table for stage, effective URL, HTTP status, timings, selector location, or diagnostic artifacts [`src/server/persistence/migrations/002-monitors.ts:L32-L62`](../../../src/server/persistence/migrations/002-monitors.ts#L32-L62). Migration 005 adds `is_final_error` and `retry_of_check_id`, allowing the initial failure and its retry/final outcome to be correlated [`src/server/persistence/migrations/005-retries-and-pause.ts:L5-L17`](../../../src/server/persistence/migrations/005-retries-and-pause.ts#L5-L17).

`failCheck` writes only `error_code`, `error_message`, completion time, and final-error flag [`src/server/persistence/monitor-store.ts:L471-L476`](../../../src/server/persistence/monitor-store.ts#L471-L476). The first failure schedules one retry after 60 seconds; a failed retry becomes final, schedules the next ordinary check, and creates the final-error notification [`src/server/persistence/monitor-store.ts:L707-L745`](../../../src/server/persistence/monitor-store.ts#L707-L745). Thus both attempts remain separate check records, but neither contains the discarded probe envelope.

No check-history pruning or retention job exists in `src/server`; checks are removed indirectly only through relational cascades when their owning monitor is deleted. This means persisted code/message history is durable for the life of the monitor, but there is no bounded retention mechanism available to reuse for larger diagnostic payloads.

The `notification_deliveries.diagnostic` column is not monitoring diagnostics. It stores bounded stdout/stderr diagnostics from the external Telegram sender when delivery finishes [`src/server/persistence/migrations/011-telegram-disabled-delivery.ts:L8-L18`](../../../src/server/persistence/migrations/011-telegram-disabled-delivery.ts#L8-L18), [`src/server/persistence/monitor-store.ts:L1191-L1192`](../../../src/server/persistence/monitor-store.ts#L1191-L1192).

### 4. HTTP/OpenAPI exposes only the persisted subset

The check schema exposes `errorCode`, `errorMessage`, `startedAt`, `completedAt`, retry/finality data, snapshot identifiers, and Telegram delivery state; there are no structured probe diagnostic properties [`src/server/http/contract.ts:L280-L329`](../../../src/server/http/contract.ts#L280-L329). The journal schema repeats the same check subset [`src/server/http/contract.ts:L476-L503`](../../../src/server/http/contract.ts#L476-L503).

`GET /api/checks` returns `listJournal()` directly, while monitor history is available via `GET /api/monitors/:monitorId/checks` [`src/server/http/server.ts:L419-L429`](../../../src/server/http/server.ts#L419-L429), [`src/server/http/server.ts:L473-L477`](../../../src/server/http/server.ts#L473-L477). The store queries map exactly the two error columns into `errorCode` and `errorMessage` for journal and monitor history [`src/server/persistence/monitor-store.ts:L968-L1015`](../../../src/server/persistence/monitor-store.ts#L968-L1015), [`src/server/persistence/monitor-store.ts:L1074-L1131`](../../../src/server/persistence/monitor-store.ts#L1074-L1131).

Interactive preview failures also lose their structured diagnostics at the HTTP boundary: although `PageProbeError` contains them, the route returns only the standard API error code/message via `apiError` [`src/server/http/server.ts:L377-L387`](../../../src/server/http/server.ts#L377-L387).

### 5. UI displays the generic outcome/message only

The Journal table receives the check error message but renders only the derived result label in its table; it does not render `errorCode`, stage, status, final URL, or timings [`src/ui/JournalWorkspace.tsx:L64-L95`](../../../src/ui/JournalWorkspace.tsx#L64-L95), [`src/ui/JournalWorkspace.tsx:L156-L162`](../../../src/ui/JournalWorkspace.tsx#L156-L162). The selected monitor’s history renders `errorMessage` under the check result, but likewise has no structured diagnostics [`src/ui/MonitorsWorkspace.tsx:L151-L160`](../../../src/ui/MonitorsWorkspace.tsx#L151-L160).

The notification center renders the persisted notification title/body and Telegram delivery state [`src/ui/NotificationsWorkspace.tsx:L76-L89`](../../../src/ui/NotificationsWorkspace.tsx#L76-L89). It does not retrieve additional failure details.

### 6. Final-error notification and Telegram receive only the generic message

Only a failed retry produces a `check_failed_final` notification. Its body embeds the generic persisted failure message; the error code and all structured probe diagnostics are omitted [`src/server/persistence/monitor-store.ts:L553-L564`](../../../src/server/persistence/monitor-store.ts#L553-L564), [`src/server/persistence/monitor-store.ts:L715-L730`](../../../src/server/persistence/monitor-store.ts#L715-L730).

The Telegram delivery job contains delivery/event/check IDs, monitor name, source URL, notification title/body, and observation time—no monitoring diagnostic structure [`src/server/persistence/monitor-store.ts:L78-L81`](../../../src/server/persistence/monitor-store.ts#L78-L81), [`src/server/persistence/monitor-store.ts:L1179-L1189`](../../../src/server/persistence/monitor-store.ts#L1179-L1189). For a failed check the dispatcher therefore sends the existing title, sanitized source URL, and generic body [`src/server/notifications/telegram-dispatcher.ts:L113-L121`](../../../src/server/notifications/telegram-dispatcher.ts#L113-L121), [`src/server/notifications/telegram-dispatcher.ts:L163-L169`](../../../src/server/notifications/telegram-dispatcher.ts#L163-L169).

### 7. NDJSON logger does not record monitoring failures

The production logger is created at startup and passed to the HTTP server/Telegram dispatcher [`src/server/cli.ts:L127-L149`](../../../src/server/cli.ts#L127-L149). Current calls record application lifecycle, release/update/rollback commands, and detailed-change preparation failures in Telegram. There is no `logger.write` call in `MonitorService`, PageProbe, or `MonitorStore` for a failed monitoring iteration. The closest reusable example is `telegram_change_details_failed`: it records safe identifiers, a bounded stage vocabulary, a sanitized error class name, and a fixed public message; logging is wrapped in `try/catch` so it cannot suppress the base alert [`src/server/notifications/telegram-dispatcher.ts:L171-L196`](../../../src/server/notifications/telegram-dispatcher.ts#L171-L196).

## NDJSON rotation and redaction

The logger writes one JSON object per line to `%LOCALAPPDATA%/WebsiteChangeMonitor/logs/application.ndjson`; the application path is defined in [`src/server/operations/paths.ts:L12-L29`](../../../src/server/operations/paths.ts#L12-L29), and file creation/writing in [`src/server/operations/logger.ts:L15-L24`](../../../src/server/operations/logger.ts#L15-L24).

Reusable behavior:

- Each record receives an ISO timestamp and event name.
- Values are recursively redacted before serialization.
- Any property whose key matches `authorization`, `cookie`, `credential`, `password`, `secret`, `stdin`, or `token` is replaced wholesale.
- Embedded URL credentials, bearer values, and Telegram bot-token-shaped strings are redacted from arbitrary strings.
- Arrays and nested objects are traversed.

The rules are implemented in [`src/server/operations/logger.ts:L6-L9`](../../../src/server/operations/logger.ts#L6-L9) and [`src/server/operations/logger.ts:L27-L40`](../../../src/server/operations/logger.ts#L27-L40).

Rotation occurs before an incoming record would make the active file exceed 10 MiB. The logger retains 20 numbered generations plus the active file, deletes generation 20, shifts generations 1–19, and renames the prior active file to `.1` [`src/server/operations/logger.ts:L4-L5`](../../../src/server/operations/logger.ts#L4-L5), [`src/server/operations/logger.ts:L42-L50`](../../../src/server/operations/logger.ts#L42-L50). Therefore capacity is approximately 210 MiB, not a time-based retention guarantee. Writes and rotation are synchronous; `write` can throw, so a monitoring-path integration would need the same best-effort isolation already used by Telegram change-detail logging.

Redaction limits relevant to future planning:

- the filter is key/pattern based, not an allowlist;
- ordinary query parameters, page text, arbitrary response headers, IP addresses, and non-matching session identifiers are not automatically removed;
- URLs without embedded credentials are retained in full;
- there is no per-event size bound in the logger itself.

These limits make the logger directly reusable for small allowlisted structured metadata, but not safe by itself for response bodies, headers, HTML, screenshots, or arbitrary browser/network traces.

## Retained versus discarded matrix

| Datum | PageProbe failure | SQLite check | HTTP/UI | Final-error notification / Telegram | NDJSON |
|---|---:|---:|---:|---:|---:|
| Monitor/check/retry identity | available at service boundary | retained | retained | partially retained internally; name/URL shown | not logged |
| Failure code | retained | retained | exposed; UI does not show it | discarded | not logged |
| Human-readable message | retained | retained | exposed/rendered | retained | not logged |
| Stage | retained | discarded in `MonitorService` | unavailable | unavailable | not logged |
| Effective final URL | retained | discarded | unavailable | source monitor URL only | not logged |
| HTTP status | retained when response exists | discarded | unavailable | unavailable | not logged |
| Total/per-stage timings | retained | discarded | unavailable | unavailable | not logged |
| Selector field/index | retained for applicable failures | discarded | unavailable | unavailable | not logged |
| Response headers/body | never collected | unavailable | unavailable | unavailable | unavailable |
| Screenshot/HAR/trace | never collected | unavailable | unavailable | unavailable | unavailable |

## Planning implications established by the repository

1. The lowest-friction capture seam is the `MonitorService` → `MonitorStore.failCheck` call, because it has both the claimed check identity and the complete `PageProbeFailure`.
2. `PageProbeDiagnostics` should be reused or deliberately projected; re-deriving HTTP status/stage/timings downstream is impossible after the current narrowing.
3. Retry-chain identifiers already distinguish first and final attempts, so a new correlation system is unnecessary.
4. SQLite check history and NDJSON solve different needs: SQLite is queryable per check but currently unbounded; NDJSON is size-bounded but operational, file-based, and not exposed through the UI.
5. Any NDJSON integration must be best-effort and use an explicit allowlist of scalar fields. Existing redaction is useful defense in depth, not sufficient permission to log raw page/network data.
6. Existing HTTP/UI/Telegram contracts need not expand merely to make diagnostics available to local investigation; that decision belongs to later frontiers. At present none of them can expose the discarded detail.
