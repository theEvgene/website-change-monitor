# Локальный HTTP API

Приложение публикует один API для React-интерфейса и прямой автоматизации. После `npm start` базовый адрес — `http://127.0.0.1:43117`. Актуальный машинно-читаемый контракт OpenAPI 3.1 доступен по `GET /openapi.json`.

## Быстрая проверка

Получить состояние приложения из PowerShell:

<!-- verify:powershell-health -->
```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:43117/api/health' | ConvertTo-Json -Compress -Depth 8
```

Получить версии приложения и API через настоящий `curl.exe`:

<!-- verify:curl-version -->
```powershell
curl.exe --fail --silent --show-error http://127.0.0.1:43117/api/version
```

Предпросмотреть Область наблюдения из нескольких Целевых селекторов и Селекторов исключения через тот же API:

<!-- verify:powershell-preview -->
```powershell
$body = @{
  url = 'https://example.com/catalog'
  targetSelectors = @('.page-title', '.product-card')
  exclusionSelectors = @('.price')
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:43117/api/preview' -ContentType 'application/json' -Body $body | ConvertTo-Json -Compress -Depth 8
```

Успешный preview возвращает фактически открытый URL после разрешённых redirect, число совпадений каждого Целевого селектора, размер уникального объединения и Целевую область в порядке DOM:

```json
{
  "finalUrl": "https://example.com/catalog",
  "targetMatches": [
    { "selector": ".page-title", "matchCount": 1 },
    { "selector": ".product-card", "matchCount": 2 }
  ],
  "exclusionSelectors": [".price"],
  "targetCount": 3,
  "targets": [
    {
      "elements": [
        {
          "namespace": "http://www.w3.org/1999/xhtml",
          "name": "div",
          "childElementCount": 0
        }
      ],
      "visibleText": "Каталог"
    },
    {
      "elements": [
        {
          "namespace": "http://www.w3.org/1999/xhtml",
          "name": "div",
          "childElementCount": 0
        }
      ],
      "visibleText": "Товар A"
    },
    {
      "elements": [
        {
          "namespace": "http://www.w3.org/1999/xhtml",
          "name": "div",
          "childElementCount": 0
        }
      ],
      "visibleText": "Товар B"
    }
  ]
}
```

После успешного preview создать Монитор и сразу выполнить его первую Проверку:

<!-- verify:powershell-create-monitor -->
```powershell
$body = @{
  name = 'Catalog'
  url = 'https://example.com/catalog'
  targetSelectors = @('.page-title', '.product-card')
  exclusionSelectors = @('.price')
  intervalHours = 12
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:43117/api/monitors' -ContentType 'application/json' -Body $body | ConvertTo-Json -Compress -Depth 12
```

`POST /api/monitors` повторно проверяет URL и селекторы, сохраняет Монитор и немедленную Проверку. Первый успешный результат имеет `result: "baseline"`, содержит метаданные Базового снимка и не считается Изменением. Допустимые значения `intervalHours`: `6`, `12`, `24`, `48`, `72`.

Прочитать сохранённые данные можно через:

- `GET /api/monitors` — компактная таблица Мониторов;
- `GET /api/monitors?label=важное` — таблица Мониторов с выбранной Меткой;
- `GET /api/monitors/{monitorId}` — Монитор, его селекторы и История;
- `PUT /api/monitors/{monitorId}` — изменить имя, URL, Интервал проверки, Метки и упорядоченные массивы селекторов;
- `DELETE /api/monitors/{monitorId}` — удалить Монитор и его данные после передачи точного имени в `confirmName`;
- `GET /api/monitors/{monitorId}/checks` — только Проверки выбранного Монитора.
- `GET /api/checks` — общий Журнал всех Проверок, от новых к старым;
- `GET /api/checks/{checkId}/comparison` — двухколоночное Сравнение снимков известной Проверки.
- `GET /api/check-intents` — активная очередь с видом, состоянием и сроком каждой ожидающей или выполняющейся Проверки.
- `POST /api/monitors/{monitorId}/pause` — приостановить автоматические Проверки, сохранив Историю и Ручную проверку;
- `POST /api/monitors/{monitorId}/resume` — возобновить Монитор, начиная с ожидающей Повторной либо одной Просроченной проверки.

