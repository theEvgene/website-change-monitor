# Структурированная диагностика ошибочных Проверок

Status: ready-for-agent

## Problem Statement

Website Change Monitor сохраняет для ошибочной Проверки только общий код и
пользовательское сообщение. При этом исследование страницы уже формирует более
точные структурированные сведения: этап ошибки, итоговый URL, HTTP-статус,
длительности этапов и положение проблемного селектора. Эти сведения теряются до
записи Результата проверки.

Из-за этого пользователь получает полезное Уведомление о факте ошибки, но агент
не может по сохранённой Проверке определить, на каком этапе и при каких
обстоятельствах произошёл сбой. Для расследования приходится воспроизводить
ошибку либо собирать временные данные вручную. Постоянно сохранять HTML,
заголовки, cookies, скриншоты и browser traces нельзя: это избыточно для
локального MVP и создаёт ненужный риск утечки содержимого страницы и секретов.

Нужна ограниченная Диагностика Проверки, существующая только для ошибочных
Проверок, доступная агенту через локальный HTTP API и автоматически удаляемая
через 14 суток. Сбой этой вспомогательной функции не должен менять сам Результат
проверки, Повторную проверку, Уведомления или работоспособность приложения.

## Solution

При каждом ошибочном Результате проверки приложение best-effort формирует одну
allowlisted Диагностику Проверки и связывает её с конкретным `checkId`.
Диагностика хранится в отдельной SQLite-записи и содержит только ограниченные
структурированные значения: этап ошибки, безопасно сокращённый итоговый URL,
HTTP-статус, общую и поэтапные длительности и, когда применимо, положение
проблемного селектора.

Проверка остаётся источником своей идентичности, вида, времён, пользовательского
кода и сообщения ошибки, финальности и связи с Повторной проверкой. Эти значения
не дублируются в диагностической таблице. Успешные Проверки не создают
диагностику.

Агент находит `checkId` через существующий журнал или Историю Монитора и
запрашивает документированный endpoint
`GET /api/checks/{checkId}/diagnostics`. Ответ явно различает доступную
диагностику, неприменимость к успешной Проверке, истечение срока хранения и
деградацию best-effort записи. UI и экспорт файлов не добавляются.

Диагностика старше 14 суток удаляется при запуске приложения и не реже одного
раза за каждые 24 часа непрерывной работы. Для неё не создаётся отдельный архив
или механизм восстановления. Существующие резервные копии всей базы не
переписываются задним числом.

## User Stories

1. As a пользователь, I want an ошибочная Проверка to retain safe technical context, so that её причину можно расследовать после события.
2. As a пользователь, I want successful Проверки to create no diagnostic records, so that ordinary monitoring does not accumulate unnecessary data.
3. As a пользователь, I want the existing Результат проверки to remain canonical, so that diagnostics cannot change monitoring history.
4. As a пользователь, I want a failed diagnostic write to leave the Проверка failed as originally determined, so that auxiliary logging cannot falsify the outcome.
5. As a пользователь, I want Повторная проверка to retain its existing behavior, so that diagnostics do not change retry policy.
6. As a пользователь, I want Окончательная ошибка to keep producing its existing Уведомление, so that diagnostic failures do not suppress alerts.
7. As an агент, I want to locate a failed Проверка through the existing journal or История Монитора, so that no new discovery workflow is required.
8. As an агент, I want to request diagnostics by `checkId`, so that the evidence is tied to one exact attempt.
9. As an агент, I want to know the stage at which the Проверка failed, so that investigation starts at the relevant subsystem.
10. As an агент, I want to see the effective final URL without credentials, query, or fragment, so that redirects are visible without exposing sensitive values.
11. As an агент, I want to see the main-document HTTP status when known, so that server responses can be distinguished from browser timeouts.
12. As an агент, I want to see total and per-stage durations when known, so that timeout and performance-related failures can be localized.
13. As an агент, I want to see whether a target or exclusion selector and its index caused the failure, so that the affected Monitor configuration can be identified.
14. As an агент, I want unknown diagnostic values to be represented as absent rather than zero, so that missing evidence is not mistaken for measured evidence.
15. As an агент, I want the endpoint to distinguish `available`, `not_applicable`, `expired`, and `unavailable`, so that absence has an unambiguous meaning.
16. As an агент, I want an unknown `checkId` to return the standard not-found error, so that invalid identity is distinct from missing diagnostics.
17. As an агент, I want the endpoint documented in OpenAPI, so that I can discover and call it without reading implementation code.
18. As a пользователь, I want HTML, response bodies, headers, cookies, credentials and browser traces excluded, so that investigation does not create a sensitive archive.
19. As a пользователь, I want diagnostic data older than 14 days removed automatically, so that retention is bounded without manual maintenance.
20. As a пользователь, I want expiration to remove only Диагностика Проверки, so that the original error, history and retry relation remain intact.
21. As a пользователь, I want no diagnostic archive or tombstone after cleanup, so that deleted diagnostics are not intentionally recoverable through this feature.
22. As a пользователь, I want cleanup failures not to block application startup, so that optional maintenance cannot stop monitoring.
23. As a пользователь, I want cleanup failures not to block future Проверки or Уведомления, so that the application remains operational.
24. As an оператор, I want diagnostic subsystem failures to produce only a bounded operational event, so that the failure is visible without copying sensitive payloads.
25. As a пользователь, I want deleting a Monitor or its Проверка to cascade to its diagnostics, so that no orphaned technical record remains.
26. As a владелец приложения, I want the feature to remain independent of particular websites, so that the same contract works for every Monitor.

