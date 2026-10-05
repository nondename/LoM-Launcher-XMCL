import { HAS_DEV_SERVER } from '@/constant'
import {
  DownloadBaseOptions,
  ProgressTracker,
  download,
  getDownloadBaseOptions,
} from '@xmcl/file-transfer'
import { Tracker, onDownloadSingle } from '@xmcl/installer'
import {
  DownloadUpdateTrackerEvents,
  ElectronUpdateOperation,
  ReleaseInfo,
} from '@xmcl/runtime-api'
import { DownloadUpdateOptions, LauncherAppUpdater } from '@xmcl/runtime/app'
import { AnyError, isSystemError } from '@xmcl/utils'
import { spawn } from 'child_process'
import { app, shell } from 'electron'
import * as updater from 'electron-updater'
import { AppUpdater, CancellationToken, UpdaterSignal } from 'electron-updater'
import { createReadStream, createWriteStream } from 'fs'
import { readFile, rename as renameAsync, unlink as unlinkAsync, writeFile } from 'fs-extra'
import { closeSync, existsSync, open, rename, unlink } from 'original-fs'
import { platform } from 'os'
import { basename, dirname, join } from 'path'
import { pipeline } from 'stream/promises'
import { setTimeout } from 'timers/promises'
import { extract as extractTar } from 'tar-stream'
import { promisify } from 'util'
import { createGunzip } from 'zlib'
import { Logger, kGFW } from '~/infra'
import { kSettings } from '~/settings'
import { checksum } from '~/util/fs'
import ElectronLauncherApp from '../ElectronLauncherApp'
import { ensureElevateExe } from './elevate'

const kPatched = Symbol('Patched')
const LOM_REPOSITORY = 'nondename/LoM-Launcher-XMCL'
const LOM_RELEASES_API = `https://api.github.com/repos/${LOM_REPOSITORY}/releases`
const LOM_RELEASE_DOWNLOAD = `https://github.com/${LOM_REPOSITORY}/releases/download`

async function downloadAsarUpdate(
  app: ElectronLauncherApp,
  destination: string,
  version: string,
  options?: {
    abortSignal?: AbortSignal
    tracker?: Tracker<DownloadUpdateTrackerEvents>
  } & DownloadBaseOptions,
): Promise<void> {
  version = version.startsWith('v') ? version.substring(1) : version
  const pl = platform()
  let platformFlag = pl === 'win32' ? 'win' : pl === 'darwin' ? 'mac' : 'linux'
  if (process.arch === 'arm64') platformFlag += '-arm64'
  else if (process.arch === 'ia32') platformFlag += '-ia32'
  const file = `app-${version}-${platformFlag}.asar`
  const github = `${LOM_RELEASE_DOWNLOAD}/v${version}/${file}`

  try {
    const sha256Response = await app.fetch(github + '.sha256', { signal: options?.abortSignal })
    const sha256 = sha256Response.ok ? (await sha256Response.text()).trim().split(/\s+/)[0] : ''
    const actual = await checksum(destination, 'sha256').catch(() => '')
    if (sha256 && sha256 === actual) return
  } catch {}

  const errors: Error[] = []
  const isAbort = (e: unknown) => e instanceof Error && e.name === 'AbortError'
  try {
    await downloadGzAsar(app, github, destination, options)
    return
  } catch (e) {
    if (isAbort(e)) return
    errors.push(Object.assign(e as Error, { name: 'UpdateAsarError', url: github }))
  }
  throw new AggregateError(errors, 'Fail to download LoM launcher asar update')
}

async function downloadAsarFromTarball(
  app: ElectronLauncherApp,
  url: string,
  destination: string,
  options?: { abortSignal?: AbortSignal; tracker?: Tracker<DownloadUpdateTrackerEvents> } & DownloadBaseOptions,
): Promise<void> {
  const tempTgz = destination + '.tgz'
  await download({ url, destination: tempTgz, tracker: onDownloadSingle(options?.tracker, 'download-update.asar', { url }), signal: options?.abortSignal, ...getDownloadBaseOptions(options) })
  try {
    await new Promise<void>((resolve, reject) => {
      const tar = extractTar(); let found = false
      tar.on('entry', (header, stream, next) => {
        if (!found && (header.name === 'package/app.asar' || header.name.endsWith('/app.asar'))) {
          found = true; const out = createWriteStream(destination); out.on('error', reject); out.on('finish', next); stream.pipe(out)
        } else { stream.on('end', next); stream.on('error', reject); stream.resume() }
      })
      tar.on('error', reject); tar.on('finish', () => found ? resolve() : reject(new AnyError('UpdateAsarError', `No app.asar found in tarball ${url}`)))
      createReadStream(tempTgz).pipe(createGunzip()).pipe(tar)
    })
  } finally { await unlinkAsync(tempTgz).catch(() => {}) }
}

