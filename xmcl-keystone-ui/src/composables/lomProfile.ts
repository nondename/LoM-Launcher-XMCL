import type { Instance, PartialRuntimeVersions } from '@xmcl/instance'

export const LOM_PROFILE_NAME = 'Legends of Medieval'
export const LOM_PROFILE_RUNTIME: PartialRuntimeVersions = {
  minecraft: '1.20.1',
  forge: '47.4.22',
}
export const LOM_COLD_START_PENDING_KEY = 'lomColdStartPendingInstancePath'
export const LOM_MANAGED_INSTANCE_PATHS_KEY = 'lomManagedInstancePaths'

export function isLoMProfile(instance: Instance | undefined) {
  return !!instance && instance.edition !== 'bedrock' && instance.name === LOM_PROFILE_NAME && instance.runtime.minecraft === LOM_PROFILE_RUNTIME.minecraft && instance.runtime.forge === LOM_PROFILE_RUNTIME.forge
}

export function isManagedLoMProfile(instance: Instance | undefined, instancePath: string, managedPaths: readonly string[], pendingPath = '') {
  // `path` and `instance` update independently while switching profiles. Never
  // authorize a new path with stale metadata from the previously selected LoM profile.
  if (!instancePath || !instance || instance.path !== instancePath || !isLoMProfile(instance)) return false
  return pendingPath === instancePath || managedPaths.includes(instancePath)
}
