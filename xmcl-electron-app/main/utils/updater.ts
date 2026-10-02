import { HAS_DEV_SERVER } from '@/constant'
import {
  DownloadBaseOptions,
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
import { shell } from 'electron'
import { readFile, rename as renameAsync, unlink as unlinkAsync, writeFile } from 'fs-extra'
import { closeSync, existsSync, open, rename, unlink } from 'original-fs'
import { basename, dirname, join } from 'path'
import { promisify } from 'util'
import { Logger } from '~/infra'
import { kSettings } from '~/settings'
import { checksum } from '~/util/fs'
import ElectronLauncherApp from '../ElectronLauncherApp'
import { ensureElevateExe } from './elevate'

const LOM_REPOSITORY = 'nondename/LoM-Launcher-XMCL'
const LOM_RELEASES_URL = `https://github.com/${LOM_REPOSITORY}/releases`
const LOM_RELEASES_API = `https://api.github.com/repos/${LOM_REPOSITORY}/releases`

function normalizeVersion(version: string) {
  return version.trim().replace(/^v/i, '')
}

function compareVersions(a: string, b: string) {
  const parse = (version: string) => {
    const normalized = normalizeVersion(version)
    const [core, prerelease = ''] = normalized.split('-', 2)
    const numbers = core.split('.').map((part) => Number.parseInt(part, 10) || 0)
    return { numbers, prerelease }
  }

  const left = parse(a)
  const right = parse(b)
  const length = Math.max(left.numbers.length, right.numbers.length)
  for (let i = 0; i < length; i += 1) {
    const diff = (left.numbers[i] ?? 0) - (right.numbers[i] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }

  if (left.prerelease === right.prerelease) return 0
  if (!left.prerelease) return 1
  if (!right.prerelease) return -1
  return left.prerelease.localeCompare(right.prerelease)
}

function getPlatformFlag(app: ElectronLauncherApp) {
  let platformFlag =
    app.platform.os === 'windows' ? 'win' : app.platform.os === 'osx' ? 'mac' : 'linux'
  if (process.arch === 'arm64') {
    platformFlag += '-arm64'
  } else if (process.arch === 'ia32') {
    platformFlag += '-ia32'
  }
  return platformFlag
}

function getAsarName(app: ElectronLauncherApp, version: string) {
  return `app-${normalizeVersion(version)}-${getPlatformFlag(app)}.asar`
}

function parseSha256(value: string) {
  const hash = value.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  return /^[a-f0-9]{64}$/.test(hash) ? hash : ''
}

async function downloadAsarUpdate(
  app: ElectronLauncherApp,
  destination: string,
  updateInfo: ReleaseInfo,
  options?: {
    abortSignal?: AbortSignal
    tracker?: Tracker<DownloadUpdateTrackerEvents>
  } & DownloadBaseOptions,
): Promise<void> {
  const fileName = getAsarName(app, updateInfo.name)
  const asar = updateInfo.files.find((file) => file.name === fileName)
  const shaFile = updateInfo.files.find((file) => file.name === `${fileName}.sha256`)

  if (!asar) {
    throw new AnyError('UpdateAsarError', `LoM update asset is missing: ${fileName}`)
  }
  if (!shaFile) {
    throw new AnyError('UpdateAsarError', `LoM update checksum is missing: ${fileName}.sha256`)
  }

  const shaResponse = await app.fetch(shaFile.url, { signal: options?.abortSignal })
  if (!shaResponse.ok) {
    throw new AnyError(
      'UpdateAsarError',
      `Cannot download LoM update checksum: HTTP ${shaResponse.status}`,
    )
  }

  const expectedSha256 = parseSha256(await shaResponse.text())
  if (!expectedSha256) {
    throw new AnyError('UpdateAsarError', `Invalid SHA-256 file for ${fileName}`)
  }

  const currentSha256 = await checksum(destination, 'sha256').catch(() => '')
  if (currentSha256.toLowerCase() === expectedSha256) {
    return
  }

  const tempFile = `${destination}.tmp`
  await unlinkAsync(tempFile).catch(() => {})

  try {
    await download({
      url: asar.url,
      destination: tempFile,
      tracker: onDownloadSingle(options?.tracker, 'download-update.asar', { url: asar.url }),
      signal: options?.abortSignal,
      ...getDownloadBaseOptions(options),
    })

    const actualSha256 = (await checksum(tempFile, 'sha256')).toLowerCase()
    if (actualSha256 !== expectedSha256) {
      throw new AnyError(
        'UpdateAsarError',
        `SHA-256 mismatch for ${fileName}. Expected ${expectedSha256}, got ${actualSha256}`,
      )
    }

    await unlinkAsync(destination).catch(() => {})
    await renameAsync(tempFile, destination)
  } catch (error) {
    await unlinkAsync(tempFile).catch(() => {})
    throw error
  }
}

async function hintUserDownload(): Promise<void> {
  await shell.openExternal(LOM_RELEASES_URL)
}

async function getUpdateAsarViaBatArgs(
  appAsarPath: string,
  updateAsarPath: string,
  appDataPath: string,
  elevatePath?: string,
): Promise<string[]> {
  const batPath = join(appDataPath, 'AutoUpdate.bat')
  await writeFile(
    batPath,
    [
      '@echo off',
      'chcp 65001',
      '%WinDir%\\System32\\timeout.exe 2',
      `taskkill /f /im "${basename(process.argv[0])}"`,
      `copy /Y "${updateAsarPath}" "${appAsarPath}"`,
      `start /b "" /d "${process.cwd()}" ${process.argv.map((s) => `"${s}"`).join(' ')}`,
    ].join('\r\n'),
  )

  return elevatePath ? [elevatePath, batPath] : ['cmd.exe', '/c', batPath]
}

export class ElectronUpdater implements LauncherAppUpdater {
  private logger: Logger

  constructor(private app: ElectronLauncherApp) {
    this.logger = app.getLogger('ElectronUpdater')
  }

  async #getUpdateFromLoMReleases(): Promise<ReleaseInfo> {
    const { allowPrerelease } = await this.app.registry.get(kSettings)
    const url = allowPrerelease ? `${LOM_RELEASES_API}?per_page=20` : `${LOM_RELEASES_API}/latest`

    this.logger.log(`Check LoM launcher update via ${url}`)
    const response = await this.app.fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })

    if (!response.ok) {
      throw new AnyError(
        'UpdateError',
        `Failed to check LoM launcher updates: HTTP ${response.status} ${await response.text()}`,
        {},
        { status: response.status },
      )
    }

    const payload = (await response.json()) as any
    const result = Array.isArray(payload)
      ? payload.find((release: any) => !release.draft && (allowPrerelease || !release.prerelease))
      : payload

    if (!result?.tag_name) {
      throw new AnyError('UpdateError', 'No published LoM launcher release was found')
    }

    const files = (result.assets ?? []).map((asset: any) => ({
      url: asset.browser_download_url,
      name: asset.name,
    })) as Array<{ url: string; name: string }>

    const version = normalizeVersion(result.tag_name)
    const asarName = getAsarName(this.app, version)
    const hasAsar = files.some((file) => file.name === asarName)
    const hasChecksum = files.some((file) => file.name === `${asarName}.sha256`)
    const newUpdate = compareVersions(version, this.app.version) > 0

    const updateInfo: ReleaseInfo = {
      name: result.tag_name,
      body: result.body ?? '',
      date: result.published_at ?? result.created_at ?? '',
      files,
      newUpdate,
      operation: ElectronUpdateOperation.Manual,
    }

    if (newUpdate && hasAsar && hasChecksum && this.app.env !== 'appx' && this.app.env !== 'appimage') {
      updateInfo.operation = ElectronUpdateOperation.Asar
    }

    this.logger.log(
      `LoM update current=${this.app.version} latest=${version} operation=${updateInfo.operation}`,
    )
    return updateInfo
  }

  private async quitAndInstallAsar() {
    const appAsarPath = join(dirname(__dirname), 'app.asar')
    const updateAsarPath = join(this.app.appDataPath, 'pending_update')

    if (!existsSync(updateAsarPath)) {
      throw new Error(`No downloaded LoM update found: ${updateAsarPath}`)
    }

    this.logger.log(`Install LoM asar update on ${this.app.platform.os}: ${appAsarPath}`)

    if (this.app.platform.os === 'windows') {
      const elevatePath = await ensureElevateExe(this.app.appDataPath)
      let hasWriteAccess = await new Promise<boolean>((resolve) => {
        open(appAsarPath, 'a', (error, fd) => {
          if (error) {
            resolve(false)
          } else {
            closeSync(fd)
            resolve(true)
          }
        })
      })

      // Keep the existing safe behaviour: replace app.asar from an elevated helper.
      hasWriteAccess = false
      const args = await getUpdateAsarViaBatArgs(
        appAsarPath,
        updateAsarPath,
        this.app.appDataPath,
        !hasWriteAccess ? elevatePath : undefined,
      )
      const child = spawn(args[0], args.slice(1), {
        cwd: this.app.appDataPath,
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
      this.app.quit()
      return
    }

    await promisify(rename)(appAsarPath, `${appAsarPath}.bk`).catch(() => {})
    try {
      try {
        await promisify(rename)(updateAsarPath, appAsarPath)
      } catch (error) {
        if (isSystemError(error) && error.code === 'EXDEV') {
          await writeFile(appAsarPath, await readFile(updateAsarPath))
        } else {
          throw error
        }
      }
      await promisify(unlink)(`${appAsarPath}.bk`).catch(() => {})
      this.app.relaunch()
    } catch (error) {
      this.logger.error(
        new AnyError('UpdateError', `Failed to install LoM update: ${appAsarPath}`, {
          cause: error,
        }),
      )
      await promisify(rename)(`${appAsarPath}.bk`, appAsarPath).catch(() => {})
      throw error
    }
  }

  async checkUpdateTask(): Promise<ReleaseInfo> {
    return this.#getUpdateFromLoMReleases()
  }

  async downloadUpdate(updateInfo: ReleaseInfo, options?: DownloadUpdateOptions): Promise<void> {
    const tracker = options?.tracker
    const abortSignal = options?.abortSignal

    if (updateInfo.operation === ElectronUpdateOperation.Asar) {
      const updatePath = join(this.app.appDataPath, 'pending_update')
      await downloadAsarUpdate(this.app, updatePath, updateInfo, {
        tracker,
        abortSignal,
      })
      return
    }

    tracker?.({
      phase: 'download-update.manual',
      payload: {},
    })
    await hintUserDownload()
  }

  async installUpdateAndQuit(updateInfo: ReleaseInfo): Promise<void> {
    if (HAS_DEV_SERVER) {
      this.logger.log('Development environment detected. Skip installing launcher update')
      return
    }

    if (updateInfo.operation === ElectronUpdateOperation.Asar) {
      await this.quitAndInstallAsar()
      return
    }

    await hintUserDownload()
  }
}