## Implementation Decisions

- SQLite is the sole source of truth for Диагностика Проверки. The diagnostic
  record is not duplicated as an NDJSON monitoring event.
- A new table stores at most one record per failed Проверка through a unique
  foreign key to `check_id`; deletion of the Проверка cascades to its
  diagnostics.
- The diagnostic record stores `recorded_at`, a closed `stage` value, optional
  `final_url`, optional `http_status`, required `total_ms`, optional
  `navigation_ms`, `target_ms`, `scroll_ms`, `stability_ms` and
  `extraction_ms`, plus optional paired `selector_field` and `selector_index`.
- Unknown values are stored as `NULL`. Synthetic orchestration failures retain
  only measurements actually known to the application.
- Existing Проверка fields supply `checkId`, `monitorId`, kind, start and
  completion times, `errorCode`, `errorMessage`, finality and retry identity.
  They are joined when needed but not copied into the diagnostic table.
- Existing retry linkage is sufficient. No new correlation identifier is
  introduced.
- The capture seam is the application-to-persistence failure transition, where
  both the claimed Проверка identity and the complete structured failure are
  available.
- Browser failures are projected from the existing structured probe result.
  Snapshot and other application-level failures use a defined application
  `stage` and only the fields known at that boundary.
- A single shared closed diagnostic type is used by capture, persistence and
  HTTP serialization. The HTTP layer does not independently reinterpret
  browser failures.
- Only explicitly allowlisted fields are accepted. The implementation does not
  serialize a failure object, exception or browser output wholesale.
- `stage` and `selector_field` use closed enums. Timings must be finite,
  non-negative integers within bounded ranges. HTTP status must be an integer
  in the valid HTTP range. Selector index must be a non-negative integer and
  may exist only with selector field.
- `final_url` must be a bounded valid HTTP(S) URL. Before persistence, its
  username, password, query string and fragment are removed. Invalid optional
  values become `NULL`.
- HTML, page or response bodies, headers, cookies, credentials, tokens,
  screenshots, HAR, traces, stack traces and arbitrary exception messages are
  never diagnostic fields.
- Diagnostic formation, validation and insertion are best-effort and isolated
  from the canonical failure transition. They cannot change the Результат
  проверки, retry scheduling, final notification or worker lifecycle.
- A diagnostic write failure may produce a best-effort operational NDJSON event
  containing only `checkId`, a fixed subsystem stage and a fixed message. It
  contains no diagnostic payload, and failure to write that event is suppressed.
- Complete unavailability of the primary SQLite database remains a fatal
  storage failure; best-effort behavior applies only to the optional diagnostic
  record.
- `GET /api/checks/{checkId}/diagnostics` is added to the existing local Fastify
  and OpenAPI contract. It does not bypass existing local host/origin
  restrictions.
- For an existing Проверка the response is `200` with `checkId`,
  `availability`, and `diagnostic`. `diagnostic` is non-null only when
  availability is `available`.
- Availability is `available` when a retained record exists,
  `not_applicable` when the Проверка was successful, `expired` when an error is
  older than the 14-day retention window, and `unavailable` when a recent
  failed Проверка lacks its best-effort record.
- A nonexistent `checkId` returns the existing standard `404 not_found`
  envelope.
- The available response may join the safe existing Проверка fields needed by
  an agent, but persistence continues to avoid duplicating them.
- Cleanup deletes records where `recorded_at` is older than 14 days. The exact
  boundary is retained.
- Cleanup runs during application startup and at least every 24 hours during
  continuous operation. It is an idempotent short transaction.
- Cleanup failure is best-effort, may emit the same bounded operational signal,
  does not block startup or monitoring, and is retried at the next scheduled
  opportunity.
- Cleanup removes only diagnostics. It does not modify Проверки, user-visible
  errors, Историю Монитора, retry relationships or Уведомления.
- No separate archive, cache, tombstone, export, deep-diagnostic mode or
  recovery facility is introduced. Existing whole-database backups are not
  rewritten or retroactively scrubbed.
