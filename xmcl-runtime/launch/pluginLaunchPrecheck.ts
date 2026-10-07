import { LaunchPrecheck, MinecraftFolder } from '@xmcl/core'
import {
  LaunchException,
  protocolToMinecraft,
  resolveFabricLoaderVersion,
  resolveForgeVersion,
  resolveQuiltVersion,
} from '@xmcl/runtime-api'
import { isSystemError } from '@xmcl/utils'
import { ensureDir, move, stat, unlink } from 'fs-extra'
import { join } from 'path'
import { LauncherAppPlugin, kGameDataPath } from '~/app'
import { InstanceService } from '~/instance'
import { ManagedInstanceUpdateService } from '~/instanceIO/ManagedInstanceUpdateService'
import { VersionInstallService } from '~/install/InstallService'
import { isLinkTo, readlinkSafe } from '~/instance/utils/readLinkSafe'
import { getManagedJavaComponent, JavaService, JavaValidation } from '~/java'
import { LaunchService } from '~/launch'
import { PeerService } from '~/peer'
import { LocalSkinService } from '~/user/LocalSkinService'
import { shouldRunManagedInstanceUpdate } from './managedInstanceLaunch'
import { linkOrCopyDirectory, missing } from '~/util/fs'

export const pluginLaunchPrecheck: LauncherAppPlugin = async (app) => {
  const launchService = await app.registry.get(LaunchService)
  const getPath = await app.registry.get(kGameDataPath)

  const logger = app.getLogger('LaunchPrecheck')

  launchService.registerMiddleware({
    name: 'lom-local-skin',
    async onBeforeLaunch(input, payload) {
      if (payload.side !== 'client') return
      const localSkinService = await app.registry.getOrCreate(LocalSkinService)
      await localSkinService.prepareLaunchSkin(input.user, input.gameDirectory)
    },
  })

  launchService.registerMiddleware({
    name: 'managed-instance-update',
    async onBeforeLaunch(input, payload) {
      if (payload.side !== 'client') return

      const instanceService = await app.registry.get(InstanceService)
      const instance = instanceService.state.all[input.gameDirectory]

      // Ordinary XMCL instances are entirely user-owned. Never invoke a
      // managed provider for them, even if their Minecraft/Forge versions or
      // display name happen to match an official profile.
      if (!shouldRunManagedInstanceUpdate(instance)) return

      logger.log(`[Managed Updater] Pre-launch check for ${input.gameDirectory} provider=${instance.managed.provider} profile=${instance.managed.profileId}`)
      try {
        const updater = await app.registry.getOrCreate(ManagedInstanceUpdateService)
        const result = await updater.update(input.gameDirectory)
        logger.log(`[Managed Updater] Pre-launch update complete: version=${result.version}, changed=${result.changed}, deleted=${result.deleted}`)
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e))
        logger.error(error)
        throw new LaunchException(
          { type: 'launchPreExecuteCommandFailed', command: 'Managed Instance Update', error: error.message },
          `Managed instance update failed: ${error.message}`,
          { cause: error },
        )
      }
    },
  })

  const ensureLinkFolder = async (fromPath: string, toPath: string) => {
    if (await missing(fromPath)) {
      await ensureDir(fromPath)
    }
    if (await isLinkTo(toPath, fromPath)) {
      return
    }

    let stage = 'link'
    const linkTarget = await readlinkSafe(toPath).catch(() => undefined)
    if (linkTarget) {
      stage = 'relink'
      await unlink(toPath).catch(() => {})
    } else {
      const fstat = await stat(toPath).catch((e) => {
        if (e.code === 'ENOENT') return undefined
        throw e
      })
      if (fstat) {
        stage = 'after move'
        try {
          await move(toPath, join(toPath + '.bk'))
        } catch (e) {
          if ((e as any).message === 'dest already exists.') {
            await move(toPath, join(toPath + Date.now() + '.bk'))
          }
        }
      }
    }

    await linkOrCopyDirectory(fromPath, toPath, logger).catch(async (e) => {
      if (isSystemError(e) && e.code === 'EEXIST' && await isLinkTo(toPath, fromPath)) {
        return
      }
      e.name = 'LaunchLinkError'
      e.stage = stage
      logger.error(e)
    })
  }
  const ensureLinkFolderFromRoot = async (gameDirectory: string, folder: string) => {
    const fromPath = getPath(folder)
    const toPath = join(gameDirectory, folder)
    await ensureLinkFolder(fromPath, toPath)
  }

  launchService.registerMiddleware({
    name: 'java-validation',
    async onBeforeLaunch(input, payload) {
      const javaService = await app.registry.getOrCreate(JavaService)
      const javaPath = input.java
      let resolved
      try {
        resolved = await javaService.resolveJava(javaPath)
        if (!resolved) {
          const managed = getManagedJavaComponent(javaPath, getPath('jre'))
          const cached = javaService.state.all.find((java) => java.path === javaPath)
          const target = ('javaVersion' in payload.version
            ? payload.version.javaVersion
            : undefined) ?? (managed && cached?.majorVersion
              ? { component: managed.component, majorVersion: cached.majorVersion }
              : undefined)
          if (managed && target) {
            await javaService.removeJava(javaPath)
            const installer = await app.registry.getOrCreate(VersionInstallService)
            resolved = await installer.install({
              type: 'java',
              target,
              forceZulu: managed.forceZulu,
            })
          }
          if (resolved) {
            input.java = resolved.path
            payload.options.javaPath = resolved.path
          }
        }
      } catch (e) {
        throw new LaunchException(
          { type: 'launchNoProperJava', javaPath },
          'Cannot launch without a valid java',
          { cause: e },
        )
      }
      if (resolved) return

      const validation = await javaService.validateJavaPath(javaPath)
      if (validation === JavaValidation.NotExisted) {
        throw new LaunchException({ type: 'launchInvalidJavaPath', javaPath })
      }
      if (validation === JavaValidation.NoPermission) {
        throw new LaunchException({ type: 'launchJavaNoPermission', javaPath })
      }
      throw new LaunchException(
        { type: 'launchNoProperJava', javaPath },
        'Java executable exists but the JVM cannot start',
      )
    },
  })
  launchService.registerMiddleware({
    name: 'check-assets',
    async onBeforeLaunch(input, payload) {
      if (payload.side === 'server') return
      const resolvedVersion = payload.version
      if (!input?.skipAssetsCheck) {
        // Reserved for XMCL asset diagnostics.
      }

      const commonLibs = resolvedVersion.libraries.filter((lib) => !lib.isNative)
      for (const lib of commonLibs) {
        if (!lib.download.path) {
          ;(lib.download as any).path = lib.path
          if (!lib.download.path) {
            throw new LaunchException(
              { type: 'launchBadVersion', version: resolvedVersion.id },
              JSON.stringify(lib),
            )
          }
        }
      }
    },
  })
  launchService.registerMiddleware({
    name: 'check-natives',
    async onBeforeLaunch(input, payload, options) {
      if (payload.side === 'server') return
      const resourceFolder = new MinecraftFolder(getPath())
      await LaunchPrecheck.checkNatives(resourceFolder, payload.version, payload.options)
    },
  })
  launchService.registerMiddleware({
    name: 'expose-server',
    async onBeforeLaunch(input, payload, options) {
      if (payload.side === 'client') return

      const peer = await app.registry.getIfPresent(PeerService)
      if (peer && payload.side === 'server') {
        const ver = payload.version.minecraftVersion
        const minecraftToProtocol: Record<string, number> = {}
        for (const [protocol, vers] of Object.entries(protocolToMinecraft)) {
          for (const v of vers) {
            minecraftToProtocol[v] = parseInt(protocol)
          }
        }
        peer.exposePort(25565, minecraftToProtocol[ver] ?? 765)
      }
    },
    async onAfterLaunch(result, input, payload, context) {
      if (payload.side === 'server') {
        const peer = await app.registry.getIfPresent(PeerService)
        if (peer) {
          peer.unexposePort(25565)
        }
      }
    },
  })

  app.registry.get(InstanceService).then((serv) => {
    serv.state.subscribe('instanceAdd', (instance) => {
      if (instance.edition === 'bedrock') return
      ensureLinkFolderFromRoot(instance.path, 'libraries')
      ensureLinkFolderFromRoot(instance.path, 'versions')
    })
  })
  launchService.registerMiddleware({
    name: 'link-assets',
    async onBeforeLaunch(input, payload) {
      if (payload.side === 'client') {
        const { version, options } = payload
        const resourceFolder = new MinecraftFolder(getPath())
        await LaunchPrecheck.linkAssets(resourceFolder, version, options)

        if (!version.inheritances[version.inheritances.length - 1].startsWith('1.4.')) {
          return
        }
        const forgeVersion = resolveForgeVersion(version as any)
        if (forgeVersion) {
          await ensureLinkFolderFromRoot(input.gameDirectory, 'libraries')
        }

        const fabricVersion = resolveFabricLoaderVersion(version as any)
        if (fabricVersion) {
          await Promise.all([
            ensureLinkFolderFromRoot(input.gameDirectory, '.fabric'),
            ensureLinkFolderFromRoot(input.gameDirectory, '.mixin.out'),
          ])
        }

        const quilt = resolveQuiltVersion(version as any)
        if (quilt) {
          await ensureLinkFolderFromRoot(input.gameDirectory, '.cache')
        }
      } else {
        const dir = join(input.gameDirectory, 'server')
        const { version } = payload

        const fabricVersion = resolveFabricLoaderVersion(version as any)
        if (fabricVersion) {
          await Promise.all([
            ensureLinkFolderFromRoot(dir, '.fabric'),
            ensureLinkFolderFromRoot(dir, '.mixin.out'),
          ])
        }

        const quilt = resolveQuiltVersion(version as any)
        if (quilt) {
          await ensureLinkFolderFromRoot(dir, '.cache')
        }

        await Promise.all([
          ensureLinkFolderFromRoot(dir, 'libraries'),
          ensureLinkFolderFromRoot(dir, 'versions'),
          ensureLinkFolder(join(input.gameDirectory, 'config'), join(dir, 'config')),
        ])
      }
    },
  })
}
