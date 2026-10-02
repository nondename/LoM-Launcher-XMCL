import { AddLocalCapeOptions, LocalCape, LocalCapeService as ILocalCapeService, LocalCapeServiceKey, LocalCapeState, UpdateLocalCapeOptions, type UserProfile } from '@xmcl/runtime-api'
import { writeFile as writeAtomically } from 'atomically'
import { createHash, randomUUID } from 'crypto'
import { copyFile, ensureDir, pathExists, readFile, remove, writeFile } from 'fs-extra'
import { isAbsolute, join, relative } from 'path'
import { fileURLToPath } from 'url'
import { Inject, LauncherApp, LauncherAppKey } from '~/app'
import { LaunchService } from '~/launch'
import { AbstractService, ExposeServiceKey } from '~/service'

const LOCAL_CAPE_LOCK = 'local-cape-service'

@ExposeServiceKey(LocalCapeServiceKey)
export class LocalCapeService extends AbstractService implements ILocalCapeService {
  private readonly closetPath: string
  private readonly statePath: string
  private state: LocalCapeState = { capes: [], equippedCapeIds: {} }

  constructor(@Inject(LauncherAppKey) app: LauncherApp) {
    super(app, async () => {
      await ensureDir(this.closetPath)
      this.state = await this.loadState()
    })
    this.closetPath = this.getAppDataPath('cape-closet')
    this.statePath = join(this.closetPath, 'index.json')

    const service = this
    void app.registry.get(LaunchService).then((launchService) => {
      launchService.registerMiddleware({
        name: 'lom-local-cape',
        async onBeforeLaunch(input, payload) {
          if (payload.side !== 'client') return
          await service.prepareLaunchCape(input.user, input.gameDirectory)
        },
      })
    }).catch((e) => {
      this.warn('Fail to register LoM local cape launch middleware')
      this.warn(e as Error)
    })
  }

