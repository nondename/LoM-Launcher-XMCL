import { describe, expect, it } from 'vitest'
import { buildUpdateBatScript } from './updateBat'

const options = {
  appAsarPath: 'C:\\Program Files\\LoM Launcher\\resources\\app.asar',
  updateAsarPath: 'C:\\Users\\tester\\AppData\\Roaming\\LoM Launcher\\pending_update',
  relaunchCwd: 'C:\\Program Files\\LoM Launcher',
  relaunchArgv: ['C:\\Program Files\\LoM Launcher\\LoM Launcher.exe', '--profile', 'a b'],
  exeName: 'LoM Launcher.exe',
}

describe('buildUpdateBatScript', () => {
  const script = buildUpdateBatScript(options)

  it('kills the running app before touching app.asar', () => {
    const kill = script.indexOf('taskkill /f /im "LoM Launcher.exe"')
    const stage = script.indexOf(`copy /Y "${options.updateAsarPath}"`)
    expect(kill).toBeGreaterThan(-1)
    expect(stage).toBeGreaterThan(kill)
  })

  it('stages and byte-verifies the payload before replacing app.asar', () => {
    const stage = script.indexOf(`copy /Y "${options.updateAsarPath}" "${options.appAsarPath}.new"`)
    const verify = script.indexOf(`fc /b "${options.updateAsarPath}" "${options.appAsarPath}.new"`)
    const backup = script.indexOf(`copy /Y "${options.appAsarPath}" "${options.appAsarPath}.bk"`)
    const swap = script.indexOf(`move /Y "${options.appAsarPath}.new" "${options.appAsarPath}"`)
    expect(stage).toBeGreaterThan(-1)
    expect(verify).toBeGreaterThan(stage)
    expect(backup).toBeGreaterThan(verify)
    expect(swap).toBeGreaterThan(backup)
  })

  it('checks the error level after every mutating step', () => {
    const checks = script.match(/if errorlevel 1 goto \w+/g) ?? []
    expect(checks).toEqual([
      'if errorlevel 1 goto fail',
      'if errorlevel 1 goto fail',
      'if errorlevel 1 goto fail',
      'if errorlevel 1 goto restore',
    ])
  })

  it('rolls back from the backup when the swap fails', () => {
    const restore = script.indexOf(':restore')
    const rollback = script.indexOf(`copy /Y "${options.appAsarPath}.bk" "${options.appAsarPath}"`)
    expect(restore).toBeGreaterThan(-1)
    expect(rollback).toBeGreaterThan(restore)
    // The fail path must relaunch even after a rollback attempt.
    expect(script.indexOf(':fail')).toBeGreaterThan(rollback)
    expect(script.indexOf(':run')).toBeGreaterThan(script.indexOf(':fail'))
  })

  it('cleans up the downloaded payload, the backup and itself on success', () => {
    expect(script).toContain(`del /Q "${options.updateAsarPath}"`)
    expect(script).toContain(`del /Q "${options.appAsarPath}.bk"`)
    expect(script).toContain('del /Q "%~f0" 2>nul')
    // Nothing must remain in appData after a successful swap.
    expect(script.indexOf('del /Q "%~f0"')).toBeGreaterThan(script.indexOf(':run'))
  })

  it('relaunches the app with quoted arguments and working directory', () => {
    expect(script).toContain(
      'start "" /d "C:\\Program Files\\LoM Launcher" "C:\\Program Files\\LoM Launcher\\LoM Launcher.exe" "--profile" "a b"',
    )
    expect(script).not.toContain('start /b')
  })

  it('logs each attempt next to the script for diagnostics', () => {
    expect(script).toContain('"%~dp0AutoUpdate.log"')
    expect(script).toContain('update succeeded')
    expect(script).toContain('update failed, previous version kept')
  })
})