async function downloadGzAsar(
  app: ElectronLauncherApp,
  url: string,
  destination: string,
  options?: { abortSignal?: AbortSignal; tracker?: Tracker<DownloadUpdateTrackerEvents> } & DownloadBaseOptions,
): Promise<void> {
  const gzUrl = url + '.gz'
  const gzResponse = await app.fetch(gzUrl, { method: 'HEAD', signal: options?.abortSignal }).catch(() => null)
  const downloadUrl = gzResponse?.ok ? gzUrl : url
  const tempFile = destination + '.tmp'
  await download({ url: downloadUrl, destination: tempFile, tracker: onDownloadSingle(options?.tracker, 'download-update.asar', { url: downloadUrl }), signal: options?.abortSignal, ...getDownloadBaseOptions(options) })
  if (downloadUrl === gzUrl) { await pipeline(createReadStream(tempFile), createGunzip(), createWriteStream(destination)); await unlinkAsync(tempFile) }
  else await renameAsync(tempFile, destination)
}

async function hintUserDownload(): Promise<void> { shell.openExternal(`https://github.com/${LOM_REPOSITORY}/releases`) }

async function downloadAppInstaller(launcherApp: ElectronLauncherApp, options?: { abortSignal?: AbortSignal; tracker?: Tracker<DownloadUpdateTrackerEvents> } & DownloadBaseOptions): Promise<void> {
  const destination = join(app.getPath('downloads'), 'XMCL.appinstaller')
  const url = 'https://xmcl.blob.core.windows.net/releases/xmcl.appinstaller'
  await download({ url, destination, tracker: onDownloadSingle(options?.tracker, 'download-update.appx', { url }), signal: options?.abortSignal, ...getDownloadBaseOptions(options) })
  shell.showItemInFolder(destination); await setTimeout(1000); await shell.openPath(destination); launcherApp.exit()
}

async function getUpdateAsarViaBatArgs(appAsarPath: string, updateAsarPath: string, appDataPath: string, elevatePath?: string): Promise<string[]> {
  const psPath = join(appDataPath, 'AutoUpdate.bat')
  await writeFile(psPath, ['@echo off','chcp 65001','%WinDir%\\System32\\timeout.exe 2',`taskkill /f /im "${basename(process.argv[0])}"`,`copy /Y "${updateAsarPath}" "${appAsarPath}"`,`start /b "" /d "${process.cwd()}" ${process.argv.map((s) => `"${s}"`).join(' ')}`].join('\r\n'))
  return elevatePath ? [elevatePath, psPath] : ['cmd.exe', '/c', psPath]
}

async function downloadFullUpdate(app: ElectronLauncherApp, appUpdater: AppUpdater, options?: { tracker?: Tracker<DownloadUpdateTrackerEvents>; abortSignal?: AbortSignal }): Promise<void> {
  const tracker: ProgressTracker = { progress: 0, total: 0, url: '' }
  options?.tracker?.({ phase: 'download-update.full', payload: { progress: tracker } })
  const signal = new UpdaterSignal(appUpdater)
  signal.progress((info) => { tracker.progress = info.transferred; tracker.total = info.total })
  const cancellationToken = new CancellationToken(); options?.abortSignal?.addEventListener('abort', () => cancellationToken.cancel())
  await appUpdater.downloadUpdate(cancellationToken)
}

function isSameVersion(a: string, b: string) { return a.replace(/^v/, '') === b.replace(/^v/, '') }

export class ElectronUpdater implements LauncherAppUpdater {
  private logger: Logger
  constructor(private app: ElectronLauncherApp) { this.logger = app.getLogger('ElectronUpdater') }

