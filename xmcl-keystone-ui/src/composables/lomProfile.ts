import type { Instance, PartialRuntimeVersions } from '@xmcl/instance'

// Canonical launcher-side profile metadata. Keep this in sync with
// lom/launcher.config.json until that file is promoted into a generated/shared
// build-time config.
export const LOM_PROFILE_NAME = 'Legends of Medieval'
export const LOM_PROFILE_RUNTIME: PartialRuntimeVersions = {
  minecraft: '1.20.1',
  forge: '47.4.22',
}

// Renderer-local hand-off between initial instance provisioning and the launch
// button install pipeline. The value is the exact path of the profile created
// during a genuinely empty-state cold start.
export const LOM_COLD_START_PENDING_KEY = 'lomColdStartPendingInstancePath'

// Persistent ownership marker for launcher-managed LoM profiles. We store the
// exact provisioned instance path instead of inferring ownership from a display
// name/runtime pair: users are free to create ordinary Forge 1.20.1 instances
// without the LoM updater ever touching them.
export const LOM_MANAGED_INSTANCE_PATHS_KEY = 'lomManagedInstancePaths'

export function isLoMProfile(instance: Instance | undefined) {
  return !!instance &&
    instance.edition !== 'bedrock' &&
    instance.name === LOM_PROFILE_NAME &&
    instance.runtime.minecraft === LOM_PROFILE_RUNTIME.minecraft &&
    instance.runtime.forge === LOM_PROFILE_RUNTIME.forge
}

export function isManagedLoMProfile(
  instance: Instance | undefined,
  instancePath: string,
  managedPaths: readonly string[],
  pendingPath = '',
) {
  if (!instancePath || !isLoMProfile(instance)) return false
  return pendingPath === instancePath || managedPaths.includes(instancePath)
}
