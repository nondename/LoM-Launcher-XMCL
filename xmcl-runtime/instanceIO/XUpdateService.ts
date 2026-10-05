import { checksum } from '@xmcl/core'
import type { InstanceFile } from '@xmcl/instance'
import { InstanceIOException, XUpdateServiceKey, type XUpdateService as IXUpdateService, type InstanceManifest, type InstanceUpdate, type SetInstanceManifestOptions, type LoMUpdateProgress, type LoMUpdateResult, type LoMUpdateStatus } from '@xmcl/runtime-api'
import { randomUUID } from 'crypto'
import { createReadStream } from 'fs'
import { mkdir, rename, unlink, writeFile } from 'fs-extra'
import { dirname, join } from 'path'
import { Readable } from 'stream'
import { Inject, LauncherAppKey, kTempDataPath } from '~/app'
import { InstanceService } from '~/instance'
import { AbstractService, ExposeServiceKey, Singleton } from '~/service'
import { UserService } from '~/user'
import { LauncherApp } from '../app/LauncherApp'
import { missing } from '../util/fs'
import { isValidUrl } from '../util/url'
import { writeZipFile } from '../util/zip'
import { ZipFile } from 'yazl'
import { LoMUpdateService } from './LoMUpdateService'

const LOM_PROFILE_NAME = 'Legends of Medieval'
const LOM_MINECRAFT_VERSION = '1.20.1'
const LOM_FORGE_VERSION = '47.4.22'

function joinFileApiUrl(base: string, relativePath: string): string {
  const normalizedBase = base.endsWith('/') ? base : `${base}/`
  const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  return new URL(normalizedPath, normalizedBase).toString()
}

@ExposeServiceKey(XUpdateServiceKey)
export class XUpdateService extends AbstractService implements IXUpdateService {
  constructor(@Inject(LauncherAppKey) app: LauncherApp,
    @Inject(InstanceService) private instanceService: InstanceService,
    @Inject(UserService) private userService: UserService,
  ) { super(app) }

  private async getAccessToken(userId: string): Promise<string> { throw new Error('Unimplemented') }

  private async getLoMUpdater(): Promise<LoMUpdateService> {
    return this.app.registry.getOrCreate(LoMUpdateService)
  }

  private assertLoMInstance(path: string) {
    const instance = this.instanceService.state.all[path]
    const isLoM = !!instance &&
      instance.edition !== 'bedrock' &&
      instance.name === LOM_PROFILE_NAME &&
      instance.runtime.minecraft === LOM_MINECRAFT_VERSION &&
      instance.runtime.forge === LOM_FORGE_VERSION

    if (!isLoM) {
      this.warn(`[LoM Updater] Rejected unrelated instance: ${path}`)
      throw new Error(`LoM updater cannot operate on unrelated instance: ${path}`)
    }
  }

  async checkLoMUpdate(path: string): Promise<LoMUpdateStatus> {
    this.assertLoMInstance(path)
    return (await this.getLoMUpdater()).check(path)
  }

  async applyLoMUpdate(path: string): Promise<LoMUpdateResult> {
    this.assertLoMInstance(path)
    return (await this.getLoMUpdater()).update(path)
  }

  async cancelLoMUpdate(path: string): Promise<boolean> {
    this.assertLoMInstance(path)
    return (await this.getLoMUpdater()).cancel(path)
  }

  async getLoMUpdateProgress(): Promise<LoMUpdateProgress> {
    return (await this.getLoMUpdater()).getProgress()
  }

