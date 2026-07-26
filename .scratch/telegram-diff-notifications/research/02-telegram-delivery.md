# Текущий путь Telegram-доставки и его ограничения

## Краткий вывод

Подробности Изменения можно подготовить непосредственно перед Telegram-доставкой, не меняя схему SQLite и не сохраняя второй diff. Событие уже хранит `check_id`, а завершённая Проверка уже ссылается на оба Снимка; существующий `MonitorStore.getComparison(checkId)` возвращает их канонический JSON. Минимально необходимое расширение контракта доставки — дать `TelegramDeliveryJob` доступ к `checkId` (либо эквивалентно получить пару внутри store), после чего использовать тот же `compareSnapshots`, который обслуживает UI.

`telegram-alert-bus` принимает и отправляет обычный текст без `parse_mode`. Поэтому Markdown/HTML-экранирование не требуется и не должно добавляться; нужны только безопасная нормализация текста и детерминированный бюджет. Внешний sender уже умеет разбивать длинный текст на несколько сообщений, однако Website Change Monitor сейчас раньше него безусловно обрезает поле `message` до 3000 Unicode code points и не сообщает о неполноте.

## Сквозной поток

1. `createMonitorService` получает новый снимок страницы и вызывает `completeChange`, если каноническое содержимое отличается от текущего. Перед транзакцией он best-effort проверяет доступность Telegram через `beforeNotificationCommit`.
2. `MonitorStore.completeChange` одной SQLite-транзакцией:
   - сохраняет новый Снимок;
   - записывает `before_snapshot_id` и `after_snapshot_id` в Проверку;
   - обновляет текущий Снимок Монитора и расписание;
   - создаёт неизменяемое `notification_events` с `check_id`;
   - создаёт связанную строку `notification_deliveries`.
3. После завершения цикла Проверок `afterNotificationCommits` вызывает `telegram.drain()`. Следовательно, dispatcher читает уже зафиксированные Проверку, событие и оба Снимка.
4. `claimTelegramDelivery` атомарно выбирает первую `pending`-доставку текущего запуска, переводит её в `sending` и возвращает `TelegramDeliveryJob`.
5. `telegram-dispatcher` формирует строгий UTF-8 JSON и без shell запускает `<telegram-executable> send`. Текущий payload содержит ровно `monitor_id`, `status`, `observed_at`, `message`.
6. `telegram-alert-bus` валидирует payload, добавляет иконку, имя устройства и московское время, разбивает текст и вызывает Bot API `sendMessage`.
7. По exit code sender приложение фиксирует `delivered`, `permanent`, `temporary` или `timeout`; изменение состояния публикуется существующим механизмом доставки.

Основные швы: [`monitor-service.ts`](../../../src/server/application/monitor-service.ts), [`monitor-store.ts`](../../../src/server/persistence/monitor-store.ts), [`telegram-dispatcher.ts`](../../../src/server/notifications/telegram-dispatcher.ts), внешний [`service.py`](../../../../telegram-alert-bus/src/telegram_alert_bus/service.py).

## Какие данные доступны

`NotificationEventRecord` уже содержит `monitorName`, исторический `url`, `checkId`, заголовок, тело и время. Но текущий `TelegramDeliveryJob` и SQL в `claimTelegramDelivery` теряют `checkId`: наружу выходят только delivery/event IDs, kind, имя, URL, title/body и observedAt.

Для change-события `notification_events.check_id` ссылается на Проверку, а та — на `before_snapshot_id` и `after_snapshot_id`. `MonitorStore.getComparison(checkId)` уже возвращает оба канонических JSON. Поэтому:

- новая колонка и миграция не нужны;
- не требуется сохранять Telegram-специфическое представление;
- подробности можно вычислять после commit и перед запуском sender;
- для контрольных уведомлений и окончательных ошибок сравнение запрашивать не нужно;
- точный интерфейс (`checkId` в job или инкапсулированное чтение пары) следует выбрать в билете 03.

