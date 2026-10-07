import { download, ProgressTrackerSingle, type DownloadBaseOptions } from '@xmcl/file-transfer'
import type { ManagedInstance } from '@xmcl/instance'
import { InstallInstanceTask } from '@xmcl/runtime-api'
import { mkdir, readFile, rename, unlink, writeFile } from 'fs-extra'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'path'
import { Inject, LauncherAppKey, kGameDataPath, type PathResolver } from '~/app'
import { kTasks, TaskInstance, Tasks } from '~/infra'
import { kDownloadOptions } from '~/network'
import { AbstractService } from '~/service'
import { VersionService } from '~/launch/VersionService'
import { VersionMetadataService } from '~/install/VersionMetadataService'
import { LauncherApp } from '../app/LauncherApp'
import { LoMManifest, LoMManifestFile, normalizeLoMManifest } from './lomDistribution'
import { isLoMTextFile, LoMIntegrityError, validateLoMFileBytes } from './lomFileIntegrity'
import type { ManagedInstanceUpdateProvider } from './ManagedInstanceUpdateProvider'

export type LoMUpdateResult = {
  version: string
  changed: number
  deleted: number
}

export type LoMUpdateStatus = {
  available: boolean
  remoteVersion: string
  installedVersion?: string
}

export type LoMUpdateProgress = {
  phase: 'idle' | 'checking' | 'downloading' | 'cancelling' | 'installing' | 'done' | 'error'
  filesDone: number
  filesTotal: number
  bytesDone: number
  bytesTotal: number
  bytesPerSecond: number
  currentFile?: string
  error?: string
}

export type ManagedUpdateIdentity = {
  provider: string
  profileId: string
}

type ManagedUpdateState = {
  provider?: string
  profileId?: string
  version?: string
  managedFiles?: string[]
  updatedAt?: string
}

const MANAGED_STATE_FILE = '.managed-update.json'
const LEGACY_STATE_FILE = '.lom-update.json'
const DEFAULT_LOM_MANIFEST_URL =
  'https://raw.githubusercontent.com/nondename/Minecraft-Legends-of-Medieval/dev/distribution.json'
const LOM_PROFILE_ID = 'legends-of-medieval'
const MAX_DOWNLOAD_ATTEMPTS = 4
const RETRY_BASE_DELAY_MS = 750
const DOWNLOAD_PROGRESS_INTERVAL_MS = 100

function safePath(root: string, filePath: string) {
  const normalized = normalize(filePath).replace(/^([/\\])+/, '')
  const base = resolve(root)
  const target = resolve(base, normalized)
  const fromBase = relative(base, target)
  if (fromBase === '..' || fromBase.startsWith(`..${sep}`) || isAbsolute(fromBase)) {
    throw new Error(`Unsafe LoM update path: ${filePath}`)
  }
  return target
}

function isUserOwnedSeedPath(filePath: string) {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\/+/, '').toLowerCase()
  return normalized === 'options.txt'
}

function abortError() {
  const error = new Error('LoM update cancelled')
  error.name = 'AbortError'
  return error
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError'
}

function getDownloadStatus(error: unknown): number | undefined {
  const seen = new Set<unknown>()
  let current: any = error
  for (let depth = 0; depth < 5 && current && !seen.has(current); depth++) {
    seen.add(current)
    for (const key of ['status', 'statusCode']) {
      const value = Number(current[key])
      if (Number.isInteger(value) && value >= 100 && value <= 599) return value
    }
    current = current.cause
  }
  return undefined
}

