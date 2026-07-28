# Контракт runtime-настроек, health и интерфейса Telegram

## Краткий вывод

Минимальный согласованный контракт строится вокруг уже существующих
`GET/PUT /api/settings/notifications`, `GET /api/health`,
`GET /api/telegram` и `POST /api/telegram/recheck`. Новый route не нужен.

Серверный runtime-контроллер из первого фронтира возвращает обе эффективные
настройки и фазу перехода. Health и Telegram-state расширяются нейтральными
состояниями `disabled` и `checking`. React только отображает серверное состояние:
главный переключатель управляет всеми Telegram-сообщениями, зависимый
переключатель доступен при включённом главном, а выключенный канал не ухудшает
общий health.

## Текущие швы

- `buildHttpServer` — composition root, где создаются dispatcher и monitor
  service, выполняется Telegram initialization, а затем запускаются первые
  Проверки (`src/server/http/server.ts:84-113`). Здесь же логично создать один
  runtime-контроллер.
- Сейчас settings routes напрямую читают и записывают SQLite через
  `MonitorStore.notificationSettings/updateNotificationSettings`
  (`src/server/http/server.ts:241-245`;
  `src/server/persistence/monitor-store.ts:1138-1144`). Это место должно
  переключиться на runtime-контроллер; таблица `application_settings` остаётся
  неиспользуемым legacy-хранилищем.
- Текущая settings schema содержит только обязательный
  `notifyWhenUnchanged` (`src/server/http/contract.ts:505-508,759-766`).
- Health сейчас всегда выводит общий `degraded`, когда sender недоступен, и
  различает только `available/unavailable`
  (`src/server/http/server.ts:222-236`;
  `src/server/http/contract.ts:76-109`).
- Dispatcher уже имеет отдельные `initialize`, `recheck`, `state` и
  availability inspection (`src/server/notifications/telegram-dispatcher.ts:14-19,27-44,87-99`).
  Сейчас `recheck` сразу записывает результат в store, а drain проверяет
  доступность только перед входом в цикл (`src/server/notifications/telegram-dispatcher.ts:69-90`);
  первый фронтир заменяет это координацией через runtime-controller и gate перед
  каждым claim.
- React загружает settings отдельно от health, опрашивает
  `GET /api/telegram` раз в пять секунд и локально пересчитывает общий health
  только по `available/unavailable` (`src/ui/App.tsx:59-128`). Модалка настроек
  имеет один switch (`src/ui/App.tsx:283-307`), а карточка состояния Telegram —
  только ready/warning и кнопку ручной перепроверки
  (`src/ui/App.tsx:233-280`).
- `doctor` не использует HTTP server или React state: он отдельно читает путь
  sender из Базы данных и вызывает `inspectTelegramExecutable`
  (`src/server/operations/doctor.ts:78-107`). Поэтому изменения runtime API не
  должны затрагивать его.

## Предлагаемый HTTP-контракт

### Runtime-настройки

Полный ответ `GET /api/settings/notifications` и успешного `PUT`:

```ts
type NotificationSettingsResponse = {
  telegramEnabled: boolean;
  notifyWhenUnchanged: boolean;
  telegramPhase: "checking" | "enabled" | "disabled";
};
```

Инварианты ответа:

- `telegramEnabled === false` всегда означает
  `notifyWhenUnchanged === false` и `telegramPhase === "disabled"`;
- `telegramPhase === "checking"` возможна только при
  `telegramEnabled === true`;
- `telegramPhase === "enabled"` означает, что recheck завершён; фактическая
  доступность sender берётся из Telegram/health state и может быть как
  available, так и unavailable.

`PUT /api/settings/notifications` принимает непустой частичный patch:

```ts
type NotificationSettingsUpdateRequest = {
  telegramEnabled?: boolean;
  notifyWhenUnchanged?: boolean;
};
```

JSON schema должна иметь `additionalProperties: false`, обе boolean property
необязательны и `minProperties: 1`. Это сохраняет совместимость старого payload
`{ "notifyWhenUnchanged": true }`, на необходимость которой указывает первый
фронтир. Пустой или типово неверный payload получает существующий `400
invalid_request`.

Правила команды:

1. `{ telegramEnabled: false }` атомарно отключает канал и автоматически
   выключает `notifyWhenUnchanged`.
2. `{ telegramEnabled: true }` переводит runtime в `checking`, немедленно
   запускает availability check и завершает HTTP-запрос после применения
   актуального результата. Новые delivery во время проверки остаются `pending`,
   но не claim-ятся.
3. Patch только `notifyWhenUnchanged` меняет зависимое значение лишь при
   включённом Telegram.
4. Любая противоречивая комбинация, например
   `{ telegramEnabled: false, notifyWhenUnchanged: true }`, нормализуется в
   `false/false` и возвращает effective response. Это проще для старого клиента,
   сохраняет серверный инвариант и не превращает автоматическое выключение
   дочерней настройки в ошибку.
5. Повторная отправка уже `disabled` delivery не выполняется.