Если пара отсутствует или не разбирается, базовые `title`, URL и `body` остаются доступными для fallback.

## Форматирование и реальные лимиты

| Уровень | Текущее поведение |
| --- | --- |
| Website Change Monitor `monitor_id` | Обрезается до 100 Unicode code points |
| Website Change Monitor `message` | Обрезается до 3000 Unicode code points с завершающим `…` |
| Валидация `telegram-alert-bus` | `message` не более 100 000 Python characters |
| Физическое сообщение Telegram | 4096 characters |
| Разбиение sender | Бюджет 4080, приоритет границы строки, затем пробела, затем жёсткая граница; части получают `[N/M] ` |
| Диагностика процесса | stdout/stderr по 4096 code points, затем токены редактируются |
| Deadline Website Change Monitor | 70 секунд по умолчанию |

`PlainTextFormatter` не использует разметку. `TelegramClient` отправляет `chat_id`, `text` и `disable_web_page_preview=true`; поля `parse_mode` нет. HTML-подобный текст и специальные символы Markdown поэтому остаются обычным текстом и не требуют разметочного escaping.

Внешний sender не теряет длинный payload: его тест с 10 000 символов подтверждает multipart-доставку. Но текущая обрезка до 3000 в `telegram-dispatcher.ts` делает этот механизм недостижимым для обычного сообщения Website Change Monitor. Выбор между компактным односообщенческим бюджетом с явным маркером и контролируемым multipart остаётся продуктовым решением билета 04.

## Отказы, повторы и безопасное логирование

- Website Change Monitor не имеет очереди повторной отправки между запусками и не доставляет старые неуспехи задним числом.
- `telegram-alert-bus` внутри одного запуска делает транспортные повторы по своей политике, затем возвращает один exit code.
- Текущий dispatcher последовательно обрабатывает доставки и сохраняет ограниченную безопасную диагностику процесса.
- Ошибка подготовки подробностей должна перехватываться до вызова `runProcess`: после неё следует сформировать текущий базовый payload и продолжить обычную доставку.
- В лог нельзя помещать сырой канонический Снимок или полный текст diff. Достаточны имя события ошибки, `eventId`, `checkId` и безопасное сообщение/класс ошибки.

Проект уже имеет `NdjsonLogger` с редактированием токенов, credentials и bearer-значений, но runtime-цепочка сейчас создаёт logger в CLI только после `startApplication`, тогда как `buildHttpServer` и dispatcher его не получают. Самый короткий существующий шов — создать logger до запуска приложения и передать его как зависимость через `StartApplicationOptions` → `BuildHttpServerOptions` → `createTelegramDispatcher` (либо передать узкий callback `write`). Окончательный выбор зависимости и события лога относится к билетам 03–04; новая система логирования не нужна.

## Архитектурные следствия для следующих билетов

- Единственным классификатором остаётся `compareSnapshots`; Telegram не получает независимый diff.
- Подготовка подробностей относится к Telegram delivery boundary: UI и сохранённые title/body менять не нужно.
- SQLite-транзакцию завершения Проверки не следует нагружать форматированием Telegram: вся необходимая исходная информация уже долговечна и доступна после commit.
- Fallback должен быть построен вокруг неизменяемого базового payload, а не вокруг повторной записи Уведомления.
- Стратегия бюджета должна учитывать уже существующий multipart sender и явно обозначать неполноту, если приложение сознательно сокращает содержимое.
- Отсутствующая пара, неполное Сравнение или исключение проекции не должны менять Результат проверки или Состояние доставки до фактической попытки sender.

Нового термина предметной области и ADR для этого исследовательского вывода не требуется: используются существующие Проверка, Снимок, Сравнение, Уведомление и Состояние доставки Telegram.

## Проверка

- Website Change Monitor: `tests/telegram-dispatcher.test.ts`, `tests/monitor-service.test.ts`, `tests/control-notifications.test.ts` — 49 тестов прошли.
- `telegram-alert-bus`: `tests/test_formatter.py`, `tests/test_service.py` — 8 тестов прошли.
