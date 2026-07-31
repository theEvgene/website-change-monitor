# Накопленное сравнение Снимков Монитора

Status: ready-for-agent

## Problem Statement

Website Change Monitor показывает Сравнение двух последовательных Снимков, связанных с одной Проверкой. Если страница менялась несколько раз, пока пользователь не открывал её, ему приходится вручную просматривать несколько последовательных Сравнений, чтобы понять итоговую разницу между ранее увиденным и более поздним состоянием.

Пользователь должен иметь возможность открыть существующее Сравнение из Журнала, Истории Монитора или Уведомления и заменить только его прежнее состояние более ранним сохранённым Снимком. Конечное состояние должно оставаться привязанным к Проверке, из которой открыто окно. Итог должен вычисляться напрямую между выбранными границами, а не путём объединения промежуточных Изменений.

## Solution

Расширить базовую backend-логику Сравнения так, чтобы общий сервис мог сравнить любую хронологически допустимую пару сохранённых Снимков одного Монитора и одной ревизии Области наблюдения. Существующий HTTP-сценарий остаётся привязанным к `checkId`: Проверка определяет неизменяемый конечный Снимок, а необязательный выбранный начальный Снимок переопределяет прежнее состояние. Без переопределения endpoint возвращает прежнее последовательное Сравнение и сохраняет обратную совместимость.

Существующее широкое модальное окно открывается немедленно и во всех точках входа работает одинаково. Над левой колонкой находится выпадающий список реально сохранённых более ранних состояний, а над правой — статичная подпись конечного состояния. По умолчанию выбран прежний Снимок исходной Проверки. Смена значения немедленно запускает новое Сравнение, не изменяя сохранённые данные.

Запрос модалки выполняется через переиспользуемый React `RequestWrapper<T>` с публичным входом `Observable<T>`. Wrapper централизованно отображает загрузку, успешные данные, статичную ошибку и повтор запроса. При быстром переключении действует правило «последний выбор побеждает»: предыдущая подписка отменяется, а её запоздалый результат не может заменить актуальный.

## User Stories

1. As a пользователь, I want to открыть Сравнение из существующей строки с обнаруженным Изменением, so that мне не нужен новый раздел или отдельный маршрут.
2. As a пользователь, I want to сначала видеть прежнее последовательное Сравнение, so that привычный сценарий не меняется.
3. As a пользователь, I want to выбрать более ранний Снимок как начальное состояние, so that я вижу итоговую разницу за несколько Изменений.
4. As a пользователь, I want the конечный Снимок to remain tied to the source Проверка, so that контекст выбранной строки не меняется незаметно.
5. As a пользователь, I want to открыть другую Проверку того же Монитора, so that она задаёт собственную конечную границу.
6. As a пользователь, I want to выбирать только реально сохранённые состояния, so that календарная дата не скрывает неочевидный выбор Снимка.
7. As a пользователь, I want to видеть только Снимки, предшествующие конечному, so that нельзя построить обратный временной диапазон.
8. As a пользователь, I want the list of initial states ordered newest first, so that ближайшие состояния доступны первыми.
9. As a пользователь, I want all available earlier states in the list, so that первая версия не ограничивает глубину Накопленного сравнения.
10. As a пользователь, I want each state labelled with Moscow date and time, so that подпись согласована с Журналом и Историей Монитора.
11. As a пользователь, I want the usual label to contain day, month, hour and minute, so that список остаётся компактным.
12. As a пользователь, I want the year shown for states from another year, so that одинаковые даты разных лет не смешиваются.
13. As a пользователь, I want seconds shown only when two states would otherwise have the same label, so that элементы списка остаются различимыми.
14. As a пользователь, I want the selected initial timestamp to serve as the left heading, so that отдельный заголовок не дублирует выпадающий список.
15. As a пользователь, I want to see the fixed final timestamp above the right column, so that обе границы Сравнения понятны.
16. As a пользователь, I want the diff to update immediately after selection, so that отдельная кнопка подтверждения не нужна.
17. As a пользователь, I want the modal to open immediately, so that нажатие получает видимый отклик до завершения запроса.
18. As a пользователь, I want to see a centred loading state in the diff area, so that незавершённое Сравнение не выглядит готовым.
19. As a пользователь, I want the selector and modal close action to remain available while loading, so that запрос не блокирует управление окном.
20. As a пользователь, I want a later selection to supersede an earlier request, so that устаревший ответ не появляется под новой датой.
21. As a пользователь, I want a failed request to keep the selected value, so that интерфейс не меняет мой выбор без команды.
22. As a пользователь, I want a failed request to replace the diff with a static error state, so that старые данные не выдаются за результат нового выбора.
23. As a пользователь, I want to retry the selected comparison, so that временная ошибка не требует переключать список или переоткрывать окно.
24. As a пользователь, I want to see «Не удалось загрузить сравнение» instead of technical details, so that ошибка остаётся понятной и компактной.
25. As a пользователь, I want an exact empty comparison to show «Между выбранными состояниями изменений нет», so that две одинаковые колонки не создают шум.
26. As a пользователь, I want intermediate changes that disappeared before the final Snapshot omitted, so that Накопленное сравнение reflects only the net difference.
27. As a пользователь, I want clickable links and existing diff highlighting preserved, so that новая граница не ухудшает текущее представление Сравнения.
28. As a пользователь, I want comparison actions hidden for Проверки without detected Изменения, so that окно с одинаковым соседним состоянием не предлагается.
29. As a пользователь, I want the same modal behaviour from Журнал, История Монитора and Уведомления, so that точка входа не меняет возможности Сравнения.
30. As a пользователь, I want Telegram messages to remain unchanged, so that интерактивный выбор границы не влияет на уведомления.
31. As a разработчик, I want one backend comparison seam for arbitrary valid Snapshot pairs, so that future selection of both boundaries does not require replacing the diff engine.
32. As a разработчик, I want one reusable Observable request wrapper, so that loading, errors, retry and cancellation are not reimplemented in the comparison modal.
33. As a разработчик, I want RxJS adoption limited to this request flow, so that the feature does not become an unrelated frontend migration.
34. As a пользователь, I want closing the modal to cancel its active subscription, so that закрытое окно не получает устаревшее обновление.

