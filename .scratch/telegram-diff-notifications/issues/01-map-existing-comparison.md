Status: resolved
Type: research
Blocked by:

# Картировать существующее Сравнение и семантику текстовых Изменений

## Question

Где и в каком виде формируются `SnapshotComparison`, `TargetComparison` и текстовые `DiffRow`, как они передаются во frontend, какие гарантии даёт классификация `insert`/`delete`/`replace`/`omitted`, и какой минимальный общий backend-контракт позволит Telegram использовать ровно те же результаты без второго алгоритма?

## Answer

Исследование зафиксировано в [«Существующее Сравнение и семантика текстовых Изменений»](../research/01-existing-comparison.md).

`compareSnapshots(beforeCanonicalJson, afterCanonicalJson): SnapshotComparison` уже является подходящим общим backend-интерфейсом. Frontend получает его результат через `MonitorStore.getComparison` → `MonitorService.getComparison` → `GET /api/checks/{checkId}/comparison` и не вычисляет diff самостоятельно. Telegram должен использовать тот же `SnapshotComparison`, а новая логика может быть только чистой проекцией его текстовых строк.

`insert` и `delete` имеют прямую семантику добавления и удаления; `omitted` честно обозначает ограниченное Сравнение и устанавливает `complete: false`. `replace` означает позиционную пару удаления и вставки внутри одного hunk, а не доказанное семантическое соответствие. Поэтому следующий проектный билет должен определить консервативное правило представления замен без второго diff-алгоритма.
