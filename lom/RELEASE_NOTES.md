# LoM Launcher v1.8.11

Стабильный релиз второго управляемого инстанса **Lite**.

## Lite

- В лаунчере автоматически создаётся отдельный официальный инстанс `Lite`.
- Minecraft 1.20.1 / Forge 47.4.22 / Java 17.
- Managed profile ID: `legends-of-medieval-lite`.
- Lite полностью изолирован от основной Legends of Medieval и обновляется из отдельного репозитория `nondename/LoM_Lite`.
- Stable-манифест: `main/distribution.json`.

## Состав Lite 0.2.0

- Добавлены выбранные gameplay/QoL-моды, Create, BuildCraft CE, Iron's Spellbooks, Ice and Fire CE, MineColonies, biome/worldgen, Relics и survival-механики.
- Добавлены обязательные библиотеки и зависимости выбранного набора.
- Используются наши версии InkSpellBooks LoM Addon, Legendary Tabs, LoM Skin Loader, Map Atlases и изменённый GlitchCore.
- В Lite не копируются лишние моды, шейдеры и resource packs основной сборки.
- Файлы Lite закреплены на конкретной ревизии исходной LoM-сборки, поэтому последующие изменения main/dev не меняют Lite самопроизвольно.

## Managed-инстансы

- Legends of Medieval и Lite имеют разные managed identity и разные манифесты.
- Обновление одной сборки не затрагивает другую.
- Пользовательские XMCL-инстансы не получают LoM updater.
- Существующий Lite автоматически переключается с DEV-манифеста на stable.

## Обновление

Пользователи LoM Launcher 1.8.10 получат 1.8.11 через встроенное обновление лаунчера.
