# Website Change Monitor

Персональное локальное приложение для Windows, которое отслеживает выбранные части общедоступных веб-страниц, сохраняет историю проверок и сообщает об изменениях.

## Текущее состояние

Реализация началась с локальной оболочки приложения: один Node.js-процесс поднимает Fastify API и React UI, открывает версионированную SQLite и предоставляет команду диагностики. Функции создания Мониторов и выполнения Проверок добавляются следующими GitHub Issues.

- Доменный язык и подтверждённые ограничения: [`CONTEXT.md`](./CONTEXT.md)
- Карта Wayfinder: [`.scratch/website-change-monitor-mvp/map.md`](./.scratch/website-change-monitor-mvp/map.md)
- Исследовательские билеты: [`.scratch/website-change-monitor-mvp/issues/`](./.scratch/website-change-monitor-mvp/issues/)
- PRD: [`.scratch/website-change-monitor-mvp/PRD.md`](./.scratch/website-change-monitor-mvp/PRD.md)
- Реализационные билеты: [GitHub Issues](https://github.com/theEvgene/website-change-monitor/issues)
- Локальный HTTP API: [`docs/http-api.md`](./docs/http-api.md)

Рабочий поток: `wayfinder -> to-spec -> to-tickets -> implement`.

## Запуск оболочки

Требуется Windows 11 x64 и Node.js 24 LTS. Команды выполняются из корня репозитория обычным пользователем:

```powershell
npm ci
npm run install:chromium
npm run build
npm run doctor
npm start
```

`doctor` возвращает:

- `0` — приложение готово;
- `1` — ядро приложения нельзя безопасно запустить;
- `2` — ядро готово, но необязательный Telegram недоступен или ещё не настроен.

На текущем этапе нормальный результат — `2`: Telegram подключается отдельным билетом и не блокирует запуск. `npm start` слушает только `127.0.0.1:43117`, открывает интерфейс в браузере и остаётся foreground-процессом. Повторный запуск открывает уже работающий экземпляр; чужой процесс на порту приводит к явной ошибке.

Изменяемые данные хранятся в `%LOCALAPPDATA%\WebsiteChangeMonitor`, а не в Git checkout. Обычная остановка выполняется через `Ctrl+C`.

Внутри этого корня приложение использует `data` для SQLite, `backups` для резервных копий, `logs` для редактированных NDJSON-логов и `browsers` для app-local Chromium. Путь к `telegram-alert.exe` хранится в SQLite; Telegram-токен остаётся только в Windows Credential Manager/keyring модуля `telegram-alert-bus`.

## Диагностика и резервные копии

Перед обслуживанием остановите приложение через `Ctrl+C`. Команды не перезаписывают существующие ручные копии и всегда печатают абсолютный путь:

```powershell
npm run build
npm run backup
node dist/server/cli.js backup --output "моя ручная копия.sqlite3"
node dist/server/cli.js restore --input "$env:LOCALAPPDATA\WebsiteChangeMonitor\backups\моя ручная копия.sqlite3"
```

Backup создаётся SQLite backup API и проверяется через `quick_check` и `foreign_key_check`. Restore сначала проверяет целостность и совместимость копии, затем атомарно заменяет основную базу; при ошибке прежняя база остаётся на месте. Ручные копии автоматически не удаляются.

`doctor` отдельно проверяет Windows/Node, доступность каталогов, SQLite и миграции, app-local Chromium, локальный порт и необязательный Telegram. Повреждённая SQLite блокирует старт до явного восстановления из проверенной копии.

Лог `%LOCALAPPDATA%\WebsiteChangeMonitor\logs\application.ndjson` не сохраняет URL credentials, authorization/cookie/token/secret/stdin и известные Telegram-токены. Он ротируется при 10 MiB; сохраняются не более 20 поколений.

## Проверка разработки

```powershell
npm run typecheck
npm test
npm run build
```

## Границы MVP

- однопользовательское локальное веб-приложение на русском языке;
- ручной запуск на Windows;
- мониторинг примерно 100 публичных страниц, включая JavaScript-рендеринг;
- наблюдение за выбранными CSS-селекторами с исключениями;
- журнал проверок, история изменений и двухколоночное сравнение;
- уведомления в интерфейсе, браузере и через Telegram-модуль.
