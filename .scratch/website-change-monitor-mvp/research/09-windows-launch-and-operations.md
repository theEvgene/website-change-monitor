# Исследование: запуск и эксплуатация на Windows

Дата проверки источников: 2026-07-15.

## Краткое решение

Для MVP выбрать **исходную установку под обычной учётной записью Windows 11 x64** и один foreground-процесс, запускаемый `npm start` либо ярлыком на поставляемый `start.cmd`. Docker, служба Windows, Task Scheduler, автозапуск, Electron/Tauri и иной desktop packaging не добавляются. Окно консоли остаётся явным признаком работающего локального сервера; штатная остановка — `Ctrl+C`.

Поддерживаемая матрица узкая и проверяемая:

| Компонент | Контракт MVP |
| --- | --- |
| ОС | Windows 11 x64; Windows 10 не обещать |
| Node.js | последний исправленный выпуск линии **24 LTS x64**, но `major = 24` фиксируется и проверяется |
| npm | версия, поставляемая с поддерживаемым Node 24; дерево зависимостей определяет committed `package-lock.json` |
| Playwright | версия из lockfile и только её Chromium |
| SQLite binding | зафиксированный `better-sqlite3`, для которого чистый `npm ci` получает Windows x64 prebuild без Visual Studio Build Tools |
| Telegram | существующий Python 3.11+ `telegram-alert-bus`, вызываемый по абсолютному пути к `.venv\Scripts\telegram-alert.exe` |