## Implementation Decisions

- Накопленное сравнение is a direct comparison of two retained Снимки. Intermediate Сравнения and notification events are not loaded, merged or replayed.
- The existing deterministic Snapshot comparison algorithm remains the single source of diff semantics for sequential and accumulated comparisons.
- The application comparison seam accepts explicit initial and final Snapshot identities. It validates that both belong to the same Monitor and the same current historical scope and are in chronological order.
- Existing Snapshot persistence remains unchanged. A baseline and each changed state have a retained Snapshot; a Проверка without Изменения reuses the current Snapshot and does not create a duplicate.
- No database migration or new persistent read marker is introduced. There is no «просмотрено» state and no automatic movement of a baseline.
- The check-based HTTP comparison contract remains the UI entry seam. The requested `checkId` fixes the final Snapshot; an optional initial Snapshot identity selects an earlier state. Omitting it preserves the existing before/after pair.
- The comparison response supplies enough metadata for the modal to render the selected initial state, fixed final state, and all distinct eligible earlier states without inventing dates from Проверки that created no Snapshot.
- An explicit initial Snapshot must belong to the same Monitor and historical scope as the final Snapshot and must precede it. Cross-monitor, stale-scope, missing and future selections return the existing bounded API error envelope.
- Existing local host, origin and HTTP contract protections remain in force. Snapshot content is returned only through the existing comparison projection, not through a new raw-Snapshot endpoint.
- The modal opens immediately from any existing comparison entry point. Its source Проверка identity remains stable for the lifetime of that opening.
- The left column heading is the accessible initial-state selector itself. It has a non-visual accessible name «Прежнее состояние».
- The right heading is static and uses the form «Новое состояние · {timestamp}».
- Eligible initial states are distinct persisted Снимки earlier than the fixed endpoint, ordered from newest to oldest. The source Проверка's existing `beforeSnapshotId` is selected initially.
- Moscow time uses the existing `Europe/Moscow` convention. The normal visible form is day, month, hour and minute; the year is added when needed across years, and seconds are added only to labels that otherwise collide.
- Comparison controls are rendered only for Проверки whose result is `change` in Журнал, История Монитора and Уведомления. Existing non-comparable rows remain unchanged.
- RxJS is added as a runtime dependency. `Observable<T>` is the public input to a reusable React `RequestWrapper<T>`, as recorded in ADR 0001.
- The wrapper owns subscription lifecycle and the `loading`, `success` and `error` presentation states. It includes the standard retry action and accepts a configurable user-facing error message; callers render successful data.
- The comparison flow uses Observable switching semantics so the latest selected initial state wins. Unsubscription cancels the prior request where possible, and stale emissions are ignored in all cases.
- Loading replaces only the diff content with a centred indicator. The selector and modal close action remain enabled.
- Error replaces the diff content, preserves the attempted selector value, shows «Не удалось загрузить сравнение», and offers «Повторить» for the same pair. Raw backend or exception details are not rendered.
- Retry creates a fresh subscription for the currently selected pair. Changing the selector after an error starts the newly selected request normally.
- Closing or unmounting the modal unsubscribes from the active request without a toast or additional user-visible error.
- When the shared comparison result reports no difference between the chosen boundary states, the success area shows «Между выбранными состояниями изменений нет» instead of duplicate columns.
- Existing diff truncation, text highlighting, clickable-link handling, modal backdrop closing and accessibility behaviour remain unchanged unless directly required by the new selector and request states.
- Telegram, browser notifications, monitoring, Snapshot creation, scheduling, retry policy and notification delivery are unchanged.
- Existing Promise/fetch calls outside Snapshot comparison are not migrated. The broader RxJS migration remains separate future work.

