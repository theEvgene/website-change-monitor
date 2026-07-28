# Нейтральное состояние отключённой Telegram-доставки

## Решение

Преднамеренно пропущенную Telegram-доставку следует хранить как отдельное
терминальное состояние `disabled` в существующей строке
`notification_deliveries`. В интерфейсе оно везде отображается точной нейтральной
подписью **«Telegram отключён»**, без `failure_reason`.

Это проще и согласованнее альтернатив:

- отсутствие строки доставки нарушило бы текущую модель «событие + одна доставка
  Telegram»: лента уведомлений использует обязательный `JOIN`, а Журнал и история
  Монитора трактуют отсутствие строки как отсутствие Telegram-события вообще
  (`src/server/persistence/monitor-store.ts:953-999,1059-1116,1181-1202`);
- `unavailable`, `abandoned` или одно из ошибочных состояний означают
  неуспешную попытку либо операционную проблему и сейчас сворачиваются UI в
  «Не отправлено» (`src/ui/telegram-delivery.ts:1-8`);
- отдельное поле-признак дублировало бы конечный автомат доставки и потребовало
  бы согласовывать две колонки во всех запросах.

Таким образом, `disabled` означает: событие существовало, отправка по Telegram
на момент фиксации результата была намеренно отключена, повторная отправка этой
доставки не планируется. Это не ошибка доступности и не незавершённая работа.

## Схема и миграция

Нужна новая миграция схемы (следующая после текущей версии 10), потому что
разрешённые значения зафиксированы `CHECK`-ограничением таблицы:
`pending`, `sending`, `delivered`, `unavailable`, `permanent`, `temporary`,
`timeout`, `abandoned` (`src/server/persistence/migrations/008-telegram-delivery.ts:9-22`,
`src/server/persistence/migrations/009-control-notifications.ts:39-53`;
текущая версия — `src/server/persistence/schema-version.ts:1`).

Миграция должна повторить уже применённый в migration 009 безопасный для этого
проекта шаблон:

1. скопировать `notification_deliveries` во временную таблицу;
2. пересоздать STRICT-таблицу с теми же колонками, внешним ключом,
   `UNIQUE(event_id, channel)` и расширенным `CHECK (..., 'disabled')`;
3. вернуть все строки без преобразования;
4. восстановить индекс
   `notification_deliveries_dispatch(boot_id, state, id)`.

Миграции выполняются вместе с записью версии внутри одной SQLite-транзакции
(`src/server/persistence/database.ts:86-113`). Backfill не нужен: ни одна
существующая доставка не была создана при новой runtime-настройке, поэтому все
старые состояния сохраняются дословно. Отдельно нужно поднять
`latestSchemaVersion` и добавить миграцию в упорядоченный список
(`src/server/persistence/database.ts:7-16,51-65`).

## Переходы и инварианты

### Создание нового события

Каждое `notification_event` продолжает получать ровно одну строку Telegram-
доставки в той же транзакции завершения Проверки. Текущий `recordNotification`
уже безусловно вставляет обе записи (`src/server/persistence/monitor-store.ts:497-529`).
Он должен получать снимок runtime-политики:

- Telegram включён и его проверка завершена успешно: `pending`;
- Telegram включён, но sender недоступен: `unavailable` с существующей причиной;
- Telegram отключён: `disabled`, `failure_reason = NULL`,
  `diagnostic = NULL`.

Во время повторного включения и проверки доступности новые записи остаются
`pending`, как определено первым фронтиром; запрет claim в этот момент принадлежит
runtime-контроллеру, а не новому durable-состоянию.

### Выключение

Одна транзакция store переводит:

```text
boot_id = текущий boot AND state = pending
    -> state = disabled, failure_reason = NULL, diagnostic = NULL
```

Она не меняет:

- `sending`: уже начатая отправка заканчивается обычным
  `finishTelegramDelivery`;
- `delivered`, ошибочные конечные состояния и `abandoned`;
- строки прежних boot-сессий.

Так сохраняется существующая граница гонки: claim условно и транзакционно делает
`pending → sending` (`src/server/persistence/monitor-store.ts:1161-1171`), а
массовый переход доступности уже затрагивает только `pending` текущего boot
(`src/server/persistence/monitor-store.ts:1151-1159`). Следовательно, каждая
доставка либо успела стать `sending` и получает фактический исход, либо осталась
`pending` и атомарно стала `disabled`.

### Claim, повторное включение и завершение процесса

Запрос claim уже выбирает только `state = 'pending'`, поэтому `disabled`
автоматически не выдаётся dispatcher и не требует отдельного исключения
(`src/server/persistence/monitor-store.ts:1161-1171`). После повторного включения
строки `disabled` не переводятся обратно в `pending`: ретроактивной досылки нет.

