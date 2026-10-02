import { download } from '@xmcl/file-transfer'
import { onDownloadSingle } from '@xmcl/installer'
import { ElectronUpdateOperation, type ReleaseInfo } from '@xmcl/runtime-api'
import type { DownloadUpdateOptions, LauncherAppUpdater } from '@xmcl/runtime/app'
import { shell } from 'electron'
import { rename, unlink } from 'fs-extra'
import { join } from 'path'
import { kSettings } from '~/settings'
import { checksum } from '~/util/fs'
import type ElectronLauncherApp from '../ElectronLauncherApp'
import { ElectronUpdater } from './updater'

const LOM_GITHUB_REPOSITORY = 'nondename/LoM-Launcher-XMCL'
const LOM_RELEASES_URL = `https://github.com/${LOM_GITHUB_REPOSITORY}/releases`
const LOM_RELEASES_API = `https://api.github.com/repos/${LOM_GITHUB_REPOSITORY}/releases`

interface GitHubReleaseAsset {
  name: string
  browser_download_url: string
}

interface GitHubRelease {
  tag_name: string
  body: string | null
  published_at: string | null
  draft: boolean
  prerelease: boolean
  assets: GitHubReleaseAsset[]
}

interface ParsedVersion {
  core: number[]
  prerelease: string[]
}

function parseVersion(value: string): ParsedVersion | undefined {
  const normalized = value.trim().replace(/^v/i, '')
  const [corePart, prereleasePart = ''] = normalized.split('-', 2)
  const core = corePart.split('.').map((part) => Number(part))
  if (core.length === 0 || core.some((part) => !Number.isSafeInteger(part) || part < 0)) {
    return undefined
  }
  return {
    core,
    prerelease: prereleasePart ? prereleasePart.split('.') : [],
  }
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1

  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const left = a[i]
    const right = b[i]
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (left === right) continue

    const leftNumber = /^\d+$/.test(left) ? Number(left) : undefined
    const rightNumber = /^\d+$/.test(right) ? Number(right) : undefined
    if (leftNumber !== undefined && rightNumber !== undefined) {
      return leftNumber > rightNumber ? 1 : -1
    }
    if (leftNumber !== undefined) return -1
    if (rightNumber !== undefined) return 1
    return left > right ? 1 : -1
  }
  return 0
}

export function compareLoMVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return 0

  const length = Math.max(left.core.length, right.core.length)
  for (let i = 0; i < length; i++) {
    const leftPart = left.core[i] ?? 0
    const rightPart = right.core[i] ?? 0
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

function getPlatformFlag(): string {
  let platform = process.platform === 'win32'
    ? 'win'
    : process.platform === 'darwin'
      ? 'mac'
      : 'linux'
  if (process.arch === 'arm64') {
    platform += '-arm64'
  } else if (process.arch === 'ia32') {
    platform += '-ia32'
  }
  return platform
}

function getAsarName(version: string): string {
  const normalized = version.trim().replace(/^v/i, '')
  return `app-${normalized}-${getPlatformFlag()}.asar`
}

function selectHighestRelease(releases: GitHubRelease[]): GitHubRelease | undefined {
  return releases
    .filter((release) => !release.draft)
    .reduce<GitHubRelease | undefined>((selected, release) => {
      if (!selected || compareLoMVersions(release.tag_name, selected.tag_name) > 0) {
        return release
      }
      return selected
    }, undefined)
}

export class LoMElectronUpdater implements LauncherAppUpdater {
  private readonly delegate: ElectronUpdater

  constructor(private readonly app: ElectronLauncherApp) {
    this.delegate = new ElectronUpdater(app)
  }

  private async getLatestRelease(): Promise<GitHubRelease> {
    const { allowPrerelease } = await this.app.registry.get(kSettings)
    const url = allowPrerelease ? `${LOM_RELEASES_API}?per_page=20` : `${LOM_RELEASES_API}/latest`
    const response = await this.app.fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    if (!response.ok) {
      throw new Error(`Fail to get LoM Launcher release: HTTP ${response.status}`)
    }

    if (allowPrerelease) {
      const releases = await response.json() as GitHubRelease[]
      const release = selectHighestRelease(releases)
      if (!release) throw new Error('No LoM Launcher release found')
      return release
    }

    return await response.json() as GitHubRelease
  }

  async checkUpdateTask(): Promise<ReleaseInfo> {
    const release = await this.getLatestRelease()
    const files = release.assets.map((asset) => ({
      name: asset.name,
      url: asset.browser_download_url,
    }))
    const asarName = getAsarName(release.tag_name)
    const supportsAsarUpdate = this.app.env === 'raw' && files.some((file) => file.name === asarName)

    return {
      name: release.tag_name,
      body: release.body ?? '',
      date: release.published_at ?? '',
      files,
      newUpdate: compareLoMVersions(release.tag_name, this.app.version) > 0,
      operation: supportsAsarUpdate
        ? ElectronUpdateOperation.Asar
        : ElectronUpdateOperation.Manual,
    }
  }

  async downloadUpdate(updateInfo: ReleaseInfo, options?: DownloadUpdateOptions): Promise<void> {
    if (updateInfo.operation !== ElectronUpdateOperation.Asar) {
      if (updateInfo.operation === ElectronUpdateOperation.Manual) {
        await shell.openExternal(LOM_RELEASES_URL)
        return
      }
      await this.delegate.downloadUpdate(updateInfo, options)
      return
    }

    const asarName = getAsarName(updateInfo.name)
    const asar = updateInfo.files.find((file) => file.name === asarName)
    const sha256 = updateInfo.files.find((file) => file.name === `${asarName}.sha256`)
    if (!asar || !sha256) {
      throw new Error(`LoM update assets are incomplete for ${updateInfo.name}`)
    }

    options?.abortSignal?.throwIfAborted()
    const hashResponse = await this.app.fetch(sha256.url, { signal: options?.abortSignal })
    if (!hashResponse.ok) {
      throw new Error(`Fail to get LoM update checksum: HTTP ${hashResponse.status}`)
    }
    const expectedHash = (await hashResponse.text()).trim().split(/\s+/)[0].toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw new Error(`Invalid LoM update checksum for ${asarName}`)
    }

    const destination = join(this.app.appDataPath, 'pending_update')
    const currentHash = await checksum(destination, 'sha256').catch(() => '')
    if (currentHash.toLowerCase() === expectedHash) {
      return
    }

    const temporary = `${destination}.tmp`
    await unlink(temporary).catch(() => {})
    try {
      await download({
        url: asar.url,
        destination: temporary,
        tracker: onDownloadSingle(options?.tracker, 'download-update.asar', { url: asar.url }),
        signal: options?.abortSignal,
      })
      options?.abortSignal?.throwIfAborted()

      const actualHash = (await checksum(temporary, 'sha256')).toLowerCase()
      if (actualHash !== expectedHash) {
        throw new Error(`LoM update checksum mismatch for ${asarName}`)
      }

      await unlink(destination).catch(() => {})
      await rename(temporary, destination)
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }

  installUpdateAndQuit(updateInfo: ReleaseInfo): Promise<void> {
    return this.delegate.installUpdateAndQuit(updateInfo)
  }
}
