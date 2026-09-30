import { InstallInstanceTask } from '@xmcl/runtime-api'
import { createHash } from 'crypto'
import { open } from 'fs/promises'
import { mkdir, readFile, rename, unlink, writeFile } from 'fs-extra'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'path'
import { Inject, LauncherAppKey } from '~/app'
import { kTasks, TaskInstance, Tasks } from '~/infra'
import { AbstractService } from '~/service'
import { LauncherApp } from '../app/LauncherApp'
import { LoMHashAlgorithm, LoMManifest, LoMManifestFile, normalizeLoMManifest } from './lomDistribution'

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

const MANIFEST_URL = process.env.LOM_UPDATE_MANIFEST_URL
  || 'https://raw.githubusercontent.com/nondename/Minecraft-Legends-of-Medieval/dev/distribution.json'
const MAX_DOWNLOAD_ATTEMPTS = 4
const RETRY_BASE_DELAY_MS = 750

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

function checksum(data: Buffer, algorithm: LoMHashAlgorithm) {
  return createHash(algorithm).update(data).digest('hex')
}

function abortError() {
  const error = new Error('LoM update cancelled')
  error.name = 'AbortError'
  return error
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError'
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

type DownloadError = Error & {
  status?: number
  retryAfterMs?: number
}

export class LoMUpdateService extends AbstractService {
  private running = new Map<string, Promise<LoMUpdateResult>>()
  private controllers = new Map<string, AbortController>()
  private progress: LoMUpdateProgress = {
    phase: 'idle', filesDone: 0, filesTotal: 0,
    bytesDone: 0, bytesTotal: 0, bytesPerSecond: 0,
  }

  constructor(
    @Inject(LauncherAppKey) app: LauncherApp,
    @Inject(kTasks) private tasks: Tasks,
  ) {
    super(app)
  }

  getProgress(): LoMUpdateProgress {
    return { ...this.progress }
  }

  private setProgress(patch: Partial<LoMUpdateProgress>) {
    Object.assign(this.progress, patch)
  }

  private async fetchManifest(signal?: AbortSignal): Promise<LoMManifest> {
    this.log(`[LoM Updater] Fetch manifest: ${MANIFEST_URL}`)
    const manifestResponse = await this.app.fetch(MANIFEST_URL, { cache: 'no-store', signal })
    if (!manifestResponse.ok) throw new Error(`[LoM Updater] Manifest HTTP ${manifestResponse.status}: ${MANIFEST_URL}`)
    const rawManifest = await manifestResponse.json() as unknown
    return normalizeLoMManifest(rawManifest, MANIFEST_URL)
  }

  async check(instancePath: string): Promise<LoMUpdateStatus> {
    const manifest = await this.fetchManifest()
    let installedVersion: string | undefined
    try {
      const state = JSON.parse(await readFile(join(instancePath, '.lom-update.json'), 'utf8')) as { version?: unknown }
      if (typeof state.version === 'string') installedVersion = state.version
    } catch {
      // No local LoM updater state yet. The first update will validate files and create it.
    }
    return {
      available: installedVersion !== manifest.version,
      remoteVersion: manifest.version,
      installedVersion,
    }
  }

  cancel(instancePath: string): boolean {
    const controller = this.controllers.get(instancePath)
    if (!controller || !['checking', 'downloading'].includes(this.progress.phase)) return false
    this.setProgress({ phase: 'cancelling', bytesPerSecond: 0 })
    controller.abort()
    this.log(`[LoM Updater] Cancellation requested: ${instancePath}`)
    return true
  }

  update(instancePath: string): Promise<LoMUpdateResult> {
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

    const task = nativeTask.wrap(this.doUpdate(instancePath, controller.signal, nativeTask))
      .catch((e) => {
        if (controller.signal.aborted || isAbortError(e)) {
          this.progress = {
            phase: 'idle', filesDone: 0, filesTotal: 0,
            bytesDone: 0, bytesTotal: 0, bytesPerSecond: 0,
          }
          this.log(`[LoM Updater] Cancelled: ${instancePath}`)
          throw e
        }
        const error = e instanceof Error ? e.message : String(e)
        this.setProgress({ phase: 'error', error, currentFile: undefined, bytesPerSecond: 0 })
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
      if (file.size && data.length !== file.size) return undefined
      if (checksum(data, file.hashAlgorithm) !== file.hash.toLowerCase()) return undefined
      return data.length
    } catch {
      return undefined
    }
  }

  private async downloadToTemp(
    response: Response,
    temp: string,
    file: LoMManifestFile,
    signal: AbortSignal,
    onProgress: (downloaded: number) => void,
  ) {
    await mkdir(dirname(temp), { recursive: true })
    await unlink(temp).catch(() => undefined)

    const handle = await open(temp, 'w')
    const hash = file.hash && file.hashAlgorithm ? createHash(file.hashAlgorithm) : undefined
    let downloaded = 0

    try {
      if (!response.body) {
        const data = Buffer.from(await response.arrayBuffer())
        if (signal.aborted) throw abortError()
        await handle.write(data)
        hash?.update(data)
        downloaded = data.length
        onProgress(downloaded)
      } else {
        const reader = response.body.getReader()
        try {
          while (true) {
            if (signal.aborted) throw abortError()
            const { done, value } = await reader.read()
            if (done) break
            if (!value?.byteLength) continue
            const chunk = Buffer.from(value)
            await handle.write(chunk)
            hash?.update(chunk)
            downloaded += chunk.length
            onProgress(downloaded)
          }
        } finally {
          reader.releaseLock()
        }
      }
      await handle.sync()
    } catch (e) {
      if (signal.aborted || isAbortError(e)) throw abortError()
      throw e
    } finally {
      await handle.close()
    }

    if (file.size && downloaded !== file.size) {
      throw new Error(`[LoM Updater] Size mismatch ${file.path}: expected=${file.size}, actual=${downloaded}`)
    }

    if (file.hash && file.hashAlgorithm) {
      const actual = hash!.digest('hex')
      if (actual !== file.hash.toLowerCase()) {
        throw new Error(`[LoM Updater] ${file.hashAlgorithm.toUpperCase()} mismatch ${file.path}: expected=${file.hash}, actual=${actual}`)
      }
    }

    return downloaded
  }

  private async doUpdate(
    instancePath: string,
    signal: AbortSignal,
    task: TaskInstance<InstallInstanceTask>,
  ): Promise<LoMUpdateResult> {
    this.progress = { phase: 'checking', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, bytesPerSecond: 0 }
    task.substate = { type: 'install-instance.resolve' }
    task.progress = { total: 0, progress: 0 }

    const manifest = await this.fetchManifest(signal)
    if (signal.aborted) throw abortError()

    const manifestBase = new URL('.', MANIFEST_URL)
    const pending: LoMManifestFile[] = []
    for (const file of manifest.files) {
      if (!file?.path) throw new Error(`[LoM Updater] Invalid file entry: ${JSON.stringify(file)}`)
      if (file.hash && !file.hashAlgorithm) throw new Error(`[LoM Updater] Missing hash algorithm: ${file.path}`)
      if (file.hashAlgorithm === 'sha1' && file.hash && !/^[a-f0-9]{40}$/i.test(file.hash)) {
        throw new Error(`[LoM Updater] Invalid SHA-1: ${file.path}`)
      }
      if (file.hashAlgorithm === 'md5' && file.hash && !/^[a-f0-9]{32}$/i.test(file.hash)) {
        throw new Error(`[LoM Updater] Invalid MD5: ${file.path}`)
      }

      // Files without a published checksum (currently only options.txt) are
      // refreshed whenever the pack version changes. All normal pack files
      // from distribution.json are checksum-validated before and after fetch.
      if (file.hash && file.hashAlgorithm) {
        try {
          if (checksum(await readFile(safePath(instancePath, file.path)), file.hashAlgorithm) === file.hash.toLowerCase()) continue
        } catch { /* missing */ }
      }
      pending.push(file)
    }

    const bytesTotal = pending.reduce((sum, file) => sum + (file.size || 0), 0)
    this.setProgress({
      phase: pending.length ? 'downloading' : 'installing',
      filesTotal: pending.length,
      bytesTotal,
    })

    let changed = 0
    let deleted = 0
    let completedBytes = 0
    const startedAt = Date.now()
    const staged: Array<{ destination: string, temp: string }> = []

    try {
      // Download and verify every file first. Nothing in the live instance is
      // replaced while cancellation is still available.
      for (let fileOffset = 0; fileOffset < pending.length; fileOffset++) {
        const file = pending[fileOffset]
        if (signal.aborted) throw abortError()
        const fileIndex = fileOffset + 1
        this.setProgress({ currentFile: file.path })
        const destination = safePath(instancePath, file.path)
        const temp = `${destination}.lom-update`
        const url = file.url ? new URL(file.url, manifestBase).toString() : new URL(file.path.replace(/\\/g, '/'), manifestBase).toString()

        const reusableBytes = await this.getReusableStagedBytes(temp, file)
        if (reusableBytes !== undefined) {
          staged.push({ destination, temp })
          changed++
          completedBytes += reusableBytes
          const seconds = Math.max((Date.now() - startedAt) / 1000, 0.001)
          const bytesPerSecond = Math.round(completedBytes / seconds)
          this.setProgress({ filesDone: changed, bytesDone: completedBytes, bytesPerSecond })
          this.setTaskDownloadState(task, fileIndex, pending.length, file.path, reusableBytes, file.size || reusableBytes, 1)
          task.progress = { url, total: bytesTotal, progress: completedBytes, speed: bytesPerSecond, acceptRanges: false }
          this.log(`[LoM Updater] Reuse staged ${fileIndex}/${pending.length} ${file.path}`)
          continue
        }
        await unlink(temp).catch(() => undefined)

        let downloaded = 0
        let completed = false
        for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
          if (signal.aborted) throw abortError()
          this.setTaskDownloadState(task, fileIndex, pending.length, file.path, 0, file.size || 0, attempt)
          this.log(`[LoM Updater] Download ${fileIndex}/${pending.length} attempt=${attempt}/${MAX_DOWNLOAD_ATTEMPTS} ${file.path} <- ${url}`)

          try {
            const response = await this.app.fetch(url, { cache: 'no-store', signal })
            if (!response.ok) {
              const error = new Error(`[LoM Updater] HTTP ${response.status} downloading ${file.path}: ${url}`) as DownloadError
              error.status = response.status
              const retryAfter = response.headers.get('retry-after')
              if (retryAfter) {
                const seconds = Number(retryAfter)
                if (Number.isFinite(seconds) && seconds >= 0) error.retryAfterMs = seconds * 1000
              }
              throw error
            }

            const acceptRanges = response.headers.get('accept-ranges') === 'bytes'
            downloaded = await this.downloadToTemp(response, temp, file, signal, (fileBytes) => {
              const bytesDone = completedBytes + fileBytes
              const seconds = Math.max((Date.now() - startedAt) / 1000, 0.001)
              const bytesPerSecond = Math.round(bytesDone / seconds)
              this.setProgress({ bytesDone, bytesPerSecond })
              this.setTaskDownloadState(task, fileIndex, pending.length, file.path, fileBytes, file.size || 0, attempt)
              task.progress = {
                url,
                total: bytesTotal,
                progress: bytesDone,
                speed: bytesPerSecond,
                acceptRanges,
              }
            })

            staged.push({ destination, temp })
            changed++
            completedBytes += downloaded
            const seconds = Math.max((Date.now() - startedAt) / 1000, 0.001)
            const bytesPerSecond = Math.round(completedBytes / seconds)
            this.setProgress({ filesDone: changed, bytesDone: completedBytes, bytesPerSecond })
            task.progress = {
              url,
              total: bytesTotal,
              progress: completedBytes,
              speed: bytesPerSecond,
              acceptRanges,
            }
            completed = true
            break
          } catch (e) {
            await unlink(temp).catch(() => undefined)
            if (signal.aborted || isAbortError(e)) throw abortError()

            const downloadError = e as DownloadError
            const retryable = attempt < MAX_DOWNLOAD_ATTEMPTS && isRetryableStatus(downloadError.status)
            const message = e instanceof Error ? e.message : String(e)
            this.warn(`[LoM Updater] Download failed ${fileIndex}/${pending.length} attempt=${attempt}/${MAX_DOWNLOAD_ATTEMPTS} retry=${retryable}: ${message}`)
            if (!retryable) throw e

            const fallbackDelay = RETRY_BASE_DELAY_MS * (2 ** (attempt - 1))
            const retryDelay = Math.min(downloadError.retryAfterMs ?? fallbackDelay, 15_000)
            this.setProgress({ bytesDone: completedBytes, bytesPerSecond: 0 })
            task.progress = {
              url,
              total: bytesTotal,
              progress: completedBytes,
              speed: 0,
              acceptRanges: false,
            }
            await waitForRetry(retryDelay, signal)
          }
        }

        if (!completed) {
          throw new Error(`[LoM Updater] Exhausted download attempts for ${file.path}`)
        }
      }

      if (signal.aborted) throw abortError()

      // Installation is intentionally non-cancellable. From this point onward
      // staged, hash-verified files are committed to the live instance.
      this.setProgress({ phase: 'installing', currentFile: undefined, bytesPerSecond: 0 })
      task.substate = { type: 'install-instance.link', count: staged.length }
      task.progress = { total: staged.length || 1, progress: 0 }
      let installed = 0
      for (const { destination, temp } of staged) {
        await unlink(destination).catch(() => undefined)
        await rename(temp, destination)
        installed++
        task.progress = { total: staged.length || 1, progress: installed }
      }

      for (const relativePath of manifest.delete ?? []) {
        const target = safePath(instancePath, relativePath)
        try {
          await unlink(target)
          deleted++
          this.log(`[LoM Updater] Delete ${relativePath}`)
        } catch (e: any) {
          if (e?.code !== 'ENOENT') throw e
        }
      }

      const statePath = join(instancePath, '.lom-update.json')
      await writeFile(statePath, JSON.stringify({ version: manifest.version, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
      this.setProgress({ phase: 'done', error: undefined, currentFile: undefined, bytesPerSecond: 0 })
      task.progress = { total: 1, progress: 1 }
      this.log(`[LoM Updater] Ready version=${manifest.version}, changed=${changed}, deleted=${deleted}`)
      return { version: manifest.version, changed, deleted }
    } catch (e) {
      // Keep fully downloaded, hash-verified staging files. A later retry can
      // resume from them instead of redownloading hundreds of already valid
      // pack files. Partial/current files are removed inside the retry loop.
      if (staged.length > 0) {
        this.log(`[LoM Updater] Keeping ${staged.length} verified staged files for retry/resume`)
      }
      throw e
    }
  }
}