  private async loadState(): Promise<LocalCapeState> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf-8')) as Partial<LocalCapeState>
      return {
        capes: Array.isArray(parsed.capes) ? parsed.capes : [],
        equippedCapeIds: parsed.equippedCapeIds && typeof parsed.equippedCapeIds === 'object' ? parsed.equippedCapeIds : {},
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.warn(`Fail to load ${this.statePath}`)
        this.warn(e as Error)
      }
      return { capes: [], equippedCapeIds: {} }
    }
  }

  private async saveState() {
    await writeAtomically(this.statePath, JSON.stringify(this.state, null, 2))
  }

  private getLocalSource(source: string): string | undefined {
    if (source.startsWith('file:')) return fileURLToPath(source)
    if (source.startsWith('http://') || source.startsWith('https://')) {
      const url = new URL(source)
      if (url.host === 'launcher' && url.pathname === '/media') {
        return url.searchParams.get('path') || undefined
      }
      return undefined
    }
    return source
  }

  private getMediaUrl(path: string) {
    const url = new URL('http://launcher/media')
    url.searchParams.set('path', path)
    return url.toString()
  }

  private async persistSource(source: string, target: string) {
    const localSource = this.getLocalSource(source)
    if (localSource) {
      const { fileTypeFromFile } = await import('file-type')
      const fileType = await fileTypeFromFile(localSource)
      if (fileType?.mime !== 'image/png') throw new Error('The local cape must be a PNG image')
      await copyFile(localSource, target)
      return
    }

    const response = await this.app.fetch(source)
    if (!response.ok) throw new Error(`Cannot download cape from ${source}`)
    const content = Buffer.from(await response.arrayBuffer())
    const { fileTypeFromBuffer } = await import('file-type')
    const fileType = await fileTypeFromBuffer(content)
    if (fileType?.mime !== 'image/png') throw new Error('The remote cape must be a PNG image')
    await writeFile(target, content)
  }

  async getState(): Promise<LocalCapeState> {
    await this.initialize()
    return structuredClone(this.state)
  }

  async addCape(options: AddLocalCapeOptions): Promise<LocalCape> {
    await this.initialize()
    return this.mutex.of(LOCAL_CAPE_LOCK).runExclusive(async () => {
      const id = randomUUID()
      const target = join(this.closetPath, `${id}.png`)
      await this.persistSource(options.source, target)
      const cape: LocalCape = {
        id,
        name: options.name.trim() || 'Custom Cape',
        url: this.getMediaUrl(target),
        source: options.source,
        dateAdded: Date.now(),
      }
      this.state.capes.unshift(cape)
      try {
        await this.saveState()
      } catch (e) {
        this.state.capes.shift()
        await remove(target)
        throw e
      }
      return structuredClone(cape)
    })
  }

  async updateCape(id: string, options: UpdateLocalCapeOptions): Promise<LocalCape> {
    await this.initialize()
    return this.mutex.of(LOCAL_CAPE_LOCK).runExclusive(async () => {
      const index = this.state.capes.findIndex(cape => cape.id === id)
      if (index === -1) throw new Error(`Cannot find local cape ${id}`)
      const original = this.state.capes[index]
      const updated = {
        ...original,
        ...(options.name === undefined ? {} : { name: options.name.trim() || original.name }),
      }
      this.state.capes[index] = updated
      try {
        await this.saveState()
      } catch (e) {
        this.state.capes[index] = original
        throw e
      }
      return structuredClone(updated)
    })
  }

  async removeCape(id: string): Promise<void> {
    await this.initialize()
    await this.mutex.of(LOCAL_CAPE_LOCK).runExclusive(async () => {
      const index = this.state.capes.findIndex(cape => cape.id === id)
      if (index === -1) return
      const [removed] = this.state.capes.splice(index, 1)
      const equippedCapeIds = { ...this.state.equippedCapeIds }
      for (const account of Object.keys(this.state.equippedCapeIds)) {
        if (this.state.equippedCapeIds[account] === id) delete this.state.equippedCapeIds[account]
      }
      try {
        await this.saveState()
      } catch (e) {
        this.state.capes.splice(index, 0, removed)
        this.state.equippedCapeIds = equippedCapeIds
        throw e
      }
      const localSource = this.getLocalSource(removed.url)
      const relativePath = localSource ? relative(this.closetPath, localSource) : undefined
      if (localSource && relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath)) {
        await remove(localSource)
      }
    })
  }

  async setEquippedCape(account: string, id: string): Promise<void> {
    await this.initialize()
    await this.mutex.of(LOCAL_CAPE_LOCK).runExclusive(async () => {
      if (id && !this.state.capes.some(cape => cape.id === id)) throw new Error(`Cannot find local cape ${id}`)
      const original = this.state.equippedCapeIds[account]
      if (id) this.state.equippedCapeIds[account] = id
      else delete this.state.equippedCapeIds[account]
      try {
        await this.saveState()
      } catch (e) {
        if (original) this.state.equippedCapeIds[account] = original
        else delete this.state.equippedCapeIds[account]
        throw e
      }
    })
  }

  /** Export the equipped local cape into the same LoM runtime profile used by LoM-Skin-Loader. */
  async prepareLaunchCape(user: UserProfile, gameDirectory: string): Promise<void> {
    await this.initialize()

    const runtimeDirectory = join(gameDirectory, '.lom', 'player')
    const runtimeCape = join(runtimeDirectory, 'cape.png')
    const runtimeProfile = join(runtimeDirectory, 'profile.json')
    const selectedProfile = user.profiles[user.selectedProfile]
    const accountKey = `${user.id}:${user.selectedProfile}`
    const equippedId = this.state.equippedCapeIds[accountKey]
    const equippedCape = equippedId ? this.state.capes.find(cape => cape.id === equippedId) : undefined

    const readProfile = async (): Promise<Record<string, unknown>> => {
      try {
        return JSON.parse(await readFile(runtimeProfile, 'utf-8')) as Record<string, unknown>
      } catch {
        return {}
      }
    }

    const clearCape = async () => {
      await remove(runtimeCape)
      if (!(await pathExists(runtimeProfile))) return
      const profile = await readProfile()
      delete profile.capeSha256
      if (!(await pathExists(join(runtimeDirectory, 'skin.png')))) {
        await remove(runtimeProfile)
      } else {
        await writeAtomically(runtimeProfile, JSON.stringify(profile, null, 2))
      }
    }

    if (!selectedProfile || !equippedCape) {
      await clearCape()
      return
    }

    const localSource = this.getLocalSource(equippedCape.url)
    if (!localSource) {
      this.warn(`Equipped local cape ${equippedCape.id} has no local source; clearing LoM runtime cape`)
      await clearCape()
      return
    }

    try {
      const content = await readFile(localSource)
      const capeSha256 = createHash('sha256').update(content).digest('hex')
      await ensureDir(runtimeDirectory)
      await writeFile(runtimeCape, content)
      const existing = await readProfile()
      await writeAtomically(runtimeProfile, JSON.stringify({
        ...existing,
        schemaVersion: 1,
        enabled: true,
        accountId: user.id,
        profileId: selectedProfile.id,
        username: selectedProfile.name,
        authority: user.authority,
        capeSha256,
      }, null, 2))
    } catch (e) {
      this.warn(`Fail to prepare LoM runtime cape from ${localSource}`)
      this.warn(e as Error)
      await clearCape()
    }
  }
}
