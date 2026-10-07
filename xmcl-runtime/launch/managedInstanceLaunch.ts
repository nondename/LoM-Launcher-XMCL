import type { Instance } from '@xmcl/instance'

/**
 * Managed providers are allowed to participate in the launch pipeline only
 * when ownership is explicitly persisted on the selected instance.
 */
export function shouldRunManagedInstanceUpdate(instance: Instance | undefined) {
  return !!instance?.managed
}