- Existing journal/history responses, Telegram delivery, user interface and
  monitoring schedule remain unchanged.
- No new ADR or external abstraction layer is required.

## Testing Decisions

- The principal test seam is the existing local HTTP application running
  against a temporary real SQLite database and a controlled page-probe double.
  One integration test covers the full observable path from structured probe
  failure through the canonical Проверка transition and persistence to the
  diagnostics endpoint.
- Tests assert externally observable records, API responses and retained
  application behavior rather than private helper calls or SQL implementation
  details.
- Migration tests follow the existing migration-test pattern. They verify the
  unique foreign key, cascade behavior, accepted constraints and cleanup index.
- Monitor service tests follow existing failure/retry tests. They cover browser,
  snapshot/application and interrupted-check failure paths, while proving that
  `baseline`, `no_change` and `change` create no diagnostics.
- Persistence tests cover all allowed stages and fields, `NULL` semantics,
  selector pairing, range validation and safe URL normalization.
- Failure-isolation tests inject diagnostic projection, insertion and
  operational-logging failures. The original error result, Повторная проверка,
  Окончательная ошибка, Уведомление and worker progress must remain unchanged.
- Retention tests use a controlled clock. They verify deletion strictly beyond
  14 days, retention at the boundary, preservation of Проверки, idempotency,
  startup cleanup and the recurring 24-hour lifecycle.
- Cleanup-failure tests prove that startup and subsequent Проверки continue and
  that cleanup can succeed at a later opportunity.
- HTTP tests use Fastify `inject` and cover `available`, `not_applicable`,
  `expired`, `unavailable` and unknown `checkId`.
- HTTP tests assert that prohibited fields and unsanitized URL components never
  appear in serialized responses.
- The existing OpenAPI contract test adds the route, operation ID, response
  schema and availability enums.
- Cascade tests delete the owning Проверка or Monitor and prove that no
  diagnostic row, archive or exported artifact remains.
- Regression tests preserve existing schedules, retry timing, notification
  behavior, journal/history payloads and Telegram behavior.
- Acceptance requires clean type checking, the complete automated test suite
  and a consistent generated OpenAPI contract.

## Out of Scope

- Diagnosing or fixing the current error of any specific Monitor, including
  Sendcloud.
- Diagnostics for successful Проверки.
- Permanent HTML, page body, screenshot, HAR, trace, network traffic, header or
  cookie capture.
- A temporary deep-diagnostic or verbose browser mode.
- A user-facing diagnostics page, modal, journal column or other UI change.
- Exporting diagnostics to a file.
- Duplicating each diagnostic record in NDJSON.
- External log aggregation, telemetry, cloud storage or application hosting.
- Rewriting or retroactively cleaning existing whole-database backups.
- A forensic secure-erase guarantee for SQLite storage media.
- Changes to page preparation, snapshot creation, comparison semantics,
  scheduling, retry policy or Telegram messages.
- Logic specific to Sendcloud or any other website or content domain.
- Implementation during `/to-spec`; implementation work begins only after
  `/to-tickets`.

## Further Notes

- The specification is synthesized from the completed
  [Wayfinder map](map.md), its four resolved investigation tickets and the
  current domain glossary. Detailed repository tracing remains in
  [the research asset](research/01-current-failure-diagnostics.md) rather than
  being duplicated here.
- The test seam was explicitly agreed during Wayfinder: the agent consumes a
  documented endpoint without UI changes, and the highest-value integration
  test exercises that same external workflow.
- The feature intentionally captures only enough structured evidence to direct
  a later investigation. If a concrete incident proves the allowlist
  insufficient, a separate proposal should identify the missing safe field
  instead of enabling broad artifact capture.

### Acceptance Criteria

- Every failed Проверка may have at most one linked Диагностика Проверки, and
  successful Проверки have none.
- Available diagnostics expose the agreed stage, safe URL, HTTP, timing and
  selector fields without arbitrary browser data.
- The agent can discover the endpoint through OpenAPI and retrieve diagnostics
  by a `checkId` obtained from existing history.
- The endpoint distinguishes available, not applicable, expired, unavailable
  and unknown-check states.
- Credentials, query parameters, fragments, HTML, headers, cookies, tokens,
  traces and stack data are absent from storage and API responses.
- Diagnostics older than 14 days are removed at startup and during continuous
  operation without deleting the original Проверка.
- The feature creates no dedicated archive, backup, tombstone or export.
- Diagnostic write, formatting, operational-log and cleanup failures do not
  alter monitoring results, retries, notifications or application availability.
- Deleting a Проверка or Monitor removes linked diagnostics by cascade.
- Existing journal, monitor history, Telegram, UI and scheduling behavior remain
  unchanged.
- All migration, service, persistence, retention, HTTP, OpenAPI, isolation and
  regression scenarios are covered by automated tests.
