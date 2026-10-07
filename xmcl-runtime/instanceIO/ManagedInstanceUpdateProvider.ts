import type { ManagedInstance } from '@xmcl/instance'
import type {
  ManagedInstanceUpdateProgress,
  ManagedInstanceUpdateResult,
  ManagedInstanceUpdateStatus,
} from '@xmcl/runtime-api'

/**
 * Provider contract for launcher-managed instances.
 *
 * The coordinator owns identity/authorization; a provider only knows how to
 * materialize and update one managed profile type.
 */
export interface ManagedInstanceUpdateProvider {
  check(instancePath: string, managed: ManagedInstance): Promise<ManagedInstanceUpdateStatus>
  update(instancePath: string, managed: ManagedInstance): Promise<ManagedInstanceUpdateResult>
  cancel(instancePath: string): boolean | Promise<boolean>
  getProgress(instancePath: string): ManagedInstanceUpdateProgress | Promise<ManagedInstanceUpdateProgress>
}