При гонке нескольких PUT generation token первого фронтира определяет
последнюю применённую команду. В частности, disable, пришедший во время enable
recheck, немедленно возвращает `disabled`; поздний результат recheck
игнорируется. Каждый ответ строится из актуального effective state после
применения своей команды, а не из request payload.

### Telegram-state и health

Один общий union используется в `GET /api/telegram`, ответе
`POST /api/telegram/recheck` и поле `telegram` ответа health:

```ts
type TelegramRuntimeState =
  | { status: "available"; reason: null }
  | { status: "unavailable"; reason: string | null }
  | { status: "checking"; reason: null }
  | { status: "disabled"; reason: null };
```

Это расширяет существующую структуру `{status, reason}` без нового объекта
(`src/server/http/contract.ts:94-109`). `GET /api/telegram` не запускает
проверку, а только читает runtime state.

`POST /api/telegram/recheck`:

- при включённом Telegram запускает generation-safe recheck и возвращает
  конечное `available/unavailable`;
- при выключенном Telegram не запускает sender и идемпотентно возвращает
  `{ status: "disabled", reason: null }`.

Последнее правило не позволяет ручному или фоновому запросу скрыто проверять
канал, который пользователь исключил из мониторинга. Включение выполняет свою
обязательную проверку через settings command, а не требует второго HTTP-запроса.

`GET /api/health` сохраняет текущую верхнеуровневую схему и рассчитывает статус:

| Telegram runtime state | `health.status` | Плашка |
| --- | --- | --- |
| `available` | `ready` | зелёная |
| `disabled` | `ready` | зелёная |
| `checking` | `degraded` | нейтральная loading-плашка до результата |
| `unavailable` | `degraded` | warning |

SQLite остаётся обязательным компонентом. В текущей модели database status
имеет только `ready` (`src/server/http/contract.ts:85-92`); если позднее появится
ошибочное состояние хранилища, оно должно иметь приоритет над Telegram и давать
общую ошибку независимо от настройки канала.

## React-поведение

### Модалка настроек

`App` хранит единый объект settings вместо отдельного
`notifyWhenUnchanged` (`src/ui/App.tsx:38-50,94-106`).

1. Первый switch: **«Отправлять уведомления в Telegram»**.
2. Второй: **«Уведомлять при отсутствии изменений»**.
3. Дочерний switch disabled, если settings ещё не загружены, выполняется
   update, `telegramEnabled === false` или `telegramPhase === "checking"`.
4. При успешном выключении UI принимает authoritative response, поэтому оба
   switch становятся выключенными.
5. При успешном включении главный switch включён, дочерний остаётся выключенным
   (выключенное значение не восстанавливается). После завершения recheck
   дочерний снова доступен даже при `unavailable`: его доступность зависит от
   пользовательского режима, а не от работоспособности sender.
6. Пока PUT выполняется, оба switch недоступны. Закрытие модалки допустимо:
   состояние принадлежит `App`, поэтому завершившийся запрос не теряется.
7. При non-2xx или network error последнее подтверждённое состояние не
   изменяется, busy снимается и используется существующий верхний toast с
   ошибкой. Рядом со switch сообщение не добавляется.

Фоновый пятисекундный refresh должен принимать все четыре Telegram-state и
пересчитывать health по таблице выше. Он не должен перезаписывать settings.
Во время PUT/recheck поздний ответ poll не должен отменять более новое состояние:
проще всего после settings response обновить settings и заново запросить
`/api/health`, а Telegram poll применять только как availability state,
обязательно учитывая текущее `telegramEnabled`.

### Плашка и модалка состояния

- При `disabled` верхняя плашка имеет то же зелёное presentation
  **«Система готова»**, что и при available. Tooltip не утверждает, что Telegram
  доступен; достаточно «SQLite доступна, уведомления Telegram отключены».
- Telegram-карточка в модалке получает отдельный серый visual state, основной
  текст **«Telegram отключён»** и точную подпись
  **«Уведомления через Telegram отключены в настройках.»**
- В disabled-карточке нет причины ошибки, warning marker, кнопки
  «Проверить снова» или действия перехода в настройки.
- При `checking` карточка нейтрально показывает проверку доступности и не
  позволяет повторно нажать recheck.
- При enabled+available и enabled+unavailable сохраняются текущие зелёная и
  warning карточки, причина недоступности и ручная кнопка повторной проверки
  (`src/ui/App.tsx:263-273`).

Нейтральное `disabled` конкретной доставки не требует логики в `App`: второй
фронтир расширяет общий `telegramDeliveryLabel`, уже используемый Журналом,
историей Монитора и центром Уведомлений
(`src/ui/JournalWorkspace.tsx:85-96`;
`src/ui/MonitorsWorkspace.tsx:151-160`;
`src/ui/NotificationsWorkspace.tsx:80-89`).

## Поток данных

```text
React SettingsDialog
  -> PUT /api/settings/notifications
  -> runtime notification controller
       -> generation-safe Telegram recheck / dispatcher gate
       -> atomic MonitorStore delivery transitions
  <- effective settings

runtime controller + dispatcher availability + database diagnostics
  -> GET /api/health, GET /api/telegram
  -> top badge and SystemStatusDialog

immutable policy snapshot at check commit
  -> MonitorStore event + delivery
  -> REST/SSE
  -> shared telegramDeliveryLabel
```