Dispatcher дополнительно должен проверять runtime-gate перед каждым claim, как
зафиксировано первым фронтиром. Сейчас проверка доступности выполняется только
перед циклом, а затем цикл способен захватить несколько работ
(`src/server/notifications/telegram-dispatcher.ts:69-85`).

Операции startup/shutdown должны сохранять прежнюю узкую семантику
`pending`/`sending → abandoned`; `disabled` в неё не включается
(`src/server/persistence/monitor-store.ts:1145-1149,1176-1177`).

## HTTP, SSE и представление

Нужно расширить один общий union состояния:

- server/domain type `NotificationEventRecord["telegram"]["state"]`
  (`src/server/persistence/monitor-store.ts:52-68`);
- HTTP schema `telegramDeliveryObjectSchema`
  (`src/server/http/contract.ts:268-275`);
- UI type `TelegramDeliveryState`
  (`src/ui/telegram-delivery.ts:1-3`).

Новый механизм SSE не нужен. Поток запоминает только `pending` и `sending`;
переход из `pending` в любое терминальное состояние уже публикуется как событие
`delivery`, после чего запись удаляется из `inFlightDeliveries`
(`src/server/http/server.ts:474-520`). Новое событие, сразу созданное как
`disabled`, приходит обычным `notification`/`replay`.

Единая функция `telegramDeliveryLabel` должна вернуть:

- `pending`/`sending` — существующее «Отправляется»;
- `delivered` — существующее «Отправлено»;
- `disabled` — **«Telegram отключён»**;
- остальные терминальные исходы — существующее «Не отправлено».

`failureReason` для `disabled` всегда `null`, поэтому UI не добавляет ошибочную
деталь. Одна общая функция уже используется всеми тремя поверхностями:

- Журнал (`src/ui/JournalWorkspace.tsx:85-96`);
- история выбранного Монитора (`src/ui/MonitorsWorkspace.tsx:151-160`);
- центр Уведомлений (`src/ui/NotificationsWorkspace.tsx:80-89`).

Это обеспечивает одинаковую формулировку без специальных веток в трёх
компонентах.

## Минимальная матрица автоматизированных проверок

1. **Миграция:** все восемь старых состояний, причины, diagnostics, идентификаторы
   и timestamps сохраняются; после миграции вставка `disabled` допустима, а
   неизвестное состояние по-прежнему отклоняется. База открывается с новой
   `latestSchemaVersion`. Существующий образец теста сохранения —
   `tests/control-notifications-migration.test.ts:6-33`.
2. **Создание:** при выключенном Telegram change, final error и разрешённый
   control event создают доставку `disabled` с обеими nullable-колонками `NULL`;
   при включённом режиме существующие `pending`/`unavailable` не меняются.
3. **Атомарное выключение:** только `pending` текущего boot становится
   `disabled`; `sending`, все завершённые состояния и другой boot сохраняются.
4. **Claim:** `disabled` никогда не возвращается
   `claimTelegramDelivery`; последующий `enable/recheck/drain` его не оживляет.
5. **Гонка:** начатая `sending` доставка завершается фактическим исходом после
   disable, а следующая `pending` становится `disabled`.
6. **SSE:** существующее событие получает `delivery` для
   `pending → disabled`; событие, созданное сразу `disabled`, приходит один раз
   как обычное live-событие. Базовый поток проверяется в
   `tests/notifications-sse.test.ts:12-36`.
7. **UI:** общий label и все три поверхности показывают «Telegram отключён» без
   «Не отправлено» и без текста ошибки. Центр Уведомлений уже имеет тест
   обновления состояния доставки через SSE
   (`tests/notifications-ui.test.tsx:34-63`); Журнал и история Монитора
   интеграционно покрываются в `tests/ui.test.tsx:471-484,592-621`.
8. **Регрессия:** существующие dispatcher-исходы `delivered`, `unavailable`,
   `permanent`, `temporary`, `timeout`, `abandoned` сохраняют прежние labels и
   поведение; их текущее покрытие находится в
   `tests/telegram-dispatcher.test.ts:18-23,69-85,198-248`.

## Затрагиваемые швы

Отдельный новый слой не нужен. Достаточно:

- одного нового terminal state в существующей delivery-модели;
- одной schema migration;
- одной атомарной store-команды для отключения и параметра начального состояния
  при `recordNotification`;
- расширения существующих TypeScript/HTTP union;
- одной ветки в общем UI formatter.

Runtime-контроллер первого фронтира решает, **когда** политика отключена;
`MonitorStore` фиксирует, **что произошло с конкретной доставкой**. Такое
разделение оставляет durable историю в SQLite, но не превращает SQLite во
владельца session-only настройки.
