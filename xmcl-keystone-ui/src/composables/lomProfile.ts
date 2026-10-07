import type { Instance, ManagedInstance, PartialRuntimeVersions } from '@xmcl/instance'

// Canonical launcher-side profile metadata. Keep this in sync with
// lom/launcher.config.json until that file is promoted into a generated/shared
// build-time config.
export const LOM_PROFILE_NAME = 'Legends of Medieval'
export const LOM_PROFILE_RUNTIME: PartialRuntimeVersions = {
  minecraft: '1.20.1',
  forge: '47.4.22',
}

export const LITE_PROFILE_NAME = 'Lite'
export const LITE_PROFILE_RUNTIME: PartialRuntimeVersions = {
  minecraft: '1.20.1',
  forge: '47.4.22',
}

export const LOM_MANAGED_INSTANCE: ManagedInstance = {
  provider: 'lom-distribution',
  profileId: 'legends-of-medieval',
  channel: 'dev',
  manifestUrl: 'https://raw.githubusercontent.com/nondename/Minecraft-Legends-of-Medieval/dev/distribution.json',
  java: {
    majorVersion: 17,
    component: 'java-runtime-gamma',
  },
}

export const LITE_MANAGED_INSTANCE: ManagedInstance = {
  provider: 'lom-distribution',
  profileId: 'legends-of-medieval-lite',
  channel: 'dev',
  manifestUrl: 'https://raw.githubusercontent.com/nondename/Minecraft-Legends-of-Medieval/dev/lite/distribution.json',
  java: {
    majorVersion: 17,
    component: 'java-runtime-gamma',
  },
}

const LOM_MANAGED_IDENTITIES = [LOM_MANAGED_INSTANCE, LITE_MANAGED_INSTANCE]

// Renderer-local hand-off retained only for migration from older launcher
// builds. New managed profiles persist ownership directly in instance.json.
export const LOM_COLD_START_PENDING_KEY = 'lomColdStartPendingInstancePath'
export const LOM_LEGACY_MANAGED_INSTANCE_PATHS_KEY = 'lomManagedInstancePaths'

/**
 * Exact managed identity check. Runtime/name/path similarity is deliberately
 * irrelevant: a user may create an ordinary instance with the same name and
 * Forge version without giving the LoM updater ownership of it.
 */
export function isManagedLoMProfile(instance: Instance | undefined) {
  return !!instance &&
    instance.edition !== 'bedrock' &&
    !!instance.managed &&
    LOM_MANAGED_IDENTITIES.some((managed) =>
      instance.managed?.provider === managed.provider &&
      instance.managed?.profileId === managed.profileId,
    )
}

/**
 * Compatibility detector used only to migrate profiles created by older LoM
 * Launcher builds before managed metadata was stored in instance.json.
 */
export function isLegacyLoMProfile(instance: Instance | undefined) {
  return !!instance &&
    !instance.managed &&
    instance.edition !== 'bedrock' &&
    instance.name === LOM_PROFILE_NAME &&
    instance.runtime.minecraft === LOM_PROFILE_RUNTIME.minecraft &&
    instance.runtime.forge === LOM_PROFILE_RUNTIME.forge
}

/** @deprecated Prefer isManagedLoMProfile for ownership decisions. */
export function isLoMProfile(instance: Instance | undefined) {
  return isManagedLoMProfile(instance) || isLegacyLoMProfile(instance)
}
