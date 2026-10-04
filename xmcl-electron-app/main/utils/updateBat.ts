/**
 * Build the Windows batch script that swaps `app.asar` while the launcher is
 * down. The script stages the new asar next to the destination, verifies the
 * staging copy byte-for-byte, backs up the current asar, and rolls back from
 * the backup when any step fails, so a failed update always relaunches the
 * previous working version.
 *
 * Kept free of electron/alias imports on purpose so it can be unit tested.
 */
export interface UpdateBatScriptOptions {
  appAsarPath: string
  updateAsarPath: string
  relaunchCwd: string
  relaunchArgv: string[]
  exeName: string
}

export function buildUpdateBatScript(options: UpdateBatScriptOptions): string {
  const { appAsarPath, updateAsarPath, relaunchCwd, relaunchArgv, exeName } = options
  const log = '"%~dp0AutoUpdate.log"'
  const staged = `${appAsarPath}.new`
  const backup = `${appAsarPath}.bk`
  const relaunch = `start "" /d "${relaunchCwd}" ${relaunchArgv.map((s) => `"${s}"`).join(' ')}`

  return [
    '@echo off',
    'chcp 65001',
    `>>${log} echo [%date% %time%] update start: "${updateAsarPath}" -^> "${appAsarPath}"`,
    '%WinDir%\\System32\\timeout.exe 2',
    `taskkill /f /im "${exeName}"`,
    // Give the force-killed process a moment to release the asar handle.
    '%WinDir%\\System32\\timeout.exe 1',
    // Stage and verify the payload before touching the installed asar.
    `copy /Y "${updateAsarPath}" "${staged}" >>${log}`,
    'if errorlevel 1 goto fail',
    `fc /b "${updateAsarPath}" "${staged}" >>${log}`,
    'if errorlevel 1 goto fail',
    // Back up the current asar so a failed swap can be rolled back.
    `copy /Y "${appAsarPath}" "${backup}" >>${log}`,
    'if errorlevel 1 goto fail',
    `move /Y "${staged}" "${appAsarPath}" >>${log}`,
    'if errorlevel 1 goto restore',
    `del /Q "${updateAsarPath}"`,
    `del /Q "${backup}"`,
    `>>${log} echo [%date% %time%] update succeeded`,
    'goto run',
    ':restore',
    `copy /Y "${backup}" "${appAsarPath}" >>${log}`,
    ':fail',
    `del /Q "${staged}" 2>nul`,
    `>>${log} echo [%date% %time%] update failed, previous version kept`,
    ':run',
    relaunch,
    // Remove the script itself so no updater leftovers stay in appData.
    'del /Q "%~f0" 2>nul',
  ].join('\r\n')
}
