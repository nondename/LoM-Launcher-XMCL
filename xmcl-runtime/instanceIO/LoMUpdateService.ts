import { createHash } from 'crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'fs-extra'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'path'
import { Inject, LauncherAppKey } from '~/app'
import { AbstractService } from '~/service'
import { LauncherApp } from '../app/LauncherApp'
import { getLoMDownloadUrls, LoMHashAlgorithm, LoMManifest, LoMManifestFile, normalizeLoMManifest } from './lomDistribution'

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

export class LoMUpdateService extends AbstractService {
  private running = new Map<string, Promise<LoMUpdateResult>>()
  private controllers = new Map<string, AbortController>()
  private progress: LoMUpdateProgress = {
    phase: 'idle', filesDone: 0, filesTotal: 0,
    bytesDone: 0, bytesTotal: 0, bytesPerSecond: 0,
  }

  constructor(@Inject(LauncherAppKey) app: LauncherApp) {
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
    if (!controller || this.progress.phase !== 'downloading') return false
    this.setProgress({ phase: 'cancelling', bytesPerSecond: 0 })
    controller.abort()
    this.log(`[LoM Updater] Cancellation requested: ${instancePath}`)
    return true
  }

  update(instancePath: string): Promise<LoMUpdateResult> {
    const current = this.running.get(instancePath)
    if (current) return current

    const controller = new AbortController()
    this.controllers.set(instancePath, controller)
    const task = this.doUpdate(instancePath, controller.signal)
      .catch((e) => {
        if (controller.signal.aborted) {
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

  private async doUpdate(instancePath: string, signal: AbortSignal): Promise<LoMUpdateResult> {
    this.progress = { phase: 'checking', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, bytesPerSecond: 0 }
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

    this.setProgress({
      phase: pending.length ? 'downloading' : 'installing',
      filesTotal: pending.length,
      bytesTotal: pending.reduce((sum, file) => sum + (file.size || 0), 0),
    })

    let changed = 0
    let deleted = 0
    const startedAt = Date.now()
    const staged: Array<{ destination: string, temp: string }> = []

    try {
      // Download and verify every file first. Nothing in the live instance is
      // replaced while cancellation is still available.
      for (const file of pending) {
        if (signal.aborted) throw abortError()
        this.setProgress({ currentFile: file.path })
        const destination = safePath(instancePath, file.path)
        const temp = `${destination}.lom-update`
        const sourceUrl = file.url
          ? new URL(file.url, manifestBase).toString()
          : new URL(file.path.replace(/\\/g, '/'), manifestBase).toString()
        const candidates = getLoMDownloadUrls(sourceUrl)

        let data: Buffer | undefined
        let lastError = `[LoM Updater] Failed downloading ${file.path}: ${sourceUrl}`
        for (let index = 0; index < candidates.length; index++) {
          const url = candidates[index]
          this.log(`[LoM Updater] Download ${file.path} <- ${url}`)
          const response = await this.app.fetch(url, { cache: 'no-store', signal })
          if (response.ok) {
            data = Buffer.from(await response.arrayBuffer())
            break
          }

          lastError = `[LoM Updater] HTTP ${response.status} downloading ${file.path}: ${url}`
          const canRetryLiteralPercent = response.status === 404 && index + 1 < candidates.length
          if (!canRetryLiteralPercent) throw new Error(lastError)
          this.log(`[LoM Updater] Raw URL returned 404; retry literal-percent filename: ${candidates[index + 1]}`)
        }

        if (!data) throw new Error(lastError)
        if (signal.aborted) throw abortError()

        if (file.hash && file.hashAlgorithm) {
          const actual = checksum(data, file.hashAlgorithm)
          if (actual !== file.hash.toLowerCase()) {
            throw new Error(`[LoM Updater] ${file.hashAlgorithm.toUpperCase()} mismatch ${file.path}: expected=${file.hash}, actual=${actual}`)
          }
        }

        await mkdir(dirname(destination), { recursive: true })
        await unlink(temp).catch(() => undefined)
        await writeFile(temp, data)
        staged.push({ destination, temp })
        changed++
        const bytesDone = this.progress.bytesDone + data.length
        const seconds = Math.max((Date.now() - startedAt) / 1000, 0.001)
        this.setProgress({ filesDone: changed, bytesDone, bytesPerSecond: Math.round(bytesDone / seconds) })
      }

      if (signal.aborted) throw abortError()

      // Installation is intentionally non-cancellable. From this point onward
      // staged, hash-verified files are committed to the live instance.
      this.setProgress({ phase: 'installing', currentFile: undefined, bytesPerSecond: 0 })
      for (const { destination, temp } of staged) {
        await unlink(destination).catch(() => undefined)
        await rename(temp, destination)
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
      this.log(`[LoM Updater] Ready version=${manifest.version}, changed=${changed}, deleted=${deleted}`)
      return { version: manifest.version, changed, deleted }
    } catch (e) {
      // Remove only staging files. Existing live files stay untouched when a
      // download is cancelled or fails before the installation phase.
      await Promise.all(staged.map(({ temp }) => unlink(temp).catch(() => undefined)))
      throw e
    }
  }
}