Node рекомендует production-приложениям Active или Maintenance LTS; линия 24 сейчас LTS ([Node.js Releases](https://nodejs.org/en/about/previous-releases)). Текущая документация Playwright допускает Node 22/24/26, но на Windows требует Windows 11+ или Server 2019+ ([Playwright system requirements](https://playwright.dev/docs/intro#system-requirements)). Поэтому Node 24 и Windows 11 совпадают с ранее выбранным стеком, а расширять обещание на Windows 10 нельзя без отдельного smoke test.

Возможность оставить установленный на целевой машине Node.js 20.11.1 без обновления проверена отдельно и отклонена. Node 20 стал EOL 24 марта 2026 года и больше не получает исправления безопасности ([Node.js EOL](https://nodejs.org/en/about/eol)); кроме того, актуальный Playwright уже не включает 20 в поддерживаемую матрицу, а актуальный Vite требует минимум Node 20.19 или 22.12 ([Vite Getting Started](https://vite.dev/guide/)). Следовательно, `20.11.1` несовместим с актуальным инструментарием даже без учёта EOL. Технически можно было бы зафиксировать старые Playwright/Vite, но это лишило бы новый MVP поддерживаемого runtime и будущих исправлений ради экономии одного обновления. Поддерживаемым решением остаётся Node 24.

`package.json` должен объявить `engines.node: ">=24 <25"`, а entry point и `doctor` обязаны завершаться ошибкой на другом major: одно предупреждение npm недостаточно. Конкретные версии всех JS-зависимостей фиксирует и коммитит `package-lock.json`. Для установки используется только `npm ci`: команда требует lockfile, отказывается обновлять его при расхождении с `package.json`, удаляет прежний `node_modules` и устанавливает всё дерево заново ([npm ci](https://docs.npmjs.com/cli/commands/npm-ci/)). Если lockfile был создан с влияющим на дерево флагом npm, соответствующая настройка должна быть закоммичена в project `.npmrc`; пользователь не должен помнить дополнительные флаги.

Не применять `--ignore-scripts`: native addon должен либо установиться из зафиксированного prebuild, либо установка должна явно упасть. Перед выпуском каждой версии нужен чистый smoke test на Windows 11 x64 без Visual Studio Build Tools: `npm ci`, загрузка `better-sqlite3`, `SELECT sqlite_version()`, production build и запуск. Актуальные релизы `better-sqlite3` публикуют Windows binaries и используют SQLite новее требуемой 3.51.3, но наличие подходящего asset всё равно является свойством **конкретной зафиксированной пары** Node/addon, а не вечной гарантией ([официальные releases](https://github.com/WiseLibs/better-sqlite3/releases)).

## Каталоги и конфигурация

Код может лежать в любом пользовательском каталоге, включая путь с пробелами и кириллицей. Состояние нельзя хранить рядом с репозиторием, `dist` или `node_modules`. Единственный корень состояния:

```text
%LOCALAPPDATA%\WebsiteChangeMonitor\
├── data\monitor.sqlite3
├── backups\manual\monitor-<UTC timestamp>.sqlite3
├── backups\pre-update\monitor-<version>-<UTC timestamp>.sqlite3
├── backups\pre-migration\monitor-<schema>-<UTC timestamp>.sqlite3
├── logs\app-<UTC timestamp>-<boot id>.ndjson
└── browsers\                         # Chromium Playwright
```

`%LOCALAPPDATA%` — штатный per-user non-roaming known folder Windows (`%USERPROFILE%\AppData\Local`) ([Microsoft `FOLDERID_LocalAppData`](https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid#folderid_localappdata)). Каталог создаётся без прав администратора. Отдельного config-файла нет: абсолютный путь Telegram executable хранится как несекретная настройка в единой SQLite-БД, а фиксированный loopback port `43117` является константой MVP. Bot token остаётся в Windows Credential Manager через `telegram-alert-bus`; в БД и логи приложения он не копируется.

Playwright по умолчанию кладёт браузеры в `%USERPROFILE%\AppData\Local\ms-playwright`, но позволяет изменить каталог переменной `PLAYWRIGHT_BROWSERS_PATH`; одно и то же значение требуется при установке и при запуске ([Playwright: managing browser binaries](https://playwright.dev/docs/browsers#managing-browser-binaries)). Для воспроизводимости оба project script — `install:browsers` и `start` — должны сами задавать `%LOCALAPPDATA%\WebsiteChangeMonitor\browsers`, а не требовать постоянной пользовательской переменной. `install:browsers` запускает локальный CLI из lockfile как `playwright install chromium`; голый `npx` не должен незаметно подтягивать другую версию. После каждого изменения версии Playwright команду выполняют снова: Playwright прямо связывает каждую свою версию с конкретными browser binaries ([Playwright browsers](https://playwright.dev/docs/browsers#introduction)). Browser cache не входит в резервную копию — он восстанавливается из lockfile.

В коде пути строятся через `path.join`, а не конкатенацией `\`. В PowerShell пользовательские пути всегда передаются отдельным аргументом и в кавычках; переход в каталог делается `Push-Location -LiteralPath 'C:\путь с пробелами\website-change-monitor'`. Переменные текущего PowerShell-процесса доступны как `$Env:NAME` и наследуются дочерними процессами ([PowerShell environment variables](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_environment_variables)).

## Первый запуск

Репозиторий должен предоставить ровно следующие пользовательские команды; это контракт будущей реализации, а не уже существующие scripts:

```powershell
Push-Location -LiteralPath 'C:\Users\<user>\Documents\repositories\website-change-monitor'

node --version                 # ожидается v24.x.x
npm --version
npm ci
npm run install:browsers      # только Chromium, в app-local cache
npm run build
# Необязательно до первого запуска; можно настроить позднее
npm run configure -- --telegram-executable 'C:\absolute\path\.venv\Scripts\telegram-alert.exe'
npm run doctor
npm start
```

Для Telegram пользователь один раз устанавливает и настраивает уже проверенный модуль из его собственного репозитория; этот шаг можно выполнить до первого запуска основного приложения либо позднее:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
.\.venv\Scripts\telegram-alert.exe configure --device 'home-pc' --chat-id '<chat id>'
```

`configure` основного приложения принимает только абсолютный существующий `.exe`, запускает безопасный `show-config`/self-check с `PYTHONUTF8=1`, не запрашивает bot token и транзакционно записывает путь в единую SQLite-БД. Если Telegram не настроен или недоступен, `doctor` явно сообщает ошибку этого компонента, но production start продолжает работу в деградированном режиме: UI показывает постоянную плашку «Telegram недоступен», а Проверки, центр и браузерные уведомления работают дальше.

Первый `npm start` выполняет последовательность до открытия UI:

1. проверяет Windows 11 x64, Node 24, доступность каталогов, native addon и Chromium как обязательные компоненты, а Telegram executable — как необязательный внешний канал;
2. проверяет, не отвечает ли уже собственный health endpoint;
3. создаёт каталоги и session log;
4. открывает SQLite, проверяет фактические `journal_mode=WAL`, `foreign_keys=ON`, `synchronous=FULL`, `busy_timeout` и минимальную версию SQLite;
5. для существующей БД выполняет `quick_check` и `foreign_key_check`; перед любой изменяющей схему миграцией создаёт и проверяет pre-migration backup;
6. транзакционно применяет миграции и startup recovery, затем запускает Chromium, worker и Fastify только на `127.0.0.1:43117`;
7. после готовности `GET /api/health` открывает `http://127.0.0.1:43117/` в браузере по умолчанию и печатает этот URL в консоль.

PowerShell `Start-Process` умеет открывать файл/URL зарегистрированным приложением и запускает процесс асинхронно ([Microsoft `Start-Process`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/start-process)). Поставляемый `start.cmd` может быть безопасной целью обычного Windows-ярлыка и вызывать тот же production entry point; отдельный background/service режим не нужен.

## Повторный ручной запуск и остановка

Фиксированный loopback port одновременно служит простым single-instance барьером. Повторный `npm start`/ярлык сначала запрашивает `/api/health` и проверяет стабильный application identifier:

- если отвечает эта же версия приложения, новый процесс только открывает UI и завершается с code 0;
- если порт занят чужим или неидентифицируемым процессом, запуск ничего не завершает принудительно и сообщает конфликт;
- если приложение не отвечает, новый процесс проходит обычный startup recovery и запускается.

Проверка health должна происходить до открытия SQLite и миграций, чтобы два почти одновременных запуска не становились двумя writers. Победивший bind продолжает startup; проигравший повторно проверяет health и либо открывает UI, либо сообщает гонку.

Штатная остановка — один `Ctrl+C` в консоли. Она запускает уже принятое восьмисекундное draining: перестаёт принимать новые Проверки, завершает/фиксирует текущую, закрывает HTTP, Chromium, логи и SQLite. Закрытие окна консоли хуже: Node получает `SIGHUP`, но Windows примерно через 10 секунд всё равно безусловно завершает процесс; `SIGINT` от `Ctrl+C` поддерживается штатно ([Node.js signal events](https://nodejs.org/docs/latest-v24.x/api/process.html#signal-events)). Поэтому интерфейс и README должны прямо говорить «Остановить: Ctrl+C; дождаться сообщения “Остановлено”». Даже жёсткое завершение остаётся восстанавливаемым благодаря долговечной очереди, но не считается обычной операцией.

## Логи и диагностика

Каждый запуск создаёт ограниченный NDJSON-log в `logs`. Записи включают UTC timestamp, level, `boot_id`, версию приложения/Node/SQLite/Playwright, пути без пользовательских данных, этап startup, migration/recovery, идентификаторы Монитора/Проверки, типизированный error code и Telegram exit code. Не логируются bot token, полный URL с credentials/query secrets, сырой HTML, Снимок, diff и полный Telegram payload. stdout остаётся коротким и человекочитаемым.

Практичный предел MVP: roll session log при 10 MiB и сохранять 20 последних файлов; cleanup выполняется только после успешного открытия нового log. Путь к текущему log всегда печатается при старте и показывается на странице диагностики.

`npm run doctor` — read-only команда, которую рекомендуют запускать при остановленном приложении. Она печатает результат по пунктам и различает фатальную ошибку от деградированного Telegram: exit `0` — всё готово, `1` — обязательный компонент не готов, `2` — приложение готово без Telegram. `npm start` и `doctor --preflight` для обновления допускают `0/2`, но не `1`:

- ОС/архитектура, Node 24 и npm;
- согласованность `package.json`/lockfile и загрузка `better-sqlite3`;
- наличие/запись каталогов и свободное место;
- SQLite version, schema version, фактические PRAGMA, `quick_check`, `foreign_key_check`;
- наличие подходящего Chromium (`playwright install --list`) и короткий launch/close smoke без обращения к сайтам;
- абсолютный Telegram executable, UTF-8 environment и `show-config` без чтения token;
- доступность порта или корректная идентификация уже работающего экземпляра.

При повреждении БД startup и doctor не переименовывают и не создают пустую замену: они сообщают абсолютный путь, последний проверенный backup и путь к log. Диагностический bundle в MVP — это выбранные session logs + вывод `doctor`, но не сама БД, потому что она содержит URL и наблюдаемое содержимое.

## Резервная копия и восстановление

Основная БД работает в WAL. WAL — часть постоянного состояния: отделение `monitor.sqlite3` от `monitor.sqlite3-wal` способно потерять уже committed транзакции или повредить копию ([SQLite WAL file](https://www.sqlite.org/wal.html#the_wal_file)). Поэтому Проводник, `Copy-Item monitor.sqlite3` и синхронизация одного `.sqlite3` не являются поддерживаемым backup.

Поддерживаемая ручная операция:

```powershell
# Сначала Ctrl+C и дождаться «Остановлено»
npm run backup
```

Команда отказывается работать при живом экземпляре, открывает существующую БД с `fileMustExist`, создаёт новый timestamped файл через `better-sqlite3 Database#backup()`, затем открывает результат и требует успешные `quick_check`, `foreign_key_check` и известную schema version. Только после этого она печатает «Резервная копия готова» и абсолютный путь. Online Backup API создаёт согласованный snapshot и позволяет копировать живую БД, а `better-sqlite3` разрешает нормальную работу во время backup ([SQLite Online Backup API](https://www.sqlite.org/backup.html), [`better-sqlite3` backup](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#backupdestination-options---promise)); однако требование остановки делает пользовательский MVP-процесс проще и исключает гонку с миграцией. `VACUUM INTO` также даёт согласованную копию, но требует дополнительного дискового места и не нужен как второй путь ([SQLite `VACUUM INTO`](https://www.sqlite.org/lang_vacuum.html#vacuuminto)).

Manual backups приложение автоматически не удаляет. В каждом автоматическом классе — `pre-update` и `pre-migration` — хранятся три последние **успешно проверенные** копии; более старую можно удалить только после успешного создания и проверки новой.

Должна существовать симметричная команда `npm run restore -- --from '<absolute backup path>'`, выполняемая только при остановленном приложении. Она сначала валидирует источник, сохраняет текущую БД в отдельный recovery-файл, восстанавливает во временный файл в том же каталоге и лишь затем заменяет основную БД; неизвестную более новую schema version не открывает. Старые `-wal/-shm` никогда не подмешиваются к восстановленной копии. После замены команда повторяет integrity/foreign-key checks, а исходная повреждённая/новая БД остаётся доступной для ручного возврата.

## Безопасное обновление

Пока нет версионированного release tag, полностью воспроизводимого пользовательского обновления нет: `main` — движущаяся цель. MVP должен выпускать теги и документировать точную целевую версию. Поддерживаемый `scripts\update.ps1 -Version vX.Y.Z` выполняет обновление только при остановленном приложении и чистом worktree:

1. проверяет health/port и `git status --porcelain`; при локальных изменениях останавливается без stash/reset;
2. записывает текущий commit/version и создаёт проверенный `pre-update` backup;
3. получает точный release tag, проверяет, что он существует в `origin`, и переводит чистый checkout именно на commit этого тега (`git switch --detach vX.Y.Z`); если проект всё же обновляет tracked branch, допускается только `git pull --ff-only`, который отказывается создавать merge commit ([Git `--ff-only`](https://git-scm.com/docs/git-pull#Documentation/git-pull.txt---ff-only)). Porcelain status предназначен для стабильного машинного разбора ([Git status porcelain](https://git-scm.com/docs/git-status#_porcelain_format_version_1));
4. выполняет `npm ci`, `npm run install:browsers`, `npm run build`, тесты и `npm run doctor -- --preflight`;
5. запускает новую версию. Startup ещё раз проверяет БД, создаёт отдельный backup непосредственно перед schema migration и применяет миграцию транзакционно.

На первом сбое script прекращает цепочку. Так как `npm ci` предварительно удаляет `node_modules`, update script должен хранить старый commit и предоставлять автоматизированный rollback, а не оставлять пользователя с полуобновлённой установкой. До применения миграции достаточно выполнить `git switch --detach <old commit>` и повторить его `npm ci`/browser install/build. После успешной миграции откат всегда парный: **старый commit + pre-update database backup**. Запуск старого кода на новой схеме запрещён; это согласуется с правилом, что приложение отказывается от неизвестной более новой schema version.

Ни backup, ни update не копируют `node_modules`, Chromium cache или логи как данные приложения. Они воспроизводятся/сохраняются отдельно. Telegram virtualenv обновляется по правилам собственного репозитория и не должен неявно изменяться вместе с основным приложением; после обновления `doctor` заново проверяет его абсолютный путь и контракт.

## Итоговый минимальный пользовательский поток

1. Один раз установить Node 24 LTS x64, затем выполнить `npm ci`, `npm run install:browsers`, `npm run build` и `doctor`; Telegram sender и `configure` можно подготовить сразу либо позднее по инструкции из UI.
2. Каждый раз запускать ярлык или `npm start`; UI открывается на `http://127.0.0.1:43117/`. Повторный запуск только открывает ещё одну вкладку существующего экземпляра.
3. Останавливать `Ctrl+C` и ждать подтверждения; не рассчитывать на закрытие окна как на гарантированно graceful операцию.
4. Искать данные, backups и логи только в `%LOCALAPPDATA%\WebsiteChangeMonitor`; кодовый каталог можно перемещать, обновлять и пересобирать независимо.
5. Делать `npm run backup` перед ручным обслуживанием; обновляться только на точную версию через проверяющий script. При откате после миграции возвращать и код, и БД.

Это сохраняет обещание «локальное веб-приложение, запускаемое вручную» и даёт проверяемые пути диагностики и восстановления, не превращая MVP в Windows-службу или desktop-продукт.