Имя, Интервал проверки, Метки и перестановка тех же селекторов обновляются без потери Истории. Изменение URL, состава или значения Целевых селекторов либо Селекторов исключения сначала возвращает `409` с кодом `scope_reset_required`. Повторный `PUT` с `resetHistory: true` атомарно повышает ревизию Области наблюдения, удаляет прежние Проверки и Снимки и запускает новый Базовый снимок. Работа старой ревизии не может записать результат после такого сброса.

Пример изменения только организационных полей:

```powershell
$body = @{ name = 'Каталог'; url = 'https://example.com/catalog'; targetSelectors = @('.card', '.hero'); exclusionSelectors = @('.price'); intervalHours = 24; labels = @('важное', 'магазин') } | ConvertTo-Json
Invoke-RestMethod -Method Put -Uri 'http://127.0.0.1:43117/api/monitors/1' -ContentType 'application/json' -Body $body
```

Удаление требует точного имени и сохраняет общие Метки других Мониторов:

```powershell
$body = @{ confirmName = 'Каталог' } | ConvertTo-Json
Invoke-RestMethod -Method Delete -Uri 'http://127.0.0.1:43117/api/monitors/1' -ContentType 'application/json' -Body $body
```

Запустить Ручную проверку первого сохранённого Монитора и получить её долговечный результат:

<!-- verify:powershell-manual-check -->
```powershell
$monitor = (Invoke-RestMethod -Uri 'http://127.0.0.1:43117/api/monitors')[0]
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:43117/api/monitors/$($monitor.id)/checks" -ContentType 'application/json' -Body '{}' | ConvertTo-Json -Compress -Depth 12
```

Повторные запросы, пока Проверка уже ожидает или выполняется, объединяются в одну работу. Успешный ответ содержит обновлённую Историю Монитора: `no_change` не создаёт дубликат Снимка, а `change` атомарно сохраняет новый Снимок и ссылки `beforeSnapshotId`/`afterSnapshotId`. SHA-256 служит индексом; окончательное равенство определяется сравнением канонических байтов.

Наблюдать активную очередь и ближайшие сроки без изменения внутренних записей:

<!-- verify:powershell-check-intents -->
```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:43117/api/check-intents' | ConvertTo-Json -Compress -Depth 8
```

Обычный следующий срок вычисляется от завершения Проверки. После перезапуска все пропущенные интервалы сворачиваются в одну Просроченную проверку на Монитор; очередь не воспроизводит каждый пропущенный запуск.

Приостановить и затем возобновить первый Монитор:

<!-- verify:powershell-pause-monitor -->
```powershell
$monitor = (Invoke-RestMethod -Uri 'http://127.0.0.1:43117/api/monitors')[0]
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:43117/api/monitors/$($monitor.id)/pause" -ContentType 'application/json' -Body '{}' | ConvertTo-Json -Compress -Depth 12
```

<!-- verify:powershell-resume-monitor -->
```powershell
$monitor = (Invoke-RestMethod -Uri 'http://127.0.0.1:43117/api/monitors')[0]
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:43117/api/monitors/$($monitor.id)/resume" -ContentType 'application/json' -Body '{}' | ConvertTo-Json -Compress -Depth 12
```

Первая ошибка Проверки создаёт ровно одну Повторную проверку через минуту. Только ошибка Повторной проверки помечается как `isFinalError: true`; успешный retry или Окончательная ошибка возвращают Монитор к обычному Интервалу проверки. При перезапуске прерванная Проверка фиксируется с `errorCode: "application_shutdown"` и проходит то же правило единственного повтора.

Прочитать общий Журнал, включая идентификаторы Проверок и ссылки на снимки:

