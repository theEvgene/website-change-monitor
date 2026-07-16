# Issue tracker: Local Markdown

Исследовательские задачи и PRD этого проекта хранятся как Markdown-файлы в `.scratch/`. Для Website Change Monitor MVP пользователь явно выбрал GitHub Issues как реальный трекер реализационных билетов после `/to-tickets`.

## Conventions

- Один feature на директорию: `.scratch/<feature-slug>/`.
- PRD: `.scratch/<feature-slug>/PRD.md`.
- Задачи реализации: `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, начиная с `01`.
- Состояние триажа записывается строкой `Status:` в начале файла задачи.
- Комментарии и история обсуждения добавляются в конец файла под заголовком `## Comments`.

## Реализационные билеты Website Change Monitor MVP

- Источник реализации — [GitHub Issues #1–#15](https://github.com/theEvgene/website-change-monitor/issues), созданные из `.scratch/website-change-monitor-mvp/PRD.md`.
- Состояние готовности задаётся меткой `ready-for-agent`; зависимости перечисляются в `Blocked by` ссылками на реальные номера issues.
- При `/implement` нужно читать полное тело соответствующего GitHub Issue. Pull request сам по себе источником требований не является.
- `.scratch/` остаётся источником PRD, карты исследования и закрытых исследовательских билетов; дублировать реализационные issues локальными Markdown-файлами не требуется.

## When a skill says "publish to the issue tracker"

Создать новый файл в `.scratch/<feature-slug>/`, при необходимости создав директорию.

## When a skill says "fetch the relevant ticket"

Прочитать файл по указанному пути. Пользователь обычно передает путь или номер задачи.

## Wayfinding operations

- **Map**: `.scratch/<effort>/map.md` — пункт назначения, заметки, указатель решений и туман войны.
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`. Строка `Type:` содержит `research`, `prototype`, `grilling` или `task`; `Status:` содержит `open`, `claimed` или `resolved`.
- **Blocking**: строка `Blocked by: NN, NN`. Билет разблокирован, когда все перечисленные билеты имеют `Status: resolved`.
- **Frontier**: открытые, разблокированные и незахваченные билеты; первым выбирается билет с меньшим номером.
- **Claim**: до начала работы установить `Status: claimed` и сохранить файл.
- **Resolve**: добавить ответ под `## Answer`, установить `Status: resolved`, затем добавить в `map.md` ссылку и краткий итог в `Decisions so far`.
