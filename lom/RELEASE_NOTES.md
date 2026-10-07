# LoM Launcher v1.8.9

Стабильный релиз новой архитектуры Legends of Medieval для основного канала обновлений.

## Главное

- Legends of Medieval теперь является отдельным launcher-managed профилем с постоянной идентичностью `provider/profileId` в `instance.json`.
- Пользовательские инстансы полностью отделены от LoM: создание обычной сборки использует штатную логику XMCL и больше не запускает LoM updater.
- Существующие установки Legends of Medieval автоматически мигрируют на managed-профиль без пересоздания инстанса и без потери миров/настроек.
- Дублированный managed-профиль становится обычным пользовательским инстансом и не создаёт второго официального LoM.

## Обновление LoM

- Моды, конфиги, resource packs, скрипты и Forge runtime устанавливаются из LoM distribution.
- Forge `1.20.1-forge-47.4.22` регистрируется из зеркального runtime-профиля LoM.
- Vanilla Minecraft client/assets/обычные библиотеки остаются на штатном пути XMCL/Mojang.
- `options.txt` сохраняется как пользовательский файл после первоначального seed.
- Updater удаляет только ранее управляемые файлы или явные `delete`-цели; сторонние пользовательские файлы не считаются мусором.
- Состояние `.managed-update.json` записывается только после успешной установки и регистрации runtime.
- Исправлен неверный runtime ID `1.20.1-47.4.22`: используется фактический `1.20.1-forge-47.4.22`.

## Java и запуск

- Для managed LoM закреплена Java 17.
- Обычные пользовательские сборки продолжают использовать автоматический выбор Java XMCL для своей версии Minecraft.
- Pre-launch managed updater запускается только для инстансов с явным `managed` ownership.

## Проверено

- миграция существующего LoM;
- обновление LoM до текущего distribution;
- запуск LoM на Forge 47.4.22 / Java 17;
- создание и запуск отдельного vanilla Minecraft 1.7.10 / Java 8;
- отсутствие LoM updater в launch-chain пользовательского инстанса;
- полный Windows production build и NSIS installer;
- managed ownership tests и live-проверка всех Forge runtime-библиотек.

Этот stable также включает изменения, ранее проходившие проверку в DEV-линейке 1.8.x.

## Загрузка

Для Windows x64 публикуются:

- `LoM-Launcher-Setup-1.8.9-x64.exe`;
- `LoM-Launcher-Setup-1.8.9-x64.exe.sha256`;
- `LoM-Launcher-v1.8.9-windows-x64.zip`;
- `LoM-Launcher-v1.8.9-windows-x64.zip.sha256`;
- `app-1.8.9-win.asar`;
- `app-1.8.9-win.asar.sha256`.

> Windows-сборка пока не подписана Authenticode, поэтому SmartScreen может показать предупреждение при первом запуске.
