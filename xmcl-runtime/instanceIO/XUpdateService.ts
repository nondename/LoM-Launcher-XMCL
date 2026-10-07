import { checksum } from '@xmcl/core'
import type { InstanceFile } from '@xmcl/instance'
import { InstanceIOException, XUpdateServiceKey, type XUpdateService as IXUpdateService, type InstanceManifest, type InstanceUpdate, type SetInstanceManifestOptions, type ManagedInstanceUpdateProgress, type ManagedInstanceUpdateResult, type ManagedInstanceUpdateStatus } from '@xmcl/runtime-api'
import { randomUUID } from 'crypto'
import { createReadStream } from 'fs'
import { appendFile, mkdir, rename, unlink, writeFile } from 'fs-extra'
import { dirname, join } from 'path'
import { Readable } from 'stream'
import { Inject, LauncherAppKey, kGameDataPath, kTempDataPath } from '~/app'
import { InstanceService } from '~/instance'
import { AbstractService, ExposeServiceKey, Singleton } from '~/service'
import { UserService } from '~/user'
import { LauncherApp } from '../app/LauncherApp'
import { missing } from '../util/fs'
import { isValidUrl } from '../util/url'
import { writeZipFile } from '../util/zip'
import { ZipFile } from 'yazl'
import { ManagedInstanceUpdateService } from './ManagedInstanceUpdateService'

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

  private async diagnostic(message: string) {
    const line = `[${new Date().toISOString()}] ${message}\n`
    this.log(`[LoM Diagnostics] ${message}`)
    try {
      const getGameDataPath = await this.app.registry.get(kGameDataPath)
      await appendFile(getGameDataPath('lom-diagnostics.log'), line, 'utf-8')
    } catch (e) {
      void this.diagnostic(`WARN Failed to persist diagnostics: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private async getManagedUpdater(): Promise<ManagedInstanceUpdateService> {
    return this.app.registry.getOrCreate(ManagedInstanceUpdateService)
  }

  private describeInstance(path: string) {
    const instance = this.instanceService.state.all[path]
    return instance
      ? `path=${path} name=${JSON.stringify(instance.name)} edition=${instance.edition ?? 'java'} minecraft=${instance.runtime.minecraft ?? '-'} forge=${instance.runtime.forge ?? '-'} managed=${instance.managed ? `${instance.managed.provider}/${instance.managed.profileId}` : '-'} fileApi=${instance.fileApi ?? '-'}`
      : `path=${path} instance=MISSING`
  }

  async checkManagedInstanceUpdate(path: string): Promise<ManagedInstanceUpdateStatus> {
    void this.diagnostic(`checkManagedInstanceUpdate requested ${this.describeInstance(path)}`)
    return (await this.getManagedUpdater()).check(path)
  }

  async applyManagedInstanceUpdate(path: string): Promise<ManagedInstanceUpdateResult> {
    void this.diagnostic(`applyManagedInstanceUpdate requested ${this.describeInstance(path)}`)
    return (await this.getManagedUpdater()).update(path)
  }

  async cancelManagedInstanceUpdate(path: string): Promise<boolean> {
    void this.diagnostic(`cancelManagedInstanceUpdate requested ${this.describeInstance(path)}`)
    return (await this.getManagedUpdater()).cancel(path)
  }

  async getManagedInstanceUpdateProgress(path: string): Promise<ManagedInstanceUpdateProgress> {
    return (await this.getManagedUpdater()).getProgress(path)
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
    void this.diagnostic(`fetchInstanceUpdate requested ${this.describeInstance(instancePath)}`)
    if (!instance) throw new InstanceIOException({ instancePath, type: 'instanceNotFound' })
    if (!instance.fileApi) {
      void this.diagnostic(`generic instance updater skipped: no fileApi path=${instancePath}`)
      return undefined
    }
    const url = isValidUrl(instance.fileApi)
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https')) throw new InstanceIOException({ instancePath, type: 'instanceInvalidFileApi', url: instance.fileApi })
    const manifestUrl = joinFileApiUrl(instance.fileApi, 'manifest.json')
    void this.diagnostic(`generic manifest GET path=${instancePath} url=${manifestUrl}`)
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
    void this.diagnostic(`generic manifest resolved path=${instancePath} updates=${updates.length} files=${manifest.files?.length ?? 0}`)
    return { updates, manifest }
  }

  @Singleton(p => p)
  async applyInstanceUpdate(path: string): Promise<InstanceUpdate | undefined> {
    void this.diagnostic(`applyInstanceUpdate requested ${this.describeInstance(path)}`)
    const update = await this.fetchInstanceUpdate(path)
    if (!update || update.updates.length === 0) {
      void this.diagnostic(`applyInstanceUpdate nothing-to-do path=${path}`)
      return update
    }
    void this.diagnostic(`applyInstanceUpdate begin path=${path} files=${update.updates.length}`)
    for (const { file } of update.updates) {
      const destination = join(path, file.path)
      const temp = `${destination}.lom-update`
      await mkdir(dirname(destination), { recursive: true })
      let lastError: unknown
      for (const download of file.downloads ?? []) {
        try {
          void this.diagnostic(`generic download path=${path} file=${file.path} url=${download} destination=${destination}`)
          const response = await this.app.fetch(download)
          if (!response.ok) throw new Error(`HTTP ${response.status} while downloading ${download}`)
          const bytes = Buffer.from(await response.arrayBuffer())
          await writeFile(temp, bytes)
          const actual = await checksum(temp, 'sha1')
          if (actual !== file.hashes.sha1) throw new Error(`SHA-1 mismatch for ${file.path}: expected ${file.hashes.sha1}, got ${actual}`)
          await unlink(destination).catch(() => undefined)
          await rename(temp, destination)
          void this.diagnostic(`generic installed path=${path} file=${file.path} destination=${destination} bytes=${bytes.length}`)
          lastError = undefined
          break
        } catch (e) {
          lastError = e
          void this.diagnostic(`WARN generic download failed path=${path} file=${file.path} url=${download}: ${e instanceof Error ? e.message : String(e)}`)
          await unlink(temp).catch(() => undefined)
        }
      }
      if (lastError) throw lastError
    }
    void this.diagnostic(`applyInstanceUpdate complete path=${path} files=${update.updates.length}`)
    return update
  }
}