  @Singleton((o) => o.path)
  async uploadInstanceManifest({ path, manifest, headers, includeFileWithDownloads, forceJsonFormat }: SetInstanceManifestOptions): Promise<void> {
    const instancePath = path
    const instance = this.instanceService.state.all[instancePath]
    if (!instance) throw new InstanceIOException({ instancePath, type: 'instanceNotFound' })
    if (!instance.fileApi) throw new InstanceIOException({ instancePath, type: 'instanceHasNoFileApi' })
    const url = isValidUrl(instance.fileApi)
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https')) throw new InstanceIOException({ instancePath, type: 'instanceInvalidFileApi', url: instance.fileApi })
    const getTemp = await this.app.registry.get(kTempDataPath)
    const tempZipFile = getTemp(randomUUID())
    const useJson = forceJsonFormat || manifest.files.every(f => f.modrinth || f.curseforge || (f.downloads && f.downloads.length > 0))
    if (!useJson) {
      const zipFile = new ZipFile()
      for (const file of manifest.files) {
        const realPath = join(instancePath, file.path)
        const canBeDownload = file.modrinth || file.curseforge || (file.downloads && file.downloads.length > 0)
        if (includeFileWithDownloads || !canBeDownload) zipFile.addFile(realPath, file.path)
      }
      zipFile.addBuffer(Buffer.from(JSON.stringify(manifest), 'utf-8'), 'manifest.json')
      await writeZipFile(zipFile, tempZipFile)
    }
    try {
      const allHeaders = headers ? { ...headers } : {}
      if (!allHeaders.Authorization) {
        const token = this.getAccessToken('')
        allHeaders.Authorization = `Bearer ${token}`
      }
      allHeaders['content-type'] = useJson ? 'application/json' : 'application/zip'
      const res = await this.app.fetch(instance.fileApi, { method: 'POST', headers: allHeaders, body: useJson ? JSON.stringify(manifest) : Readable.toWeb(createReadStream(tempZipFile)) as any })
      if (res.status !== 201) throw new InstanceIOException({ type: 'instanceSetManifestFailed', httpBody: res.body, statusCode: res.status })
      if (res.body) for await (const _ of Readable.from(res.body as any)) { /* drain */ }
    } finally { await unlink(tempZipFile).catch(() => undefined) }
  }

  @Singleton(p => p)
  async fetchInstanceUpdate(path: string): Promise<InstanceUpdate | undefined> {
    const instancePath = path
    const instance = this.instanceService.state.all[instancePath]
    if (!instance) throw new InstanceIOException({ instancePath, type: 'instanceNotFound' })
    if (!instance.fileApi) return undefined
    const url = isValidUrl(instance.fileApi)
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https')) throw new InstanceIOException({ instancePath, type: 'instanceInvalidFileApi', url: instance.fileApi })
    const manifestUrl = joinFileApiUrl(instance.fileApi, 'manifest.json')
    let manifest: InstanceManifest
    try {
      const response = await this.app.fetch(manifestUrl)
      if (!response.ok) throw Object.assign(new Error(`Failed to fetch instance manifest: ${response.status}`), { response })
      manifest = await response.json() as any
    } catch (e) {
      if (e instanceof Error) this.error(e)
      throw new InstanceIOException({ type: 'instanceNotFoundInApi', url: manifestUrl, statusCode: (e as any)?.response?.status ?? (e as any)?.response?.statusCode })
    }
    const updates: InstanceUpdate['updates'] = []
    for (const file of manifest.files ?? []) {
      const filePath = join(instancePath, file.path)
      if (await missing(filePath)) updates.push({ file, operation: 'add' })
      else if (await checksum(filePath, 'sha1') !== file.hashes.sha1) updates.push({ file, operation: 'update' })
      const fileApiUrl = joinFileApiUrl(instance.fileApi, file.path)
      if (file.downloads) { if (!file.downloads.includes(fileApiUrl)) file.downloads.push(fileApiUrl) }
      else file.downloads = [fileApiUrl]
    }
    return { updates, manifest }
  }

  @Singleton(p => p)
  async applyInstanceUpdate(path: string): Promise<InstanceUpdate | undefined> {
    const update = await this.fetchInstanceUpdate(path)
    if (!update || update.updates.length === 0) return update
    for (const { file } of update.updates) {
      const destination = join(path, file.path)
      const temp = `${destination}.lom-update`
      await mkdir(dirname(destination), { recursive: true })
      let lastError: unknown
      for (const download of file.downloads ?? []) {
        try {
          const response = await this.app.fetch(download)
          if (!response.ok) throw new Error(`HTTP ${response.status} while downloading ${download}`)
          const bytes = Buffer.from(await response.arrayBuffer())
          await writeFile(temp, bytes)
          const actual = await checksum(temp, 'sha1')
          if (actual !== file.hashes.sha1) throw new Error(`SHA-1 mismatch for ${file.path}: expected ${file.hashes.sha1}, got ${actual}`)
          await unlink(destination).catch(() => undefined)
          await rename(temp, destination)
          lastError = undefined
          break
        } catch (e) {
          lastError = e
          await unlink(temp).catch(() => undefined)
        }
      }
      if (lastError) throw lastError
    }
    return update
  }
}
