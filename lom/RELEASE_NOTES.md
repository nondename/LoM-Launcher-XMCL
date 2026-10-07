# LoM Launcher v1.8.11-dev.1

DEV-сборка для тестирования второго управляемого инстанса **Lite**.

## Lite

- Добавлен отдельный managed-instance `Lite`.
- Minecraft: 1.20.1.
- Forge: 47.4.22.
- Java: 17.
- Managed profile ID: `legends-of-medieval-lite`.
- Источник обновлений вынесен в отдельный публичный репозиторий `nondename/LoM_Lite`.
- DEV-манифест: `dev/distribution.json`.
- Начальное состояние Lite — чистый Forge без управляемых модов, конфигов, шейдеров, ресурспаков и `options.txt`.

## Изоляция управляемых сборок

- Основная Legends of Medieval и Lite имеют разные managed identity и разные источники манифестов.
- Lite не наследует legacy update-state основной сборки.
- Специальные правила основной LoM-сборки (seed `options.txt`, cleanup marker) не применяются к Lite.
- Runtime-only manifest разрешён, поэтому Lite может существовать как чистый Forge-профиль.

## Что проверить

- после запуска лаунчера рядом с основной сборкой появляется `Lite`;
- Lite создаётся только один раз и не дублируется при следующих запусках;
- запускается Minecraft 1.20.1 Forge 47.4.22;
- в Lite не приезжают моды и конфиги основной Legends of Medieval;
- обновление основной сборки не изменяет Lite и наоборот.

> Это DEV prerelease. В stable изменения пока не выпускаются.
