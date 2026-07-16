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

`targetSelectors` содержит минимум один уникальный после `trim` стандартный CSS-селектор; `exclusionSelectors` может быть пустым. Каждый Целевой селектор обязан найти хотя бы один элемент. Совпадения объединяются без дублей и сортируются по DOM, поэтому порядок массивов не задаёт порядок результата. Каждый Селектор исключения удаляет совпавшие поддеревья внутри каждого элемента Целевой области из структуры и видимого текста.

Разрешены только публичные абсолютные HTTP(S) URL без встроенных учётных данных и стандартные CSS-селекторы light DOM главного документа. XPath, Playwright-specific selectors, iframe и shadow DOM не поддерживаются. Каждый запрос и redirect проходит проверку адреса; loopback, private, link-local, multicast и служебные диапазоны блокируются.

Сохранить OpenAPI-документ для инструмента или агента:

```powershell
Invoke-WebRequest -Uri 'http://127.0.0.1:43117/openapi.json' -OutFile 'openapi.json'
```

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
