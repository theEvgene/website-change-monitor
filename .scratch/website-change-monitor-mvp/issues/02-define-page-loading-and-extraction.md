# Определить модель загрузки и извлечения страницы

Type: research
Status: resolved
Blocked by: 01

## Question

Как выбранный стек должен загружать общедоступные статические и JavaScript-страницы, ждать готовности, однократно прокручивать до Целевой области, применять множественные совпадения и Исключения, ограничивать время и выдавать однозначные Результаты проверки?

## Answer

### Решение

`browser-playwright` реализует один ограниченный по времени конвейер исследования страницы. Он работает только с главным документом основной страницы в новом непостоянном `BrowserContext`, возвращает либо полностью сформированный результат исследования, либо типизированную ошибку и никогда не возвращает частичный Снимок.

Последовательность одной Проверки:

1. **Проверить входные данные до запуска браузерной работы.** URL обязан быть абсолютным `http:` или `https:` URL без встроенных имени пользователя и пароля. Целевой селектор и каждый селектор Исключения обязаны разбираться нативным `document.querySelectorAll`; синтаксически неверный селектор — ошибка конфигурации, а не «ничего не найдено».
2. **Создать изолированный контекст и основную страницу.** Долгоживущим остаётся только процесс Chromium. Cookies, cache, `localStorage`, `sessionStorage`, разрешения и service workers не переносятся между Проверками. Для воспроизводимости фиксируются desktop viewport `1440×900`, `deviceScaleFactor: 1`, locale `ru-RU`, часовой пояс `Europe/Moscow` и светлая цветовая схема; используется обычный User-Agent поставляемого Chromium. Обработчики аварии, диалогов, download, popup и навигации регистрируются до перехода по URL.
3. **Перейти по URL** через `page.goto(url, { waitUntil: 'domcontentloaded' })`. `DOMContentLoaded` означает, что документ разобран и перешёл в состояние `interactive`, но не обещает, что SPA/AJAX закончил наполнять страницу. Поэтому он является лишь нижней границей готовности; после него всегда выполняется предметное ожидание Целевой области. `networkidle` не используется: Playwright прямо помечает его как discouraged, а 500 мс без сетевых соединений не являются достоверным признаком готовности приложения ([`page.goto`](https://playwright.dev/docs/api/class-page#page-goto), [`waitForLoadState`](https://playwright.dev/docs/api/class-page#page-wait-for-load-state), [готовность документа в HTML Standard](https://html.spec.whatwg.org/multipage/dom.html#current-document-readiness)).
4. **Проверить ответ главного ресурса.** Redirect разрешён; исследуется фактически открытый главный документ и записывается итоговый `page.url()`. `page.goto` не бросает исключение на `404` или `500`, поэтому отв…245 tokens truncated…playwright.dev/docs/api/class-locator#locator-wait-for)). Если совпадений нет — `target_not_found`; если совпадения есть, но ни одно не отрисовано, — `target_not_visible`.
6. **Выполнить ровно одну попытку прокрутки.** Якорь — первое отрисованное совпадение в порядке документа. Оно однократно прокручивается к центру viewport с мгновенным поведением. Для множественного селектора нельзя вызывать single-element locator без явного якоря: такие операции strict и при нескольких совпадениях бросают исключение ([strictness](https://playwright.dev/docs/locators#strictness), [`scrollIntoViewIfNeeded`](https://playwright.dev/docs/api/class-locator#locator-scroll-into-view-if-needed)). Прокрутка к последнему элементу, обход всех совпадений, пагинация и бесконечная прокрутка в MVP не выполняются.
7. **Дождаться краткой стабильности после прокрутки.** Проверка стабильности начинается не раньше чем через одну секунду после прокрутки. Включённая проекция Целевой области должна не меняться непрерывно `750` мс. Ожидание ограничено пятью секундами. Изменения целевых узлов, их включённых потомков, состава совпадений или границ Исключений сбрасывают тихое окно; мутации целиком внутри уже определённого исключённого поддерева его не сбрасывают. Наблюдение реализуется через `MutationObserver`, а не безусловный `waitForTimeout` ([MutationObserver](https://dom.spec.whatwg.org/#mutation-observers), [почему `waitForTimeout` discouraged](https://playwright.dev/docs/api/class-page#page-wait-for-timeout)). Если тихого окна не возникло, Проверка завершается `content_unstable`, а не сохраняет случайное промежуточное состояние.
8. **Атомарно извлечь результат.** Один синхронный, не содержащий `await`, вызов `page.evaluate` заново получает все цели, применяет Исключения отдельно внутри каждой цели, строит сериализуемое представление структуры и видимого текста и возвращает его в Node.js. Только после успешного возврата прикладной слой может строить Снимок и сохранять Результат проверки. Контекст закрывается в `finally` при любом исходе.

### Бюджеты времени и отмена

У Проверки есть один абсолютный deadline **60 секунд**, отсчитываемый от создания `BrowserContext`. Внутри него действуют максимальные бюджеты:

- переход и `DOMContentLoaded` — `30` секунд;
- появление и отрисовка Целевой области — `15` секунд;
- однократная прокрутка — `5` секунд;
- стабильность — `5` секунд, включая тихое окно `750` мс;
- финальное извлечение — `5` секунд.

Каждый вызов получает `min(бюджет этапа, оставшееся время общего deadline)`. `browserContext.setDefaultNavigationTimeout` задаёт потолок навигации, `browserContext.setDefaultTimeout` — остальных Playwright-операций; явный timeout этапа имеет приоритет ([navigation timeout](https://playwright.dev/docs/api/class-browsercontext#browser-context-set-default-navigation-timeout), [default timeout](https://playwright.dev/docs/api/class-browsercontext#browser-context-set-default-timeout)). Нулевой timeout не используется, поскольку в Library API он отключает ограничение.

Простой `Promise.race` не считается отменой: проигравшая Playwright-операция продолжила бы выполняться. По общему deadline адаптер закрывает только контекст этой Проверки через `context.close({ reason: 'check_deadline_exceeded' })`; закрытие прерывает его операции и закрывает все принадлежащие ему страницы ([`BrowserContext.close`](https://playwright.dev/docs/api/class-browsercontext#browser-context-close)). Таймер очищается, а повторное закрытие безопасно обрабатывается в `finally`. Остановка приложения использует тот же путь с причиной `application_shutdown`.

### Точная семантика CSS и области документа

В MVP «CSS-селектор» означает **стандартный CSS selector для light DOM главного документа**:

- поиск выполняется нативным `document.querySelectorAll`, а не автоопределением селектора Playwright;
- XPath, текстовые селекторы Playwright, `:visible`, `:has-text()` и прочие расширения не принимаются;
- `iframe`, open/closed Shadow DOM и popup не входят в область поиска;
- `querySelectorAll` возвращает статический набор совпадений; порядок целей — tree order, то есть preorder depth-first ([`querySelectorAll`](https://dom.spec.whatwg.org/#dom-parentnode-queryselectorall), [tree order](https://dom.spec.whatwg.org/#concept-tree-order)).

Это ограничение важно зафиксировать явно: `page.locator()` способен автоопределить строку `//...` как XPath, а CSS-locators Playwright по умолчанию проходят через открытые shadow roots ([CSS/XPath locators](https://playwright.dev/docs/locators#locate-by-css-or-xpath), [Shadow DOM](https://playwright.dev/docs/locators#locate-in-shadow-dom)). Такое поведение было бы шире пользовательского контракта обычного CSS и сделало бы порядок и область Исключений неоднозначными.

### Множественные цели, Исключения и исчезновение узлов

Финальный набор целей всегда определяется заново непосредственно на границе извлечения. Если селектор совпал с несколькими элементами, в результат входят **все** совпадения в порядке документа. Вложенные цели остаются отдельными элементами набора: содержимое вложенной цели может поэтому присутствовать и в представлении родительской цели, и в собственном представлении. Эта намеренная семантика следует определению Целевой области в `CONTEXT.md`.

Каждый селектор Исключения применяется **независимо относительно каждого target root**:

- рассматриваются только потомки цели; само корневое совпадение Целевой области исключением не удаляется;
- объединение всех совпавших Исключений образует набор удаляемых поддеревьев;
- если одно совпадение Исключения вложено в другое, сохраняется только внешняя граница: всё поддерево уже удаляется целиком;
- Исключение удаляет и структуру, и текст соответствующего поддерева;
- Исключение в одной цели не удаляет тот же узел из отдельного результата другой, перекрывающейся цели, если он не совпал с Исключением относительно второй цели.

Нельзя получать массив через `locator.all()` и затем обходить ElementHandle/Locator по одному: `locator.all()` не ждёт и для динамического списка даёт непредсказуемые результаты, а handles по своей природе подвержены гонкам detach ([`locator.all`](https://playwright.dev/docs/api/class-locator#locator-all), [`evaluateAll`](https://playwright.dev/docs/api/class-locator#locator-evaluate-all), [предупреждение об ElementHandle](https://playwright.dev/docs/api/class-locator#locator-element-handle)). Wait, scroll и extraction поэтому каждый раз разрешают селектор заново; истинным считается набор в атомарном финальном вызове.

Если якорь исчез до прокрутки, этап повторно разрешает селектор в пределах своего бюджета и выбирает новое первое отрисованное совпадение. Если на финальной границе совпадений уже ноль, результат — `target_disappeared`, а не пустой успешный Снимок. Если главный frame начал новую навигацию до извлечения, готовность, прокрутка и стабильность начинаются заново для нового документа в пределах того же общего deadline. Навигация во время синхронного извлечения уничтожает execution context: частичный результат отбрасывается, после чего допускается повтор конвейера только пока остаётся общий бюджет.

### Граница атомарного извлечения и видимый текст

Внутри одного синхронного page callback выполняются: повторный `querySelectorAll`, построение границ Исключений, обход каждой цели и создание plain JSON без DOM handles. Между целями нет возврата в Node event loop, поэтому страница не может вставить отдельную browser task между их чтением. Результат содержит эффективный URL, HTTP-статус главного документа, число целей, упорядоченные сырые деревья без Исключений, видимый текст и диагностические timings; нормализация Снимка и алгоритм Сравнения остаются билету «Определить формат Снимка и алгоритм Сравнения».

Для видимого текста нормативной основой служит `HTMLElement.innerText`: это текст «as rendered» с учётом CSS visibility, line breaks, `white-space` и `text-transform` ([HTML Standard: `innerText`](https://html.spec.whatwg.org/multipage/dom.html#the-innertext-and-outertext-properties)). Есть две обязательные предосторожности:

1. `innerText` нельзя читать у detached clone как эквивалент видимого текста. Для неотрисованного элемента стандарт возвращает descendant text content, из-за чего в результат может попасть скрытый текст.
2. Исключения нельзя сначала безвозвратно удалить из живой страницы. Для каждой цели callback сохраняет исходные inline `display`-значения внешних границ Исключений, временно задаёт им `display:none !important`, читает `innerText` только у отрисованной исходной цели, строит дерево с явным пропуском исключённых узлов и восстанавливает стили в `finally`. Для неотрисованной цели видимый текст задаётся пустой строкой. Весь цикл остаётся синхронным; после возврата контекст всё равно закрывается.

Такой подход сохраняет браузерную семантику rendered text и не вызывает синхронных custom-element callbacks, которые возникли бы при удалении узла из DOM. Изменения inline style могут быть замечены page-side `MutationObserver` после callback, но они происходят уже после получения результата и перед немедленным закрытием одноразового контекста.

### Изоляция, побочные события и безопасность

Каждая Проверка получает новый `browser.newContext`, а после неё контекст гарантированно закрывается. Непостоянные контексты не записывают browsing data на диск и изолируют cookies/storage друг от друга ([BrowserContext](https://playwright.dev/docs/api/class-browsercontext)). Контекст создаётся с `acceptDownloads: false`, `serviceWorkers: 'block'`, без выданных permissions, без client certificates и HTTP credentials, с `ignoreHTTPSErrors: false`. Chromium запускается с sandbox; `--no-sandbox` и произвольные browser flags не используются.

Перед навигацией URL-политика разрешает только общедоступные HTTP(S)-адреса и запрещает `localhost`, loopback, private, link-local, multicast и unspecified IP ranges, включая их IPv4/IPv6-представления. Та же политика применяется к каждому redirect и каждому запросу страницы; это не позволяет недоверенной странице использовать локальное приложение для исследования служб машины или LAN. Hostname разрешается и проверяется перед запросом, а redirect проверяется заново; несоответствие даёт `address_blocked`. Защита от DNS rebinding должна быть реализована в сетевом адаптере так, чтобы проверенный адрес соответствовал фактическому соединению; одна проверка строки hostname для этого недостаточна.

Побочные browser events трактуются так:

- `alert`, `confirm`, `prompt` и `beforeunload` немедленно dismiss и записываются в диагностику. Если зарегистрировать listener и не вызвать `accept`/`dismiss`, страница замрёт; без listener Playwright dismisses их автоматически ([dialog event](https://playwright.dev/docs/api/class-browsercontext#browser-context-event-dialog), [модальные prompts в HTML Standard](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#simple-dialogs)).
- Любой attachment download — `unsupported_content`; файл не сохраняется. Временные downloads в любом случае удаляются при закрытии контекста ([Downloads](https://playwright.dev/docs/downloads)).
- Popup не становится новой основной страницей и сразу закрывается; область наблюдения остаётся в исходной primary page.
- Ошибка отдельного subresource, console error или `pageerror` записывается в диагностику, но сама по себе не перечёркивает успешно готовую и извлечённую Целевую область. Ошибка ответа главного документа, напротив, фатальна. Playwright различает сетевой failure и HTTP error response ([`requestfailed`](https://playwright.dev/docs/api/class-browsercontext#browser-context-event-request-failed)).
- `page.on('crash')`, неожиданное закрытие контекста или `browser.on('disconnected')` дают `browser_failed`; текущая Проверка не восстанавливает частичный результат. Долгоживущий browser adapter может один раз поднять новый Chromium для следующих Проверок, но повтор самой Проверки принадлежит оркестратору ([page crash](https://playwright.dev/docs/api/class-page#page-event-crash), [browser disconnected](https://playwright.dev/docs/api/class-browser#browser-event-disconnected)).

### Однозначные исходы исследования

`PageProbe` возвращает discriminated union. Успех содержит полный payload исследования; ошибка содержит стабильный машинный `code`, безопасное русское сообщение, этап, эффективный URL (если известен), HTTP-статус (если известен) и timings. Минимальный набор кодов:

- `invalid_url`, `invalid_selector`, `address_blocked`;
- `navigation_timeout`, `navigation_failed`, `http_error`, `unsupported_content`;
- `target_not_found`, `target_not_visible`, `target_disappeared`;
- `scroll_failed`, `content_unstable`, `extraction_failed`;
- `check_deadline_exceeded`, `browser_failed`, `application_shutdown`.

На уровне домена все эти коды остаются разновидностями единственного Результата проверки «ошибка». При любой ошибке последний успешный Снимок не меняется. Только полный успешный payload передаётся дальше для создания Базового снимка либо Сравнения; решение, считать ли его «без изменений» или «обнаружено Изменение», не входит в ответственность `browser-playwright`.