function isRetryableStatus(status: number | undefined) {
  return status === undefined || status === 403 || status === 408 || status === 425 || status === 429 || status >= 500
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = units[0]
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024
    unit = units[i]
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${unit}`
}

async function waitForRetry(ms: number, signal: AbortSignal) {
  if (signal.aborted) throw abortError()
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onAbort = () => {
      clearTimeout(timer)
      rejectPromise(abortError())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolvePromise()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export class LoMUpdateService extends AbstractService implements ManagedInstanceUpdateProvider {
  private running = new Map<string, Promise<LoMUpdateResult>>()
  private controllers = new Map<string, AbortController>()
  private progress = new Map<string, LoMUpdateProgress>()

  constructor(
    @Inject(LauncherAppKey) app: LauncherApp,
    @Inject(kTasks) private tasks: Tasks,
    @Inject(kDownloadOptions) private downloadOptions: DownloadBaseOptions,
    @Inject(kGameDataPath) private getPath: PathResolver,
  ) {
    super(app)
  }

  getProgress(instancePath: string): LoMUpdateProgress {
    return {
      phase: 'idle', filesDone: 0, filesTotal: 0,
      bytesDone: 0, bytesTotal: 0, bytesPerSecond: 0,
      ...(this.progress.get(instancePath) ?? {}),
    }
  }

  private setProgress(instancePath: string, patch: Partial<LoMUpdateProgress>) {
    this.progress.set(instancePath, { ...this.getProgress(instancePath), ...patch })
  }

  private resolveManifestUrl(managed: ManagedInstance) {
    if (managed.provider !== 'lom-distribution' || managed.profileId !== LOM_PROFILE_ID) {
      throw new Error(`Unsupported LoM managed profile: ${managed.provider}/${managed.profileId}`)
    }

    // Never trust an arbitrary URL persisted in instance.json for shared
    // runtime writes. The provider/profile identity selects a launcher-owned
    // source. The environment override is retained for explicit dev/test use.
    return process.env.LOM_UPDATE_MANIFEST_URL || DEFAULT_LOM_MANIFEST_URL
  }

  private async ensureInheritedMinecraftMetadata(runtimeVersion: string) {
    const runtimeJsonPath = this.getPath('versions', runtimeVersion, `${runtimeVersion}.json`)
    const runtimeJson = JSON.parse(await readFile(runtimeJsonPath, 'utf8')) as { inheritsFrom?: unknown }
    const parentVersion = typeof runtimeJson.inheritsFrom === 'string' ? runtimeJson.inheritsFrom : ''
    if (!parentVersion) return

    const parentJsonPath = this.getPath('versions', parentVersion, `${parentVersion}.json`)
    try {
      const current = JSON.parse(await readFile(parentJsonPath, 'utf8')) as { id?: unknown }
      if (current.id === parentVersion) return
    } catch {
      // Missing/corrupt parent metadata: restore it from Mojang metadata below.
    }

    const metadataService = await this.app.registry.getOrCreate(VersionMetadataService)
    const versions = await metadataService.getMinecraftVersions()
    const parent = versions.versions.find((version) => version.id === parentVersion)
    if (!parent?.url) {
      throw new Error(`[LoM Updater] Cannot resolve inherited Minecraft metadata: ${parentVersion}`)
    }

    const response = await this.app.fetch(parent.url, { cache: 'no-store' })
    if (!response.ok) {
      throw new Error(`[LoM Updater] Minecraft metadata HTTP ${response.status}: ${parent.url}`)
    }
    const data = Buffer.from(await response.arrayBuffer())
    const parsed = JSON.parse(data.toString('utf8')) as { id?: unknown }
    if (parsed.id !== parentVersion) {
      throw new Error(`[LoM Updater] Unexpected Minecraft metadata id: ${String(parsed.id)}`)
    }

    const temp = `${parentJsonPath}.lom-update`
    await mkdir(dirname(parentJsonPath), { recursive: true })
    await writeFile(temp, data)
    await unlink(parentJsonPath).catch(() => undefined)
    await rename(temp, parentJsonPath)
    this.log(`[LoM Updater] Installed inherited Minecraft metadata ${parentVersion}`)
  }

  private async fetchManifest(manifestUrl: string, signal?: AbortSignal): Promise<LoMManifest> {
    this.log(`[LoM Updater] Fetch manifest: ${manifestUrl}`)
    const manifestResponse = await this.app.fetch(manifestUrl, { cache: 'no-store', signal })
    if (!manifestResponse.ok) throw new Error(`[LoM Updater] Manifest HTTP ${manifestResponse.status}: ${manifestUrl}`)
    const rawManifest = await manifestResponse.json() as unknown
    return normalizeLoMManifest(rawManifest, manifestUrl)
  }

  private async readUpdateState(instancePath: string, identity: ManagedUpdateIdentity): Promise<ManagedUpdateState> {
    try {
      const state = JSON.parse(await readFile(join(instancePath, MANAGED_STATE_FILE), 'utf8')) as ManagedUpdateState
      if (state.provider !== identity.provider || state.profileId !== identity.profileId) return {}
      return state
    } catch {
      // Migrate the version marker written by pre-managed LoM Launcher builds.
      if (identity.provider === 'lom-distribution') {
        try {
          const legacy = JSON.parse(await readFile(join(instancePath, LEGACY_STATE_FILE), 'utf8')) as ManagedUpdateState
          return typeof legacy.version === 'string' ? { version: legacy.version } : {}
        } catch {
          // First managed update.
        }
      }
      return {}
    }
  }

  async check(instancePath: string, managed: ManagedInstance): Promise<LoMUpdateStatus> {
    const manifestUrl = this.resolveManifestUrl(managed)
    const manifest = await this.fetchManifest(manifestUrl)
    const state = await this.readUpdateState(instancePath, { provider: managed.provider, profileId: managed.profileId })
    const installedVersion = typeof state.version === 'string' ? state.version : undefined
    const initializedManagedState =
      state.provider === managed.provider &&
      state.profileId === managed.profileId &&
      Array.isArray(state.managedFiles)
    return {
      // A profile migrated from the legacy LoM updater must run once even when
      // the pack revision itself did not change. That first managed pass writes
      // ownership state and installs the provider-owned Forge runtime cache.
      available: installedVersion !== manifest.version || !initializedManagedState,
      remoteVersion: manifest.version,
      installedVersion,
    }
  }

  cancel(instancePath: string): boolean {
    const controller = this.controllers.get(instancePath)
    const currentProgress = this.getProgress(instancePath)
    if (!controller || !['checking', 'downloading'].includes(currentProgress.phase)) return false
    this.setProgress(instancePath, { phase: 'cancelling', bytesPerSecond: 0 })
    controller.abort()
    this.log(`[LoM Updater] Cancellation requested: ${instancePath}`)
    return true
  }

  update(instancePath: string, managed: ManagedInstance): Promise<LoMUpdateResult> {
    const current = this.running.get(instancePath)
    if (current) return current

    const nativeTask = this.tasks.create<InstallInstanceTask>({
      type: 'installInstance',
      key: `lom-update-${instancePath}`,
      instancePath,
      taskId: 'lom-update',
    })
    const controller = nativeTask.controller
    this.controllers.set(instancePath, controller)

    const task = nativeTask.wrap(this.doUpdate(instancePath, managed, controller.signal, nativeTask))
      .catch((e) => {
        if (controller.signal.aborted || isAbortError(e)) {
          this.progress.delete(instancePath)
          this.log(`[LoM Updater] Cancelled: ${instancePath}`)
          throw e
        }
        const error = e instanceof Error ? e.message : String(e)
        this.setProgress(instancePath, { phase: 'error', error, currentFile: undefined, bytesPerSecond: 0 })
        throw e
      })
      .finally(() => {
        this.running.delete(instancePath)
        this.controllers.delete(instancePath)
      })
    this.running.set(instancePath, task)
    return task
  }

  private setTaskDownloadState(
    task: TaskInstance<InstallInstanceTask>,
    fileIndex: number,
    fileTotal: number,
    filePath: string,
    fileBytes: number,
    fileSize: number,
    attempt: number,
  ) {
    const retry = attempt > 1 ? ` · retry ${attempt}/${MAX_DOWNLOAD_ATTEMPTS}` : ''
    const size = fileSize > 0 ? ` · ${formatBytes(fileBytes)}/${formatBytes(fileSize)}` : ` · ${formatBytes(fileBytes)}`
    task.substate = {
      type: 'install-instance.download',
      count: `${fileIndex}/${fileTotal} · ${filePath}${size}${retry}`,
    } as any
  }

  private async getReusableStagedBytes(temp: string, file: LoMManifestFile) {
    if (!file.hash || !file.hashAlgorithm) return undefined
    try {
      const data = await readFile(temp)
      const validation = validateLoMFileBytes(data, file)
      if (!validation.valid) return undefined
      if (validation.eolCompatible) {
        this.log(`[LoM Updater] Reuse LF text compatible with CRLF manifest: ${file.path}`)
      }
      return data.length
    } catch {
      return undefined
    }
  }

  private async downloadToTemp(
    url: string,
    temp: string,
    file: LoMManifestFile,
    signal: AbortSignal,
    onProgress: (downloaded: number, total: number, activeUrl: string) => void,
  ) {
    await mkdir(dirname(temp), { recursive: true })
    await unlink(temp).catch(() => undefined)

    const tracker = new ProgressTrackerSingle()
    const report = () => {
      const downloaded = tracker.progress
      const total = tracker.total || file.size || downloaded
      onProgress(downloaded, total, tracker.url || url)
    }
    const timer = setInterval(report, DOWNLOAD_PROGRESS_INTERVAL_MS)
    timer.unref?.()

    try {
      await download({
        ...this.downloadOptions,
        url,
        destination: temp,
        signal,
        tracker,
        // Text files can have a Windows CRLF size in distribution.json while
        // raw.githubusercontent.com serves the canonical LF Git blob. Let the
        // HTTP response define their actual transfer size.
        expectedTotal: !isLoMTextFile(file.path) && file.size ? file.size : undefined,
      })
      report()
      if (signal.aborted) throw abortError()

      const data = await readFile(temp)
      const validation = validateLoMFileBytes(data, file)
      if (!validation.valid) throw new LoMIntegrityError(file, validation)
      if (validation.eolCompatible) {
        this.log(`[LoM Updater] Accepted LF Git blob for CRLF manifest entry: ${file.path} (${data.length}/${file.size || data.length} bytes)`)
      }
      return data.length
    } catch (e) {
      if (signal.aborted || isAbortError(e)) throw abortError()
      throw e
    } finally {
      clearInterval(timer)
    }
  }

  private async doUpdate(
    instancePath: string,
    managed: ManagedInstance,
    signal: AbortSignal,
    task: TaskInstance<InstallInstanceTask>,
  ): Promise<LoMUpdateResult> {
    this.progress.set(instancePath, { phase: 'checking', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, bytesPerSecond: 0 })
    task.substate = { type: 'install-instance.resolve' }
    task.progress = { total: 0, progress: 0 }

    const manifestUrl = this.resolveManifestUrl(managed)
    const identity: ManagedUpdateIdentity = { provider: managed.provider, profileId: managed.profileId }
    const manifest = await this.fetchManifest(manifestUrl, signal)
    if (signal.aborted) throw abortError()

    const previousState = await this.readUpdateState(instancePath, identity)
    const manifestBase = new URL('.', manifestUrl)
    const gameDataRoot = this.getPath()
    const pending: Array<{
      file: LoMManifestFile
      root: string
      scope: 'instance' | 'runtime'
    }> = []

    const enqueueIfNeeded = async (
      file: LoMManifestFile,
      root: string,
      scope: 'instance' | 'runtime',
    ) => {
      if (!file?.path) throw new Error(`[LoM Updater] Invalid file entry: ${JSON.stringify(file)}`)
      if (file.hash && !file.hashAlgorithm) throw new Error(`[LoM Updater] Missing hash algorithm: ${file.path}`)
      if (file.hashAlgorithm === 'sha1' && file.hash && !/^[a-f0-9]{40}$/i.test(file.hash)) {
        throw new Error(`[LoM Updater] Invalid SHA-1: ${file.path}`)
      }
      if (file.hashAlgorithm === 'md5' && file.hash && !/^[a-f0-9]{32}$/i.test(file.hash)) {
        throw new Error(`[LoM Updater] Invalid MD5: ${file.path}`)
      }

      // Seed files belong to the player after their first installation.
      if (scope === 'instance' && isUserOwnedSeedPath(file.path)) {
        try {
          await readFile(safePath(root, file.path))
          this.log(`[LoM Updater] Preserve user-owned file: ${file.path}`)
          return
        } catch { /* missing: seed it below */ }
      }

      if (file.hash && file.hashAlgorithm) {
        try {
          const data = await readFile(safePath(root, file.path))
          if (validateLoMFileBytes(data, file).valid) return
        } catch { /* missing or invalid */ }
      }

      pending.push({ file, root, scope })
    }

    for (const file of manifest.files) {
      await enqueueIfNeeded(file, instancePath, 'instance')
    }
    for (const file of manifest.runtimeFiles ?? []) {
      await enqueueIfNeeded(file, gameDataRoot, 'runtime')
    }

    const bytesTotal = pending.reduce((sum, entry) => sum + (entry.file.size || 0), 0)
    this.setProgress(instancePath, {
      phase: pending.length ? 'downloading' : 'installing',
      filesTotal: pending.length,
      bytesTotal,
    })

    let changed = 0
    let deleted = 0
    let completedBytes = 0
    let effectiveBytesTotal = bytesTotal
    const startedAt = Date.now()
    const staged: Array<{
      destination: string
      temp: string
      scope: 'instance' | 'runtime'
      path: string
    }> = []

    try {
      // Stage and verify both instance-owned and shared runtime artifacts before
      // replacing any live file. Runtime artifacts are written to XMCL's
      // shared libraries/versions root, never into the instance directory.
      for (let fileOffset = 0; fileOffset < pending.length; fileOffset++) {
        const { file, root, scope } = pending[fileOffset]
        if (signal.aborted) throw abortError()
        const fileIndex = fileOffset + 1
        const displayPath = scope === 'runtime' ? `runtime:${file.path}` : file.path
        this.setProgress(instancePath, { currentFile: displayPath })
        const destination = safePath(root, file.path)
        const temp = `${destination}.lom-update`
        const url = file.url
          ? new URL(file.url, manifestBase).toString()
          : new URL(file.path.replace(/\\/g, '/'), manifestBase).toString()

        const reusableBytes = await this.getReusableStagedBytes(temp, file)
        if (reusableBytes !== undefined) {
          staged.push({ destination, temp, scope, path: file.path })
          changed++
          completedBytes += reusableBytes
          effectiveBytesTotal += reusableBytes - (file.size || reusableBytes)
          const seconds = Math.max((Date.now() - startedAt) / 1000, 0.001)
          const bytesPerSecond = Math.round(completedBytes / seconds)
          this.setProgress(instancePath, { filesDone: changed, bytesDone: completedBytes, bytesTotal: effectiveBytesTotal, bytesPerSecond })
          this.setTaskDownloadState(task, fileIndex, pending.length, displayPath, reusableBytes, reusableBytes, 1)
          task.progress = { url, total: effectiveBytesTotal || completedBytes || 1, progress: completedBytes, speed: bytesPerSecond, acceptRanges: false }
          this.log(`[LoM Updater] Reuse staged ${fileIndex}/${pending.length} ${displayPath}`)
          continue
        }
        await unlink(temp).catch(() => undefined)

        let downloaded = 0
        let completed = false
        for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
          if (signal.aborted) throw abortError()
          this.setTaskDownloadState(task, fileIndex, pending.length, displayPath, 0, file.size || 0, attempt)
          this.log(`[LoM Updater] Download ${fileIndex}/${pending.length} attempt=${attempt}/${MAX_DOWNLOAD_ATTEMPTS} ${displayPath} <- ${url}`)

          try {
            downloaded = await this.downloadToTemp(url, temp, file, signal, (fileBytes, fileTotal, activeUrl) => {
              const bytesDone = completedBytes + fileBytes
              const seconds = Math.max((Date.now() - startedAt) / 1000, 0.001)
              const bytesPerSecond = Math.round(bytesDone / seconds)
              this.setProgress(instancePath, { bytesDone, bytesPerSecond })
              this.setTaskDownloadState(task, fileIndex, pending.length, displayPath, fileBytes, fileTotal || file.size || 0, attempt)
              task.progress = {
                url: activeUrl || url,
                total: effectiveBytesTotal || bytesDone || 1,
                progress: bytesDone,
                speed: bytesPerSecond,
                acceptRanges: false,
              }
            })

            staged.push({ destination, temp, scope, path: file.path })
            changed++
            completedBytes += downloaded
            effectiveBytesTotal += downloaded - (file.size || downloaded)
            const seconds = Math.max((Date.now() - startedAt) / 1000, 0.001)
            const bytesPerSecond = Math.round(completedBytes / seconds)
            this.setProgress(instancePath, { filesDone: changed, bytesDone: completedBytes, bytesTotal: effectiveBytesTotal, bytesPerSecond })
            task.progress = {
              url,
              total: effectiveBytesTotal || completedBytes || 1,
              progress: completedBytes,
              speed: bytesPerSecond,
              acceptRanges: false,
            }
            completed = true
            break
          } catch (e) {
            await unlink(temp).catch(() => undefined)
            if (signal.aborted || isAbortError(e)) throw abortError()

            const status = getDownloadStatus(e)
            const retryable = !(e instanceof LoMIntegrityError)
              && attempt < MAX_DOWNLOAD_ATTEMPTS
              && isRetryableStatus(status)
            const message = e instanceof Error ? e.message : String(e)
            this.warn(`[LoM Updater] Download failed ${fileIndex}/${pending.length} attempt=${attempt}/${MAX_DOWNLOAD_ATTEMPTS} status=${status ?? 'network'} retry=${retryable}: ${message}`)
            if (!retryable) throw e

            const retryDelay = Math.min(RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)), 15_000)
            this.setProgress(instancePath, { bytesDone: completedBytes, bytesPerSecond: 0 })
            task.progress = {
              url,
              total: effectiveBytesTotal || completedBytes || 1,
              progress: completedBytes,
              speed: 0,
              acceptRanges: false,
            }
            await waitForRetry(retryDelay, signal)
          }
        }

        if (!completed) {
          throw new Error(`[LoM Updater] Exhausted download attempts for ${displayPath}`)
        }
      }

      if (signal.aborted) throw abortError()

      // Installation is intentionally non-cancellable. From this point onward
      // all staged files are hash-verified. Shared runtime cache entries are
      // only replaced; they are never removed as part of pack cleanup.
      this.setProgress(instancePath, { phase: 'installing', currentFile: undefined, bytesPerSecond: 0 })
      task.substate = { type: 'install-instance.link', count: staged.length }
      task.progress = { total: staged.length || 1, progress: 0 }
      let installed = 0
      for (const { destination, temp } of staged) {
        await unlink(destination).catch(() => undefined)
        await rename(temp, destination)
        installed++
        task.progress = { total: staged.length || 1, progress: installed }
      }

      // Remove only files that this managed instance previously owned.
      // Runtime files are shared XMCL cache and deliberately never deleted.
      const nextManagedFiles = manifest.files
        .map((file) => file.path)
        .filter((filePath) => !isUserOwnedSeedPath(filePath))
      const nextManagedSet = new Set(nextManagedFiles)
      const staleManagedFiles = (previousState.managedFiles ?? [])
        .filter((filePath) => !nextManagedSet.has(filePath))
      const deletePaths = new Set([...(manifest.delete ?? []), ...staleManagedFiles])

      for (const relativePath of deletePaths) {
        if (isUserOwnedSeedPath(relativePath)) {
          this.log(`[LoM Updater] Preserve user-owned delete target: ${relativePath}`)
          continue
        }
        const target = safePath(instancePath, relativePath)
        try {
          await unlink(target)
          deleted++
          this.log(`[LoM Updater] Delete managed file ${relativePath}`)
        } catch (e: any) {
          if (e?.code !== 'ENOENT') throw e
        }
      }

      const statePath = join(instancePath, MANAGED_STATE_FILE)
      await writeFile(statePath, JSON.stringify({
        provider: identity.provider,
        profileId: identity.profileId,
        version: manifest.version,
        managedFiles: nextManagedFiles,
        updatedAt: new Date().toISOString(),
      }, null, 2), 'utf8')

      if (manifest.runtimeVersion) {
        // Forge's version profile inherits the vanilla Minecraft profile. On a
        // completely fresh launcher the parent JSON does not exist yet, which
        // would make VersionService reject our mirrored Forge profile and send
        // the native installer back to Forge Maven. Seed only that tiny Mojang
        // metadata JSON here; client.jar/assets/vanilla libraries remain on the
        // normal XMCL/Mojang installation path.
        await this.ensureInheritedMinecraftMetadata(manifest.runtimeVersion)
        const versionService = await this.app.registry.getOrCreate(VersionService)
        await versionService.refreshVersion(manifest.runtimeVersion)
      }

      this.setProgress(instancePath, { phase: 'done', error: undefined, currentFile: undefined, bytesPerSecond: 0 })
      task.progress = { total: 1, progress: 1 }
      this.log(`[LoM Updater] Ready version=${manifest.version}, changed=${changed}, deleted=${deleted}, runtime=${manifest.runtimeFiles?.length ?? 0}`)
      return { version: manifest.version, changed, deleted }
    } catch (e) {
      // Keep fully downloaded, hash-verified staging files. A later retry can
      // resume them instead of redownloading hundreds of valid pack/runtime
      // files. Partial/current files are removed inside the retry loop.
      if (staged.length > 0) {
        this.log(`[LoM Updater] Keeping ${staged.length} verified staged files for retry/resume`)
      }
      throw e
    }
  }

}