<!-- verify:powershell-journal -->
```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:43117/api/checks' | ConvertTo-Json -Compress -Depth 8
```

Сравнение открывается из известного контекста Журнала или Истории Монитора — пользователю не нужно вводить идентификаторы вручную. Для прямой автоматизации агент может взять `id` Проверки из Журнала и запросить соответствующую пару снимков:

<!-- verify:powershell-comparison -->
```powershell
$checks = Invoke-RestMethod -Uri 'http://127.0.0.1:43117/api/checks'
$check = $checks[0]
Invoke-RestMethod -Uri "http://127.0.0.1:43117/api/checks/$($check.id)/comparison" | ConvertTo-Json -Compress -Depth 12
```

Ответ содержит Целевые области и отдельные построчные секции `structure` и `text`. Удаления находятся слева, добавления — справа, перемещение представляется как удаление и добавление. При превышении встроенного бюджета ответ устанавливает `complete: false` и сообщает точное число пропущенных строк вместо ложного результата «изменений нет».

В ответах API Снимок содержит `id`, `formatVersion` и `sha256`; канонический JSON остаётся внутренним долговечным представлением и через HTTP не публикуется.

`targetSelectors` содержит минимум один уникальный после `trim` стандартный CSS-селектор; `exclusionSelectors` может быть пустым. Каждый Целевой селектор обязан найти хотя бы один элемент. Совпадения объединяются без дублей и сортируются по DOM, поэтому порядок массивов не задаёт порядок результата. Каждый Селектор исключения удаляет совпавшие поддеревья внутри каждого элемента Целевой области из структуры и видимого текста.

Если итоговая Целевая область превышает встроенный бюджет элементов или текста, preview целиком отклоняется с `target_area_too_large` (HTTP 422) без частичного результата. В этом случае сузьте Целевые селекторы или добавьте Селекторы исключения.

Разрешены только публичные абсолютные HTTP(S) URL без встроенных учётных данных и стандартные CSS-селекторы light DOM главного документа. XPath, Playwright-specific selectors, iframe и shadow DOM не поддерживаются. Каждый запрос и redirect проходит проверку адреса; loopback, private, link-local, multicast и служебные диапазоны блокируются.

Сохранить OpenAPI-документ для инструмента или агента:

```powershell
Invoke-WebRequest -Uri 'http://127.0.0.1:43117/openapi.json' -OutFile 'openapi.json'
```

## Долговечные Уведомления и браузерная доставка

Изменение и Окончательная ошибка создают неизменяемое Уведомление в той же SQLite-транзакции, что завершает Проверку. Первая ошибка с назначенной Повторной проверкой события не создаёт. Переименование Монитора позднее не меняет сохранённые русские `title`, `body` и имя Монитора.

- `GET /api/notifications` возвращает текущий `highWaterMark` и все события;
- `GET /api/notifications?after=17` возвращает только события с `id > 17`;
- `GET /api/notifications/stream?after=17` с заголовком `Accept: text/event-stream` открывает SSE replay новых событий. При reconnect корректный `Last-Event-ID` имеет приоритет над query cursor. Catch-up приходит как `event: replay`, новые live-события — как `event: notification`, а неизвестный cursor выше текущего high-water получает `event: reset`. Каждое событие содержит JSON из REST-модели.

Клиент сначала читает REST high-water mark и только затем подключает SSE. Доставка at least once означает, что клиент обязан удалять дубли по `id`/`dedupeKey`. REST-история, replay и reset обновляют центр без browser popup; только новое live-событие даёт toast в активной вкладке либо системное уведомление в фоновой вкладке, если пользователь сам разрешил Notification API.

```powershell
$feed = Invoke-RestMethod -Uri 'http://127.0.0.1:43117/api/notifications'
$feed.items | Format-Table id, kind, monitorName, observedAt, targetPath
```

Для проверки SSE настоящим `curl.exe`:

