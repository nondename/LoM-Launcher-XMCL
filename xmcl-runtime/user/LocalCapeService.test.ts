import { ensureDir, mkdtemp, pathExists, readJson, rm, writeFile, writeJson } from 'fs-extra'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('~/app', () => ({
  Inject: () => () => { },
  InjectionKey: Symbol,
  LauncherApp: class { },
  LauncherAppKey: Symbol('LauncherAppKey'),
}))

const { LocalCapeService } = await import('./LocalCapeService')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

describe('LocalCapeService', () => {
  let appDataPath: string
  let service: InstanceType<typeof LocalCapeService>
  let app: any

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
    appDataPath = await mkdtemp(join(tmpdir(), 'xmcl-local-cape-'))
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    app = {
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
    service = new LocalCapeService(app as any)
  })

  afterEach(async () => {
    await rm(appDataPath, { recursive: true, force: true })
  })

  test('owns imported cape files and equips them per profile', async () => {
    const source = join(appDataPath, 'source.png')
    await writeFile(source, png)

    const local = await service.addCape({ name: 'Local', source })
    const localPath = new URL(local.url).searchParams.get('path')!
    const remote = await service.addCape({ name: 'Remote', source: 'https://example.com/cape.png' })
    const remotePath = new URL(remote.url).searchParams.get('path')!

    expect(localPath).toBe(join(appDataPath, 'cape-closet', `${local.id}.png`))
    await expect(pathExists(localPath)).resolves.toBe(true)
    expect(remotePath).toBe(join(appDataPath, 'cape-closet', `${remote.id}.png`))
    await expect(pathExists(remotePath)).resolves.toBe(true)
    expect(app.fetch).toHaveBeenCalledWith('https://example.com/cape.png')

    await service.setEquippedCape('user-a:profile-a', local.id)
    await service.setEquippedCape('user-b:profile-b', remote.id)
    expect((await service.getState()).equippedCapeIds).toEqual({
      'user-a:profile-a': local.id,
      'user-b:profile-b': remote.id,
    })

    await service.removeCape(local.id)
    await expect(pathExists(localPath)).resolves.toBe(false)
    expect((await service.getState()).equippedCapeIds).toEqual({
      'user-b:profile-b': remote.id,
    })
  })

  test('exports the equipped wardrobe cape into the launched instance', async () => {
    const cape = await service.addCape({ name: 'Launch Cape', source: 'https://example.com/cape.png' })
    await service.setEquippedCape('user-a:profile-a', cape.id)

    const gameDirectory = join(appDataPath, 'instance')
    await service.prepareLaunchCape(user as any, gameDirectory)

    const runtimeDirectory = join(gameDirectory, '.lom', 'player')
    await expect(pathExists(join(runtimeDirectory, 'cape.png'))).resolves.toBe(true)
    await expect(readJson(join(runtimeDirectory, 'profile.json'))).resolves.toMatchObject({
      schemaVersion: 1,
      enabled: true,
      accountId: 'user-a',
      profileId: '12345678123456781234567812345678',
      username: 'LoMPlayer',
      authority: 'offline',
    })

    const profile = await readJson(join(runtimeDirectory, 'profile.json'))
    expect(profile.capeSha256).toMatch(/^[a-f0-9]{64}$/)

    await service.setEquippedCape('user-a:profile-a', '')
    await service.prepareLaunchCape(user as any, gameDirectory)
    await expect(pathExists(join(runtimeDirectory, 'cape.png'))).resolves.toBe(false)
    await expect(pathExists(join(runtimeDirectory, 'profile.json'))).resolves.toBe(false)
  })

  test('keeps skin fields of the shared profile when clearing the cape', async () => {
    const gameDirectory = join(appDataPath, 'instance')
    const runtimeDirectory = join(gameDirectory, '.lom', 'player')
    await ensureDir(runtimeDirectory)
    await writeFile(join(runtimeDirectory, 'skin.png'), png)
    await writeJson(join(runtimeDirectory, 'profile.json'), {
      schemaVersion: 1,
      enabled: true,
      accountId: 'user-a',
      model: 'slim',
      sha256: 'a'.repeat(64),
    })

    await service.prepareLaunchCape(user as any, gameDirectory)

    await expect(pathExists(join(runtimeDirectory, 'cape.png'))).resolves.toBe(false)
    await expect(readJson(join(runtimeDirectory, 'profile.json'))).resolves.toEqual({
      schemaVersion: 1,
      enabled: true,
      accountId: 'user-a',
      model: 'slim',
      sha256: 'a'.repeat(64),
    })
  })

  test('merges the cape into an existing skin profile without dropping skin keys', async () => {
    const cape = await service.addCape({ name: 'Merge Cape', source: 'https://example.com/cape.png' })
    await service.setEquippedCape('user-a:profile-a', cape.id)

    const gameDirectory = join(appDataPath, 'instance')
    const runtimeDirectory = join(gameDirectory, '.lom', 'player')
    await ensureDir(runtimeDirectory)
    await writeFile(join(runtimeDirectory, 'skin.png'), png)
    await writeJson(join(runtimeDirectory, 'profile.json'), {
      schemaVersion: 1,
      enabled: true,
      accountId: 'user-a',
      model: 'slim',
      sha256: 'b'.repeat(64),
    })

    await service.prepareLaunchCape(user as any, gameDirectory)

    await expect(readJson(join(runtimeDirectory, 'profile.json'))).resolves.toMatchObject({
      model: 'slim',
      sha256: 'b'.repeat(64),
      username: 'LoMPlayer',
    })
    const profile = await readJson(join(runtimeDirectory, 'profile.json'))
    expect(profile.capeSha256).toMatch(/^[a-f0-9]{64}$/)
  })
})
