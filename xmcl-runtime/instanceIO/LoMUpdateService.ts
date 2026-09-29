import { createHash } from 'crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'fs-extra'
import { dirname, join, normalize, resolve } from 'path'
import { Inject, LauncherAppKey } from '~/app'
import { AbstractService } from '~/service'
import { LauncherApp } from '../app/LauncherApp'

type LoMManifestFile = {
  path: string
  sha1: string
  url?: string
}

type LoMManifest = {
  version: string
  files: LoMManifestFile[]
  delete?: string[]
}

export type LoMUpdateResult = {
  version: string
  changed: number
  deleted: number
}

const MANIFEST_URL = process.env.LOM_UPDATE_MANIFEST_URL || 'https://raw.githubusercontent.com/nondename/LoM-Launcher-XMCL/lom-updater-test-assets/lom-update/manifest.json'

function safePath(root: string, relative: string) {
  const normalized = normalize(relative).replace(/^([/\\])+/, '')
  const target = resolve(root, normalized)
  const base = resolve(root) + '\\'
  if (target !== resolve(root) && !target.toLowerCase().startsWith(base.toLowerCase())) {
    throw new Error(`Unsafe LoM update path: ${relative}`)
  }
  return target
}

function sha1(data: Buffer) {
  return createHash('sha1').update(data).digest('hex')
}

export class LoMUpdateService extends AbstractService {
  private running = new Map<string, Promise<LoMUpdateResult>>()

  constructor(@Inject(LauncherAppKey) app: LauncherApp) {
    super(app)
  }

  update(instancePath: string): Promise<LoMUpdateResult> {
    const current = this.running.get(instancePath)
    if (current) return current
    const task = this.doUpdate(instancePath).finally(() => this.running.delete(instancePath))
    this.running.set(instancePath, task)
    return task
  }

  private async doUpdate(instancePath: string): Promise<LoMUpdateResult> {
    this.log(`[LoM Updater] Fetch manifest: ${MANIFEST_URL}`)
    const manifestResponse = await this.app.fetch(MANIFEST_URL, { cache: 'no-store' })
    if (!manifestResponse.ok) throw new Error(`[LoM Updater] Manifest HTTP ${manifestResponse.status}: ${MANIFEST_URL}`)
    const manifest = await manifestResponse.json() as LoMManifest
    if (!manifest || typeof manifest.version !== 'string' || !Array.isArray(manifest.files)) {
      throw new Error('[LoM Updater] Invalid manifest')
    }

    let changed = 0
    let deleted = 0
    const manifestBase = new URL('.', MANIFEST_URL)

    for (const file of manifest.files) {
      if (!file?.path || !/^[a-f0-9]{40}$/i.test(file.sha1)) throw new Error(`[LoM Updater] Invalid file entry: ${JSON.stringify(file)}`)
      const destination = safePath(instancePath, file.path)
      let matches = false
      try {
        matches = sha1(await readFile(destination)) === file.sha1.toLowerCase()
      } catch { /* missing file */ }
      if (matches) continue

      const url = file.url ? new URL(file.url, manifestBase).toString() : new URL(file.path.replace(/\\/g, '/'), manifestBase).toString()
      this.log(`[LoM Updater] Download ${file.path} <- ${url}`)
      const response = await this.app.fetch(url, { cache: 'no-store' })
      if (!response.ok) throw new Error(`[LoM Updater] HTTP ${response.status} downloading ${file.path}: ${url}`)
      const data = Buffer.from(await response.arrayBuffer())
      const actual = sha1(data)
      if (actual !== file.sha1.toLowerCase()) throw new Error(`[LoM Updater] SHA-1 mismatch ${file.path}: expected=${file.sha1}, actual=${actual}`)

      await mkdir(dirname(destination), { recursive: true })
      const temp = `${destination}.lom-update`
      await writeFile(temp, data)
      await unlink(destination).catch(() => undefined)
      await rename(temp, destination)
      changed++
    }

    for (const relative of manifest.delete ?? []) {
      const target = safePath(instancePath, relative)
      try {
        await unlink(target)
        deleted++
        this.log(`[LoM Updater] Delete ${relative}`)
      } catch (e: any) {
        if (e?.code !== 'ENOENT') throw e
      }
    }

    const statePath = join(instancePath, '.lom-update.json')
    await writeFile(statePath, JSON.stringify({ version: manifest.version, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
    this.log(`[LoM Updater] Ready version=${manifest.version}, changed=${changed}, deleted=${deleted}`)
    return { version: manifest.version, changed, deleted }
  }
}
