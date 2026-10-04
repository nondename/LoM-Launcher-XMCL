import { AUTHORITY_MICROSOFT } from '@xmcl/runtime-api'
import { ensureDir, mkdtemp, pathExists, readFile, readJson, rm, writeFile, writeJson } from 'fs-extra'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('~/app', () => ({
  Inject: () => () => { },
  InjectionKey: Symbol,
  LauncherApp: class { },
  LauncherAppKey: Symbol('LauncherAppKey'),
}))

const { LocalSkinService } = await import('./LocalSkinService')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

describe('LocalSkinService', () => {
  let appDataPath: string
  let service: InstanceType<typeof LocalSkinService>
  let yggdrasilRegistry: { getYggdrasilServices: ReturnType<typeof vi.fn> }

  const user = {
    id: 'user-a',
    authority: 'offline',
    selectedProfile: 'profile-a',
    profiles: {
      'profile-a': {
        id: '12345678123456781234567812345678',
        name: 'LoMPlayer',
      },
    },
  }

  beforeEach(async () => {
    appDataPath = await mkdtemp(join(tmpdir(), 'xmcl-local-skin-'))
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const app = {
      appDataPath,
      getLogger: () => logger,
      controller: { broadcast: vi.fn() },
      mutex: {
        of: () => ({ runExclusive: async <T>(task: () => Promise<T>) => task() }),
      },
      fetch: vi.fn(async () => new Response(png, {
        headers: { 'content-type': 'image/png' },
      })),
    }
    yggdrasilRegistry = {
      getYggdrasilServices: vi.fn(() => [{ url: 'https://auth.example/api/yggdrasil' }]),
    }
    service = new LocalSkinService(app as any, yggdrasilRegistry as any)
  })

  afterEach(async () => {
    await rm(appDataPath, { recursive: true, force: true })
  })

  test('owns imported files and downloads remote skins', async () => {
    const source = join(appDataPath, 'source.png')
    await writeFile(source, png)

    const local = await service.addSkin({ name: 'Local', source, slim: false })
    const localPath = new URL(local.url).searchParams.get('path')!
    const remote = await service.addSkin({ name: 'Remote', source: 'https://example.com/skin.png', slim: true })
    const remotePath = new URL(remote.url).searchParams.get('path')!

    expect(localPath).toBe(join(appDataPath, 'closet', `${local.id}.png`))
    await expect(pathExists(localPath)).resolves.toBe(true)
    expect(remotePath).toBe(join(appDataPath, 'closet', `${remote.id}.png`))
    await expect(pathExists(remotePath)).resolves.toBe(true)
    expect(remote.source).toBe('https://example.com/skin.png')
    expect(service.app.fetch).toHaveBeenCalledWith('https://example.com/skin.png')
    expect(await readJson(join(appDataPath, 'closet', 'index.json'))).toMatchObject({
      skins: [{ id: remote.id, url: remote.url }, { id: local.id, url: local.url }],
    })

    await service.removeSkin(local.id)
    await expect(pathExists(localPath)).resolves.toBe(false)
    expect((await service.getState()).skins).toEqual([remote])
  })

  test('exports the equipped wardrobe skin into the launched instance', async () => {
    const skin = await service.addSkin({ name: 'Launch Skin', source: 'https://example.com/skin.png', slim: true })
    await service.setEquippedSkin('user-a:profile-a', skin.id)

    const gameDirectory = join(appDataPath, 'instance')

    await service.prepareLaunchSkin(user as any, gameDirectory)

    const runtimeDirectory = join(gameDirectory, '.lom', 'player')
    await expect(readFile(join(runtimeDirectory, 'skin.png'))).resolves.toEqual(png)
    await expect(readJson(join(runtimeDirectory, 'profile.json'))).resolves.toMatchObject({
      schemaVersion: 1,
      enabled: true,
      accountId: 'user-a',
      profileId: '12345678123456781234567812345678',
      username: 'LoMPlayer',
      authority: 'offline',
      model: 'slim',
    })

    const profile = await readJson(join(runtimeDirectory, 'profile.json'))
    expect(profile.sha256).toMatch(/^[a-f0-9]{64}$/)

    await service.setEquippedSkin('user-a:profile-a', '')
    await service.prepareLaunchSkin(user as any, gameDirectory)
    await expect(pathExists(join(runtimeDirectory, 'skin.png'))).resolves.toBe(false)
    await expect(pathExists(join(runtimeDirectory, 'profile.json'))).resolves.toBe(false)
  })

  test('keeps cape fields of the shared profile when clearing the skin', async () => {
    const gameDirectory = join(appDataPath, 'instance')
    const runtimeDirectory = join(gameDirectory, '.lom', 'player')
    await ensureDir(runtimeDirectory)
    await writeFile(join(runtimeDirectory, 'cape.png'), png)
    await writeJson(join(runtimeDirectory, 'profile.json'), {
      schemaVersion: 1,
      enabled: true,
      accountId: 'user-a',
      capeSha256: 'c'.repeat(64),
    })

    await service.prepareLaunchSkin(user as any, gameDirectory)

    await expect(pathExists(join(runtimeDirectory, 'skin.png'))).resolves.toBe(false)
    await expect(readJson(join(runtimeDirectory, 'profile.json'))).resolves.toEqual({
      schemaVersion: 1,
      enabled: true,
      accountId: 'user-a',
      capeSha256: 'c'.repeat(64),
    })
  })

  test('merges the skin into an existing cape profile without dropping capeSha256', async () => {
    const skin = await service.addSkin({ name: 'Merge Skin', source: 'https://example.com/skin.png', slim: true })
    await service.setEquippedSkin('user-a:profile-a', skin.id)

    const gameDirectory = join(appDataPath, 'instance')
    const runtimeDirectory = join(gameDirectory, '.lom', 'player')
    await ensureDir(runtimeDirectory)
    await writeJson(join(runtimeDirectory, 'profile.json'), {
      schemaVersion: 1,
      enabled: true,
      accountId: 'user-a',
      capeSha256: 'c'.repeat(64),
    })

    await service.prepareLaunchSkin(user as any, gameDirectory)

    await expect(readJson(join(runtimeDirectory, 'profile.json'))).resolves.toMatchObject({
      model: 'slim',
      capeSha256: 'c'.repeat(64),
      username: 'LoMPlayer',
    })
    const profile = await readJson(join(runtimeDirectory, 'profile.json'))
    expect(profile.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  test('migrates legacy remote skins into the closet', async () => {
    const closetPath = join(appDataPath, 'closet')
    await ensureDir(closetPath)
    await writeJson(join(closetPath, 'index.json'), {
      skins: [{
        id: 'legacy',
        name: 'Legacy',
        url: 'https://example.com/legacy.png',
        slim: false,
        dateAdded: 1,
      }],
      equippedSkinIds: {},
    })

    const state = await service.getState()
    const [migrated] = state.skins
    const migratedPath = new URL(migrated.url).searchParams.get('path')!
    expect(migrated.source).toBe('https://example.com/legacy.png')
    expect(migratedPath).toBe(join(closetPath, 'legacy.png'))
    await expect(pathExists(migratedPath)).resolves.toBe(true)
    await expect(readJson(join(closetPath, 'index.json'))).resolves.toMatchObject({
      skins: [{ id: 'legacy', source: 'https://example.com/legacy.png', url: migrated.url }],
    })
  })

  test('persists equipped skins independently for each account profile', async () => {
    const first = await service.addSkin({ name: 'First', source: 'https://example.com/first.png', slim: false })
    const second = await service.addSkin({ name: 'Second', source: 'https://example.com/second.png', slim: true })

    await service.setEquippedSkin('user-a:profile-a', first.id)
    await service.setEquippedSkin('user-b:profile-b', second.id)

    const restored = new LocalSkinService(service.app, yggdrasilRegistry as any)
    expect(await restored.getState()).toEqual({
      skins: [second, first],
      equippedSkinIds: {
        'user-a:profile-a': first.id,
        'user-b:profile-b': second.id,
      },
    })

    await restored.removeSkin(first.id)
    expect((await restored.getState()).equippedSkinIds).toEqual({
      'user-b:profile-b': second.id,
    })
  })

  test('resolves a player skin from a third-party yggdrasil authority', async () => {
    const textures = Buffer.from(JSON.stringify({
      textures: {
        SKIN: { url: 'https://textures.example/skin.png', metadata: { model: 'slim' } },
      },
    })).toString('base64')
    service.app.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 'player-id', name: 'Steve' }])))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'player-id',
        name: 'Steve',
        properties: [{ name: 'textures', value: textures }],
      })))

    await expect(service.resolveSkin('https://auth.example/api/yggdrasil', 'Steve')).resolves.toEqual({
      url: 'https://textures.example/skin.png',
      slim: true,
    })
    expect(service.app.fetch).toHaveBeenNthCalledWith(1, new URL('https://auth.example/api/yggdrasil/api/profiles/minecraft'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(['Steve']),
    })
    expect(service.app.fetch).toHaveBeenNthCalledWith(2, new URL('https://auth.example/api/yggdrasil/sessionserver/session/minecraft/profile/player-id?unsigned=true'))
  })

  test('resolves a player skin from Mojang by default', async () => {
    const textures = Buffer.from(JSON.stringify({
      textures: { SKIN: { url: 'https://textures.minecraft.net/skin.png' } },
    })).toString('base64')
    service.app.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'player-id', name: 'Alex' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'player-id',
        name: 'Alex',
        properties: [{ name: 'textures', value: textures }],
      })))

    await expect(service.resolveSkin(AUTHORITY_MICROSOFT, 'Alex')).resolves.toEqual({
      url: 'https://textures.minecraft.net/skin.png',
      slim: false,
    })
    expect(service.app.fetch).toHaveBeenNthCalledWith(1, 'https://api.mojang.com/users/profiles/minecraft/Alex')
    expect(service.app.fetch).toHaveBeenNthCalledWith(2, new URL('https://sessionserver.mojang.com/session/minecraft/profile/player-id?unsigned=true'))
  })

  test('rejects an unregistered yggdrasil authority', async () => {
    await expect(service.resolveSkin('https://unknown.example/yggdrasil', 'Steve')).rejects.toThrow('Unknown Yggdrasil authority')
  })
})