```powershell
curl.exe --no-buffer --header "Accept: text/event-stream" "http://127.0.0.1:43117/api/notifications/stream?after=0"
```

### Telegram best effort

Установленный `telegram-alert-bus` 0.1.5 настраивается отдельно и подключается только абсолютным путём к executable:

```powershell
npm run configure -- --telegram-executable 'C:\absolute\path\.venv\Scripts\telegram-alert.exe'
```

Приложение напрямую, без shell, запускает `telegram-alert.exe send`, передаёт строгий UTF-8 JSON через stdin с `PYTHONUTF8=1` и завершает зависший процесс через 70 секунд. Собственных повторов и очереди поверх sender нет. Ограниченная диагностика stdout/stderr сохраняется с удалением Telegram-токенов; секрет остаётся в Windows Credential Manager модуля.

- `GET /api/telegram` — текущая доступность канала;
- `POST /api/telegram/recheck` — явная повторная проверка из плашки «Telegram недоступен»;
- поле `telegram` каждого элемента `GET /api/notifications` хранит окончательное состояние доставки.

SSE-событие `delivery` обновляет уже показанное Уведомление с тем же `id`, когда отправка переходит из `pending`/`sending` в окончательное состояние.

### Уведомления при отсутствии изменений

- `GET /api/settings/notifications` возвращает глобальную настройку `notifyWhenUnchanged`;
- `PUT /api/settings/notifications` с JSON `{"notifyWhenUnchanged": true|false}` сохраняет её в SQLite.

Значение читается в транзакции завершения Проверки. При включённой настройке успешная повторная Проверка без Изменений создаёт событие `control_check_ok`; первый Базовый снимок его не создаёт. Такое событие доставляется только как новое live-событие текущей вкладке браузера и в Telegram, но не входит в `GET /api/notifications`, SSE replay/reset и таблицу центра Уведомлений. Его Состояние доставки Telegram доступно в Журнале и Истории Монитора. Переключение настройки не создаёт события задним числом.

`pending`/`sending` отображаются как «Отправляется», `delivered` — «Отправлено», остальные состояния — «Не отправлено» с безопасной причиной. Старые неуспехи и доставки прошлого запуска не отправляются после восстановления; восстановленный канал используется только новыми Уведомлениями. Недоступный Telegram оставляет приложение и Проверки рабочими, а `doctor` возвращает degraded exit code 2.

## Формат ответов

Успешная операция возвращает описанный в OpenAPI типизированный JSON-объект. Например, `GET /api/version`:

```json
{
  "application": "website-change-monitor",
  "apiVersion": "v1",
  "version": "0.1.0"
}
```

Все ошибки используют один безопасный конверт:

```json
{
  "error": {
    "code": "not_found",
    "message": "Запрошенная операция не найдена."
  }
}
```

`code` предназначен для программной обработки, `message` — для пользователя. Ответ никогда не содержит stack trace, секреты или внутренние подробности исключения. Базовые коды: `invalid_request`/`invalid_origin` (400/403), `not_found` (404), `invalid_host` (421) и `internal_error` (500). Preview дополнительно возвращает стабильные коды валидации, сетевой политики, навигации, поиска цели и Chromium, перечисленные в схеме `ApiErrorV1` OpenAPI-документа.

## Ограничение локального доступа

Сервер слушает только `127.0.0.1`. Прямой loopback-клиент PowerShell/curl может не передавать `Origin`, но обязан отправить корректный `Host` для `127.0.0.1:43117` или `localhost:43117`; обычные клиенты формируют его автоматически. Браузерный запрос с `Origin` принимается только от `http://127.0.0.1:43117` или `http://localhost:43117`. Открытый CORS не используется.

## Правило изменения контракта

Каждая новая или изменённая HTTP-операция должна в том же тикете обновить Fastify JSON-схему, сгенерированный OpenAPI-контракт, это руководство и исполняемый пример либо контрактный тест. Пользовательская возможность не считается завершённой, если React UI обращается к скрытой или недокументированной операции.