  async #getUpdateFromSelfHost(): Promise<ReleaseInfo> {
    const { allowPrerelease } = await this.app.registry.get(kSettings)
    this.logger.log(`Check LoM launcher updates prerelease=${allowPrerelease}`)
    const response = await this.app.fetch(`${LOM_RELEASES_API}?per_page=30`, { headers: { Accept: 'application/vnd.github+json' } })
    if (!response.ok) throw new AnyError('UpdateError', `Fail to get LoM launcher releases: ${await response.text()}`, {}, { status: response.status })
    const releases = (await response.json()) as any[]
    const candidates = releases.filter((r) => !r.draft && (allowPrerelease ? r.prerelease : !r.prerelease))
    const result = candidates[0]
    if (!result) {
      return { name: `v${this.app.version}`, body: '', date: new Date().toISOString(), files: [], newUpdate: false, operation: ElectronUpdateOperation.Manual }
    }
    const files = result.assets.map((a: any) => ({ url: a.browser_download_url, name: a.name })) as Array<{ url: string; name: string }>
    const version = result.tag_name.replace(/^v/, '')
    const platformString = this.app.platform.os === 'windows' ? 'win' : this.app.platform.os === 'osx' ? 'mac' : 'linux'
    const hasAsar = files.some((f) => f.name === `app-${version}-${platformString}.asar`)
    const updateInfo: ReleaseInfo = {
      name: result.tag_name,
      body: result.body || '',
      date: result.published_at,
      files,
      newUpdate: !isSameVersion(this.app.version, result.tag_name),
      operation: hasAsar ? ElectronUpdateOperation.Asar : ElectronUpdateOperation.Manual,
    }
    this.logger.log(`Got LoM update ${result.tag_name} operation=${updateInfo.operation}`)
    return updateInfo
  }

  async #getUpdateFromAutoUpdater(): Promise<ReleaseInfo> {
    const autoUpdater = updater.autoUpdater
    this.logger.log(`Check update via ${autoUpdater.getFeedURL()}`)
    const info = await autoUpdater.checkForUpdates(); if (!info) throw new Error('No update info found')
    const files = info.updateInfo.files.map((f) => ({ name: basename(f.url), url: f.url }))
    return { name: info.updateInfo.version, body: info.updateInfo.releaseNotes as string, date: info.updateInfo.releaseDate, files, newUpdate: !isSameVersion(info.updateInfo.version, this.app.version), operation: ElectronUpdateOperation.AutoUpdater }
  }

  private async quitAndInstallAsar() {
    const appAsarPath = join(dirname(__dirname), 'app.asar'); const updateAsarPath = join(this.app.appDataPath, 'pending_update')
    this.logger.log(`Install asar on ${this.app.platform.os} ${appAsarPath}`)
    if (this.app.platform.os === 'windows') {
      const elevatePath = await ensureElevateExe(this.app.appDataPath)
      if (!existsSync(updateAsarPath)) throw new Error(`No update found: ${updateAsarPath}`)
      let hasWriteAccess = await new Promise((resolve) => open(appAsarPath, 'a', (e, fd) => { if (e) resolve(false); else { closeSync(fd); resolve(true) } }))
      hasWriteAccess = false
      const args = await getUpdateAsarViaBatArgs(appAsarPath, updateAsarPath, this.app.appDataPath, !hasWriteAccess ? elevatePath : undefined)
      const x = spawn(args[0], args.slice(1), { cwd: this.app.appDataPath, detached: true, stdio: 'ignore' }); x.unref(); this.app.quit()
    } else {
      await promisify(rename)(appAsarPath, appAsarPath + '.bk').catch(() => {})
      try {
        try { await promisify(rename)(updateAsarPath, appAsarPath) }
        catch (e) { if (isSystemError(e) && e.code === 'EXDEV') await writeFile(appAsarPath, await readFile(updateAsarPath)); else throw e }
        await promisify(unlink)(appAsarPath + '.bk').catch(() => {}); this.app.relaunch()
      } catch (e) { this.logger.error(new AnyError('UpdateError', `Fail to install update: ${appAsarPath}`, { cause: e })); await promisify(rename)(appAsarPath + '.bk', appAsarPath) }
    }
  }

  async checkUpdateTask(): Promise<ReleaseInfo> { return this.#getUpdateFromSelfHost() }

  async downloadUpdate(updateInfo: ReleaseInfo, options?: DownloadUpdateOptions): Promise<void> {
    const tracker = options?.tracker; const abortSignal = options?.abortSignal
    if (updateInfo.operation === ElectronUpdateOperation.AutoUpdater) await downloadFullUpdate(this.app, updater.autoUpdater, { tracker, abortSignal })
    else if (updateInfo.operation === ElectronUpdateOperation.Asar) await downloadAsarUpdate(this.app, join(this.app.appDataPath, 'pending_update'), updateInfo.name, { tracker, abortSignal })
    else if (updateInfo.operation === ElectronUpdateOperation.Appx) await downloadAppInstaller(this.app, { tracker, abortSignal })
    else { tracker?.({ phase: 'download-update.manual', payload: {} }); await hintUserDownload() }
  }

  async installUpdateAndQuit(updateInfo: ReleaseInfo): Promise<void> {
    if (updateInfo.operation === ElectronUpdateOperation.Asar) await this.quitAndInstallAsar()
    else if (updateInfo.operation === ElectronUpdateOperation.AutoUpdater) updater.autoUpdater.quitAndInstall()
  }
}
