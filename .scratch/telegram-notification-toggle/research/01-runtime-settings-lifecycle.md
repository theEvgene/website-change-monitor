# Runtime-владелец настроек Telegram

## Вывод

Обе пользовательские настройки следует держать в одном **серверном runtime-контроллере Уведомлений**, создаваемом один раз внутри `buildHttpServer`. Начальное состояние каждого процесса:

```ts
{
  telegramEnabled: true,
  notifyWhenUnchanged: false,
  telegramPhase: "checking" | "enabled" | "disabled"
}
```

Контроллер — единственная точка чтения и изменения настроек для HTTP, health, завершения Проверки и dispatcher. React не может быть владельцем: Проверки и dispatcher продолжают работать без открытой вкладки. SQLite не может быть владельцем: продуктово оба значения сбрасываются при каждом запуске. Сам dispatcher также слишком узок: `notifyWhenUnchanged` управляет и браузерным контрольным Уведомлением.

`buildHttpServer` уже является composition root: здесь одновременно создаются dispatcher и monitor service и связываются callbacks до `onReady` (`src/server/http/server.ts:84-110`). `startApplication` при каждом новом процессе заново открывает Базу данных и строит сервер (`src/server/operations/start.ts:47-78`), поэтому созданный здесь controller естественно получает требуемые defaults без миграции и чтения SQLite.

Durable-состояние конкретной Доставки остаётся ответственностью `MonitorStore`. Он уже атомарно создаёт событие и Telegram delivery в транзакции завершения Проверки (`src/server/persistence/monitor-store.ts:497-529,631-690,694-715`) и уже держит process-local `telegramBootId`/`telegramAvailable` (`src/server/persistence/monitor-store.ts:208-212`). Controller должен командовать store, но не подменять его транзакции.

## Поток состояния

1. **Startup.** Controller создаётся с `telegramEnabled=true`, `notifyWhenUnchanged=false`. `telegram.initialize()` проверяет sender до запуска первых доступных Проверок; текущий `onReady` уже соблюдает этот порядок (`src/server/http/server.ts:108-113`, `src/server/notifications/telegram-dispatcher.ts:87-90`). Старые `pending`/`sending` остаются abandoned при новом boot, как сейчас (`src/server/persistence/monitor-store.ts:1145-1149`).
2. **HTTP.** Существующий `GET/PUT /api/settings/notifications` должен читать и менять controller, а не `application_settings`; сейчас routes напрямую вызывают persisted store API (`src/server/http/server.ts:241-245`). Ответ включает оба effective-значения. При `telegramEnabled=false` controller всегда возвращает `notifyWhenUnchanged=false` и отклоняет/нормализует противоречивую комбинацию.
3. **Завершение Проверки.** Значение `notifyWhenUnchanged` снимается непосредственно перед commit и передаётся в транзакцию `completeNoChange`; это сохраняет существующую семантику «настройка на момент commit» (`src/server/application/monitor-service.ts:192-205`; текущий тест явно проверяет её в `tests/control-notifications.test.ts:10-38`). Baseline по-прежнему не создаёт контрольное событие. Change и final error всегда создают внутреннее событие; режим Telegram определяет только начальное состояние его Доставки.
4. **Dispatcher.** Claim разрешён только в phase `enabled` и при доступном sender. Проверка этого условия нужна **перед каждым** claim, а не только перед входом в цикл: сейчас `drainOnce` проверяет доступность один раз, после чего может claim несколько работ (`src/server/notifications/telegram-dispatcher.ts:69-85`). `sending` завершается существующим `finishTelegramDelivery`; исторические финальные состояния не переписываются.

## Атомарные переходы

### Выключение

Одна синхронная команда controller/store:

1. увеличивает generation переходов, чтобы запущенный ранее async recheck не смог снова включить канал;
2. в одной SQLite-транзакции переводит только delivery текущего boot со `state='pending'` в новое нейтральное состояние `disabled`;
3. после успешного commit публикует runtime `telegramPhase='disabled'`, `telegramEnabled=false`, `notifyWhenUnchanged=false`;
4. вызывает drain-gate, чтобы цикл не claim следующую запись.

`sending` не затрагивается и получает фактический результат. Новые события после commit сразу создаются с `disabled`. Это исключает двусмысленность: одна запись либо уже стала `sending`, либо атомарно осталась `pending` и была отключена. Основа уже есть: claim переводит `pending → sending` условным UPDATE внутри транзакции (`src/server/persistence/monitor-store.ts:1161-1171`), а недоступность массово меняет только `pending` текущего boot (`src/server/persistence/monitor-store.ts:1151-1159`).

### Повторное включение

1. Controller увеличивает generation, публикует `telegramEnabled=true`, `telegramPhase='checking'`; `notifyWhenUnchanged` остаётся `false`.
2. Новые события во время проверки получают `pending`, но claim-gate их не выдаёт.
3. Выполняется существующий `inspectAvailability`.
4. Результат применяется только если generation всё ещё актуален:
   - available: атомарно phase становится `enabled`, `pending` остаются `pending`, затем запускается drain;
   - unavailable: phase становится `enabled`, channel state — unavailable, а только новые `pending` текущего boot переходят в `unavailable`.
5. Ранее `disabled` записи не меняются и не досылаются.

Generation обязателен из-за async-проверки: второй запрос «выключить» может прийти до завершения recheck. UI busy-state полезен, но HTTP API доступен автоматизации и не может полагаться на блокировку кнопки.

## Совместимость и необходимые швы

- Удалять таблицу `application_settings` не требуется. Миграция 009 создала persisted `notify_when_unchanged` (`src/server/persistence/migrations/009-control-notifications.ts:1-9`); её можно оставить legacy-данными и прекратить читать/писать, чтобы не вводить обратную миграцию.
- `MonitorStore.notificationSettings/updateNotificationSettings` и чтение SQL внутри `completeNoChange` (`src/server/persistence/monitor-store.ts:646-647,1138-1143`) заменяются runtime API/commit-параметром.
- HTTP schema сейчас содержит только обязательный `notifyWhenUnchanged` (`src/server/http/contract.ts:505-508,759-766`). Для сохранения API v1 разумно расширить response обоими полями, а update-request сделать отдельной схемой, способной принять старый payload без `telegramEnabled` как «не менять главный переключатель».
- Новый `disabled` — terminal state для SSE: существующий поток отслеживает только `pending`/`sending` и уже публикует переход в любое другое состояние (`src/server/http/server.ts:474-520`). Потребуются расширение enum (`src/server/http/contract.ts:268-273`) и нейтральный UI mapping, но новый механизм SSE не нужен.
- `doctor` не подключается к controller и продолжает независимо проверять sender; это уже отдельный процесс, читающий executable из Базы данных (`src/server/operations/doctor.ts:64-107`).

## Минимальные регрессионные проверки

- новый server и повторное открытие той же Базы данных всегда дают `{ telegramEnabled: true, notifyWhenUnchanged: false }`;
- настройка читается на момент commit no-change, Baseline не создаёт контрольное событие;
- disable атомарно меняет `pending`, не меняет `sending`/завершённые и делает новые delivery `disabled`;
- drain не claim следующую работу после disable;
- enable удерживает новые работы до recheck, затем отправляет только новые `pending`;
- disable во время recheck выигрывает за счёт generation;
- старые `disabled` не отправляются после enable;
- недоступный sender после enable переводит ожидавшие recheck работы в `unavailable`;
- старый HTTP update только с `notifyWhenUnchanged` остаётся валиден.