Этот поток не создаёт второго владельца: runtime-controller отвечает за
настройку текущего процесса, dispatcher — за sender, store — за durable outcome,
React — только за presentation.

## `doctor`

`npm run doctor` не читает settings endpoint и не получает runtime-controller.
Он, как сейчас, при каждом отдельном запуске читает настроенный executable и
вызывает `inspectTelegramExecutable` (`src/server/operations/doctor.ts:78-107`).
Следовательно, Telegram остаётся обязательной диагностической проверкой doctor
даже тогда, когда работающий UI временно показывает `disabled`. Изменять
`doctor.ts`, его результат или CLI-контракт для этой фичи не требуется.

## Автоматизированная матрица

### HTTP и runtime

1. Новый server на новой и повторно открытой прежней Базе данных возвращает
   `{telegramEnabled:true, notifyWhenUnchanged:false}`; SQLite legacy-value не
   влияет.
2. GET возвращает full effective state и фазу.
3. Старый PUT только с `notifyWhenUnchanged` остаётся валиден.
4. Empty/unknown/wrong-type update получает 400.
5. Disable возвращает false/false/disabled и переводит только допустимые
   delivery по правилам фронтиров 01–02.
6. Противоречивый payload нормализуется в false/false.
7. Enable запускает recheck; во время него новые delivery pending, claim закрыт.
8. Успешный enable открывает drain только новым pending; старые disabled не
   оживают.
9. Неуспешный enable оставляет настройку включённой, health degraded, а
   ожидавшие recheck delivery получают unavailable.
10. Disable во время recheck выигрывает; поздний результат не меняет state.
11. Sending завершается, а следующий pending становится disabled.
12. Recheck при disabled не вызывает inspector и возвращает disabled.
13. GET Telegram и health отображают checking/disabled/available/unavailable
   согласованно.
14. `health.status` ready при disabled и available, degraded при checking и
   unavailable.

Текущая база route/health тестов находится в `tests/http.test.ts:14-72`, а
OpenAPI operation/schema registration — в `tests/http-contract.test.ts:31-82`.
Гонки и dispatcher outcomes следует расширять рядом с существующими сценариями
recovery/restart (`tests/telegram-dispatcher.test.ts:207-237`).

### События, delivery и SSE

15. Change и final error при disabled сохраняют внутреннее событие с delivery
   `disabled`; sender не вызывается.
16. No-change при дочерней настройке off не создаёт control event.
17. No-change при обеих настройках on создаёт browser/control event и Telegram
   delivery; после отключения главного дочерняя effective-настройка false.
18. `pending -> disabled` публикуется существующим SSE delivery event; сразу
   созданный disabled приходит обычным notification/replay один раз.
19. Все три UI-поверхности показывают «Telegram отключён» без failure reason;
   остальные delivery labels не меняются.

Текущая семантика control notification покрыта
`tests/control-notifications.test.ts:10-45`, доставка контрольного сообщения —
`tests/telegram-dispatcher.test.ts:190-197`, а SSE tracking реализован в
`src/server/http/server.ts:474-520`.

### UI

20. Settings modal показывает два корректно названных switch.
21. Начальные значения — главный on, дочерний off.
22. Disable выключает и блокирует дочерний; повторное enable не восстанавливает
   его прошлое значение.
23. Busy/checking предотвращает повторные клики.
24. HTTP/network failure сохраняет подтверждённые значения и показывает toast.
25. Дочерний switch доступен при enabled+unavailable.
26. Disabled даёт зелёную верхнюю плашку, серую Telegram-карточку, обе точные
   подписи и отсутствие recheck/action.
27. Checking даёт нейтральную loading-плашку, unavailable — warning,
   available — ready.
28. Backdrop/close поведение существующих модалок не меняется.
29. Пятисекундный poll не может показать warning только из-за disabled и не
   включает Telegram после более новой disable-команды.

Текущие UI fixtures и проверки модалок/health/settings находятся в
`tests/ui.test.tsx:23-140`; их нужно расширить четырьмя runtime-state и
зависимостью switch.

### Независимость doctor

30. Существующие doctor tests продолжают получать ready/degraded Telegram из
   прямой проверки executable независимо от HTTP settings
   (`tests/doctor.test.ts:20-44,87-128`).

## Implementation-ready границы

Новый общий слой сверх runtime-controller первого фронтира не нужен. Потребуются:

- runtime-controller в composition root;
- раздельные request/response JSON schemas для settings;
- расширение Telegram runtime union в health/Telegram endpoints;
- адаптация dispatcher/store seams по фронтирам 01–02;
- два switch и четыре presentation-state в существующем `App`;
- `disabled` в общем delivery formatter и schema migration 011;
- контрактные, store/dispatcher, SSE и UI tests из матрицы выше.

ADR не требуется: решения локальны текущему notification seam, совместимы с
существующим HTTP v1 и не вводят новый труднообратимый внешний механизм.