## Testing Decisions

- Tests assert observable behaviour through the two agreed highest existing seams rather than private helper state.
- The backend seam is the local Fastify HTTP application backed by a temporary real SQLite database. Tests seed a Monitor with several distinct Sнимки and request sequential and accumulated comparisons through the public contract.
- API tests verify that omitting the initial identity preserves the existing adjacent comparison and response compatibility.
- API tests verify direct comparison of non-adjacent Sнимки and prove that an intermediate addition later removed does not appear in the net result.
- API tests reject an unknown Snapshot, a Snapshot from another Monitor, a Snapshot from another historical scope, and a Snapshot later than the fixed endpoint.
- API tests verify that only eligible distinct earlier states are exposed, in newest-first order, and that no-change Проверки do not manufacture duplicate options.
- Existing Snapshot comparison unit tests remain the prior art for diff correctness, truncation, structure, visible text and link projection. The unchanged algorithm is not duplicated in new tests.
- The frontend seam is React Testing Library operating through visible controls and mocked HTTP responses, following existing modal and workspace tests.
- UI tests open the modal from each supported entry point and verify the same fixed endpoint and selectable earlier-state behaviour.
- UI tests verify immediate modal opening, initial loading, default adjacent selection, timestamp headings and immediate accumulated reload.
- UI tests verify Moscow formatting, conditional year display and conditional seconds for colliding labels.
- A controlled pair of Observable requests proves latest-request-wins: selecting twice cancels or ignores the first response and only the second result renders.
- UI tests verify that selector and close controls remain available during loading and that closing unsubscribes without later rendering.
- UI tests verify the shared static error, preserved selection, retry of the same pair, recovery after retry, and switching to another state after an error.
- UI tests verify the exact empty-comparison message when the chosen states have no net difference.
- UI tests verify that comparison actions are absent for baseline, no-change, running and error results and remain available for change results wherever those rows appear.
- Regression tests preserve existing diff colours, text-only presentation, clickable links, truncation notice, modal backdrop behaviour and default adjacent comparison.
- Acceptance requires clean type checking, the complete automated test suite and a consistent OpenAPI/HTTP contract.

## Out of Scope

- Marking a state as reviewed, read or acknowledged.
- Automatically moving a per-Monitor comparison baseline.
- A calendar or free-form date picker.
- Exposing an editable final-state selector in the first UI.
- A new page, route, timeline screen or separate accumulated-comparison action.
- Summing, replaying or presenting every intermediate Изменение.
- Showing transient changes that disappeared before the final state.
- Creating duplicate Sнимки for Проверки without Изменения.
- Changing Snapshot retention or historical-scope reset behaviour.
- Changing the Snapshot diff algorithm or introducing a second comparison algorithm.
- Changing Telegram messages, delivery, browser notifications or the notification centre.
- Refactoring unrelated `fetch` or Promise code to RxJS.
- Search, pagination or virtualisation in the initial-state selector.
- Implementing the future arbitrary-final-state UI even though the backend comparison seam supports an explicit pair.
- Portfolio/CV preparation tracked separately in GitHub Discussion #66.
- Implementation during `/to-spec`; implementation begins only after `/to-tickets`.

## Further Notes

- The specification was synthesized from the completed `grill-with-docs` interview, the current domain glossary and ADR 0001.
- The term Накопленное сравнение is defined in `CONTEXT.md`. It is intentionally a net comparison, not a sum of historical events.
- The existing scope-reset rule already removes history after a confirmed change to the URL or selectors, preventing comparison across incompatible Области наблюдения.
- The first UI fixes the endpoint to the source Проверка, while the backend seam deliberately accepts an explicit valid pair to support a future second selector without replacing the comparison engine.

### Acceptance Criteria

- Opening comparison for a changed Проверка immediately shows the modal and then its existing adjacent diff.
- The user can replace the initial state with any eligible earlier saved Snapshot and receive a direct net diff against the fixed final state.
- The final state cannot be changed inside the modal and later Sнимки cannot be selected as the initial state.
- Intermediate changes that do not exist at either boundary are absent from the result.
- All modal entry points provide the same selector and request-state behaviour.
- Only changed Проверки expose a comparison action.
- Timestamps follow the agreed Moscow, year and collision rules.
- Loading, error, retry, rapid reselection and modal closing follow the Observable wrapper contract without stale rendering.
- Empty net comparisons show the agreed static message.
- Invalid Snapshot pairs are rejected without exposing raw Snapshot data.
- Telegram and unrelated request flows remain unchanged.
- RxJS is introduced only for the reusable request wrapper and comparison flow.
- The agreed API and React integration suites pass together with all existing automated checks.
